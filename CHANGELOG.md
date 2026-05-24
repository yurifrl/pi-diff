# Changelog

## Unreleased

- Added comment-send backups. Every `/diff` send is persisted to `~/.pi/agent/sessions/<slug>/<base>.pi-diff.json` (sibling of the pi session log) before any output dispatch. Each attempt records the full untruncated comment text, the target, the output mode, and the result (created beads or failures). Failures during `bd` no longer lose comments.
- Added `/diff-backups list` command to enumerate all backup files newest-first, showing attempt count, failures, and pending sends.

## 0.1.0

- Forked from `@siddr/pi-diff-cmux@0.1.3`.
- Renamed package to `pi-diff`. Removed cmux from the public surface.
- Single command `/diff [target]` replaces `/diff-cmux-pane` and `/diff-cmux-surface`.
- Added `/diff-settings` to show/update settings from inside pi.
- Configurable viewer backend via `viewer` setting:
  - `browser` (default) opens the URL in the system default browser.
  - `cmux` uses the original cmux pane/surface flow (`cmuxMode` selects).
  - `none` only prints the URL.
- Configurable output mode:
  - `prompt` (default) keeps the original "address the following feedback" prompt block.
  - `beads` directly creates one bead per comment via `bd create --stdin --silent`. Bead IDs are appended to the editor. Falls back to `beads-script` if `bd` is not on PATH.
  - `beads-script` emits a `bd create …` shell script appended to the editor for review/run.
- Settings live at `~/.pi/agent/extensions/pi-diff.json` with project-level override at `<repo>/.pi/extensions/pi-diff.json` (JSONC tolerated).
