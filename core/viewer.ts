import type { Exec, ExecResult } from "./exec.js";
import { openCmuxPane, openCmuxSurface, resolveCmuxCallerContext } from "./cmux.js";
import type { CmuxMode, DiffSettings } from "./settings.js";

export type ViewerOpenResult = {
	ok: boolean;
	message: string;
};

async function openWithSystemBrowser(exec: Exec, cwd: string, url: string): Promise<ExecResult> {
	const platform = process.platform;
	if (platform === "darwin") {
		return await exec("open", [url], { cwd, timeout: 3000 });
	}
	if (platform === "win32") {
		return await exec("cmd", ["/c", "start", "", url], { cwd, timeout: 3000 });
	}
	return await exec("xdg-open", [url], { cwd, timeout: 3000 });
}

export async function openCmuxViewer(
	exec: Exec,
	cwd: string,
	url: string,
	mode: CmuxMode,
): Promise<ViewerOpenResult> {
	const ctx = await resolveCmuxCallerContext(exec, cwd);
	if (!ctx?.workspaceId) {
		return { ok: false, message: "cmux context not found. Run inside cmux, or change `viewer` in settings." };
	}
	if (mode === "surface" && !ctx.callerPaneRef) {
		return { ok: false, message: "Could not determine the current cmux pane. Try again from an active pane." };
	}
	const result =
		mode === "pane"
			? await openCmuxPane(exec, cwd, ctx.workspaceId, url)
			: await openCmuxSurface(exec, cwd, ctx.workspaceId, ctx.callerPaneRef!, url);
	if (result.code !== 0) {
		return { ok: false, message: result.stderr.trim() || "Failed to open the diff viewer in cmux." };
	}
	return { ok: true, message: `Opened diff viewer (cmux ${mode}).` };
}

export async function openSystemBrowserViewer(exec: Exec, cwd: string, url: string): Promise<ViewerOpenResult> {
	try {
		const result = await openWithSystemBrowser(exec, cwd, url);
		if (result.code !== 0) {
			return { ok: false, message: `Failed to open browser. URL: ${url}` };
		}
		return { ok: true, message: `Opened diff viewer in browser. URL: ${url}` };
	} catch {
		return { ok: false, message: `Failed to open browser. URL: ${url}` };
	}
}

export async function openViewer(
	exec: Exec,
	cwd: string,
	url: string,
	settings: DiffSettings,
): Promise<ViewerOpenResult> {
	if (settings.viewer === "cmux") {
		return await openCmuxViewer(exec, cwd, url, settings.cmuxMode);
	}
	if (settings.viewer === "browser") {
		return await openSystemBrowserViewer(exec, cwd, url);
	}
	return { ok: true, message: `Diff viewer ready. Open this URL: ${url}` };
}
