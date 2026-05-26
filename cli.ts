#!/usr/bin/env node
import { spawn } from "node:child_process";
import React from "react";
import { render } from "ink";
import { appendAttempt, formatBackupSummary, listBackupFiles, readBackup, summarizeBeadsResult, updateLastResult } from "./core/backups.js";
import { createBeadsForComments, isBeadsAvailable, isBeadsRepoConfigured, summarizeCreated, type CreatedBead } from "./core/bd-client.js";
import { formatCommentsAsBeadsScript } from "./core/beads.js";
import { formatCommentsForEditor } from "./core/comments.js";
import { getVersionInfo } from "./core/version.js";
const __versionInfo = getVersionInfo();
import type { Exec, ExecOptions, ExecResult } from "./core/exec.js";
import { buildDiffViewerData, hasWorkingTreeChanges, isGitRepository } from "./core/git.js";
import { handleSendComments, isBeadsOutputMode } from "./core/handle-send.js";
import { createDiffServer } from "./core/server.js";
import { coerceSettings, describeSettings, type DiffSettings, loadSettings, mergeSettings, saveSettings, type SettingsLocation } from "./core/settings.js";
import { parseDiffTargetArgs } from "./core/target-resolver.js";
import type { DiffComment, DiffTarget, ResolvedDiffTarget, SendCommentsResponse } from "./core/types.js";
import { openViewer } from "./core/viewer.js";
import { App } from "./cli/app.js";
import { TargetPickerApp } from "./cli/target-picker-app.js";

// ---------------------------------------------------------------------------
// Node-based Exec.
// ---------------------------------------------------------------------------

const nodeExec: Exec = (command, args, options: ExecOptions = {}) => {
	return new Promise<ExecResult>((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		let timer: NodeJS.Timeout | null = null;

		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

		if (options.timeout && options.timeout > 0) {
			timer = setTimeout(() => {
				killed = true;
				child.kill("SIGKILL");
			}, options.timeout);
		}

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr: stderr || (err instanceof Error ? err.message : String(err)), code: 1, killed });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 0, killed });
		});

		if (options.input !== undefined) {
			child.stdin.end(options.input, "utf8");
		} else {
			child.stdin.end();
		}
	});
};

// ---------------------------------------------------------------------------
// Argv parsing.
// ---------------------------------------------------------------------------

type MainFlags = {
	viewer?: DiffSettings["viewer"];
	output?: DiffSettings["output"];
	cwd?: string;
	noOpen?: boolean;
	autoSubmit?: boolean;
};

type ParsedArgs =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "main"; targetTokens: string[]; flags: MainFlags }
	| { kind: "settings-show" }
	| { kind: "settings-set"; key: string; value: string; location: SettingsLocation }
	| { kind: "backups-list" }
	| { kind: "error"; message: string };

function parseArgv(argv: string[]): ParsedArgs {
	const args = argv.slice();
	if (args.length === 0) return { kind: "main", targetTokens: [], flags: {} };
	if (args[0] === "-h" || args[0] === "--help") return { kind: "help" };
	if (args[0] === "-V" || args[0] === "--version" || args[0] === "version") return { kind: "version" };

	if (args[0] === "settings") {
		const sub = args[1] ?? "show";
		if (sub === "show") return { kind: "settings-show" };
		if (sub === "set") {
			let i = 2;
			let location: SettingsLocation = "global";
			if (args[i] === "--project") { location = "project"; i += 1; }
			else if (args[i] === "--global") { location = "global"; i += 1; }
			const key = args[i];
			const value = args.slice(i + 1).join(" ");
			if (!key || !value) return { kind: "error", message: "Usage: pi-diff settings set [--project|--global] <key> <value>" };
			return { kind: "settings-set", key, value, location };
		}
		return { kind: "error", message: `Unknown settings subcommand: ${sub}` };
	}

	if (args[0] === "backups") {
		const sub = args[1] ?? "list";
		if (sub !== "list") return { kind: "error", message: `Usage: pi-diff backups list` };
		return { kind: "backups-list" };
	}

	const flags: MainFlags = {};
	const targetTokens: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const a = args[i];
		if (a === "--viewer") {
			const v = args[++i];
			if (v !== "cmux" && v !== "browser" && v !== "none") return { kind: "error", message: `--viewer must be cmux|browser|none` };
			flags.viewer = v;
		} else if (a === "--output") {
			const v = args[++i];
			if (v !== "prompt" && v !== "beads" && v !== "beads-script") return { kind: "error", message: `--output must be prompt|beads|beads-script` };
			flags.output = v;
		} else if (a === "--cwd") {
			flags.cwd = args[++i];
		} else if (a === "--no-open") {
			flags.noOpen = true;
		} else if (a === "--auto-submit") {
			flags.autoSubmit = true;
		} else if (a.startsWith("--")) {
			return { kind: "error", message: `Unknown flag: ${a}` };
		} else {
			targetTokens.push(a);
		}
	}
	return { kind: "main", targetTokens, flags };
}

