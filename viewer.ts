import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openCmuxPane, openCmuxSurface, resolveCmuxCallerContext } from "./cmux";
import type { CmuxMode, DiffSettings } from "./settings";

export type ViewerOpenResult = {
	ok: boolean;
	message: string;
};

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
};

async function openWithSystemBrowser(pi: ExtensionAPI, cwd: string, url: string): Promise<ExecResult> {
	const platform = process.platform;
	if (platform === "darwin") {
		return await pi.exec("open", [url], { cwd, timeout: 3000 });
	}
	if (platform === "win32") {
		return await pi.exec("cmd", ["/c", "start", "", url], { cwd, timeout: 3000 });
	}
	return await pi.exec("xdg-open", [url], { cwd, timeout: 3000 });
}

export async function openCmuxViewer(
	pi: ExtensionAPI,
	cwd: string,
	url: string,
	mode: CmuxMode,
): Promise<ViewerOpenResult> {
	const ctx = await resolveCmuxCallerContext(pi, cwd);
	if (!ctx?.workspaceId) {
		return { ok: false, message: "cmux context not found. Run inside cmux, or change `viewer` in settings." };
	}
	if (mode === "surface" && !ctx.callerPaneRef) {
		return { ok: false, message: "Could not determine the current cmux pane. Try again from an active pane." };
	}
	const result =
		mode === "pane"
			? await openCmuxPane(pi, cwd, ctx.workspaceId, url)
			: await openCmuxSurface(pi, cwd, ctx.workspaceId, ctx.callerPaneRef!, url);
	if (result.code !== 0) {
		return { ok: false, message: result.stderr.trim() || "Failed to open the diff viewer in cmux." };
	}
	return { ok: true, message: `Opened diff viewer (cmux ${mode}).` };
}

export async function openSystemBrowserViewer(pi: ExtensionAPI, cwd: string, url: string): Promise<ViewerOpenResult> {
	try {
		const result = await openWithSystemBrowser(pi, cwd, url);
		if (result.code !== 0) {
			return { ok: false, message: `Failed to open browser. URL: ${url}` };
		}
		return { ok: true, message: `Opened diff viewer in browser. URL: ${url}` };
	} catch {
		return { ok: false, message: `Failed to open browser. URL: ${url}` };
	}
}

export async function openViewer(
	pi: ExtensionAPI,
	cwd: string,
	url: string,
	settings: DiffSettings,
): Promise<ViewerOpenResult> {
	if (settings.viewer === "cmux") {
		return await openCmuxViewer(pi, cwd, url, settings.cmuxMode);
	}
	if (settings.viewer === "browser") {
		return await openSystemBrowserViewer(pi, cwd, url);
	}
	return { ok: true, message: `Diff viewer ready. Open this URL: ${url}` };
}
