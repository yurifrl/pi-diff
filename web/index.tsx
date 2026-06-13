import React from "react";
import { createRoot } from "react-dom/client";
import "react-diff-view/style/index.css";
import "./styles.generated.css";
import { App } from "./app";
import { Shell } from "./shell";

declare global {
	interface Window {
		__PI_DIFF_CMUX_VIEWER_TOKEN__?: string;
		__PI_DIFF_SHELL__?: boolean;
	}
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Missing #root element.");
}

if (window.__PI_DIFF_SHELL__) {
	createRoot(rootElement).render(
		<React.StrictMode>
			<Shell />
		</React.StrictMode>,
	);
} else {
	const viewerToken = window.__PI_DIFF_CMUX_VIEWER_TOKEN__;
	if (!viewerToken) {
		throw new Error("Missing diff viewer bootstrap state.");
	}
	createRoot(rootElement).render(
		<React.StrictMode>
			<App viewerToken={viewerToken} />
		</React.StrictMode>,
	);
}
