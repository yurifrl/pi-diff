---
name: run-pi-diff
description: "Build, run, drive, and screenshot pi-diff — the CLI + browser diff-review tool. Use to run pi-diff, start its server, register diffs as PR tabs, link beads, test the HTTP API, or smoke-test changes."
---

pi-diff is a GitHub-style **diff-review** tool with two surfaces: a Node/Bun
**CLI** (`dist/cli.js`, compiled to a single binary) and a **browser viewer**
(React, served over localhost HTTP). It also loads into pi as an extension
(`index.ts`). Two run shapes exist: **single-shot** (one process owns one diff
and blocks in an Ink TUI) and **server / PR mode** (one persistent server hosts
many diffs, each in its own browser tab).

The agent path is the driver — a Node smoke script that launches the server,
registers a diff, and asserts the whole HTTP surface. There is no GUI to click
programmatically beyond that; the browser viewer is plain HTML+fetch against the
same endpoints the driver hits.

> All paths below are relative to the repo root (the `pi-diff/` directory).

## Prerequisites

- Node (this repo was driven on Node 24) and `npm`. No `apt-get` needed on macOS/Linux.
- `bd` (beads) only if you exercise the linked-bead flow; everything else works without it.

## Build

`dist/` and `web/dist/` must exist before the CLI can serve the viewer.

```bash
npm run build      # tailwind -> web/styles.generated.css, esbuild web bundle, tsc -> dist/
```

`npm run build` runs `scripts/build-web.mjs` (Tailwind v4 CLI + esbuild) then
`tsc -p tsconfig.json`. Source edits to `web/**` need a rebuild before the
server serves them.

## Run (agent path) — the driver

The driver launches `pi-diff serve`, registers a diff, and checks
sessions/bootstrap/beads/shell endpoints, then shuts the server down and
confirms cleanup. It is **non-destructive** (links a bead read-only, only
exercises the invalid-status validation path — never creates or mutates beads).

```bash
npm run build
node .claude/skills/run-pi-diff/driver.mjs
# override the bead it links (default: pi-diff-idr):
PI_DIFF_DRIVER_BEAD=bd-123 node .claude/skills/run-pi-diff/driver.mjs
```

Expected tail: `DRIVER PASSED`. The driver reads the server port from
`~/.pi/agent/pi-diff-server.json`, so it never needs a hard-coded port.

### Drive it by hand (curl)

```bash
node dist/cli.js serve --no-open &                      # start the server
PORT=$(node -e "console.log(require(require('os').homedir()+'/.pi/agent/pi-diff-server.json').port)")
node dist/cli.js commit HEAD --name "My PR" --bead pi-diff-idr   # register a tab, exits immediately
curl -s http://127.0.0.1:$PORT/api/sessions | python3 -m json.tool
TOKEN=$(curl -s http://127.0.0.1:$PORT/api/sessions | python3 -c "import json,sys;print(json.load(sys.stdin)['sessions'][0]['token'])")
curl -s http://127.0.0.1:$PORT/api/viewer/$TOKEN | python3 -m json.tool   # bootstrap: name, linkedBeads, files
kill %1                                                  # SIGTERM clears the state file
```

## CLI reference (everything)

```
pi-diff [target] [flags]      open the diff viewer for a target
pi-diff serve [flags]         run a persistent server; later diffs become tabs
pi-diff settings show
pi-diff settings set [--project|--global] <key> <value>
pi-diff backups list
pi-diff --help | --version
```

`node dist/cli.js --help` prints the full text. Verified subcommands:

- **`node dist/cli.js --version`** → prints `pi-diff <version>`.
- **`node dist/cli.js --help`** → full usage (targets, PR mode, all flags).
- **`node dist/cli.js settings show`** → current merged settings.
- **`node dist/cli.js backups list`** → past comment-send backups under `~/.pi/agent/sessions/`.

### Targets
- `uncommitted` — working tree vs HEAD (errors if there are no changes).
- `branch <name>` — merge-base of `<name>` vs HEAD.
- `commit <sha>` — `<sha>` vs its parent (use `HEAD` to diff the last commit; works on any repo with a commit).
- (no target) — interactive Ink picker.

