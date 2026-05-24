import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiffComment, DiffLineComment, ResolvedDiffTarget } from "./types";

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

function buildArgs(comment: DiffComment, options: BeadsCreateOptions): string[] {
	const args = [
		"create",
		buildTitle(comment),
		"--type", options.type,
		"--stdin",
		"--silent",
	];
	if (options.labels.length > 0) args.push("--labels", options.labels.join(","));
	if (options.priority !== null) args.push("--priority", String(options.priority));
	return args;
}

export type ExecLike = (
	cmd: string,
	args: string[],
	opts: { cwd: string; timeout?: number; input?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Adapter so we can pass either pi.exec (no input support) or a custom exec for tests. */
function makeExec(pi: ExtensionAPI): ExecLike {
	return async (cmd, args, opts) => {
		// pi.exec does not accept stdin; we shell out via `bash -c` and pipe.
		// To stay resilient, we encode the description with base64 and decode on the fly.
		if (opts.input !== undefined) {
			const encoded = Buffer.from(opts.input, "utf8").toString("base64");
			const argString = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
			const script = `printf %s "${encoded}" | base64 -d | ${cmd} ${argString}`;
			return await pi.exec("bash", ["-lc", script], { cwd: opts.cwd, timeout: opts.timeout ?? 10000 });
		}
		return await pi.exec(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 10000 });
	};
}

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

export async function isBeadsAvailable(pi: ExtensionAPI, command: string, cwd: string): Promise<boolean> {
	try {
		const result = await pi.exec(command, ["--version"], { cwd, timeout: 3000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

export async function createBead(
	exec: ExecLike,
	comment: DiffComment,
	target: ResolvedDiffTarget,
	options: BeadsCreateOptions,
): Promise<CreatedBead> {
	const title = buildTitle(comment);
	const args = buildArgs(comment, options);
	const description = buildDescription(comment, target);
	try {
		const result = await exec(options.command, args, { cwd: options.cwd, input: description });
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
	pi: ExtensionAPI,
	comments: DiffComment[],
	target: ResolvedDiffTarget,
	options: BeadsCreateOptions,
	execOverride?: ExecLike,
): Promise<CreatedBead[]> {
	const exec = execOverride ?? makeExec(pi);
	const meaningful = comments.filter((c) => c.text.trim().length > 0);
	const out: CreatedBead[] = [];
	for (const comment of meaningful) {
		out.push(await createBead(exec, comment, target, options));
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
