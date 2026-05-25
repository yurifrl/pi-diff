import { describe, expect, test } from "vitest";
import { formatCommentAsBeadsCommand, formatCommentsAsBeadsScript } from "../core/beads";
import type { DiffComment, ResolvedDiffTarget } from "../core/types";

const target: ResolvedDiffTarget = {
	type: "baseBranch",
	branch: "main",
	label: "branch main",
	subtitle: "vs main",
	baseRev: "main",
	headRev: "HEAD",
	hasHead: true,
};

const lineComment: DiffComment = {
	kind: "line",
	id: "c1",
	text: "fix nil deref",
	createdAt: 1,
	updatedAt: 1,
	sentAt: null,
	fileId: "f1",
	path: "foo.ts",
	oldPath: null,
	newPath: "foo.ts",
	lineNumber: 42,
	side: "new",
	changeKey: "k",
	excerpt: "  return user.name",
};

const overallComment: DiffComment = {
	kind: "overall",
	id: "c2",
	text: "consider extracting helper",
	createdAt: 2,
	updatedAt: 2,
	sentAt: null,
};

describe("formatCommentAsBeadsCommand", () => {
	test("emits a bd create command with title, type, description, labels", () => {
		const out = formatCommentAsBeadsCommand(lineComment, target, {
			command: "bd",
			type: "task",
			labels: ["code-review", "frontend"],
			priority: null,
		});
		expect(out).toContain("bd create ");
		expect(out).toContain("--type task");
		expect(out).toContain("--description ");
		expect(out).toContain("--labels code-review,frontend");
		expect(out).toContain("foo.ts:42");
		expect(out).not.toContain("--priority");
	});

	test("includes priority when set", () => {
		const out = formatCommentAsBeadsCommand(overallComment, target, {
			command: "bd",
			type: "task",
			labels: [],
			priority: 2,
		});
		expect(out).toContain("--priority 2");
	});

	test("uses overall prefix in title for overall comments", () => {
		const out = formatCommentAsBeadsCommand(overallComment, target, {
			command: "bd",
			type: "task",
			labels: [],
			priority: null,
		});
		expect(out).toContain("'consider extracting helper'");
	});
});

describe("formatCommentsAsBeadsScript", () => {
	test("includes one bd create per meaningful comment", () => {
		const empty: DiffComment = { ...overallComment, id: "c3", text: "   " };
		const script = formatCommentsAsBeadsScript(target, [lineComment, overallComment, empty], {
			command: "bd",
			type: "task",
			labels: ["code-review"],
			priority: null,
		});
		const lines = script.trim().split("\n").filter((l) => l.startsWith("bd create"));
		expect(lines).toHaveLength(2);
		expect(script).toContain("# Code review feedback for branch main");
		expect(script).toContain("# 2 comment(s)");
	});

	test("returns empty when no comments have text", () => {
		const empty: DiffComment = { ...overallComment, text: "" };
		expect(formatCommentsAsBeadsScript(target, [empty], {
			command: "bd",
			type: "task",
			labels: [],
			priority: null,
		})).toBe("");
	});
});
