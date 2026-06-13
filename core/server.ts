import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDiffComments } from "./comments.js";
import type { ApplyBeadStatusesResponse, BeadStatusChange, RegisterDiffPayload, ViewerBootstrapPayload, ViewerSession, ViewerSessionSummary } from "./types.js";

const HOST = "127.0.0.1";
const APP_JS_BASENAME = "app.js";
const APP_CSS_BASENAME = "app.css";

/**
 * Walk up from this file's directory to locate the package root. Works both
 * when running TS via vitest (core/server.ts) and when running compiled JS
 * (dist/core/server.js).
 */
function findPackageRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_DIR = findPackageRoot(HERE);
const WEB_ENTRY_PATH = path.join(PACKAGE_DIR, "web", "index.tsx");
const WEB_DIST_DIR = path.join(PACKAGE_DIR, "web", "dist");

type AssetManifest = {
	jsPath: string;
	cssPath: string;
};

export type CreateViewerSessionInput = {
	bootstrap: Omit<ViewerBootstrapPayload, "viewerToken">;
	refreshBootstrap?: () => Promise<Omit<ViewerBootstrapPayload, "viewerToken">>;
	loadFile: ViewerSession["loadFile"];
	sendComments: ViewerSession["sendComments"];
	setBeadsEnabled?: ViewerSession["setBeadsEnabled"];
	applyBeadStatuses?: ViewerSession["applyBeadStatuses"];
	markDone?: ViewerSession["markDone"];
};

export type DiffServerOptions = {
	buildAssets?: () => Promise<AssetManifest>;
	/**
	 * When provided, the server accepts `POST /api/register` and turns the
	 * pushed diff payload into a viewer session. Supplied by the persistent
	 * `pi-diff serve` process, which owns comment output and bead updates.
	 */
	onRegister?: (payload: RegisterDiffPayload) => Promise<CreateViewerSessionInput>;
};

function isValidViewerToken(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function ensureViewerAssetsBuilt(): Promise<AssetManifest> {
	const jsPath = path.join(WEB_DIST_DIR, APP_JS_BASENAME);
	const cssPath = path.join(WEB_DIST_DIR, APP_CSS_BASENAME);
	try {
		await Promise.all([readFile(jsPath), readFile(cssPath)]);
		return { jsPath, cssPath };
	} catch {
		const esbuild = await import("esbuild");
		await esbuild.build({
			absWorkingDir: PACKAGE_DIR,
			entryPoints: [WEB_ENTRY_PATH],
			bundle: true,
			format: "esm",
			platform: "browser",
			jsx: "automatic",
			entryNames: "app",
			outdir: WEB_DIST_DIR,
			loader: {
				".css": "css",
			},
			define: {
				"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
			},
		});
		return { jsPath, cssPath };
	}
}

function renderHtmlShell(token: string): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>pi diff cmux</title>
	<link rel="stylesheet" href="/assets/${APP_CSS_BASENAME}" />
</head>
<body>
	<div id="root"></div>
	<script>window.__PI_DIFF_CMUX_VIEWER_TOKEN__ = ${JSON.stringify(token)};</script>
	<script type="module" src="/assets/${APP_JS_BASENAME}"></script>
</body>
</html>`;
}

function renderShellPageHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>pi-diff</title>
	<link rel="stylesheet" href="/assets/${APP_CSS_BASENAME}" />
</head>
<body>
	<div id="root"></div>
	<script>window.__PI_DIFF_SHELL__ = true;</script>
	<script type="module" src="/assets/${APP_JS_BASENAME}"></script>
</body>
</html>`;
}

function json(response: ServerResponse, statusCode: number, value: unknown) {
	response.statusCode = statusCode;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.end(JSON.stringify(value));
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const rawBody = Buffer.concat(chunks).toString("utf8");
	if (!rawBody.trim()) {
		return {};
	}
	return JSON.parse(rawBody);
}

function parseRegisterPayload(body: unknown): RegisterDiffPayload {
	if (typeof body !== "object" || body === null) throw new Error("Registration payload must be an object.");
	const b = body as Record<string, unknown>;
	if (typeof b.cwd !== "string" || !b.cwd) throw new Error("`cwd` is required.");
	if (typeof b.repo !== "object" || b.repo === null) throw new Error("`repo` is required.");
	if (typeof b.target !== "object" || b.target === null) throw new Error("`target` is required.");
	if (!Array.isArray(b.files)) throw new Error("`files` must be an array.");
	if (typeof b.filePayloads !== "object" || b.filePayloads === null) throw new Error("`filePayloads` is required.");
	const beadIds = Array.isArray(b.beadIds) ? b.beadIds.filter((x): x is string => typeof x === "string") : [];
	return {
		name: typeof b.name === "string" ? b.name : undefined,
		cwd: b.cwd,
		repo: b.repo as RegisterDiffPayload["repo"],
		target: b.target as RegisterDiffPayload["target"],
		files: b.files as RegisterDiffPayload["files"],
		filePayloads: b.filePayloads as RegisterDiffPayload["filePayloads"],
		beadIds,
	};
}

