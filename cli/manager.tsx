import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { appendAttempt, summarizeBeadsResult, updateLastResult } from "../core/backups.js";
import { buildTitle, createBeadsForComments, isBeadsAvailable, isBeadsRepoConfigured, summarizeCreated, type CreatedBead } from "../core/bd-client.js";
import { formatCommentsAsBeadsScript } from "../core/beads.js";
import { formatCommentsForEditor } from "../core/comments.js";
import type { Exec } from "../core/exec.js";
import { mergeSettings, type DiffSettings } from "../core/settings.js";
import type { DiffComment, ResolvedDiffTarget } from "../core/types.js";

export type ItemOverrides = { title?: string; labels?: string[]; type?: string; priority?: number | null };
export type Item = { comment: DiffComment; overrides: ItemOverrides; lastError?: string };

export type ManagerProps = {
	initial: DiffComment[];
	exec: Exec;
	cwd: string;
	settings: DiffSettings;
	target: ResolvedDiffTarget;
	/** Called once Ink should fully exit. Pass exit code and optional sync print closure. */
	onDone: (result: { code: number; finalPrint?: () => void }) => void;
};

function locationFor(comment: DiffComment): string {
	if (comment.kind === "overall") return "(overall)";
	if (comment.kind === "file") return `./${comment.path}`;
	return `./${comment.path}:${(comment as { lineNumber: number }).lineNumber}`;
}

function summarize(text: string, max = 60): string {
	const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
	if (firstLine.length <= max) return firstLine;
	return `${firstLine.slice(0, max - 1).trimEnd()}…`;
}

function effectiveSettingsFor(base: DiffSettings, ov: ItemOverrides): DiffSettings {
	const patch: Partial<DiffSettings> = {};
	if (ov.type !== undefined) patch.beadsType = ov.type;
	if (ov.labels !== undefined) patch.beadsLabels = ov.labels;
	if (ov.priority !== undefined) patch.beadsPriority = ov.priority;
	return mergeSettings(base, patch);
}

function buildEditBuffer(item: Item, settings: DiffSettings, includeMeta: boolean): string {
	const lines: string[] = [];
	lines.push("# pi-diff edit — save and quit to apply.");
	lines.push(`# location: ${locationFor(item.comment)}`);
	if (includeMeta) {
		const eff = effectiveSettingsFor(settings, item.overrides);
		const title = item.overrides.title ?? buildTitle(item.comment);
		lines.push(`title: ${title}`);
		lines.push(`labels: ${eff.beadsLabels.join(",")}`);
		lines.push(`type: ${eff.beadsType}`);
		lines.push(`priority: ${eff.beadsPriority === null ? "" : String(eff.beadsPriority)}`);
	}
	lines.push("text: |");
	for (const tline of item.comment.text.split(/\r?\n/)) {
		lines.push(`  ${tline}`);
	}
	return `${lines.join("\n")}\n`;
}

type ParsedBuffer = {
	title?: string;
	labels?: string[];
	type?: string;
	priority?: number | null;
	text: string;
};

