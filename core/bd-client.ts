import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Exec } from "./exec.js";
import type { DiffComment, DiffLineComment, ResolvedDiffTarget } from "./types.js";

export type BeadsCreateOptions = {
	command: string; // e.g. "bd"
	type: string;    // e.g. "task"
	labels: string[];
	priority: number | null;
	cwd: string;
};

export type CreatedBead = {
	commentId: string;
	id: string | null;
	title: string;
	error?: string;
};

function formatDisplayPath(filePath: string): string {
	return filePath.startsWith("./") ? filePath : `./${filePath}`;
}

function locationFor(comment: DiffComment): string {
	if (comment.kind === "overall") return "(overall)";
	if (comment.kind === "file") return formatDisplayPath(comment.path);
	const c = comment as DiffLineComment;
	return `${formatDisplayPath(c.path)}:${c.lineNumber} (${c.side === "old" ? "old" : "new"})`;
}

function targetLabel(target: ResolvedDiffTarget): string {
	if (target.type === "uncommitted") return "uncommitted";
	if (target.type === "baseBranch") return `branch ${target.branch}`;
	return `commit ${target.sha.slice(0, 12)}`;
}

function summarize(text: string, max = 72): string {
	const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
	if (firstLine.length <= max) return firstLine;
	return `${firstLine.slice(0, max - 1).trimEnd()}…`;
}

export function buildTitle(comment: DiffComment): string {
	const summary = summarize(comment.text);
	if (comment.kind === "overall") return summary || "Overall review note";
	if (comment.kind === "file") return `${comment.path}: ${summary || "review note"}`;
	const c = comment as DiffLineComment;
	return `${c.path}:${c.lineNumber} ${summary || "review note"}`;
}

export function buildDescription(comment: DiffComment, target: ResolvedDiffTarget): string {
	const lines: string[] = [];
	lines.push(`Source: ${targetLabel(target)}`);
	lines.push(`Location: ${locationFor(comment)}`);
	if (comment.kind === "line" && comment.excerpt) {
		lines.push("");
		lines.push("Excerpt:");
		for (const excerptLine of comment.excerpt.split(/\r?\n/)) {
			lines.push(`  ${excerptLine}`);
		}
	}
	lines.push("");
	lines.push(comment.text.trim());
	return lines.join("\n");
}

function buildArgs(comment: DiffComment, options: BeadsCreateOptions, titleOverrides?: Map<string, string>): string[] {
	const overriddenTitle = titleOverrides?.get(comment.id);
	const args = [
		"create",
		overriddenTitle && overriddenTitle.trim().length > 0 ? overriddenTitle : buildTitle(comment),
		"--type", options.type,
		"--stdin",
		"--silent",
	];
	if (options.labels.length > 0) args.push("--labels", options.labels.join(","));
	if (options.priority !== null) args.push("--priority", String(options.priority));
	return args;
}

/** Back-compat alias for tests. */
export type ExecLike = Exec;

/**
 * Check whether beads is initialized in the given repo. Beads stores its
 * Dolt database under `.beads/`, so a directory check is sufficient and
 * cheap (no subprocess).
 */
export function isBeadsRepoConfigured(cwd: string): boolean {
	try {
		const beadsDir = path.join(cwd, ".beads");
		return existsSync(beadsDir) && statSync(beadsDir).isDirectory();
	} catch {
		return false;
	}
}

export async function isBeadsAvailable(exec: Exec, command: string, cwd: string): Promise<boolean> {
	try {
		const result = await exec(command, ["--version"], { cwd, timeout: 3000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

export async function createBead(
	exec: Exec,
	comment: DiffComment,
	target: ResolvedDiffTarget,
	options: BeadsCreateOptions,
	titleOverrides?: Map<string, string>,
): Promise<CreatedBead> {
	const overriddenTitle = titleOverrides?.get(comment.id);
	const title = overriddenTitle && overriddenTitle.trim().length > 0 ? overriddenTitle : buildTitle(comment);
	const args = buildArgs(comment, options, titleOverrides);
	const description = buildDescription(comment, target);
	try {
		const result = await exec(options.command, args, { cwd: options.cwd, input: description, timeout: 10000 });
		if (result.code !== 0) {
			return { commentId: comment.id, id: null, title, error: result.stderr.trim() || `exit ${result.code}` };
		}
		const id = result.stdout.trim().split(/\s+/).pop() ?? null;
		return { commentId: comment.id, id, title };
	} catch (error) {
		return { commentId: comment.id, id: null, title, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function createBeadsForComments(
	exec: Exec,
	comments: DiffComment[],
	target: ResolvedDiffTarget,
	options: BeadsCreateOptions,
	titleOverrides?: Map<string, string>,
): Promise<CreatedBead[]> {
	const meaningful = comments.filter((c) => c.text.trim().length > 0);
	const out: CreatedBead[] = [];
	for (const comment of meaningful) {
		out.push(await createBead(exec, comment, target, options, titleOverrides));
	}
	return out;
}

export function summarizeCreated(results: CreatedBead[]): string {
	const lines: string[] = [];
	const ok = results.filter((r) => r.id);
	const failed = results.filter((r) => !r.id);
	if (ok.length > 0) {
		lines.push(`Created ${ok.length} bead(s):`);
		for (const r of ok) lines.push(`  ${r.id}  ${r.title}`);
	}
	if (failed.length > 0) {
		lines.push(`Failed to create ${failed.length} bead(s):`);
		for (const r of failed) lines.push(`  ! ${r.title} — ${r.error ?? "unknown error"}`);
	}
	return lines.join("\n");
}
