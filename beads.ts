import type { DiffComment, DiffLineComment, ResolvedDiffTarget } from "./types";

export type BeadsFormatOptions = {
	command: string;
	type: string;
	labels: string[];
	priority: number | null;
};

function isLineComment(comment: DiffComment): comment is DiffLineComment {
	return comment.kind === "line";
}

function shellQuote(value: string): string {
	if (value === "") return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatDisplayPath(filePath: string): string {
	return filePath.startsWith("./") ? filePath : `./${filePath}`;
}

function locationFor(comment: DiffComment): string {
	if (comment.kind === "overall") return "(overall)";
	if (comment.kind === "file") return formatDisplayPath(comment.path);
	const c = comment as DiffLineComment;
	return `${formatDisplayPath(c.path)}:${c.lineNumber} (${c.side === "old" ? "old" : "new"})`;
}

function summarize(text: string, max = 72): string {
	const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
	if (firstLine.length <= max) return firstLine;
	return `${firstLine.slice(0, max - 1).trimEnd()}…`;
}

function targetLabel(target: ResolvedDiffTarget): string {
	if (target.type === "uncommitted") return "uncommitted";
	if (target.type === "baseBranch") return `branch ${target.branch}`;
	return `commit ${target.sha.slice(0, 12)}`;
}

function buildDescription(comment: DiffComment, target: ResolvedDiffTarget): string {
	const lines: string[] = [];
	lines.push(`Source: ${targetLabel(target)}`);
	lines.push(`Location: ${locationFor(comment)}`);
	if (isLineComment(comment) && comment.excerpt) {
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

function buildTitle(comment: DiffComment): string {
	const summary = summarize(comment.text);
	if (comment.kind === "overall") {
		return summary || "Overall review note";
	}
	if (comment.kind === "file") {
		return `${comment.path}: ${summary || "review note"}`;
	}
	const c = comment as DiffLineComment;
	return `${c.path}:${c.lineNumber} ${summary || "review note"}`;
}

export function formatCommentAsBeadsCommand(
	comment: DiffComment,
	target: ResolvedDiffTarget,
	options: BeadsFormatOptions,
): string {
	const args: string[] = [options.command, "create"];
	args.push(shellQuote(buildTitle(comment)));
	args.push("--type", shellQuote(options.type));
	args.push("--description", shellQuote(buildDescription(comment, target)));
	if (options.labels.length > 0) {
		args.push("--labels", shellQuote(options.labels.join(",")));
	}
	if (options.priority !== null) {
		args.push("--priority", String(options.priority));
	}
	return args.join(" ");
}

export function formatCommentsAsBeadsScript(
	target: ResolvedDiffTarget,
	comments: DiffComment[],
	options: BeadsFormatOptions,
): string {
	const meaningful = comments.filter((c) => c.text.trim().length > 0);
	if (meaningful.length === 0) return "";
	const lines: string[] = [];
	lines.push(`# Code review feedback for ${targetLabel(target)}`);
	lines.push(`# ${meaningful.length} comment(s) — run these to create beads`);
	lines.push("");
	for (const comment of meaningful) {
		lines.push(formatCommentAsBeadsCommand(comment, target, options));
	}
	return `${lines.join("\n")}\n`;
}
