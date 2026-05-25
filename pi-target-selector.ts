import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Exec } from "./core/exec.js";
import { getCurrentBranch, getDefaultBranch, getLocalBranches, getRecentCommits, hasWorkingTreeChanges } from "./core/git.js";
import { getPresetsForSelector, getSmartDefaultPreset, parseDiffTargetArgs } from "./core/target-resolver.js";
import type { DiffTarget } from "./core/types.js";

/**
 * Pi-specific interactive selector. Keeps `ctx.ui` usage out of `core/`.
 *
 * Accepts either a raw `Exec` or a pi `ExtensionAPI`-shaped object (anything
 * with an `exec(cmd, args, opts)` method) so tests that previously passed a
 * `pi` stub continue to work without rewrites.
 */
function toExec(piOrExec: ExtensionAPI | Exec | { exec: ExtensionAPI["exec"] }): Exec {
	if (typeof piOrExec === "function") return piOrExec;
	const e = (piOrExec as { exec: ExtensionAPI["exec"] }).exec;
	return (cmd, args, opts) => e(cmd, args, opts);
}

async function showBranchSelector(exec: Exec, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const branches = await getLocalBranches(exec, ctx.cwd);
	const [currentBranch, defaultBranch] = await Promise.all([getCurrentBranch(exec, ctx.cwd), getDefaultBranch(exec, ctx.cwd)]);
	const candidates = currentBranch ? branches.filter((branch) => branch !== currentBranch) : branches;
	if (candidates.length === 0) {
		ctx.ui.notify(currentBranch ? `No other branches found (current branch: ${currentBranch})` : "No branches found", "error");
		return null;
	}

	const sorted = [...candidates].sort((left, right) => {
		if (left === defaultBranch) return -1;
		if (right === defaultBranch) return 1;
		return left.localeCompare(right);
	});
	const labels = sorted.map((branch) => (branch === defaultBranch ? `${branch} (default)` : branch));
	const selection = await ctx.ui.select("Select a branch to compare against", labels);
	if (selection === undefined) return null;
	const index = labels.indexOf(selection);
	if (index < 0) return null;
	return { type: "baseBranch", branch: sorted[index]! };
}

async function showCommitSelector(exec: Exec, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const commits = await getRecentCommits(exec, 20, ctx.cwd);
	if (commits.length === 0) {
		ctx.ui.notify("No commits found", "error");
		return null;
	}
	const labels = commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.title}`.trim());
	const selection = await ctx.ui.select("Select a commit to review", labels);
	if (selection === undefined) return null;
	const index = labels.indexOf(selection);
	if (index < 0) return null;
	return { type: "commit", sha: commits[index]!.sha, title: commits[index]!.title };
}

export async function showTargetSelector(piOrExec: ExtensionAPI | Exec, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const exec = toExec(piOrExec);
	const smartDefault = await getSmartDefaultPreset(exec, ctx.cwd);
	const orderedPresets = getPresetsForSelector(smartDefault);
	while (true) {
		const labels = orderedPresets.map((preset) => `${preset.label}${preset.description ? ` ${preset.description}` : ""}`);
		const selection = await ctx.ui.select("Select a diff target", labels);
		if (selection === undefined) return null;
		const index = labels.indexOf(selection);
		const preset = orderedPresets[index];
		if (!preset) return null;
		switch (preset.value) {
			case "uncommitted":
				return { type: "uncommitted" };
			case "baseBranch": {
				const target = await showBranchSelector(exec, ctx);
				if (target) return target;
				break;
			}
			case "commit": {
				const target = await showCommitSelector(exec, ctx);
				if (target) return target;
				break;
			}
		}
	}
}

export async function resolveDiffTargetFromArgs(piOrExec: ExtensionAPI | Exec, ctx: ExtensionContext, args: string): Promise<DiffTarget | null> {
	const exec = toExec(piOrExec);
	const trimmed = args.trim();
	const parsed = parseDiffTargetArgs(trimmed);
	if (parsed) {
		if (parsed.type === "uncommitted" && !(await hasWorkingTreeChanges(exec, ctx.cwd))) {
			ctx.ui.notify("No uncommitted changes found", "error");
			return null;
		}
		return parsed;
	}
	if (trimmed.length > 0) {
		ctx.ui.notify("Invalid diff target. Use uncommitted, branch <name>, or commit <sha>.", "error");
		return null;
	}
	return await showTargetSelector(exec, ctx);
}

export { parseDiffTargetArgs };