const HELP_TEXT = `pi-diff — GitHub-style diff review for the terminal

USAGE:
  pi-diff [target] [flags]      open the diff viewer for a target
  pi-diff settings show
  pi-diff settings set [--project|--global] <key> <value>
  pi-diff backups list
  pi-diff --help
  pi-diff --version

TARGETS:
  uncommitted                   working tree vs HEAD
  branch <name>                 merge-base of <name> vs HEAD
  commit <sha>                  <sha> vs its parent
  (no target)                   interactive prompt

FLAGS (main flow):
  --viewer cmux|browser|none    override the configured viewer for this run
  --output prompt|beads|beads-script
                                override the configured output mode
  --cwd <path>                  run as if executed from <path>
  --no-open                     don't try to open the viewer; just print the URL
  --auto-submit                 process the first browser submission and exit
                                (skip the interactive TUI)
`;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function locationFor(comment: DiffComment): string {
	if (comment.kind === "overall") return "(overall)";
	if (comment.kind === "file") return `./${comment.path}`;
	return `./${comment.path}:${(comment as { lineNumber: number }).lineNumber}`;
}

function summarize(text: string, max = 72): string {
	const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
	if (firstLine.length <= max) return firstLine;
	return `${firstLine.slice(0, max - 1).trimEnd()}…`;
}

function targetLabel(t: ResolvedDiffTarget): string {
	if (t.type === "uncommitted") return "uncommitted";
	if (t.type === "baseBranch") return `branch ${t.branch}`;
	const title = t.title ? ` ${t.title}` : "";
	return `commit ${t.sha.slice(0, 12)}${title}`;
}

// ---------------------------------------------------------------------------
// Subcommand handlers.
// ---------------------------------------------------------------------------

async function runSettingsShow(cwd: string): Promise<number> {
	const settings = await loadSettings(cwd);
	console.log(`pi-diff settings:`);
	console.log(describeSettings(settings));
	return 0;
}

function buildSettingsPatch(key: string, value: string): Partial<DiffSettings> {
	const v = value.trim();
	switch (key) {
		case "viewer": return coerceSettings({ viewer: v });
		case "cmuxMode": return coerceSettings({ cmuxMode: v });
		case "defaultViewMode": return coerceSettings({ defaultViewMode: v });
		case "layoutMode": return coerceSettings({ layoutMode: v });
		case "output": return coerceSettings({ output: v });
		case "beadsCommand": return coerceSettings({ beadsCommand: v });
		case "beadsType": return coerceSettings({ beadsType: v });
		case "beadsLabels": return coerceSettings({ beadsLabels: v.split(",").map((s) => s.trim()).filter(Boolean) });
		case "beadsPriority":
			if (v === "null" || v === "unset") return { beadsPriority: null };
			return coerceSettings({ beadsPriority: Number(v) });
		default:
			throw new Error(`Unknown setting key: ${key}`);
	}
}

