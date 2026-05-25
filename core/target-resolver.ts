import type { Exec } from "./exec.js";
import { getCurrentBranch, getDefaultBranchInfo, getLocalBranches, hasWorkingTreeChanges } from "./git.js";
import type { DiffTarget } from "./types.js";

export type DiffTargetPreset = "uncommitted" | "baseBranch" | "commit";

export const TARGET_PRESETS: Array<{ value: DiffTargetPreset; label: string; description: string }> = [
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "baseBranch", label: "Compare against a branch", description: "" },
	{ value: "commit", label: "Review a commit", description: "" },
];

export async function getSmartDefaultPreset(exec: Exec, cwd: string): Promise<DiffTargetPreset> {
	if (await hasWorkingTreeChanges(exec, cwd)) {
		return "uncommitted";
	}

	const [currentBranch, localBranches, defaultBranchInfo] = await Promise.all([
		getCurrentBranch(exec, cwd),
		getLocalBranches(exec, cwd),
		getDefaultBranchInfo(exec, cwd),
	]);
	if (!currentBranch) {
		return "commit";
	}

	const hasAlternateLocalBranch = localBranches.some((branch) => branch !== currentBranch);
	if (!hasAlternateLocalBranch) {
		return "commit";
	}

	if (!defaultBranchInfo.isReliable) {
		return "commit";
	}

	if (currentBranch !== defaultBranchInfo.branch) {
		return "baseBranch";
	}

	return "commit";
}

export function getPresetsForSelector(smartDefault: DiffTargetPreset) {
	const presets = smartDefault === "uncommitted" ? TARGET_PRESETS : TARGET_PRESETS.filter((preset) => preset.value !== "uncommitted");
	const smartDefaultIndex = presets.findIndex((preset) => preset.value === smartDefault);
	if (smartDefaultIndex <= 0) {
		return presets;
	}
	const selected = presets[smartDefaultIndex]!;
	return [selected, ...presets.slice(0, smartDefaultIndex), ...presets.slice(smartDefaultIndex + 1)];
}

export function parseDiffTargetArgs(args: string | undefined): DiffTarget | null {
	if (!args?.trim()) {
		return null;
	}

	const parts = args.trim().split(/\s+/);
	const subcommand = (parts[0] ?? "").toLowerCase();
	switch (subcommand) {
		case "uncommitted":
			return { type: "uncommitted" };
		case "branch": {
			const branch = parts[1];
			if (!branch) {
				return null;
			}
			return { type: "baseBranch", branch };
		}
		case "commit": {
			const sha = parts[1];
			if (!sha) {
				return null;
			}
			const title = parts.slice(2).join(" ") || undefined;
			return { type: "commit", sha, title };
		}
		default:
			return null;
	}
}
