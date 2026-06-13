import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import type { RegisterDiffPayload } from "./types.js";

const HOST = "127.0.0.1";

export type ServerState = {
	port: number;
	pid: number;
	startedAt: number;
};

export function serverStateFilePath(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-diff-server.json");
}

export async function writeServerState(state: ServerState): Promise<void> {
	const file = serverStateFilePath();
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

export async function readServerState(): Promise<ServerState | null> {
	try {
		const raw = await readFile(serverStateFilePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<ServerState>;
		if (typeof parsed.port !== "number" || typeof parsed.pid !== "number") return null;
		return { port: parsed.port, pid: parsed.pid, startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0 };
	} catch {
		return null;
	}
}

export async function clearServerState(): Promise<void> {
	try {
		await unlink(serverStateFilePath());
	} catch {
		/* ignore */
	}
}

/** Best-effort liveness check: process exists AND the HTTP endpoint answers. */
export async function isServerAlive(state: ServerState): Promise<boolean> {
	try {
		process.kill(state.pid, 0);
	} catch {
		return false;
	}
	return await pingSessions(state.port);
}

function pingSessions(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const req = httpRequest({ host: HOST, port, path: "/api/sessions", method: "GET", timeout: 1500 }, (res) => {
			res.resume();
			resolve((res.statusCode ?? 500) < 500);
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

export type RegisterResult = { token: string; url: string };

/** POST a diff payload to a running server's /api/register endpoint. */
export function postRegister(port: number, payload: RegisterDiffPayload): Promise<RegisterResult> {
	const body = JSON.stringify(payload);
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: HOST,
				port,
				path: "/api/register",
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
				timeout: 15000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let parsed: unknown;
					try {
						parsed = text ? JSON.parse(text) : {};
					} catch {
						reject(new Error(`Invalid response from server: ${text.slice(0, 200)}`));
						return;
					}
					if ((res.statusCode ?? 500) >= 400) {
						const msg = typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error: unknown }).error) : `HTTP ${res.statusCode}`;
						reject(new Error(msg));
						return;
					}
					const r = parsed as Partial<RegisterResult>;
					if (typeof r.token !== "string" || typeof r.url !== "string") {
						reject(new Error("Server did not return a token/url."));
						return;
					}
					resolve({ token: r.token, url: r.url });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("Timed out contacting the pi-diff server."));
		});
		req.end(body);
	});
}
