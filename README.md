# pi-diff

GitHub-style diff review for pi. Open a unified or split diff in the browser of your choice, comment on lines/files/PR overall, and either drop the feedback into your prompt editor or emit ready-to-run [beads](https://github.com/anthropics/beads) `bd create` commands so each comment becomes a tracked task.

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

## Local development

```bash
pnpm install
pnpm run build
pnpm test
```

To load locally, symlink this directory into `~/.pi/agent/extensions/pi-diff` and run `/reload` in pi.