async function runSettingsSet(cwd: string, location: SettingsLocation, key: string, value: string): Promise<number> {
	const patch = buildSettingsPatch(key, value);
	if (Object.keys(patch).length === 0) {
		console.error(`Invalid value for ${key}: ${value}`);
		return 1;
	}
	const file = await saveSettings(location, cwd, patch);
	console.log(`Saved ${key} -> ${value} (${location}) at ${file}`);
	return 0;
}

async function runBackupsList(): Promise<number> {
	const entries = await listBackupFiles();
	if (entries.length === 0) {
		console.log("No pi-diff backups found under ~/.pi/agent/sessions/");
		return 0;
	}
	console.log(`pi-diff backups (${entries.length}):`);
	for (const entry of entries) {
		const file = await readBackup(entry.path);
		console.log(file ? formatBackupSummary(entry.path, file) : `${entry.path}  (unreadable)`);
	}
	return 0;
}

function buildEffectiveSettings(base: DiffSettings, flags: MainFlags): DiffSettings {
	const overrides: Partial<DiffSettings> = {};
	if (flags.viewer) overrides.viewer = flags.viewer;
	if (flags.output) overrides.output = flags.output;
	if (flags.noOpen) overrides.viewer = "none";
	return mergeSettings(base, overrides);
}

function formatBeadsSummary(comments: DiffComment[]): string {
	const meaningful = comments.filter((c) => c.text.trim().length > 0);
	const lines: string[] = [];
	meaningful.forEach((c, i) => {
		lines.push(`  ${i + 1}. ${locationFor(c)}  — ${summarize(c.text)}`);
	});
	return lines.join("\n");
}

