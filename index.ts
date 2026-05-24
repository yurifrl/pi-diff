import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	appendAttempt,
	formatBackupSummary,
	listBackupFiles,
	readBackup,
	summarizeBeadsResult,
	updateLastResult,
} from "./backups";
import { createBeadsForComments, isBeadsAvailable, isBeadsRepoConfigured, summarizeCreated } from "./bd-client";
import { formatCommentsAsBeadsScript } from "./beads";
import { appendTextToEditor, formatCommentsForEditor, hasMeaningfulText } from "./comments";
import { buildDiffViewerData, isGitRepository } from "./git";
import { createDiffServer, type DiffServer } from "./server";
import {
	type DiffSettings,
	type SettingsLocation,
	coerceSettings,
	describeSettings,
	loadSettings,
	saveSettings,
} from "./settings";
import { resolveDiffTargetFromArgs } from "./target-selector";
import type { DiffComment, SendCommentsResponse } from "./types";
import { openViewer } from "./viewer";

const DIFF_COMMAND = "diff";
const SETTINGS_COMMAND = "diff-settings";
const BACKUPS_COMMAND = "diff-backups";

function notify(ctx: ExtensionContext, message: string, level: "info" | "error" | "success" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function isBeadsOutputMode(output: DiffSettings["output"]): boolean {
	return output === "beads" || output === "beads-script";
}

async function handleSendComments(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: DiffSettings,
	target: import("./types").ResolvedDiffTarget,
	comments: DiffComment[],
): Promise<SendCommentsResponse> {
	const beadsOpts = {
		command: settings.beadsCommand,
		type: settings.beadsType,
		labels: settings.beadsLabels,
		priority: settings.beadsPriority,
	};

	// Backup BEFORE any output dispatch. If the backup itself fails we still
	// proceed with the send (don't block the user); we just log a warning so
	// failures here don't go silent.
	let backupPath: string | null = null;
	try {
		backupPath = await appendAttempt(ctx, {
			output: settings.output,
			target,
			cwd: ctx.cwd,
			comments,
		});
	} catch (err) {
		console.warn("[pi-diff] failed to write backup file:", err);
	}

	const finalize = async (result: Parameters<typeof updateLastResult>[1]) => {
		if (!backupPath) return;
		try {
			await updateLastResult(backupPath, result);
		} catch (err) {
			console.warn("[pi-diff] failed to update backup result:", err);
		}
	};

	if (isBeadsOutputMode(settings.output) && !isBeadsRepoConfigured(ctx.cwd)) {
		const message = `Beads is enabled but \`.beads/\` is not initialized in this repo. Run \`${settings.beadsCommand} init\` or disable beads in the diff viewer.`;
		notify(ctx, message, "error");
		await finalize({ ok: false, note: message });
		throw new Error(message);
	}

	if (settings.output === "beads") {
		const available = await isBeadsAvailable(pi, settings.beadsCommand, ctx.cwd);
		if (!available) {
			notify(
				ctx,
				`\`${settings.beadsCommand}\` not found. Install beads or set output: "beads-script" in settings.`,
				"error",
			);
			const script = formatCommentsAsBeadsScript(target, comments, beadsOpts);
			await finalize({ ok: false, note: "beads command not found; emitted script" });
			return { sentAt: Date.now(), formattedText: script };
		}
		const results = await createBeadsForComments(pi, comments, target, { ...beadsOpts, cwd: ctx.cwd });
		const summary = summarizeCreated(results);
		if (ctx.hasUI) {
			const editor = ctx.ui.getEditorText();
			const next = appendTextToEditor(editor, `${summary}\n`);
			await ctx.ui.setEditorText(next);
		}
		await finalize(summarizeBeadsResult(results));
		return { sentAt: Date.now(), formattedText: summary };
	}

	if (settings.output === "beads-script") {
		const script = formatCommentsAsBeadsScript(target, comments, beadsOpts);
		const block = `\n${script}`;
		const editor = ctx.hasUI ? ctx.ui.getEditorText() : "";
		const next = appendTextToEditor(editor, block);
		if (ctx.hasUI) await ctx.ui.setEditorText(next);
		await finalize({ ok: true, note: "beads-script appended to editor" });
		return { sentAt: Date.now(), formattedText: script };
	}

	const formatted = formatCommentsForEditor(target, comments);
	const formattedForEditor = `${formatted}\n`;
	if (ctx.hasUI) {
		const editor = ctx.ui.getEditorText();
		const block = hasMeaningfulText(editor) ? `\n\n${formattedForEditor.replace(/^(?:\r?\n)+/u, "")}` : formattedForEditor;
		const next = hasMeaningfulText(editor) ? `${editor.replace(/(?:\r?\n)+$/u, "")}${block}` : formattedForEditor;
		await ctx.ui.setEditorText(next);
	}
	await finalize({ ok: true, note: "prompt text appended to editor" });
	return { sentAt: Date.now(), formattedText: formattedForEditor };
}

async function runBackupsCommand(_pi: ExtensionAPI, args: string, ctx: ExtensionContext) {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const sub = tokens[0] ?? "list";

	if (sub !== "list") {
		notify(ctx, `Usage: /${BACKUPS_COMMAND} list`, "error");
		return;
	}

	const entries = await listBackupFiles();
	if (entries.length === 0) {
		const msg = "No pi-diff backups found under ~/.pi/agent/sessions/";
		notify(ctx, msg, "info");
		console.log(msg);
		return;
	}

	const lines: string[] = [`pi-diff backups (${entries.length}):`];
	for (const entry of entries) {
		const file = await readBackup(entry.path);
		if (!file) {
			lines.push(`${entry.path}  (unreadable)`);
			continue;
		}
		lines.push(formatBackupSummary(entry.path, file));
	}
	const text = lines.join("\n");
	console.log(text);
	notify(ctx, `pi-diff: ${entries.length} backup file(s) — see terminal`, "info");
}

async function runDiffCommand(pi: ExtensionAPI, server: { instance: DiffServer | null }, args: string, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	if (!(await isGitRepository(pi, ctx.cwd))) {
		notify(ctx, "This command only works inside a git repository.", "error");
		return;
	}

	const settings = await loadSettings(ctx.cwd);

	const target = await resolveDiffTargetFromArgs(pi, ctx, args);
	if (!target) return;

	try {
		let currentSettings: DiffSettings = settings;
		let viewerData = await buildDiffViewerData(pi, ctx.cwd, target);
		let hasServedInitialBootstrap = false;

		const computeBootstrap = () => ({
			repo: viewerData.repo,
			target: viewerData.target,
			files: viewerData.files,
			defaultViewMode: currentSettings.defaultViewMode,
			beadsEnabled: isBeadsOutputMode(currentSettings.output),
			beadsConfigured: isBeadsRepoConfigured(ctx.cwd),
		});

		if (!server.instance) server.instance = createDiffServer();
		const session = await server.instance.createViewerSession({
			bootstrap: computeBootstrap(),
			refreshBootstrap: async () => {
				if (!hasServedInitialBootstrap) {
					hasServedInitialBootstrap = true;
					return computeBootstrap();
				}
				viewerData = await buildDiffViewerData(pi, ctx.cwd, target);
				currentSettings = await loadSettings(ctx.cwd);
				return computeBootstrap();
			},
			loadFile: async (fileId) => viewerData.filePayloads.get(fileId) ?? null,
			sendComments: async (comments: DiffComment[]) => handleSendComments(pi, ctx, currentSettings, viewerData.target, comments),
			setBeadsEnabled: async (enabled: boolean) => {
				const nextOutput: DiffSettings["output"] = enabled ? "beads" : "prompt";
				if (currentSettings.output !== nextOutput) {
					await saveSettings("project", ctx.cwd, { output: nextOutput });
					currentSettings = await loadSettings(ctx.cwd);
				}
				return {
					beadsEnabled: isBeadsOutputMode(currentSettings.output),
					beadsConfigured: isBeadsRepoConfigured(ctx.cwd),
				};
			},
		});

		const opened = await openViewer(pi, ctx.cwd, session.url, settings);
		if (!opened.ok) {
			notify(ctx, opened.message, "error");
			return;
		}
		notify(ctx, `${opened.message} Target: ${viewerData.target.label}.`, "success");
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to open the diff viewer.";
		notify(ctx, message, "error");
	}
}

function parseSettingsArgs(args: string): { action: "show" } | { action: "set"; key: string; value: string; location: SettingsLocation } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "show") return { action: "show" };
	let location: SettingsLocation = "global";
	let i = 0;
	if (tokens[0] === "--project" || tokens[0] === "project") {
		location = "project";
		i = 1;
	} else if (tokens[0] === "--global" || tokens[0] === "global") {
		location = "global";
		i = 1;
	}
	if (tokens[i] === "set") i += 1;
	const key = tokens[i];
	const value = tokens.slice(i + 1).join(" ");
	if (!key || !value) {
		throw new Error("Usage: /diff-settings [--project|--global] <key> <value>");
	}
	return { action: "set", key, value, location };
}

