import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type ViewerKind = "cmux" | "browser" | "none";
export type CmuxMode = "pane" | "surface";
export type DefaultViewMode = "split" | "unified";
export type LayoutMode = "stream" | "deck";
export type OutputMode = "prompt" | "beads" | "beads-script";

export type DiffSettings = {
	viewer: ViewerKind;
	cmuxMode: CmuxMode;
	defaultViewMode: DefaultViewMode;
	layoutMode: LayoutMode;
	output: OutputMode;
	beadsCommand: string;
	beadsLabels: string[];
	beadsType: string;
	beadsPriority: number | null;
};

export const DEFAULT_SETTINGS: DiffSettings = {
	viewer: "browser",
	cmuxMode: "pane",
	defaultViewMode: "unified",
	layoutMode: "stream",
	output: "prompt",
	beadsCommand: "bd",
	beadsLabels: ["code-review"],
	beadsType: "task",
	beadsPriority: null,
};

const GLOBAL_RELATIVE = path.join(".pi", "agent", "extensions", "pi-diff.json");
const PROJECT_RELATIVE = path.join(".pi", "extensions", "pi-diff.json");

function globalSettingsPath(): string {
	return path.join(homedir(), GLOBAL_RELATIVE);
}

export type SettingsLocation = "global" | "project";

export function settingsPathFor(location: SettingsLocation, cwd: string): string {
	if (location === "project") return path.join(cwd, PROJECT_RELATIVE);
	return globalSettingsPath();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function mergeSettings(...layers: Array<Partial<DiffSettings> | undefined>): DiffSettings {
	const merged: DiffSettings = { ...DEFAULT_SETTINGS };
	for (const layer of layers) {
		if (!layer) continue;
		for (const [key, value] of Object.entries(layer)) {
			if (value === undefined) continue;
			(merged as Record<string, unknown>)[key] = value;
		}
	}
	return merged;
}

export function coerceSettings(raw: unknown): Partial<DiffSettings> {
	if (!isRecord(raw)) return {};
	const out: Partial<DiffSettings> = {};
	if (raw.viewer === "cmux" || raw.viewer === "browser" || raw.viewer === "none") {
		out.viewer = raw.viewer;
	}
	if (raw.cmuxMode === "pane" || raw.cmuxMode === "surface") {
		out.cmuxMode = raw.cmuxMode;
	}
	if (raw.defaultViewMode === "split" || raw.defaultViewMode === "unified") {
		out.defaultViewMode = raw.defaultViewMode;
	}
	if (raw.layoutMode === "stream" || raw.layoutMode === "deck") {
		out.layoutMode = raw.layoutMode;
	}
	if (raw.output === "prompt" || raw.output === "beads" || raw.output === "beads-script") {
		out.output = raw.output;
	}
	if (typeof raw.beadsCommand === "string" && raw.beadsCommand.trim()) {
		out.beadsCommand = raw.beadsCommand.trim();
	}
	if (Array.isArray(raw.beadsLabels)) {
		out.beadsLabels = raw.beadsLabels.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
	}
	if (typeof raw.beadsType === "string" && raw.beadsType.trim()) {
		out.beadsType = raw.beadsType.trim();
	}
	if (raw.beadsPriority === null || (typeof raw.beadsPriority === "number" && Number.isFinite(raw.beadsPriority))) {
		out.beadsPriority = raw.beadsPriority as number | null;
	}
	return out;
}

/** Strip JSONC comments and trailing commas. */
export function stripJsonc(input: string): string {
	let out = "";
	let i = 0;
	const n = input.length;
	let inString = false;
	let stringQuote = "";
	while (i < n) {
		const ch = input[i];
		const next = input[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\" && i + 1 < n) {
				out += input[i + 1];
				i += 2;
				continue;
			}
			if (ch === stringQuote) inString = false;
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			out += ch;
			i += 1;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < n && input[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

async function readJsoncFile(filePath: string): Promise<unknown | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		return JSON.parse(stripJsonc(raw)) as unknown;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return null;
		throw error;
	}
}

export async function loadSettings(cwd: string): Promise<DiffSettings> {
	const [globalRaw, projectRaw] = await Promise.all([
		readJsoncFile(settingsPathFor("global", cwd)),
		readJsoncFile(settingsPathFor("project", cwd)),
	]);
	return mergeSettings(coerceSettings(globalRaw), coerceSettings(projectRaw));
}

export async function saveSettings(location: SettingsLocation, cwd: string, patch: Partial<DiffSettings>): Promise<string> {
	const filePath = settingsPathFor(location, cwd);
	await mkdir(path.dirname(filePath), { recursive: true });
	const existing = (await readJsoncFile(filePath)) ?? {};
	const next = { ...(isRecord(existing) ? existing : {}), ...coerceSettings(patch) };
	await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return filePath;
}

export function describeSettings(settings: DiffSettings): string {
	const lines = [
		`viewer            ${settings.viewer}`,
		`cmuxMode          ${settings.cmuxMode}`,
		`defaultViewMode   ${settings.defaultViewMode}`,
		`layoutMode        ${settings.layoutMode}`,
		`output            ${settings.output}`,
		`beadsCommand      ${settings.beadsCommand}`,
		`beadsType         ${settings.beadsType}`,
		`beadsLabels       ${settings.beadsLabels.join(",") || "(none)"}`,
		`beadsPriority     ${settings.beadsPriority === null ? "(unset)" : String(settings.beadsPriority)}`,
	];
	return lines.join("\n");
}
