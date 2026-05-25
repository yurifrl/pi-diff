# pi-diff

GitHub-style diff review for pi. Open a unified or split diff in the browser of your choice, comment on lines/files/PR overall, and either drop the feedback into your prompt editor or emit ready-to-run [beads](https://github.com/anthropics/beads) `bd create` commands so each comment becomes a tracked task.

## Install

### Single binary (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/yurifrl/pi-diff/main/install.sh | bash
# or pin a version
curl -fsSL https://raw.githubusercontent.com/yurifrl/pi-diff/main/install.sh | bash -s -- --version v0.1.0
```

Manual download: grab the right asset for your OS/arch from the [Releases page](https://github.com/yurifrl/pi-diff/releases) and put it on your `PATH`. Verify it with the matching `.sha256` (or against `SHA256SUMS`).

### From source (dev)

This repo uses [Task](https://taskfile.dev) for build scripts (`brew install go-task`).

```bash
git clone https://github.com/yurifrl/pi-diff.git
cd pi-diff
task install            # npm install
task build              # web bundle + tsc
task test               # vitest (93 tests)
task build:binary       # bun-compiled single-file binary at ./pi-diff
task install:local      # copies the binary into ~/.local/bin
task dev -- uncommitted # run the CLI from source via tsx, no rebuild
```

The full task list is `task --list`.

## Use as a pi extension

The same code is also a [pi](https://github.com/earendil-works/pi-coding-agent) extension. When loaded by pi it registers three slash commands:

- `/diff` — open the diff viewer for a chosen target (uncommitted / branch / commit)
- `/diff-settings` — show or update settings (`viewer`, `output`, `beads*`, …)
- `/diff-backups list` — list past comment-send backups

### Install into pi

```bash
# from a clone (recommended for now — installs everything pi needs in one step)
cd /path/to/pi-diff
task install            # npm install (also pulls react, ink, esbuild, react-diff-view)
task build              # produces dist/ and web/dist/ that index.ts depends on
```

Then point your pi config at this directory. In `~/.pi/config.toml` (or whichever pi config you use), add:

```toml
[[extensions]]
path = "/absolute/path/to/pi-diff"
```

pi will read `package.json#pi.extensions` (`./index.ts`) and load it natively (pi loads `.ts` extensions directly — no compile step required for the extension entry, though you do need the bundled `web/dist/` for the viewer to render).

Alternatively, drop a symlink under `~/.pi/agent/npm/node_modules/`:

```bash
mkdir -p ~/.pi/agent/npm/node_modules
ln -s "$(pwd)" ~/.pi/agent/npm/node_modules/pi-diff
```

### Verify

Open pi in any git repo and run `/diff`. The settings command also works as a quick smoke test:

```
/diff-settings show
```

Settings live in two layers — `~/.pi/agent/extensions/pi-diff.json` (global) and `<repo>/.pi/extensions/pi-diff.json` (project, overrides global). Both accept JSONC.

The extension and the standalone CLI share the same `core/` library, so any behavior you configure (output mode, beads command, etc.) applies identically to both.

## Commands

- `/diff [target]` — opens the diff viewer using the viewer configured in settings.
- `/diff-settings` — show or update settings (see below).

### Targets

- `uncommitted`
- `branch <name>`
- `commit <sha>`

If you omit args, the extension shows an interactive target picker.

Examples:

- `/diff uncommitted`
- `/diff branch main`
- `/diff commit abc123`

## Viewer behavior

- Continuous changed-files stream, similar to GitHub's changed-files view.
- Collapsible grouped-path sidebar with fuzzy search, status markers, comment badges, reviewed indicators.
- Unified/split toggle and wrap toggle.
- Line, file, and overall comments.
- Manual reviewed/unreviewed tracking persisted in browser storage per viewer token.
- Send individual comments from each draft textarea, use Cmd+Enter on macOS or Ctrl+Enter elsewhere, or send all unsent comments at once.

## Settings

Settings live in:

- Global: `~/.pi/agent/extensions/pi-diff.json`
- Project (overrides global): `<repo>/.pi/extensions/pi-diff.json`

Both files accept JSONC (comments + trailing commas).

Example `pi-diff.json`:

```jsonc
{
  "viewer": "cmux",        // "cmux" | "browser" | "none"
  "cmuxMode": "pane",      // "pane" | "surface"
  "defaultViewMode": "unified",
  "output": "beads",       // "prompt" | "beads"
  "beadsCommand": "bd",
  "beadsType": "task",
  "beadsLabels": ["code-review"],
  "beadsPriority": null
}
```

| Key                | Values                                | Default     | Notes |
| ------------------ | ------------------------------------- | ----------- | ----- |
| `viewer`           | `cmux`, `browser`, `none`             | `browser`   | Where to open the diff URL |
| `cmuxMode`         | `pane`, `surface`                     | `pane`      | Only used when `viewer = cmux` |
| `defaultViewMode`  | `unified`, `split`                    | `unified`   | Initial layout of the viewer |
| `output`           | `prompt`, `beads`                     | `prompt`    | How review comments are emitted |
| `beadsCommand`     | string                                | `bd`        | CLI used in the generated commands |
| `beadsType`        | string                                | `task`      | Passed to `--type` |
| `beadsLabels`      | comma list (string)                   | `code-review` | Passed to `--labels` |
| `beadsPriority`    | number or `null`                      | `null`      | Passed to `--priority` if set |

### Show or update from inside pi

```
/diff-settings                          # show
/diff-settings viewer cmux              # save globally
/diff-settings --project output beads   # save in project
/diff-settings beadsLabels review,frontend
/diff-settings beadsPriority 2
/diff-settings beadsPriority null
```

## Output modes

- `prompt` (default): comments are formatted into a compact "Please address the following feedback" block and appended to your editor.
- `beads`: each comment is created **directly as a bead** by shelling out to `bd create --stdin --silent` (one process per comment). Title comes from the comment summary + location, description includes source target, location, excerpt, and full text. Labels, type, and priority come from settings. The list of created bead IDs is appended to the editor. If the `bd` binary is not on PATH, the extension falls back to `beads-script` and shows an error.
- `beads-script`: emits a script of `bd create …` commands, one per comment, appended to the editor (no execution). Useful when you want to review/edit the commands before running them, or when the agent is on a host without `bd`.

Example direct-creation summary:

```
Created 2 bead(s):
  bd-12345  foo.ts:42 fix nil deref
  bd-12346  consider extracting helper
```

## cmux

cmux is one of three viewer backends. When `viewer = cmux`, the extension uses `cmux identify` to find the current workspace and opens the diff in either a new browser pane (`cmuxMode = pane`) or a browser surface in the active pane (`cmuxMode = surface`). With `viewer = browser` or `viewer = none`, cmux is not required.

## CLI usage

The same review flow is available as a standalone CLI (`pi-diff`), independent
of the pi extension.

Install (one of):

```bash
npm i -g pi-diff
# or, from a checkout:
npm run build && node dist/cli.js --help
```

Examples:

```bash
pi-diff                                 # interactive target picker
pi-diff uncommitted                     # working tree vs HEAD
pi-diff branch main                     # merge-base of main vs HEAD
pi-diff commit abc123 --output beads    # one-off override of output mode
pi-diff settings show
pi-diff settings set output beads
pi-diff settings set --project viewer browser
pi-diff backups list
```

Flags for the main flow (override settings for this run only, never persisted):
`--viewer cmux|browser|none`, `--output prompt|beads|beads-script`,
`--cwd <path>`, `--no-open` (just print the URL).

End-of-flow behavior mirrors the extension:

- `prompt` (default) — the formatted comment block is printed to stdout under
  a `--- pi-diff comments ---` header. Pipe it into your editor or the agent
  of your choice.
- `beads` — prints a numbered summary, then asks `Create N bead(s)? [y/N]`.
  On `y`, runs `bd create` for each comment and prints the resulting bead IDs.
  On `n`, emits the equivalent `bd create` script you can run later.
- `beads-script` — always emits the script, never executes `bd`.

All runs append to the same `~/.pi/agent/sessions/_ephemeral/*.pi-diff.json`
backup that `pi-diff backups list` reads.

## Local development

```bash
pnpm install
pnpm run build
pnpm test
```

To load locally, symlink this directory into `~/.pi/agent/extensions/pi-diff` and run `/reload` in pi.
