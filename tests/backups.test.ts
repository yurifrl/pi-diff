import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type BackupFile,
	appendAttempt,
	formatBackupSummary,
	listBackupFiles,
	readBackup,
	resolveBackupPath,
	summarizeBeadsResult,
	updateLastResult,
} from "../backups";
import type { CreatedBead } from "../bd-client";
import type { DiffComment, ResolvedDiffTarget } from "../types";

let dir: string;
let originalHome: string | undefined;

const target: ResolvedDiffTarget = {
	type: "uncommitted",
	label: "uncommitted",
	subtitle: "",
	baseRev: null,
	headRev: null,
	hasHead: false,
};

const comment: DiffComment = {
	id: "c1",
	kind: "overall",
	text: "first comment, full text not truncated",
	createdAt: 1,
	updatedAt: 1,
	sentAt: null,
};

function makeCtx(sessionFile: string | undefined) {
	return {
		cwd: "/repo",
		hasUI: false,
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub for tests
		ui: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub for tests
		sessionManager: {
			getSessionFile: () => sessionFile,
		} as any,
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub for tests
	} as any;
}

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-diff-backups-"));
	originalHome = process.env.HOME;
	process.env.HOME = path.join(dir, "home");
	await mkdir(process.env.HOME, { recursive: true });
});

afterEach(async () => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await rm(dir, { recursive: true, force: true });
});

describe("resolveBackupPath", () => {
	test("derives sibling .pi-diff.json from session file", () => {
		const sf = "/Users/x/.pi/agent/sessions/--repo--/2026-01-01_abc.jsonl";
		const ctx = makeCtx(sf);
		expect(resolveBackupPath(ctx)).toBe("/Users/x/.pi/agent/sessions/--repo--/2026-01-01_abc.pi-diff.json");
	});

	test("falls back to _ephemeral when no session file", () => {
		const ctx = makeCtx(undefined);
		const p = resolveBackupPath(ctx);
		expect(p.startsWith(path.join(process.env.HOME!, ".pi", "agent", "sessions", "_ephemeral"))).toBe(true);
		expect(p.endsWith(".pi-diff.json")).toBe(true);
	});
});

describe("appendAttempt + updateLastResult", () => {
	test("creates file, appends attempts, updates result", async () => {
		const sf = path.join(process.env.HOME!, ".pi/agent/sessions/--repo--/sess.jsonl");
		const ctx = makeCtx(sf);

		const p1 = await appendAttempt(ctx, { output: "beads", target, cwd: "/repo", comments: [comment] });
		expect(p1.endsWith("sess.pi-diff.json")).toBe(true);

		const after1 = (await readBackup(p1)) as BackupFile;
		expect(after1.attempts).toHaveLength(1);
		expect(after1.attempts[0].comments[0].text).toBe(comment.text);
		expect(after1.attempts[0].result).toBeNull();
		expect(after1.session.file).toBe(sf);

		await updateLastResult(p1, { ok: false, failures: [{ commentId: "c1", title: "t", error: "boom" }] });
		const after2 = (await readBackup(p1)) as BackupFile;
		expect(after2.attempts[0].result?.ok).toBe(false);
		expect(after2.attempts[0].result?.failures?.[0].error).toBe("boom");

		// Second attempt appends, doesn't clobber
		await appendAttempt(ctx, { output: "prompt", target, cwd: "/repo", comments: [] });
		const after3 = (await readBackup(p1)) as BackupFile;
		expect(after3.attempts).toHaveLength(2);
		expect(after3.attempts[0].result?.ok).toBe(false); // first attempt's result still there
		expect(after3.attempts[1].result).toBeNull();
	});
});

describe("summarizeBeadsResult", () => {
	test("splits beads into createdBeads + failures", () => {
		const beads: CreatedBead[] = [
			{ commentId: "c1", id: "bd-1", title: "t1" },
			{ commentId: "c2", id: null, title: "t2", error: "no beads database found" },
		];
		const r = summarizeBeadsResult(beads);
		expect(r.ok).toBe(false);
		expect(r.createdBeads).toEqual([{ id: "bd-1", title: "t1" }]);
		expect(r.failures).toEqual([{ commentId: "c2", title: "t2", error: "no beads database found" }]);
	});

	test("ok=true when all created", () => {
		const beads: CreatedBead[] = [{ commentId: "c1", id: "bd-1", title: "t1" }];
		expect(summarizeBeadsResult(beads).ok).toBe(true);
	});
});

describe("listBackupFiles + formatBackupSummary", () => {
	test("walks ~/.pi/agent/sessions and returns .pi-diff.json files", async () => {
		const root = path.join(process.env.HOME!, ".pi/agent/sessions");
		const slug = path.join(root, "--repo--");
		await mkdir(slug, { recursive: true });

		const f1 = path.join(slug, "a.pi-diff.json");
		const f2 = path.join(slug, "b.pi-diff.json");
		const noise = path.join(slug, "a.jsonl");

		const file: BackupFile = {
			session: { file: null, id: null },
			attempts: [
				{
					savedAt: "2026-05-23T14:32:11.000Z",
					output: "beads",
					target,
					cwd: "/repo",
					comments: [comment],
					result: { ok: false, failures: [{ commentId: "c1", title: "t", error: "no beads database found" }] },
				},
			],
		};

		await writeFile(f1, JSON.stringify(file), "utf8");
		await writeFile(f2, JSON.stringify({ ...file, attempts: [] }), "utf8");
		await writeFile(noise, "{}", "utf8");

		const list = await listBackupFiles();
		const paths = list.map((e) => e.path).sort();
		expect(paths).toEqual([f1, f2].sort());

		const summary = formatBackupSummary(f1, file);
		expect(summary).toContain("attempts=1");
		expect(summary).toContain("failed=1");
		expect(summary).toContain("pending=0");
	});

	test("returns empty when sessions dir absent", async () => {
		const list = await listBackupFiles();
		expect(list).toEqual([]);
	});
});

describe("readBackup", () => {
	test("returns null on missing file", async () => {
		const r = await readBackup(path.join(dir, "nope.pi-diff.json"));
		expect(r).toBeNull();
	});

	test("returns null on corrupt file (does not throw)", async () => {
		const p = path.join(dir, "bad.pi-diff.json");
		await writeFile(p, "{ not json", "utf8");
		const r = await readBackup(p);
		expect(r).toBeNull();
	});
});

describe("integration: full text survives even when bd fails", () => {
	test("backup contains untruncated comment text after failed beads send", async () => {
		const sf = path.join(process.env.HOME!, ".pi/agent/sessions/--repo--/sess.jsonl");
		const ctx = makeCtx(sf);
		const longText = "lets make it work like this https://github.com/juicesharp/rpiv-mono, " +
			"my full untruncated comment that bd would have cut at 72 chars";
		const c: DiffComment = { ...comment, text: longText };

		const p = await appendAttempt(ctx, { output: "beads", target, cwd: "/repo", comments: [c] });
		await updateLastResult(p, summarizeBeadsResult([
			{ commentId: c.id, id: null, title: longText.slice(0, 72), error: "no beads database found" },
		]));

		const after = (await readBackup(p)) as BackupFile;
		expect(after.attempts[0].comments[0].text).toBe(longText); // FULL text survived
		expect(after.attempts[0].result?.ok).toBe(false);
	});
});
