import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let dir: string;
let originalHome: string | undefined;

async function importSettings() {
	return await import("../core/settings");
}

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-diff-settings-"));
	originalHome = process.env.HOME;
	process.env.HOME = path.join(dir, "home");
	await mkdir(process.env.HOME, { recursive: true });
});
afterEach(async () => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await rm(dir, { recursive: true, force: true });
});

describe("coerceSettings", () => {
	test("ignores unknown values", async () => {
		const { coerceSettings } = await importSettings();
		expect(coerceSettings({ viewer: "weird" })).toEqual({});
	});
	test("accepts known values", async () => {
		const { coerceSettings } = await importSettings();
		expect(coerceSettings({ viewer: "cmux", output: "beads", beadsLabels: ["a"] })).toEqual({
			viewer: "cmux",
			output: "beads",
			beadsLabels: ["a"],
		});
	});
});

describe("stripJsonc", () => {
	test("removes line/block comments and trailing commas", async () => {
		const { stripJsonc } = await importSettings();
		expect(JSON.parse(stripJsonc(`{ // c\n "a": 1, /* x */ "b": [1,2,], }`))).toEqual({ a: 1, b: [1, 2] });
	});
	test("does not mangle URLs", async () => {
		const { stripJsonc } = await importSettings();
		expect(JSON.parse(stripJsonc(`{"url": "https://example.com"}`))).toEqual({ url: "https://example.com" });
	});
});

describe("loadSettings", () => {
	test("reads global pi-diff.json", async () => {
		const { loadSettings, settingsPathFor } = await importSettings();
		const file = settingsPathFor("global", dir);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ viewer: "cmux", output: "beads" }), "utf8");
		const settings = await loadSettings(dir);
		expect(settings.viewer).toBe("cmux");
		expect(settings.output).toBe("beads");
	});

	test("project pi-diff.json overrides global", async () => {
		const { loadSettings, saveSettings } = await importSettings();
		await saveSettings("global", dir, { viewer: "cmux", output: "beads" });
		await saveSettings("project", dir, { viewer: "browser" });
		const settings = await loadSettings(dir);
		expect(settings.viewer).toBe("browser");
		expect(settings.output).toBe("beads");
	});

	test("falls back to defaults when nothing is set", async () => {
		const { loadSettings, DEFAULT_SETTINGS } = await importSettings();
		expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
	});

	test("tolerates JSONC comments", async () => {
		const { loadSettings, settingsPathFor } = await importSettings();
		const file = settingsPathFor("global", dir);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, `// header\n{ "viewer": "none" /* yes */, }\n`, "utf8");
		const settings = await loadSettings(dir);
		expect(settings.viewer).toBe("none");
	});
});

describe("saveSettings", () => {
	test("writes to ~/.pi/agent/extensions/pi-diff.json", async () => {
		const { saveSettings } = await importSettings();
		const file = await saveSettings("global", dir, { viewer: "cmux" });
		expect(file).toBe(path.join(process.env.HOME!, ".pi", "agent", "extensions", "pi-diff.json"));
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.viewer).toBe("cmux");
	});

	test("writes to <repo>/.pi/extensions/pi-diff.json for project location", async () => {
		const { saveSettings } = await importSettings();
		const file = await saveSettings("project", dir, { output: "beads" });
		expect(file).toBe(path.join(dir, ".pi", "extensions", "pi-diff.json"));
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.output).toBe("beads");
	});

	test("merges into existing file", async () => {
		const { saveSettings } = await importSettings();
		await saveSettings("global", dir, { viewer: "cmux", output: "prompt" });
		await saveSettings("global", dir, { output: "beads" });
		const file = path.join(process.env.HOME!, ".pi", "agent", "extensions", "pi-diff.json");
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw).toMatchObject({ viewer: "cmux", output: "beads" });
	});
});
