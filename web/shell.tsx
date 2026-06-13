import React, { useCallback, useEffect, useState } from "react";
import { App } from "./app";

type SessionSummary = {
	token: string;
	name: string;
	url: string;
	targetLabel: string;
	createdAt: number;
	linkedBeadCount: number;
};

const POLL_INTERVAL_MS = 3000;

export function Shell() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [activeToken, setActiveToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/sessions");
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { sessions: SessionSummary[] };
			setSessions(body.sessions);
			setError(null);
			setActiveToken((current) => {
				if (current && body.sessions.some((s) => s.token === current)) return current;
				return body.sessions.length > 0 ? body.sessions[body.sessions.length - 1].token : null;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load sessions.");
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	return (
		<div className="pr-shell">
			<nav className="pr-shell__tabs" aria-label="Open diffs">
				<span className="pr-shell__brand">pi-diff</span>
				{sessions.map((session) => (
					<button
						className={`pr-shell__tab ${session.token === activeToken ? "is-active" : ""}`}
						key={session.token}
						onClick={() => setActiveToken(session.token)}
						title={session.targetLabel}
						type="button"
					>
						<span className="pr-shell__tab-name">{session.name}</span>
						{session.linkedBeadCount > 0 ? <span className="pr-shell__tab-badge">{session.linkedBeadCount}</span> : null}
					</button>
				))}
				{sessions.length === 0 ? <span className="pr-shell__empty">No diffs yet — run `pi-diff &lt;target&gt; --name …`</span> : null}
				{error ? <span className="pr-shell__error">{error}</span> : null}
			</nav>
			<div className="pr-shell__body">
				{activeToken ? (
					<App key={activeToken} viewerToken={activeToken} />
				) : (
					<div className="pr-shell__placeholder">
						<h1>pi-diff server</h1>
						<p>Register a diff to open it here:</p>
						<pre>pi-diff uncommitted --name "My change" --bead bd-123</pre>
					</div>
				)}
			</div>
		</div>
	);
}