async function autoProcessSubmission(
	cwd: string,
	settings: DiffSettings,
	resolvedTarget: ResolvedDiffTarget,
	comments: DiffComment[],
): Promise<void> {
	if (comments.length === 0) {
		console.log("\npi-diff: empty submission ignored.");
		return;
	}

	const beadsOpts = {
		command: settings.beadsCommand,
		type: settings.beadsType,
		labels: settings.beadsLabels,
		priority: settings.beadsPriority,
	};

	if (settings.output === "prompt") {
		const formatted = formatCommentsForEditor(resolvedTarget, comments);
		console.log("\n--- pi-diff comments ---");
		process.stdout.write(formatted);
		if (!formatted.endsWith("\n")) process.stdout.write("\n");
		console.log("------------------------");
		await handleSendComments(
			{ exec: nodeExec, cwd, sessionFile: null, settings, target: resolvedTarget },
			comments,
		);
		return;
	}

	if (settings.output === "beads-script") {
		const script = formatCommentsAsBeadsScript(resolvedTarget, comments, beadsOpts);
		console.log("\n--- pi-diff bd create script ---");
		process.stdout.write(script);
		if (!script.endsWith("\n")) process.stdout.write("\n");
		console.log("--------------------------------");
		await handleSendComments(
			{ exec: nodeExec, cwd, sessionFile: null, settings, target: resolvedTarget },
			comments,
		);
		return;
	}

	const meaningful = comments.filter((c) => c.text.trim().length > 0);
	console.log(`\n${meaningful.length} comment(s):`);
	console.log(formatBeadsSummary(comments));
	try {
		const result = await handleSendComments(
			{
				exec: nodeExec,
				cwd,
				sessionFile: null,
				settings,
				target: resolvedTarget,
				notify: (msg, level) => {
					if (level === "error") console.error(`pi-diff: ${msg}`);
					else console.log(`pi-diff: ${msg}`);
				},
			},
			comments,
		);
		process.stdout.write(`${result.formattedText}\n`);
	} catch (err) {
		console.error(`pi-diff: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Suppress unused import warning when only invoked via auto-submit branch.
	void appendAttempt; void updateLastResult; void summarizeBeadsResult;
	void createBeadsForComments; void isBeadsAvailable; void summarizeCreated;
}

// ---------------------------------------------------------------------------
// Ink runners.
// ---------------------------------------------------------------------------

function runInkPicker(cwd: string): Promise<DiffTarget | null> {
	return new Promise((resolve) => {
		const instance = render(
			React.createElement(TargetPickerApp, {
				exec: nodeExec,
				cwd,
				onDone: (target) => {
					resolve(target);
					instance.unmount();
				},
			}),
			{ exitOnCtrlC: true },
		);
		instance.waitUntilExit().catch(() => resolve(null));
	});
}

type AppExitResult = { code: number; comments?: DiffComment[]; finalPrint?: () => void };

function runInkApp(args: {
	targetLabel: string;
	viewerMessage: string;
	url: string;
	submissionState: import("./cli/app.js").SubmissionState;
	cwd: string;
	settings: DiffSettings;
	target: ResolvedDiffTarget;
	autoSubmit: boolean;
}): Promise<AppExitResult> {
	return new Promise((resolve) => {
		const instance = render(
			React.createElement(App, {
				targetLabel: args.targetLabel,
				viewerMessage: args.viewerMessage,
				url: args.url,
				submissionState: args.submissionState,
				exec: nodeExec,
				cwd: args.cwd,
				settings: args.settings,
				target: args.target,
				autoSubmit: args.autoSubmit,
				onDone: (r) => {
					resolve(r);
					instance.unmount();
				},
			}),
			{ exitOnCtrlC: false },
		);
	});
}

// ---------------------------------------------------------------------------
// Bun-embedded asset loading (only active when running under Bun, e.g. the
// `bun build --compile` single-file binary). Under Node (pi-extension path),
// this returns {} and the server falls back to its esbuild-on-demand path.
// ---------------------------------------------------------------------------

async function loadEmbeddedAssetServerOptions(): Promise<import("./core/server.js").DiffServerOptions> {
	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return {};
	try {
		const mod = await import("./cli/assets.js");
		const { jsPath, cssPath } = mod.embeddedAssets;
		return {
			buildAssets: async () => ({ jsPath, cssPath }),
		};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Main flow.
// ---------------------------------------------------------------------------

async function runMain(targetTokens: string[], flags: MainFlags): Promise<number> {
	const cwd = flags.cwd ? flags.cwd : process.cwd();

	if (!(await isGitRepository(nodeExec, cwd))) {
		console.error(`pi-diff: not a git repository: ${cwd}`);
		return 1;
	}

	const baseSettings = await loadSettings(cwd);
	const settings = buildEffectiveSettings(baseSettings, flags);

	let target: DiffTarget | null = null;
	if (targetTokens.length > 0) {
		target = parseDiffTargetArgs(targetTokens.join(" "));
		if (!target) {
			console.error(`pi-diff: invalid target. Use uncommitted, branch <name>, or commit <sha>.`);
			return 1;
		}
		if (target.type === "uncommitted" && !(await hasWorkingTreeChanges(nodeExec, cwd))) {
			console.error("pi-diff: no uncommitted changes found.");
			return 1;
		}
	} else {
		target = await runInkPicker(cwd);
		if (!target) return 0;
	}

	const viewerData = await buildDiffViewerData(nodeExec, cwd, target);
	const resolvedTarget: ResolvedDiffTarget = viewerData.target;

	// Phase A: accumulate every browser submission. The user can submit many
	// times (inline + Send-all). Server stays alive across the whole run.
	const accumulated = new Map<string, DiffComment>();
	let countListeners: Array<(n: number) => void> = [];
	let firstSubmissionListeners: Array<() => void> = [];
	let doneListeners: Array<() => void> = [];
	let markedDone = false;

	const submissionState = {
		getCount: () => accumulated.size,
		getComments: () => Array.from(accumulated.values()),
		onCountChange: (cb: (n: number) => void) => {
			countListeners.push(cb);
			return () => { countListeners = countListeners.filter((l) => l !== cb); };
		},
		onFirstSubmission: (cb: () => void) => {
			if (accumulated.size > 0) { cb(); return () => {}; }
			firstSubmissionListeners.push(cb);
			return () => { firstSubmissionListeners = firstSubmissionListeners.filter((l) => l !== cb); };
		},
		onFinishedFromBrowser: (cb: () => void) => {
			if (markedDone) { cb(); return () => {}; }
			doneListeners.push(cb);
			return () => { doneListeners = doneListeners.filter((l) => l !== cb); };
		},
	};

	const server = createDiffServer(await loadEmbeddedAssetServerOptions());
	const session = await server.createViewerSession({
		bootstrap: {
			repo: viewerData.repo,
			target: viewerData.target,
			files: viewerData.files,
			defaultViewMode: settings.defaultViewMode,
			defaultLayoutMode: settings.layoutMode,
			beadsEnabled: isBeadsOutputMode(settings.output),
			beadsConfigured: isBeadsRepoConfigured(cwd),
			buildVersion: __versionInfo.display,
			buildKind: __versionInfo.buildKind,
		},
		loadFile: async (fileId) => viewerData.filePayloads.get(fileId) ?? null,
		sendComments: async (comments: DiffComment[]): Promise<SendCommentsResponse> => {
			const wasEmpty = accumulated.size === 0;
			for (const c of comments) accumulated.set(c.id, c);
			const total = accumulated.size;
			for (const l of countListeners) {
				try { l(total); } catch { /* ignore */ }
			}
			if (wasEmpty && firstSubmissionListeners.length > 0) {
				const ls = firstSubmissionListeners; firstSubmissionListeners = [];
				for (const l of ls) {
					try { l(); } catch { /* ignore */ }
				}
			}
			return {
				sentAt: Date.now(),
				formattedText: `Received. ${total} comment(s) total. Press Done when you're finished.`,
			};
		},
		markDone: () => {
			if (markedDone) return;
			markedDone = true;
			const ls = doneListeners; doneListeners = [];
			for (const l of ls) {
				try { l(); } catch { /* ignore */ }
			}
		},
	});

	let viewerMessage: string;
	if (settings.viewer === "none" || flags.noOpen) {
		viewerMessage = `open ${session.url} in your browser, then submit comments.`;
	} else {
		const opened = await openViewer(nodeExec, cwd, session.url, settings);
		viewerMessage = opened.ok ? opened.message : `${opened.message} (open ${session.url})`;
	}

	let appResult: AppExitResult;
	appResult = await runInkApp({
		targetLabel: targetLabel(resolvedTarget),
		viewerMessage,
		url: session.url,
		submissionState,
		cwd,
		settings,
		target: resolvedTarget,
		autoSubmit: Boolean(flags.autoSubmit),
	});

	// If autoSubmit and we got comments, run the auto flow now (Ink already exited).
	if (flags.autoSubmit && appResult.comments && appResult.comments.length > 0) {
		try {
			await autoProcessSubmission(cwd, settings, resolvedTarget, appResult.comments);
		} catch (err) {
			console.error(`pi-diff: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Print any deferred output (the Manager exits Ink before printing).
	if (appResult.finalPrint) {
		try { appResult.finalPrint(); } catch { /* ignore */ }
	}

	// Now that the CLI is exiting, stop the server.
	await server.stop();

	return appResult.code;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const parsed = parseArgv(process.argv.slice(2));
	switch (parsed.kind) {
		case "help":
			process.stdout.write(HELP_TEXT);
			return 0;
		case "version": {
			const v = getVersionInfo();
			process.stdout.write(`pi-diff ${v.display}\n`);
			return 0;
		}
		case "error":
			console.error(`pi-diff: ${parsed.message}`);
			return 2;
		case "settings-show":
			return await runSettingsShow(process.cwd());
		case "settings-set":
			return await runSettingsSet(process.cwd(), parsed.location, parsed.key, parsed.value);
		case "backups-list":
			return await runBackupsList();
		case "main":
			return await runMain(parsed.targetTokens, parsed.flags);
	}
}

// Suppress unused-import warning for CreatedBead used only in cli/manager.tsx.
type _unused = CreatedBead;

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? err.stack || err.message : String(err));
		process.exit(1);
	},
);
