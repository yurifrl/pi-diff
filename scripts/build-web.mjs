import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");

// Step 1: compile Tailwind v4 source -> web/styles.generated.css.
// We invoke the standalone @tailwindcss/cli (no postcss/vite plugins).
const twResult = spawnSync(
	"npx",
	[
		"--no-install",
		"@tailwindcss/cli",
		"-i",
		"web/styles.src.css",
		"-o",
		"web/styles.generated.css",
		"--minify",
	],
	{ cwd: packageDir, stdio: "inherit" },
);
if (twResult.status !== 0) {
	console.error("[build-web] tailwind compile failed");
	process.exit(twResult.status ?? 1);
}

// Step 2: bundle JS + CSS via esbuild.
await build({
	absWorkingDir: packageDir,
	entryPoints: [path.join(packageDir, "web/index.tsx")],
	bundle: true,
	format: "esm",
	platform: "browser",
	jsx: "automatic",
	entryNames: "app",
	outdir: path.join(packageDir, "web/dist"),
	loader: {
		".css": "css",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
	},
});
