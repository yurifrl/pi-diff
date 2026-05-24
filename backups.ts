import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CreatedBead } from "./bd-client";
import type { DiffComment, ResolvedDiffTarget } from "./types";

/**
 * Backup of every send attempt, written next to the pi session log.
 *
 * Layout: ~/.pi/agent/sessions/<slug>/<base>.pi-diff.json
 *   where <base> is the session log file name without ".jsonl".
 *
 * If no session file is available (ephemeral sessions, tests), we fall back
 * to ~/.pi/agent/sessions/_ephemeral/<ISO>_<rand>.pi-diff.json.
 */

export type BackupAttemptResult = {
	ok: boolean;
	createdBeads?: { id: string; title: string }[];
	failures?: { commentId: string; title: string; error: string }[];
	/** Free-form note for non-beads outputs (e.g. "appended to editor"). */
	note?: string;
};

export type BackupAttempt = {
	savedAt: string;
	output: string;
	target: ResolvedDiffTarget;
	cwd: string;
	comments: DiffComment[];
	result: BackupAttemptResult | null;
};

export type BackupFile = {
	session: { file: string | null; id: string | null };
	attempts: BackupAttempt[];
};

/** Returns the absolute path of the backup file for the current session. */
export function resolveBackupPath(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionFile && sessionFile.endsWith(".jsonl")) {
		return sessionFile.replace(/\.jsonl$/, ".pi-diff.json");
	}
	const ephemeralDir = path.join(homedir(), ".pi", "agent", "sessions", "_ephemeral");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rand = Math.random().toString(36).slice(2, 10);
	return path.join(ephemeralDir, `${stamp}_${rand}.pi-diff.json`);
}

/** Extract the uuid suffix from a session file base name, if present. */
function extractSessionId(sessionFile: string | undefined): string | null {
	if (!sessionFile) return null;
	const base = path.basename(sessionFile, ".jsonl");
	const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
	return m ? m[1] : null;
}

async function readBackupRaw(filePath: string): Promise<BackupFile | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as BackupFile;
		if (!Array.isArray(parsed.attempts)) return null;
		return parsed;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		// Corrupted/unreadable: do NOT clobber. Caller starts fresh.
		return null;
	}
}

/** Atomic write: tmp + rename. */
async function writeBackupRaw(filePath: string, data: BackupFile): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await rename(tmp, filePath);
}

/**
 * Append a new attempt with `result: null`. Returns the path written so the
 * caller can later update the same attempt with a result.
 */
export async function appendAttempt(
	ctx: ExtensionContext,
	attempt: Omit<BackupAttempt, "savedAt" | "result"> & Partial<Pick<BackupAttempt, "savedAt" | "result">>,
): Promise<string> {
	const filePath = resolveBackupPath(ctx);
	const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
	const existing = await readBackupRaw(filePath);
	const next: BackupFile = existing ?? {
		session: { file: sessionFile, id: extractSessionId(sessionFile ?? undefined) },
		attempts: [],
	};
	next.attempts.push({
		savedAt: attempt.savedAt ?? new Date().toISOString(),
		output: attempt.output,
		target: attempt.target,
		cwd: attempt.cwd,
		comments: attempt.comments,
		result: attempt.result ?? null,
	});
	await writeBackupRaw(filePath, next);
	return filePath;
}

/** Update the most-recently-appended attempt's result. */
export async function updateLastResult(filePath: string, result: BackupAttemptResult): Promise<void> {
	const existing = await readBackupRaw(filePath);
	if (!existing || existing.attempts.length === 0) return;
	existing.attempts[existing.attempts.length - 1].result = result;
	await writeBackupRaw(filePath, existing);
}

/** Convert beads results into a BackupAttemptResult. */
export function summarizeBeadsResult(results: CreatedBead[]): BackupAttemptResult {
	const createdBeads = results.filter((r) => r.id).map((r) => ({ id: r.id as string, title: r.title }));
	const failures = results
		.filter((r) => !r.id)
		.map((r) => ({ commentId: r.commentId, title: r.title, error: r.error ?? "unknown error" }));
	return {
		ok: failures.length === 0,
		createdBeads,
		failures,
	};
}

/**
 * Walk ~/.pi/agent/sessions/** for all *.pi-diff.json files. Returns sorted
 * newest-first by mtime.
 */
export async function listBackupFiles(): Promise<{ path: string; mtimeMs: number }[]> {
	const root = path.join(homedir(), ".pi", "agent", "sessions");
	const out: { path: string; mtimeMs: number }[] = [];
	async function walk(dir: string) {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".pi-diff.json")) {
				try {
					const s = await stat(full);
					out.push({ path: full, mtimeMs: s.mtimeMs });
				} catch {
					/* ignore */
				}
			}
		}
	}
	await walk(root);
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

/** Render a BackupFile as a one-line summary for `list-backups`. */
export function formatBackupSummary(filePath: string, file: BackupFile): string {
	const total = file.attempts.length;
	const failed = file.attempts.filter((a) => a.result && !a.result.ok).length;
	const pending = file.attempts.filter((a) => a.result === null).length;
	const lastAt = total > 0 ? file.attempts[total - 1].savedAt : "—";
	return `${filePath}  attempts=${total} failed=${failed} pending=${pending} last=${lastAt}`;
}

export async function readBackup(filePath: string): Promise<BackupFile | null> {
	return readBackupRaw(filePath);
}
