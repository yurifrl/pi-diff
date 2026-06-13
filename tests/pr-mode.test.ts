import { afterEach, describe, expect, test, vi } from "vitest";
import { applyBeadStatuses, isBeadStatus, loadBeads, updateBeadStatus } from "../core/bd-client";
import { createDiffServer, type DiffServer } from "../core/server";
import type { Exec } from "../core/exec";

describe("isBeadStatus", () => {
	test("accepts built-in statuses", () => {
		for (const s of ["open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"]) {
			expect(isBeadStatus(s)).toBe(true);
		}
	});
	test("rejects unknown values", () => {
		expect(isBeadStatus("bogus")).toBe(false);
		expect(isBeadStatus(42)).toBe(false);
		expect(isBeadStatus(undefined)).toBe(false);
	});
});

describe("loadBeads", () => {
	test("parses bd show --json into linked beads", async () => {
		const exec: Exec = vi.fn(async () => ({
			stdout: JSON.stringify([
				{ id: "bd-1", title: "First", status: "open", extra: 1 },
				{ id: "bd-2", title: "Second", status: "closed" },
			]),
			stderr: "",
			code: 0,
		}));
		const beads = await loadBeads(exec, ["bd-1", "bd-2", "bd-1"], "bd", "/repo");
		expect(beads).toEqual([
			{ id: "bd-1", title: "First", status: "open" },
			{ id: "bd-2", title: "Second", status: "closed" },
		]);
		// de-duplicates ids before calling bd
		expect((exec as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual(["show", "bd-1", "bd-2", "--json"]);
	});

	test("returns [] for empty id list without calling exec", async () => {
		const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
		expect(await loadBeads(exec, [], "bd", "/repo")).toEqual([]);
		expect(exec).not.toHaveBeenCalled();
	});

	test("returns [] on invalid JSON", async () => {
		const exec: Exec = vi.fn(async () => ({ stdout: "not json", stderr: "", code: 0 }));
		expect(await loadBeads(exec, ["bd-1"], "bd", "/repo")).toEqual([]);
	});
});

describe("updateBeadStatus / applyBeadStatuses", () => {
	test("passes id and status to bd update", async () => {
		const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
		const result = await updateBeadStatus(exec, "bd-1", "closed", "bd", "/repo");
		expect(result).toEqual({ id: "bd-1", status: "closed", ok: true });
		expect((exec as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual(["update", "bd-1", "--status", "closed"]);
	});

	test("reports failure with stderr", async () => {
		const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "no such issue", code: 1 }));
		const result = await updateBeadStatus(exec, "bd-x", "open", "bd", "/repo");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("no such issue");
	});

	test("applies many sequentially", async () => {
		const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
		const results = await applyBeadStatuses(
			exec,
			[{ id: "bd-1", status: "closed" }, { id: "bd-2", status: "open" }],
			"bd",
			"/repo",
		);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
		expect(exec).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Server: register / sessions / beads endpoints.
// ---------------------------------------------------------------------------

const servers: DiffServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const registerPayload = {
	name: "My PR",
	cwd: "/repo",
	repo: { root: "/repo", name: "repo", cwd: "/repo" },
	target: {
		type: "uncommitted" as const,
		label: "Uncommitted changes",
		subtitle: "Working tree vs HEAD",
		baseRev: "HEAD",
		headRev: "HEAD",
		hasHead: true,
	},
	files: [
		{ id: "f1", path: "a.ts", oldPath: null, newPath: "a.ts", status: "modified" as const, anchorId: "a", isBinary: false },
	],
	filePayloads: { f1: { file: { id: "f1", path: "a.ts", oldPath: null, newPath: "a.ts", status: "modified" as const, anchorId: "a", isBinary: false }, diffText: "diff" } },
	beadIds: ["bd-1"],
};

function baseUrlOf(url: string): string {
	return url.replace(/\/viewer\/.+$/, "");
}

describe("DiffServer register/sessions/beads", () => {
	test("register builds a session and lists it", async () => {
		const applied: Array<{ id: string; status: string }> = [];
		const server = createDiffServer({
			onRegister: async (payload) => ({
				bootstrap: {
					name: payload.name ?? payload.target.label,
					repo: payload.repo,
					target: payload.target,
					files: payload.files,
					defaultViewMode: "unified",
					defaultLayoutMode: "stream",
					beadsEnabled: true,
					beadsConfigured: true,
					linkedBeads: [{ id: "bd-1", title: "First", status: "open" }],
					buildVersion: "test",
					buildKind: "dev",
				},
				loadFile: async (id) => (payload.filePayloads as Record<string, never>)[id] ?? null,
				sendComments: async () => ({ sentAt: 1, formattedText: "ok" }),
				applyBeadStatuses: async (changes) => {
					for (const c of changes) applied.push(c);
					return { results: changes.map((c) => ({ ...c, ok: true })), formattedText: "done" };
				},
			}),
		});
		servers.push(server);
		await server.start();
		const port = server.getPort();

		const regRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(registerPayload),
		});
		expect(regRes.status).toBe(200);
		const { token, url } = (await regRes.json()) as { token: string; url: string };
		expect(token).toBeTruthy();

		const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
		const { sessions } = (await listRes.json()) as { sessions: Array<{ token: string; name: string; linkedBeadCount: number }> };
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ token, name: "My PR", linkedBeadCount: 1 });

		const bootstrapRes = await fetch(`${baseUrlOf(url)}/api/viewer/${token}`);
		expect((await bootstrapRes.json()).linkedBeads).toEqual([{ id: "bd-1", title: "First", status: "open" }]);

		const beadsRes = await fetch(`${baseUrlOf(url)}/api/viewer/${token}/beads`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ changes: [{ id: "bd-1", status: "closed" }] }),
		});
		expect(beadsRes.status).toBe(200);
		expect(applied).toEqual([{ id: "bd-1", status: "closed" }]);
	});

	test("register is rejected when no onRegister handler is configured", async () => {
		const server = createDiffServer();
		servers.push(server);
		await server.start();
		const port = server.getPort();
		const res = await fetch(`http://127.0.0.1:${port}/api/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(registerPayload),
		});
		expect(res.status).toBe(400);
	});

	test("serves the multi-tab shell page at /", async () => {
		const server = createDiffServer();
		servers.push(server);
		await server.start();
		const html = await (await fetch(`http://127.0.0.1:${server.getPort()}/`)).text();
		expect(html).toContain("__PI_DIFF_SHELL__ = true");
	});
});