### Main-flow flags
- `--name <title>` — PR/tab title (default: target label).
- `--bead <id>` — link an existing bead; repeatable, or comma-list `--bead a,b`.
- `--viewer cmux|browser|none` — where to open the URL.
- `--output prompt|beads|beads-script` — how comments are emitted.
- `--cwd <path>` — run as if from `<path>`.
- `--no-open` — print the URL, open nothing.
- `--no-server` — ignore any running server; force single-shot.
- `--auto-submit` — process the first browser submission and exit (skips the manager TUI; also skips server registration).

### `serve` flags
- `--cwd <path>` — base directory for the server process.
- `--viewer cmux|browser|none` — how to open the multi-tab page on start.
- `--no-open` — just print the URL.

## Server / PR mode — how it fits together

- `pi-diff serve` binds a random localhost port, serves the multi-tab shell at
  `/`, and writes `{port,pid,startedAt}` to `~/.pi/agent/pi-diff-server.json`.
- `pi-diff <target> --name … --bead …` reads that file; if the server is alive
  (pid check + `GET /api/sessions` ping) it `POST`s the diff to `/api/register`
  and exits, printing the tab URL. Otherwise it falls back to single-shot.
- The **serve process owns output**: comment submissions print from *its* stdout
  (`output: prompt`) or create beads (`output: beads`); linked-bead status
  changes are applied by it via `bd update <id> --status <new>`.
- In the viewer, the **Linked beads** panel shows each `--bead` with a status
  dropdown (`open` / `in_progress` / `blocked` / `deferred` / `closed`); Apply
  posts to `/api/viewer/:token/beads`.

### HTTP surface (all verified by the driver)
- `GET  /` — multi-tab shell page (`window.__PI_DIFF_SHELL__ = true`).
- `GET  /viewer/:token` — single-diff page.
- `GET  /api/sessions` — `{ sessions: [{token,name,url,targetLabel,createdAt,linkedBeadCount}] }`.
- `POST /api/register` — body = `RegisterDiffPayload`; returns `{token,url}` (only when serve supplied `onRegister`).
- `GET  /api/viewer/:token` — bootstrap (`name`, `linkedBeads`, `files`, …).
- `GET  /api/viewer/:token/files/:fileId` — one file's diff payload.
- `POST /api/viewer/:token/send` — `{comments}`; emitted by the owning process.
- `POST /api/viewer/:token/beads` — `{changes:[{id,status}]}`; applies bead state.
- `POST /api/viewer/:token/done` — marks the review finished.

## Test

```bash
./node_modules/.bin/vitest run tests/*.test.ts    # 104 tests
```

Use the local binary, not `npx vitest` (see Gotchas).

## Run (human path)

`node dist/cli.js uncommitted` (or via the installed `pi-diff` binary) starts a
server, opens the viewer per your `viewer` setting, and **blocks** in the Ink
TUI until you finish in the browser. Useless headless — there's no terminal to
drive. For automation use `serve` + the driver instead.

## Gotchas

- **`npx vitest` triggers a pnpm install hook and fails** in this repo. Always
  run `./node_modules/.bin/vitest run tests/*.test.ts` directly.
- **`tsc` excludes `tests/` and `web/`** (see `tsconfig.json`). Type errors in
  those dirs only surface through the esbuild bundle (`npm run build`), not
  `npx tsc --noEmit`. Run both.
- **`uncommitted` errors with "no uncommitted changes"** on a clean tree. The
  driver uses `commit HEAD` so it works regardless of working-tree state.
- **Registration is skipped under `--auto-submit`** and `--no-server`; those
  always run single-shot even if a server is up.
- **Output mode is per-repo.** This repo's settings use `output: beads`, so a
  real comment submission creates a real bead. The driver avoids `/send` for
  that reason and only tests the bead-status validation path.
- **The state file is the discovery mechanism.** If a serve process is killed
  with `SIGKILL` (not `SIGTERM`/`SIGINT`) the file is left behind; the next
  `pi-diff` run detects the dead pid, clears the file, and falls back to
  single-shot — so a stale file is self-healing, not fatal.

## Troubleshooting

- **`pi-diff: not a git repository`** — run inside a git repo or pass `--cwd <repo>`.
- **Viewer shows nothing / 404 on assets** — `web/dist/` is missing; run `npm run build`.
- **`a server is already running`** from `pi-diff serve` — another serve owns the
  state file; open the printed URL or kill that pid first.
- **Linked beads show as empty** — `bd` isn't installed/initialized, or the IDs
  don't exist; `loadBeads` degrades to `[]` silently by design.