function parseEditBuffer(buf: string, includeMeta: boolean): ParsedBuffer | { error: string } {
	const lines = buf.split(/\r?\n/);
	const out: ParsedBuffer = { text: "" };
	let i = 0;
	while (i < lines.length) {
		const raw = lines[i] ?? "";
		const trimmed = raw.trim();
		if (trimmed === "" || trimmed.startsWith("#")) { i += 1; continue; }
		const colon = raw.indexOf(":");
		if (colon < 0) return { error: `unexpected line: ${raw}` };
		const key = raw.slice(0, colon).trim();
		const value = raw.slice(colon + 1).trim();
		if (key === "text") {
			const body: string[] = [];
			let j = i + 1;
			if (j < lines.length && (lines[j] ?? "") === "") j += 1;
			for (; j < lines.length; j += 1) body.push(lines[j] ?? "");
			while (body.length > 0 && body[body.length - 1] === "") body.pop();
			const nonEmpty = body.filter((l) => l.length > 0);
			const allIndented = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith("  "));
			const stripped = allIndented ? body.map((l) => (l.startsWith("  ") ? l.slice(2) : l)) : body;
			out.text = stripped.join("\n");
			i = lines.length;
			break;
		}
		if (!includeMeta) return { error: `unexpected field: ${key}` };
		switch (key) {
			case "title":
				out.title = value;
				break;
			case "labels":
				out.labels = value === "" ? [] : value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
				break;
			case "type":
				out.type = value;
				break;
			case "priority":
				if (value === "") {
					out.priority = null;
				} else {
					const n = Number(value);
					if (!Number.isInteger(n)) return { error: `priority must be an integer or blank: ${value}` };
					out.priority = n;
				}
				break;
			default:
				return { error: `unknown field: ${key}` };
		}
		i += 1;
	}
	return out;
}

async function commandExists(exec: Exec, cmd: string): Promise<boolean> {
	if (!cmd) return false;
	const result = await exec("sh", ["-c", `command -v ${cmd}`], { timeout: 2000 });
	return result.code === 0 && result.stdout.trim().length > 0;
}

async function spawnEditorOnBuffer(
	exec: Exec,
	initialText: string,
	setRawMode: ((value: boolean) => void) | undefined,
): Promise<string | null> {
	const editor = process.env.VISUAL || process.env.EDITOR;
	let chosen = editor && editor.trim() ? editor.trim() : null;
	if (!chosen && (await commandExists(exec, "vi"))) chosen = "vi";
	if (!chosen) return null;

	const dir = mkdtempSync(path.join(tmpdir(), "pi-diff-edit-"));
	const tmpPath = path.join(dir, `pi-diff-edit-${randomUUID()}.txt`);
	writeFileSync(tmpPath, initialText, "utf8");
	try {
		// Detach Ink's raw-mode stdin handling so the editor takes the terminal cleanly.
		if (setRawMode) {
			try { setRawMode(false); } catch { /* ignore */ }
		}
		await new Promise<void>((resolve, reject) => {
			const child = spawn(chosen!, [tmpPath], { stdio: "inherit", shell: chosen!.includes(" ") });
			child.on("error", reject);
			child.on("close", () => resolve());
		});
		if (setRawMode) {
			try { setRawMode(true); } catch { /* ignore */ }
		}
		return readFileSync(tmpPath, "utf8");
	} finally {
		try { unlinkSync(tmpPath); } catch { /* ignore */ }
	}
}

function applyEdit(item: Item, parsed: ParsedBuffer, settings: DiffSettings, includeMeta: boolean): Item {
	const next: Item = { comment: item.comment, overrides: { ...item.overrides } };
	if (parsed.text !== undefined) {
		next.comment = { ...item.comment, text: parsed.text, updatedAt: Date.now() } as DiffComment;
	}
	if (includeMeta) {
		if (parsed.title !== undefined) {
			const auto = buildTitle(next.comment);
			if (parsed.title.trim().length === 0 || parsed.title === auto) {
				delete next.overrides.title;
			} else {
				next.overrides.title = parsed.title;
			}
		}
		if (parsed.labels !== undefined) {
			const same = parsed.labels.length === settings.beadsLabels.length
				&& parsed.labels.every((l, i) => l === settings.beadsLabels[i]);
			if (same) delete next.overrides.labels; else next.overrides.labels = parsed.labels;
		}
		if (parsed.type !== undefined) {
			if (parsed.type === settings.beadsType || parsed.type === "") delete next.overrides.type;
			else next.overrides.type = parsed.type;
		}
		if (parsed.priority !== undefined) {
			if (parsed.priority === settings.beadsPriority) delete next.overrides.priority;
			else next.overrides.priority = parsed.priority;
		}
	}
	delete next.lastError;
	return next;
}