function buildSettingsPatch(key: string, value: string): Partial<DiffSettings> {
	const lower = value.trim();
	switch (key) {
		case "viewer":
			return coerceSettings({ viewer: lower });
		case "cmuxMode":
			return coerceSettings({ cmuxMode: lower });
		case "defaultViewMode":
			return coerceSettings({ defaultViewMode: lower });
		case "output":
			return coerceSettings({ output: lower });
		case "beadsCommand":
			return coerceSettings({ beadsCommand: lower });
		case "beadsType":
			return coerceSettings({ beadsType: lower });
		case "beadsLabels":
			return coerceSettings({ beadsLabels: lower.split(",").map((s) => s.trim()).filter(Boolean) });
		case "beadsPriority":
			if (lower === "null" || lower === "unset") return { beadsPriority: null };
			return coerceSettings({ beadsPriority: Number(lower) });
		default:
			throw new Error(`Unknown setting key: ${key}`);
	}
}

async function runSettingsCommand(_pi: ExtensionAPI, args: string, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	let parsed: ReturnType<typeof parseSettingsArgs>;
	try {
		parsed = parseSettingsArgs(args);
	} catch (error) {
		notify(ctx, (error as Error).message, "error");
		return;
	}

	if (parsed.action === "show") {
		const settings = await loadSettings(ctx.cwd);
		notify(ctx, `pi-diff settings:\n${describeSettings(settings)}`, "info");
		return;
	}

	try {
		const patch = buildSettingsPatch(parsed.key, parsed.value);
		if (Object.keys(patch).length === 0) {
			notify(ctx, `Invalid value for ${parsed.key}: ${parsed.value}`, "error");
			return;
		}
		const filePath = await saveSettings(parsed.location, ctx.cwd, patch);
		notify(ctx, `Saved ${parsed.key} -> ${parsed.value} (${parsed.location}) at ${filePath}`, "success");
	} catch (error) {
		notify(ctx, (error as Error).message, "error");
	}
}

export function createDiffExtension() {
	return function (pi: ExtensionAPI) {
		const server: { instance: DiffServer | null } = { instance: null };

		pi.registerCommand(DIFF_COMMAND, {
			description: "Open a GitHub-style diff viewer for review",
			handler: async (args, ctx) => runDiffCommand(pi, server, args, ctx),
		});

		pi.registerCommand(SETTINGS_COMMAND, {
			description: "Show or update pi-diff settings (viewer, output, beads…)",
			handler: async (args, ctx) => runSettingsCommand(pi, args, ctx),
		});

		pi.registerCommand(BACKUPS_COMMAND, {
			description: "List pi-diff comment-send backups (use `/diff-backups list`)",
			handler: async (args, ctx) => runBackupsCommand(pi, args, ctx),
		});

		pi.on("session_shutdown", async () => {
			if (server.instance) {
				await server.instance.stop();
				server.instance = null;
			}
		});
	};
}

export default createDiffExtension();
