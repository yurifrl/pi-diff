// Version reporting. Source of truth for `pi-diff --version`.
//
// At compile time, `scripts/build-binary.ts` injects build-time globals via
// Bun's `define`:
//   __PI_DIFF_BUILD_KIND__  "release" | "dev"
//   __PI_DIFF_GIT_SHA__     short git sha or empty
//
// When running uncompiled (`bun cli.ts ...`), neither is defined and we
// default to a "dev" label. Locally-built binaries (`task install:local`)
// also default to "dev" because the build script only marks "release"
// when PI_DIFF_RELEASE=1 is set in the env (CI release path).

import packageJson from "../package.json" with { type: "json" };

declare const __PI_DIFF_BUILD_KIND__: string | undefined;
declare const __PI_DIFF_GIT_SHA__: string | undefined;

export type BuildKind = "release" | "dev";

export type VersionInfo = {
	version: string;        // semver from package.json, e.g. "0.1.0"
	buildKind: BuildKind;   // "release" or "dev"
	gitSha: string;         // short sha or "" if unknown
	display: string;        // canonical one-liner: "0.1.0" or "0.1.0-dev+abc1234"
};

function readBuildKind(): BuildKind {
	try {
		if (typeof __PI_DIFF_BUILD_KIND__ !== "undefined" && __PI_DIFF_BUILD_KIND__ === "release") {
			return "release";
		}
	} catch {
		/* ignore */
	}
	return "dev";
}

function readGitSha(): string {
	try {
		if (typeof __PI_DIFF_GIT_SHA__ !== "undefined" && typeof __PI_DIFF_GIT_SHA__ === "string") {
			return __PI_DIFF_GIT_SHA__;
		}
	} catch {
		/* ignore */
	}
	return "";
}

export function getVersionInfo(): VersionInfo {
	const baseVersion = (packageJson as { version?: string }).version ?? "0.0.0";
	const buildKind = readBuildKind();
	const gitSha = readGitSha();
	let display = baseVersion;
	if (buildKind === "dev") {
		display = `${baseVersion}-dev${gitSha ? `+${gitSha}` : ""}`;
	} else if (gitSha) {
		display = `${baseVersion}+${gitSha}`;
	}
	return { version: baseVersion, buildKind, gitSha, display };
}

export function getVersionString(): string {
	return getVersionInfo().display;
}