type Mode =
	| { kind: "list" }
	| { kind: "view"; index: number }
	| { kind: "editing" }
	| { kind: "submitting" }
	| { kind: "results"; created: CreatedBead[] }
	| { kind: "confirmClear" }
	| { kind: "confirmQuit" };

export function Manager(props: ManagerProps): React.JSX.Element {
	const { initial, exec, cwd, settings, target, onDone } = props;
	const { exit } = useApp();
	const stdin = useStdin();

	const [items, setItems] = useState<Item[]>(() => initial.map((c) => ({ comment: c, overrides: {} })));
	const [cursor, setCursor] = useState(0);
	const [mode, setMode] = useState<Mode>({ kind: "list" });
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!error) return;
		const t = setTimeout(() => setError(null), 3000);
		return () => clearTimeout(t);
	}, [error]);

	const finalExit = (code: number, finalPrint?: () => void) => {
		exit();
		onDone({ code, finalPrint });
	};

	const finishSubmitPrompt = async () => {
		const comments = items.map((it) => it.comment);
		const formatted = formatCommentsForEditor(target, comments);
		try {
			const p = await appendAttempt(null, { output: settings.output, target, cwd, comments });
			await updateLastResult(p, { ok: true, note: "prompt printed to stdout (TUI)" });
		} catch (err) {
			// non-fatal
			console.warn(`pi-diff: failed to write backup: ${err instanceof Error ? err.message : String(err)}`);
		}
		finalExit(0, () => {
			console.log("\n--- pi-diff comments ---");
			process.stdout.write(formatted);
			if (!formatted.endsWith("\n")) process.stdout.write("\n");
			console.log("------------------------");
		});
	};

	const finishSubmitBeadsScript = async () => {
		const comments = items.map((it) => it.comment);
		const beadsOpts = {
			command: settings.beadsCommand,
			type: settings.beadsType,
			labels: settings.beadsLabels,
			priority: settings.beadsPriority,
		};
		const script = formatCommentsAsBeadsScript(target, comments, beadsOpts);
		try {
			const p = await appendAttempt(null, { output: settings.output, target, cwd, comments });
			await updateLastResult(p, { ok: true, note: "beads-script printed to stdout (TUI)" });
		} catch (err) {
			console.warn(`pi-diff: failed to write backup: ${err instanceof Error ? err.message : String(err)}`);
		}
		finalExit(0, () => {
			console.log("\n--- pi-diff bd create script ---");
			process.stdout.write(script);
			if (!script.endsWith("\n")) process.stdout.write("\n");
			console.log("--------------------------------");
		});
	};

	const finishSubmitBeads = async () => {
		setMode({ kind: "submitting" });
		const comments = items.map((it) => it.comment);
		if (!isBeadsRepoConfigured(cwd)) {
			setError(`beads not initialized in ${cwd}. Run \`${settings.beadsCommand} init\`.`);
			setMode({ kind: "list" });
			return;
		}
		const available = await isBeadsAvailable(exec, settings.beadsCommand, cwd);
		if (!available) {
			setError(`\`${settings.beadsCommand}\` not found.`);
			setMode({ kind: "list" });
			return;
		}
		let backupPath: string | null = null;
		try {
			backupPath = await appendAttempt(null, { output: settings.output, target, cwd, comments });
		} catch (err) {
			// non-fatal
			console.warn(`pi-diff: failed to write backup: ${err instanceof Error ? err.message : String(err)}`);
		}
		const allResults: CreatedBead[] = [];
		const remaining: Item[] = [];
		for (const it of items) {
			const eff = effectiveSettingsFor(settings, it.overrides);
			const opts = {
				command: eff.beadsCommand,
				type: eff.beadsType,
				labels: eff.beadsLabels,
				priority: eff.beadsPriority,
				cwd,
			};
			const titleOverrides = it.overrides.title ? new Map([[it.comment.id, it.overrides.title]]) : undefined;
			const results = await createBeadsForComments(exec, [it.comment], target, opts, titleOverrides);
			allResults.push(...results);
			const r = results[0];
			if (!r || r.id == null) {
				remaining.push({ ...it, lastError: r?.error ?? "unknown" });
			}
		}
		if (backupPath) {
			try {
				await updateLastResult(backupPath, summarizeBeadsResult(allResults));
			} catch {
				// ignore
			}
		}
		setItems(remaining);
		setCursor(0);
		if (remaining.length === 0) {
			finalExit(0, () => {
				console.log(summarizeCreated(allResults));
			});
		} else {
			setMode({ kind: "results", created: allResults });
		}
	};

	const startSubmit = () => {
		if (items.length === 0) {
			finalExit(0);
			return;
		}
		if (settings.output === "prompt") {
			void finishSubmitPrompt();
			return;
		}
		if (settings.output === "beads-script") {
			void finishSubmitBeadsScript();
			return;
		}
		void finishSubmitBeads();
	};

	const startEdit = async () => {
		const item = items[cursor];
		if (!item) return;
		const includeMeta = settings.output === "beads" || settings.output === "beads-script";
		setMode({ kind: "editing" });
		const initialBuf = buildEditBuffer(item, settings, includeMeta);
		let edited: string | null = null;
		try {
			edited = await spawnEditorOnBuffer(
				exec,
				initialBuf,
				stdin.setRawMode ? (v: boolean) => stdin.setRawMode!(v) : undefined,
			);
		} catch (err) {
			setError(`editor failed: ${err instanceof Error ? err.message : String(err)}`);
			setMode({ kind: "list" });
			return;
		}
		if (edited === null) {
			setError("no $EDITOR/$VISUAL/vi available; cannot edit");
			setMode({ kind: "list" });
			return;
		}
		const parsed = parseEditBuffer(edited, includeMeta);
		if ("error" in parsed) {
			setError(`edit cancelled: ${parsed.error}`);
			setMode({ kind: "list" });
			return;
		}
		setItems((prev) => {
			const idx = prev.indexOf(item);
			if (idx < 0) return prev;
			const next = prev.slice();
			next[idx] = applyEdit(item, parsed, settings, includeMeta);
			return next;
		});
		setMode({ kind: "list" });
	};

	useInput((input, key) => {
		if (mode.kind === "submitting" || mode.kind === "editing") return;

		if (mode.kind === "view") {
			setMode({ kind: "list" });
			return;
		}

		if (mode.kind === "results") {
			setMode({ kind: "list" });
			return;
		}

		if (mode.kind === "confirmClear") {
			if (input === "y" || input === "Y") {
				setItems([]);
				setCursor(0);
			}
			setMode({ kind: "list" });
			return;
		}

		if (mode.kind === "confirmQuit") {
			if (input === "y" || input === "Y") {
				finalExit(0);
				return;
			}
			setMode({ kind: "list" });
			return;
		}

		// list mode
		if (key.ctrl && input === "c") {
			if (items.length === 0) {
				finalExit(130);
				return;
			}
			setMode({ kind: "confirmQuit" });
			return;
		}
		if (input === "q") {
			if (items.length === 0) {
				finalExit(0);
				return;
			}
			setMode({ kind: "confirmQuit" });
			return;
		}
		if (key.upArrow || input === "k") {
			setCursor((i) => (i <= 0 ? Math.max(0, items.length - 1) : i - 1));
			return;
		}
		if (key.downArrow || input === "j") {
			setCursor((i) => (i >= items.length - 1 ? 0 : i + 1));
			return;
		}
		if (key.return) {
			if (items[cursor]) setMode({ kind: "view", index: cursor });
			return;
		}
		if (input === "e") {
			void startEdit();
			return;
		}
		if (input === "d") {
			if (items.length === 0) return;
			setItems((prev) => prev.filter((_, i) => i !== cursor));
			setCursor((c) => Math.max(0, Math.min(c, items.length - 2)));
			return;
		}
		if (input === "s") {
			startSubmit();
			return;
		}
		if (input === "c") {
			if (items.length === 0) return;
			setMode({ kind: "confirmClear" });
			return;
		}
	});

	const safeCursor = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);
	const header = `pi-diff — ${items.length} comment${items.length === 1 ? "" : "s"}  ·  output: ${settings.output}`;

	if (mode.kind === "view") {
		const item = items[mode.index];
		if (!item) return <Box />;
		const includeMeta = settings.output === "beads" || settings.output === "beads-script";
		const eff = effectiveSettingsFor(settings, item.overrides);
		const title = item.overrides.title ?? buildTitle(item.comment);
		return (
			<Box flexDirection="column">
				<Text bold>View comment {mode.index + 1}/{items.length}</Text>
				<Box height={1} />
				<Text><Text dimColor>location: </Text>{locationFor(item.comment)}</Text>
				{includeMeta ? (
					<>
						<Text><Text dimColor>title: </Text>{title}</Text>
						<Text><Text dimColor>type: </Text>{eff.beadsType}</Text>
						<Text><Text dimColor>labels: </Text>{eff.beadsLabels.join(",") || "(none)"}</Text>
						<Text><Text dimColor>priority: </Text>{eff.beadsPriority === null ? "(unset)" : String(eff.beadsPriority)}</Text>
					</>
				) : null}
				<Box height={1} />
				<Text dimColor>text:</Text>
				{item.comment.text.split(/\r?\n/).map((line, idx) => (
					<Text key={idx}>{line || " "}</Text>
				))}
				{item.lastError ? (
					<>
						<Box height={1} />
						<Text color="red">last error: {item.lastError}</Text>
					</>
				) : null}
				<Box height={1} />
				<Text dimColor>(press any key to return)</Text>
			</Box>
		);
	}

	if (mode.kind === "submitting") {
		return (
			<Box flexDirection="column">
				<Text>Submitting…</Text>
			</Box>
		);
	}

	if (mode.kind === "editing") {
		return (
			<Box flexDirection="column">
				<Text>Opening editor…</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Text bold>{header}</Text>
			<Box height={1} />
			{items.length === 0 ? (
				<Text dimColor>(empty queue)</Text>
			) : (
				items.map((it, i) => {
					const active = i === safeCursor;
					const loc = locationFor(it.comment).padEnd(28).slice(0, 28);
					const summary = summarize(it.comment.text);
					return (
						<Text key={it.comment.id} color={active ? "cyan" : undefined}>
							{active ? "> " : "  "}
							{i + 1}. {loc}  {summary}
							{it.lastError ? <Text color="red"> (failed: {it.lastError})</Text> : null}
						</Text>
					);
				})
			)}
			<Box height={1} />
			{mode.kind === "results" ? (
				<>
					<Text bold>Submission results:</Text>
					{mode.created.map((r, i) => (
						<Text key={i} color={r.id ? "green" : "red"}>
							{r.id ? `  ✓ ${r.id}  ${r.title}` : `  ✗ ${r.title} — ${r.error ?? "unknown"}`}
						</Text>
					))}
					<Box height={1} />
					<Text dimColor>(press any key to return)</Text>
				</>
			) : mode.kind === "confirmClear" ? (
				<Text>Clear all {items.length} item(s)? [y/N]</Text>
			) : mode.kind === "confirmQuit" ? (
				<Text>Discard {items.length} item(s)? [y/N]</Text>
			) : (
				<>
					<Text dimColor>[↑↓] navigate  [enter] view  [e] edit  [d] delete  [s] submit all  [c] clear  [q] quit</Text>
					{error ? <Text color="red">{error}</Text> : null}
				</>
			)}
		</Box>
	);
}
