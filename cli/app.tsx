import React, { useEffect, useState } from "react";
import { useApp, useInput } from "ink";
import type { Exec } from "../core/exec.js";
import type { DiffSettings } from "../core/settings.js";
import type { DiffComment, ResolvedDiffTarget } from "../core/types.js";
import { Manager } from "./manager.js";
import { Waiting } from "./waiting.js";

type Phase = "waiting" | "manager";

export type SubmissionState = {
	getCount: () => number;
	getComments: () => DiffComment[];
	onCountChange: (cb: (n: number) => void) => () => void;
	onFirstSubmission: (cb: () => void) => () => void;
	onFinishedFromBrowser: (cb: () => void) => () => void;
};

export type AppProps = {
	targetLabel: string;
	viewerMessage: string;
	url: string;
	submissionState: SubmissionState;
	exec: Exec;
	cwd: string;
	settings: DiffSettings;
	target: ResolvedDiffTarget;
	autoSubmit: boolean;
	onDone: (result: { code: number; comments?: DiffComment[]; finalPrint?: () => void }) => void;
};

export function App(props: AppProps): React.JSX.Element | null {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("waiting");
	const [comments, setComments] = useState<DiffComment[] | null>(null);
	const [count, setCount] = useState<number>(() => props.submissionState.getCount());

	const finishWaiting = () => {
		const c = props.submissionState.getComments();
		if (c.length === 0) return;
		setComments(c);
		setPhase("manager");
	};

	useInput((input, key) => {
		if (phase !== "waiting") return;
		if (key.return) {
			finishWaiting();
			return;
		}
		if (input === "q" || (key.ctrl && input === "c")) {
			exit();
			props.onDone({ code: 130 });
		}
	});

	useEffect(() => {
		const unsub = props.submissionState.onCountChange((n) => setCount(n));
		return unsub;
	}, []);

	useEffect(() => {
		const unsub = props.submissionState.onFinishedFromBrowser(() => {
			if (phase !== "waiting") return;
			const c = props.submissionState.getComments();
			if (c.length === 0) {
				exit();
				props.onDone({ code: 0, finalPrint: () => console.log("pi-diff: no comments submitted.") });
				return;
			}
			setComments(c);
			setPhase("manager");
		});
		return unsub;
	}, [phase]);

	useEffect(() => {
		if (!props.autoSubmit) return;
		const unsub = props.submissionState.onFirstSubmission(() => {
			const c = props.submissionState.getComments();
			exit();
			props.onDone({ code: 0, comments: c });
		});
		return unsub;
	}, []);

	if (phase === "waiting" || comments === null) {
		return (
			<Waiting
				targetLabel={props.targetLabel}
				viewerMessage={props.viewerMessage}
				url={props.url}
				count={count}
				autoSubmit={props.autoSubmit}
			/>
		);
	}

	return (
		<Manager
			initial={comments}
			exec={props.exec}
			cwd={props.cwd}
			settings={props.settings}
			target={props.target}
			onDone={(r) => props.onDone({ ...r, comments })}
		/>
	);
}