function parseBeadStatusChanges(body: unknown): BeadStatusChange[] {
	const raw = typeof body === "object" && body !== null && "changes" in body ? (body as { changes?: unknown }).changes : undefined;
	if (!Array.isArray(raw)) throw new Error("`changes` must be an array.");
	const out: BeadStatusChange[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) throw new Error("Each change must be an object.");
		const rec = item as Record<string, unknown>;
		if (typeof rec.id !== "string" || !rec.id) throw new Error("Each change requires a string `id`.");
		if (typeof rec.status !== "string" || !rec.status) throw new Error("Each change requires a string `status`.");
		out.push({ id: rec.id, status: rec.status });
	}
	return out;
}

export class DiffServer {
	private readonly sessions = new Map<string, ViewerSession>();
	private readonly buildAssets: () => Promise<AssetManifest>;
	private readonly onRegister?: (payload: RegisterDiffPayload) => Promise<CreateViewerSessionInput>;
	private readonly server = createServer(this.handleRequest.bind(this));
	private startPromise: Promise<void> | null = null;
	private stopped = false;
	private port: number | null = null;

	constructor(options: DiffServerOptions = {}) {
		this.buildAssets = options.buildAssets ?? ensureViewerAssetsBuilt;
		this.onRegister = options.onRegister;
	}

	async start(): Promise<void> {
		if (this.port !== null) {
			return;
		}
		if (this.startPromise) {
			return await this.startPromise;
		}
		this.startPromise = new Promise<void>((resolve, reject) => {
			this.server.listen(0, HOST, () => {
				const address = this.server.address();
				if (!address || typeof address === "string") {
					reject(new Error("Failed to bind the diff viewer server."));
					return;
				}
				this.port = address.port;
				resolve();
			});
			this.server.once("error", reject);
		});
		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.sessions.clear();
		if (this.port === null) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		this.port = null;
	}

	async createViewerSession(input: CreateViewerSessionInput): Promise<{ token: string; url: string }> {
		await this.start();
		const token = randomUUID();
		this.sessions.set(token, {
			token,
			createdAt: Date.now(),
			bootstrap: {
				...input.bootstrap,
				viewerToken: token,
			},
			refreshBootstrap: input.refreshBootstrap
				? async () => ({
					...(await input.refreshBootstrap!()),
					viewerToken: token,
				})
				: undefined,
			loadFile: input.loadFile,
			sendComments: input.sendComments,
			setBeadsEnabled: input.setBeadsEnabled,
			applyBeadStatuses: input.applyBeadStatuses,
			markDone: input.markDone,
		});
		return {
			token,
			url: this.getViewerUrl(token),
		};
	}

	getSessionSummaries(): ViewerSessionSummary[] {
		return Array.from(this.sessions.values())
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((session) => ({
				token: session.token,
				name: session.bootstrap.name || session.bootstrap.target.label,
				url: this.getViewerUrl(session.token),
				targetLabel: session.bootstrap.target.label,
				createdAt: session.createdAt,
				linkedBeadCount: session.bootstrap.linkedBeads.length,
			}));
	}

	getViewerUrl(token: string): string {
		if (this.port === null) {
			throw new Error("The diff viewer server has not started yet.");
		}
		return `http://${HOST}:${this.port}/viewer/${token}`;
	}

	getPort(): number {
		if (this.port === null) {
			throw new Error("The diff viewer server has not started yet.");
		}
		return this.port;
	}

