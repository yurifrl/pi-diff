#!/usr/bin/env node
// run-pi-diff driver: launches `pi-diff serve`, registers a diff against the
// running server, and asserts the PR-mode HTTP surface end-to-end. Safe to run
// inside the pi-diff repo: it never creates or mutates beads (it links an
// existing bead read-only and only exercises the invalid-status validation
// path). Run from the repo root:  node .claude/skills/run-pi-diff/driver.mjs
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPO = process.cwd();
const CLI = path.join(REPO, "dist", "cli.js");
const STATE = path.join(os.homedir(), ".pi", "agent", "pi-diff-server.json");
const LINK_BEAD = process.env.PI_DIFF_DRIVER_BEAD ?? "pi-diff-idr";

function ok(label) { console.log(`  ok  ${label}`); }
function fail(label, detail) { console.error(`FAIL  ${label}\n      ${detail}`); process.exitCode = 1; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readState() {
	try { return JSON.parse(await readFile(STATE, "utf8")); } catch { return null; }
}

async function run(args, opts = {}) {
	return await new Promise((resolve) => {
		const child = spawn("node", [CLI, ...args], { cwd: REPO, ...opts });
		let stdout = "", stderr = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

async function main() {
	console.log("pi-diff PR-mode smoke driver\n");

	// 1. Launch the persistent server.
	const serve = spawn("node", [CLI, "serve", "--no-open"], { cwd: REPO });
	serve.stdout.on("data", (c) => process.stdout.write(`  [serve] ${c}`));
	serve.stderr.on("data", (c) => process.stderr.write(`  [serve!] ${c}`));

	let state = null;
	for (let i = 0; i < 40 && !state; i++) { await sleep(150); state = await readState(); }
	if (!state) { fail("serve wrote state file", "no ~/.pi/agent/pi-diff-server.json"); serve.kill("SIGTERM"); return; }
	ok(`serve up on port ${state.port} (pid ${state.pid})`);
	const base = `http://127.0.0.1:${state.port}`;

	// 2. Register a diff as a new tab and exit immediately.
	const reg = await run(["commit", "HEAD", "--name", "driver smoke", "--bead", LINK_BEAD]);
	if (reg.code !== 0 || !/registered "driver smoke"/.test(reg.stdout)) {
		fail("register a diff", `code=${reg.code} stdout=${reg.stdout} stderr=${reg.stderr}`);
	} else ok("registered diff and exited immediately");

	// 3. List sessions.
	const sessions = await (await fetch(`${base}/api/sessions`)).json();
	if (sessions.sessions?.length === 1 && sessions.sessions[0].name === "driver smoke") {
		ok(`GET /api/sessions -> 1 tab "${sessions.sessions[0].name}" (${sessions.sessions[0].linkedBeadCount} bead)`);
	} else fail("GET /api/sessions", JSON.stringify(sessions));
	const token = sessions.sessions?.[0]?.token;

	// 4. Bootstrap carries name + linked beads.
	const boot = await (await fetch(`${base}/api/viewer/${token}`)).json();
	if (boot.name === "driver smoke" && Array.isArray(boot.linkedBeads)) {
		ok(`GET /api/viewer/:token -> name + ${boot.linkedBeads.length} linkedBeads, ${boot.files.length} files`);
	} else fail("GET /api/viewer/:token", JSON.stringify(boot).slice(0, 200));

	// 5. Bead-status endpoint: validation path (no mutation).
	const beadsRes = await fetch(`${base}/api/viewer/${token}/beads`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ changes: [{ id: LINK_BEAD, status: "bogus" }] }),
	});
	const beadsBody = await beadsRes.json();
	if (beadsRes.status === 200 && beadsBody.results?.[0]?.ok === false) {
		ok("POST /beads rejects invalid status without mutating");
	} else fail("POST /beads validation", JSON.stringify(beadsBody));

	// 6. Multi-tab shell page.
	const html = await (await fetch(`${base}/`)).text();
	if (html.includes("__PI_DIFF_SHELL__ = true")) ok("GET / serves the multi-tab shell");
	else fail("GET / shell page", html.slice(0, 120));

	// 7. Shut down; the SIGTERM handler clears the state file.
	serve.kill("SIGTERM");
	let cleared = false;
	for (let i = 0; i < 20 && !cleared; i++) { await sleep(150); cleared = !(await stat(STATE).catch(() => null)); }
	if (cleared) ok("SIGTERM stopped serve and cleared the state file");
	else fail("state file cleanup", "state file still present after SIGTERM");

	console.log(process.exitCode ? "\nDRIVER FAILED" : "\nDRIVER PASSED");
}

main().catch((err) => { console.error(err); process.exit(1); });
