import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatBackupSummary,
	listBackupFiles,
	readBackup,
} from "./core/backups.js";
import { isBeadsRepoConfigured } from "./core/bd-client.js";
import type { Exec } from "./core/exec.js";
import { buildDiffViewerData, isGitRepository } from "./core/git.js";
import { handleSendComments, isBeadsOutputMode } from "./core/handle-send.js";
import { createDiffServer, type DiffServer } from "./core/server.js";
import { getVersionInfo } from "./core/version.js";
import {
	type DiffSettings,
	type SettingsLocation,
	coerceSettings,
	describeSettings,
	loadSettings,
	saveSettings,
} from "./core/settings.js";
import type { DiffComment, SendCommentsResponse } from "./core/types.js";
import { openViewer } from "./core/viewer.js";
import { resolveDiffTargetFromArgs } from "./pi-target-selector.js";

const DIFF_COMMAND = "diff";
const SETTINGS_COMMAND = "diff-settings";
const BACKUPS_COMMAND = "diff-backups";

/**
 * Adapter from pi.exec (which has no stdin support) to the runtime-agnostic
 * Exec interface used by core/. When `input` is provided, we shell out via
 * bash and feed stdin through a base64 pipe so binaries like `bd` can read
 * the description from stdin.
 */
function makeExec(pi: ExtensionAPI): Exec {
	return async (cmd, args, opts) => {
		if (opts?.input !== undefined) {
			const encoded = Buffer.from(opts.input, "utf8").toString("base64");
			const argString = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
			const script = `printf %s "${encoded}" | base64 -d | ${cmd} ${argString}`;
			return await pi.exec("bash", ["-lc", script], { cwd: opts.cwd, timeout: opts.timeout ?? 10000 });
		}
		return await pi.exec(cmd, args, opts);
	};
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "error" | "success" = "info") {
	if (!ctx.hasUI) return;
	// pi.notify only knows info | warning | error; map "success" → "info".
	const piLevel: "info" | "warning" | "error" = level === "success" ? "info" : level;
	ctx.ui.notify(message, piLevel);
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function runBackupsCommand(_exec: Exec, args: string, ctx: ExtensionContext) {
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

async function runDiffCommand(exec: Exec, server: { instance: DiffServer | null }, args: string, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	if (!(await isGitRepository(exec, ctx.cwd))) {
		notify(ctx, "This command only works inside a git repository.", "error");
		return;
	}

	const settings = await loadSettings(ctx.cwd);

	const target = await resolveDiffTargetFromArgs(exec, ctx, args);
	if (!target) return;

	try {
		let currentSettings: DiffSettings = settings;
		let viewerData = await buildDiffViewerData(exec, ctx.cwd, target);
		let hasServedInitialBootstrap = false;

		const computeBootstrap = () => ({
			name: viewerData.target.label,
			repo: viewerData.repo,
			target: viewerData.target,
			files: viewerData.files,
			defaultViewMode: currentSettings.defaultViewMode,
			defaultLayoutMode: currentSettings.layoutMode,
			beadsEnabled: isBeadsOutputMode(currentSettings.output),
			beadsConfigured: isBeadsRepoConfigured(ctx.cwd),
			linkedBeads: [],
			buildVersion: getVersionInfo().display,
			buildKind: getVersionInfo().buildKind,
		});

		if (!server.instance) server.instance = createDiffServer();
		const session = await server.instance.createViewerSession({
			bootstrap: computeBootstrap(),
			refreshBootstrap: async () => {
				if (!hasServedInitialBootstrap) {
					hasServedInitialBootstrap = true;
					return computeBootstrap();
				}
				viewerData = await buildDiffViewerData(exec, ctx.cwd, target);
				currentSettings = await loadSettings(ctx.cwd);
				return computeBootstrap();
			},
			loadFile: async (fileId) => viewerData.filePayloads.get(fileId) ?? null,
			sendComments: async (comments: DiffComment[]): Promise<SendCommentsResponse> => {
				return await handleSendComments(
					{
						exec,
						cwd: ctx.cwd,
						sessionFile: ctx.sessionManager?.getSessionFile?.() ?? null,
						settings: currentSettings,
						target: viewerData.target,
						notify: (message, level) => notify(ctx, message, level ?? "info"),
						editor: ctx.hasUI
							? {
								getText: () => ctx.ui.getEditorText(),
								setText: (value) => ctx.ui.setEditorText(value),
							}
							: undefined,
					},
					comments,
				);
			},
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

		const opened = await openViewer(exec, ctx.cwd, session.url, settings);
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
		case "layoutMode":
			return coerceSettings({ layoutMode: lower });
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

async function runSettingsCommand(args: string, ctx: ExtensionContext) {
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
		const exec = makeExec(pi);
		const server: { instance: DiffServer | null } = { instance: null };

		pi.registerCommand(DIFF_COMMAND, {
			description: "Open a GitHub-style diff viewer for review",
			handler: async (args, ctx) => runDiffCommand(exec, server, args, ctx),
		});

		pi.registerCommand(SETTINGS_COMMAND, {
			description: "Show or update pi-diff settings (viewer, output, beads…)",
			handler: async (args, ctx) => runSettingsCommand(args, ctx),
		});

		pi.registerCommand(BACKUPS_COMMAND, {
			description: "List pi-diff comment-send backups (use `/diff-backups list`)",
			handler: async (args, ctx) => runBackupsCommand(exec, args, ctx),
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
