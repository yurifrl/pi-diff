import React from "react";
import type { DiffViewMode } from "../../types";
import { getSendAllHint } from "../shortcuts";

type ToolbarProps = {
	repoName: string;
	targetLabel: string;
	viewMode: DiffViewMode;
	wrapLines: boolean;
	unsentCount: number;
	expired: boolean;
	beadsEnabled: boolean;
	beadsConfigured: boolean;
	beadsToggleBusy: boolean;
	onViewModeChange: (mode: DiffViewMode) => void;
	onWrapToggle: () => void;
	onToggleBeads: () => void;
	onToggleSidebarPopover: () => void;
	onRefresh: () => void;
	onSendAll: () => void;
};

export function Toolbar(props: ToolbarProps) {
	const sendAllHint = getSendAllHint();

	return (
		<header className="toolbar">
			<div className="toolbar__leading">
				<button aria-label="Files · T" className="toolbar__sidebar-trigger" onClick={props.onToggleSidebarPopover} title="Files · T" type="button">
					<svg aria-hidden="true" className="toolbar__sidebar-icon" viewBox="0 0 16 16">
						<path d="M3 4.25h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
						<path d="M3 8h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
						<path d="M3 11.75h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
					</svg>
					<span className="shortcut-chip shortcut-chip--overlay">T</span>
				</button>
				<button aria-label="Refresh · R" className="toolbar__refresh" onClick={props.onRefresh} title="Refresh · R" type="button">
					<svg aria-hidden="true" className="toolbar__refresh-icon" viewBox="0 0 16 16">
						<path
							d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="1.4"
						/>
						<path d="M9.75 2.5h2.75v2.75" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
					</svg>
					<span className="shortcut-chip shortcut-chip--overlay">R</span>
				</button>
				<div className="toolbar__title">
					<div className="toolbar__eyebrow">{props.repoName}</div>
					<div className="toolbar__label">{props.targetLabel}</div>
				</div>
			</div>
			<div className="toolbar__controls">
				<label
					className={`checkbox-control toolbar__checkbox-control ${props.beadsEnabled && !props.beadsConfigured ? "is-warning" : ""}`}
					title={
						props.beadsEnabled && !props.beadsConfigured
							? "Beads is enabled but `.beads/` is not initialized in this repo. Run `bd init` or turn beads off."
							: props.beadsEnabled
								? "Comments are sent as beads (`bd create`)."
								: "Comments are sent to the editor as plain text."
					}
				>
					<input
						checked={props.beadsEnabled}
						disabled={props.beadsToggleBusy}
						onChange={props.onToggleBeads}
						type="checkbox"
					/>
					<span>
						Beads{props.beadsEnabled && !props.beadsConfigured ? " (not configured)" : ""}
					</span>
				</label>
				<label className="checkbox-control toolbar__checkbox-control">
					<input checked={props.wrapLines} onChange={props.onWrapToggle} type="checkbox" />
					<span>Wrap lines</span>
				</label>
				<div className="segmented-control" role="tablist" aria-label="Diff view mode">
					<button className={props.viewMode === "unified" ? "is-active" : ""} onClick={() => props.onViewModeChange("unified")}>
						Unified
					</button>
					<button className={props.viewMode === "split" ? "is-active" : ""} onClick={() => props.onViewModeChange("split")}>
						Split
					</button>
				</div>
				<button className="button--primary button-with-shortcut" disabled={props.expired} onClick={props.onSendAll}>
					<span>Done{props.unsentCount > 0 ? ` (${props.unsentCount})` : ""}</span>
					<span className="shortcut-chip">{sendAllHint}</span>
				</button>
			</div>
		</header>
	);
}
