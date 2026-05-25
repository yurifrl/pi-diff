import React, { useEffect, useState } from "react";
import { useApp } from "ink";
import type { Exec } from "../core/exec.js";
import { getCurrentBranch, getDefaultBranch, getLocalBranches, getRecentCommits, hasWorkingTreeChanges } from "../core/git.js";
import { getPresetsForSelector, getSmartDefaultPreset } from "../core/target-resolver.js";
import type { DiffTarget } from "../core/types.js";
import { SimpleSelect, type SimpleOption } from "./target-picker.js";

export type TargetPickerProps = {
	exec: Exec;
	cwd: string;
	onDone: (target: DiffTarget | null) => void;
};

type State =
	| { kind: "loading" }
	| { kind: "presets"; options: SimpleOption[] }
	| { kind: "branches"; options: SimpleOption[]; presets: SimpleOption[] }
	| { kind: "commits"; options: SimpleOption[]; presets: SimpleOption[] }
	| { kind: "info"; message: string };

export function TargetPickerApp({ exec, cwd, onDone }: TargetPickerProps): React.JSX.Element | null {
	const { exit } = useApp();
	const [state, setState] = useState<State>({ kind: "loading" });

	const finish = (target: DiffTarget | null) => {
		exit();
		onDone(target);
	};

	useEffect(() => {
		(async () => {
			try {
				const smartDefault = await getSmartDefaultPreset(exec, cwd);
				const presets = getPresetsForSelector(smartDefault);
				setState({
					kind: "presets",
					options: presets.map((p) => ({ label: p.label, value: p.value })),
				});
			} catch (err) {
				setState({ kind: "info", message: `failed: ${err instanceof Error ? err.message : String(err)}` });
			}
		})();
	}, []);

	if (state.kind === "loading") return null;

	if (state.kind === "info") {
		return (
			<SimpleSelect
				title={state.message}
				options={[{ label: "OK", value: "ok" }]}
				footer="enter to exit"
				onSelect={() => finish(null)}
				onCancel={() => finish(null)}
			/>
		);
	}

	if (state.kind === "presets") {
		return (
			<SimpleSelect
				title="Select a diff target"
				options={state.options}
				onCancel={() => finish(null)}
				onSelect={async (value) => {
					if (value === "uncommitted") {
						if (!(await hasWorkingTreeChanges(exec, cwd))) {
							setState({ kind: "info", message: "No uncommitted changes found." });
							return;
						}
						finish({ type: "uncommitted" });
						return;
					}
					if (value === "baseBranch") {
						const [branches, current, def] = await Promise.all([
							getLocalBranches(exec, cwd),
							getCurrentBranch(exec, cwd),
							getDefaultBranch(exec, cwd),
						]);
						const candidates = current ? branches.filter((b) => b !== current) : branches;
						if (candidates.length === 0) {
							setState({ kind: "info", message: "No other branches available." });
							return;
						}
						const sorted = [...candidates].sort((l, r) => (l === def ? -1 : r === def ? 1 : l.localeCompare(r)));
						setState({
							kind: "branches",
							options: sorted.map((b) => ({ label: b === def ? `${b} (default)` : b, value: b })),
							presets: state.options,
						});
						return;
					}
					if (value === "commit") {
						const commits = await getRecentCommits(exec, 20, cwd);
						if (commits.length === 0) {
							setState({ kind: "info", message: "No commits found." });
							return;
						}
						setState({
							kind: "commits",
							options: commits.map((c) => ({
								label: `${c.sha.slice(0, 7)} ${c.title}`.trim(),
								value: `${c.sha}\u0000${c.title}`,
							})),
							presets: state.options,
						});
						return;
					}
				}}
			/>
		);
	}

	if (state.kind === "branches") {
		const presets = state.presets;
		return (
			<SimpleSelect
				title="Select a branch to compare against"
				options={state.options}
				onCancel={() => setState({ kind: "presets", options: presets })}
				onSelect={(value) => finish({ type: "baseBranch", branch: value })}
			/>
		);
	}

	if (state.kind === "commits") {
		const presets = state.presets;
		return (
			<SimpleSelect
				title="Select a commit to review"
				options={state.options}
				onCancel={() => setState({ kind: "presets", options: presets })}
				onSelect={(value) => {
					const [sha, title] = value.split("\u0000");
					finish({ type: "commit", sha: sha!, title: title || undefined });
				}}
			/>
		);
	}

	return null;
}
