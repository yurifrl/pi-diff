import { appendAttempt, summarizeBeadsResult, updateLastResult, type BackupAttemptResult } from "./backups.js";
import { createBeadsForComments, isBeadsAvailable, isBeadsRepoConfigured, summarizeCreated } from "./bd-client.js";
import { formatCommentsAsBeadsScript } from "./beads.js";
import { appendTextToEditor, formatCommentsForEditor, hasMeaningfulText } from "./comments.js";
import type { Exec } from "./exec.js";
import type { DiffSettings } from "./settings.js";
import type { DiffComment, ResolvedDiffTarget, SendCommentsResponse } from "./types.js";

export type NotifyFn = (message: string, level?: "info" | "error" | "success") => void;

/**
 * Adapter for a host text editor (e.g. the pi prompt editor). When omitted
 * (CLI flow), no text is written to any editor — the caller is expected to
 * surface the returned `formattedText` itself.
 */
export type EditorAdapter = {
	getText: () => string;
	setText: (value: string) => Promise<void> | void;
};

export type SendDeps = {
	exec: Exec;
	cwd: string;
	sessionFile: string | null;
	settings: DiffSettings;
	target: ResolvedDiffTarget;
	notify?: NotifyFn;
	/**
	 * When provided, output text is appended to a host editor (pi extension).
	 * CLI omits this and prints to stdout itself based on `formattedText`.
	 * Spec called this `appendToEditor`; we expose read+set since merge
	 * semantics differ per output mode.
	 */
	editor?: EditorAdapter;
	/** Optional per-comment title overrides for beads creation, keyed by comment.id. */
	titleOverrides?: Map<string, string>;
};

export function isBeadsOutputMode(output: DiffSettings["output"]): boolean {
	return output === "beads" || output === "beads-script";
}

export async function handleSendComments(
	deps: SendDeps,
	comments: DiffComment[],
): Promise<SendCommentsResponse> {
	const { exec, cwd, sessionFile, settings, target, notify } = deps;

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
		backupPath = await appendAttempt(sessionFile, {
			output: settings.output,
			target,
			cwd,
			comments,
		});
	} catch (err) {
		console.warn("[pi-diff] failed to write backup file:", err);
	}

	const finalize = async (result: BackupAttemptResult) => {
		if (!backupPath) return;
		try {
			await updateLastResult(backupPath, result);
		} catch (err) {
			console.warn("[pi-diff] failed to update backup result:", err);
		}
	};

	if (isBeadsOutputMode(settings.output) && !isBeadsRepoConfigured(cwd)) {
		const message = `Beads is enabled but \`.beads/\` is not initialized in this repo. Run \`${settings.beadsCommand} init\` or disable beads in the diff viewer.`;
		notify?.(message, "error");
		await finalize({ ok: false, note: message });
		throw new Error(message);
	}

	if (settings.output === "beads") {
		const available = await isBeadsAvailable(exec, settings.beadsCommand, cwd);
		if (!available) {
			notify?.(
				`\`${settings.beadsCommand}\` not found. Install beads or set output: "beads-script" in settings.`,
				"error",
			);
			const script = formatCommentsAsBeadsScript(target, comments, beadsOpts);
			await finalize({ ok: false, note: "beads command not found; emitted script" });
			return { sentAt: Date.now(), formattedText: script };
		}
		const results = await createBeadsForComments(exec, comments, target, { ...beadsOpts, cwd }, deps.titleOverrides);
		const summary = summarizeCreated(results);
		if (deps.editor) {
			const current = deps.editor.getText();
			const next = appendTextToEditor(current, `${summary}\n`);
			await deps.editor.setText(next);
		}
		await finalize(summarizeBeadsResult(results));
		return { sentAt: Date.now(), formattedText: summary };
	}

	if (settings.output === "beads-script") {
		const script = formatCommentsAsBeadsScript(target, comments, beadsOpts);
		const block = `\n${script}`;
		if (deps.editor) {
			const current = deps.editor.getText();
			const next = appendTextToEditor(current, block);
			await deps.editor.setText(next);
		}
		await finalize({ ok: true, note: "beads-script appended to editor" });
		return { sentAt: Date.now(), formattedText: script };
	}

	const formatted = formatCommentsForEditor(target, comments);
	const formattedForEditor = `${formatted}\n`;
	if (deps.editor) {
		const current = deps.editor.getText();
		const block = hasMeaningfulText(current)
			? `\n\n${formattedForEditor.replace(/^(?:\r?\n)+/u, "")}`
			: formattedForEditor;
		const next = hasMeaningfulText(current)
			? `${current.replace(/(?:\r?\n)+$/u, "")}${block}`
			: formattedForEditor;
		await deps.editor.setText(next);
	}
	await finalize({ ok: true, note: "prompt text appended to editor" });
	return { sentAt: Date.now(), formattedText: formattedForEditor };
}
