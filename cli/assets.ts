// Bun-only embedded asset paths. This file is excluded from tsc
// (see tsconfig.json) and is only imported by cli.ts which runs under
// Bun (either via `bun cli.ts` or as a `bun build --compile` binary).
//
// The `with { type: "file" }` import attribute tells Bun to embed the
// file into the compiled binary and resolves the import to a string
// path that can be read at runtime via `Bun.file()` or fs.readFile.

// @ts-expect-error - Bun-only file import attribute
import jsPath from "../web/dist/app.js" with { type: "file" };
// @ts-expect-error - Bun-only file import attribute
import cssPath from "../web/dist/app.css" with { type: "file" };

export const embeddedAssets = {
	jsPath: jsPath as unknown as string,
	cssPath: cssPath as unknown as string,
};
