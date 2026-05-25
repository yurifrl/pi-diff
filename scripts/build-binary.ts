#!/usr/bin/env bun
// Bun-compile build script for the pi-diff CLI single-file binary.
//
// We need to stub `react-devtools-core` because Ink imports it
// statically inside a dynamic-import chunk, but Bun's bundler still
// tries to resolve it at build time. The package is only used when
// DEV=true, so a no-op stub is safe.

import { plugin, build } from "bun";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const stubPath = path.join(repoRoot, "scripts/devtools-stub.ts");

const outfile = process.argv[2] ?? path.join(repoRoot, "pi-diff-test");
const target = process.argv[3]; // optional Bun --target string

const stubPlugin = {
	name: "stub-react-devtools-core",
	setup(builder: any) {
		builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: stubPath }));
	},
};

const compileOpt: any = { outfile };
if (target) compileOpt.target = target;

const result = await build({
	entrypoints: [path.join(repoRoot, "cli.ts")],
	compile: compileOpt,
	plugins: [stubPlugin as any],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

console.log(`built ${outfile}`);