	private async serveAsset(response: ServerResponse, assetPath: string, contentType: string) {
		let content: Buffer | Uint8Array;
		try {
			content = await readFile(assetPath);
		} catch (err) {
			// Bun-compiled binaries embed assets at virtual paths (e.g. /$bunfs/...).
			// node:fs may or may not resolve those depending on Bun version, so fall
			// back to Bun.file when available.
			const maybeBun = (globalThis as { Bun?: { file: (p: string) => { arrayBuffer: () => Promise<ArrayBuffer> } } }).Bun;
			if (!maybeBun) throw err;
			const buf = await maybeBun.file(assetPath).arrayBuffer();
			content = new Uint8Array(buf);
		}
		response.statusCode = 200;
		response.setHeader("Content-Type", `${contentType}; charset=utf-8`);
		response.end(content);
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse) {
		try {
			const url = new URL(request.url ?? "/", `http://${HOST}`);
			const pathname = url.pathname;

			if (pathname === `/assets/${APP_JS_BASENAME}`) {
				const assets = await this.buildAssets();
				await this.serveAsset(response, assets.jsPath, "text/javascript");
				return;
			}
			if (pathname === `/assets/${APP_CSS_BASENAME}`) {
				const assets = await this.buildAssets();
				await this.serveAsset(response, assets.cssPath, "text/css");
				return;
			}

			if (pathname === "/" || pathname === "/index.html") {
				response.statusCode = 200;
				response.setHeader("Content-Type", "text/html; charset=utf-8");
				response.end(renderShellPageHtml());
				return;
			}

			if (pathname === "/api/sessions" && request.method === "GET") {
				json(response, 200, { sessions: this.getSessionSummaries() });
				return;
			}

			if (pathname === "/api/register" && request.method === "POST") {
				if (!this.onRegister) {
					json(response, 400, { error: "This server does not accept registrations." });
					return;
				}
				const body = await readJsonRequestBody(request);
				let payload: RegisterDiffPayload;
				try {
					payload = parseRegisterPayload(body);
				} catch (error) {
					json(response, 400, { error: error instanceof Error ? error.message : "Invalid registration payload." });
					return;
				}
				const input = await this.onRegister(payload);
				const session = await this.createViewerSession(input);
				json(response, 200, { token: session.token, url: session.url });
				return;
			}

			const viewerMatch = pathname.match(/^\/viewer\/([^/]+)$/);
			if (viewerMatch) {
				const token = viewerMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				response.statusCode = 200;
				response.setHeader("Content-Type", "text/html; charset=utf-8");
				response.end(renderHtmlShell(token));
				return;
			}

			const bootstrapMatch = pathname.match(/^\/api\/viewer\/([^/]+)$/);
			if (bootstrapMatch) {
				const token = bootstrapMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				if (session.refreshBootstrap) {
					session.bootstrap = await session.refreshBootstrap();
				}
				json(response, 200, session.bootstrap);
				return;
			}

			const fileMatch = pathname.match(/^\/api\/viewer\/([^/]+)\/files\/([^/]+)$/);
			if (fileMatch) {
				const token = fileMatch[1] ?? "";
				const fileId = fileMatch[2] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				const filePayload = await session.loadFile(fileId);
				if (!filePayload) {
					json(response, 404, { error: "Diff file not found." });
					return;
				}
				json(response, 200, filePayload);
				return;
			}

			const sendMatch = pathname.match(/^\/api\/viewer\/([^/]+)\/send$/);
			if (sendMatch && request.method === "POST") {
				const token = sendMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				const body = await readJsonRequestBody(request);
				const rawComments = typeof body === "object" && body !== null && "comments" in body ? (body as { comments?: unknown }).comments : undefined;
				let comments;
				try {
					comments = validateDiffComments(rawComments);
				} catch (error) {
					json(response, 400, { error: error instanceof Error ? error.message : "Invalid comments." });
					return;
				}
				if (comments.length === 0) {
					json(response, 400, { error: "No comments were provided." });
					return;
				}
				const result = await session.sendComments(comments);
				json(response, 200, result);
				return;
			}

			const doneMatch = pathname.match(/^\/api\/viewer\/([^/]+)\/done$/);
			if (doneMatch && request.method === "POST") {
				const token = doneMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				if (session.markDone) {
					try { await session.markDone(); } catch { /* ignore */ }
				}
				json(response, 200, { ok: true });
				return;
			}

			const beadsMatch = pathname.match(/^\/api\/viewer\/([^/]+)\/beads$/);
			if (beadsMatch && request.method === "POST") {
				const token = beadsMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				if (!session.applyBeadStatuses) {
					json(response, 400, { error: "Bead status updates are not supported for this session." });
					return;
				}
				const body = await readJsonRequestBody(request);
				let changes: BeadStatusChange[];
				try {
					changes = parseBeadStatusChanges(body);
				} catch (error) {
					json(response, 400, { error: error instanceof Error ? error.message : "Invalid bead changes." });
					return;
				}
				const result = await session.applyBeadStatuses(changes);
				if (session.refreshBootstrap) {
					try { session.bootstrap = await session.refreshBootstrap(); } catch { /* ignore */ }
				}
				json(response, 200, result);
				return;
			}

			const settingsMatch = pathname.match(/^\/api\/viewer\/([^/]+)\/settings$/);
			if (settingsMatch && request.method === "POST") {
				const token = settingsMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				if (!session.setBeadsEnabled) {
					json(response, 400, { error: "Settings updates are not supported for this session." });
					return;
				}
				const body = await readJsonRequestBody(request);
				const rawEnabled = typeof body === "object" && body !== null && "beadsEnabled" in body
					? (body as { beadsEnabled?: unknown }).beadsEnabled
					: undefined;
				if (typeof rawEnabled !== "boolean") {
					json(response, 400, { error: "`beadsEnabled` must be a boolean." });
					return;
				}
				const result = await session.setBeadsEnabled(rawEnabled);
				json(response, 200, result);
				return;
			}

			json(response, 404, { error: "Not found." });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown server error.";
			json(response, 500, { error: message });
		}
	}
}

export function createDiffServer(options: DiffServerOptions = {}): DiffServer {
	return new DiffServer(options);
}

// Back-compat aliases
export const createDiffCmuxServer = createDiffServer;
export type DiffCmuxServerOptions = DiffServerOptions;
export { DiffServer as DiffCmuxServer };
