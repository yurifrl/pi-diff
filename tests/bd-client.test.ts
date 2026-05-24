import { describe, expect, test, vi } from "vitest";
import { buildDescription, buildTitle, createBead, createBeadsForComments, summarizeCreated, type ExecLike } from "../bd-client";
import type { DiffComment, ResolvedDiffTarget } from "../types";

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

describe("buildTitle / buildDescription", () => {
	test("title includes path and line", () => {
		expect(buildTitle(lineComment)).toBe("foo.ts:42 fix nil deref");
	});
	test("description has Source, Location, Excerpt, body", () => {
		const d = buildDescription(lineComment, target);
		expect(d).toContain("Source: branch main");
		expect(d).toContain("Location: ./foo.ts:42 (new)");
		expect(d).toContain("Excerpt:");
		expect(d).toContain("  return user.name");
		expect(d).toContain("fix nil deref");
	});
});

describe("createBead", () => {
	test("calls exec with structured args + stdin description, returns id", async () => {
		const calls: Array<{ cmd: string; args: string[]; opts: { cwd: string; input?: string } }> = [];
		const exec: ExecLike = vi.fn(async (cmd, args, opts) => {
			calls.push({ cmd, args, opts });
			return { stdout: "bd-12345\n", stderr: "", code: 0 };
		});
		const result = await createBead(exec, lineComment, target, {
			command: "bd",
			type: "task",
			labels: ["code-review"],
			priority: 2,
			cwd: "/tmp/repo",
		});
		expect(result.id).toBe("bd-12345");
		expect(result.title).toBe("foo.ts:42 fix nil deref");
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.cmd).toBe("bd");
		expect(call.args).toContain("create");
		expect(call.args).toContain("--type");
		expect(call.args).toContain("task");
		expect(call.args).toContain("--stdin");
		expect(call.args).toContain("--silent");
		expect(call.args).toContain("--labels");
		expect(call.args).toContain("code-review");
		expect(call.args).toContain("--priority");
		expect(call.args).toContain("2");
		expect(call.opts.input).toContain("Source: branch main");
		expect(call.opts.input).toContain("fix nil deref");
	});

	test("returns error on non-zero exit", async () => {
		const exec: ExecLike = async () => ({ stdout: "", stderr: "no db", code: 1 });
		const r = await createBead(exec, lineComment, target, {
			command: "bd",
			type: "task",
			labels: [],
			priority: null,
			cwd: "/tmp/repo",
		});
		expect(r.id).toBeNull();
		expect(r.error).toBe("no db");
	});
});

describe("createBeadsForComments", () => {
	test("filters empty comments and creates the rest", async () => {
		const empty: DiffComment = { ...lineComment, id: "c2", text: "   " };
		let counter = 0;
		const exec: ExecLike = async () => ({ stdout: `bd-${++counter}`, stderr: "", code: 0 });
		const results = await createBeadsForComments(
			null as never,
			[lineComment, empty, { ...lineComment, id: "c3", text: "another" }],
			target,
			{ command: "bd", type: "task", labels: [], priority: null, cwd: "/tmp/repo" },
			exec,
		);
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.id)).toEqual(["bd-1", "bd-2"]);
	});
});

describe("summarizeCreated", () => {
	test("groups created and failed", () => {
		const text = summarizeCreated([
			{ commentId: "a", id: "bd-1", title: "t1" },
			{ commentId: "b", id: null, title: "t2", error: "boom" },
		]);
		expect(text).toContain("Created 1 bead(s):");
		expect(text).toContain("bd-1");
		expect(text).toContain("Failed to create 1 bead(s):");
		expect(text).toContain("boom");
	});
});
