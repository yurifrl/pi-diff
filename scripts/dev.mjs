#!/usr/bin/env node
// Dev loop for pi-diff:
//   1. tailwind: compile web/styles.src.css -> web/styles.generated.css once at startup,
//      then re-run on changes to that file via fs.watch (chokidar-free). NOTE: tailwind
//      JIT also keys off utility usage in web/**/*.tsx; those changes are picked up by
//      esbuild rebuilds importing the generated CSS, but a *new* utility class only
//      appears in styles.generated.css after the next tailwind run. Editing
//      web/styles.src.css triggers a fresh tailwind build (which re-scans sources),
//      so simply touch that file or restart `npm run dev` after introducing a brand
//      new utility class. This is an intentional simplification.
//   2. esbuild rebuilds web/dist/app.{js,css} on every file change in web/.
//   3. `bun cli.ts diff` runs the viewer; it serves the latest bundle from disk,
//      so a browser refresh is enough to see web changes.
//
// Stops both on Ctrl+C.

import { context } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const stylesSrc = path.join(packageDir, "web/styles.src.css");

function runTailwind({ watch = false } = {}) {
	const args = [
		"--no-install",
		"@tailwindcss/cli",
		"-i",
		"web/styles.src.css",
		"-o",
		"web/styles.generated.css",
	];
	if (!watch) {
		const r = spawnSync("npx", args, { cwd: packageDir, stdio: "inherit" });
		if (r.status !== 0) {
			console.error("[dev] tailwind compile failed");
			process.exit(r.status ?? 1);
		}
	}
}

runTailwind();

let twTimer = null;
fs.watch(stylesSrc, () => {
	clearTimeout(twTimer);
	twTimer = setTimeout(() => {
		console.log("[dev] styles.src.css changed — re-running tailwind");
		runTailwind();
	}, 50);
});

const ctx = await context({
	absWorkingDir: packageDir,
	entryPoints: [path.join(packageDir, "web/index.tsx")],
	bundle: true,
	format: "esm",
	platform: "browser",
	jsx: "automatic",
	entryNames: "app",
	outdir: path.join(packageDir, "web/dist"),
	loader: { ".css": "css" },
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
	},
	logLevel: "info",
	sourcemap: "inline",
});

await ctx.watch();
console.log("[dev] esbuild watching web/");

// Forward CLI args after `--` to pi-diff. Default target is `uncommitted`.
// Examples:
//   bun dev                       -> bun cli.ts uncommitted
//   bun dev -- branch main        -> bun cli.ts branch main
//   bun dev -- commit abc123      -> bun cli.ts commit abc123
const sepIdx = process.argv.indexOf("--");
const passthrough = sepIdx >= 0 ? process.argv.slice(sepIdx + 1) : [];

const cli = spawn(
	"bun",
	["cli.ts", ...(passthrough.length ? passthrough : ["uncommitted"])],
	{ cwd: packageDir, stdio: "inherit", env: { ...process.env, PI_DIFF_DEV: "1" } },
);

const shutdown = async (code = 0) => {
	try { await ctx.dispose(); } catch {}
	if (!cli.killed) cli.kill("SIGINT");
	process.exit(code);
};

cli.on("exit", (code) => { void shutdown(code ?? 0); });
process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });
