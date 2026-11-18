# dsh-unread-badge

[![npm](https://img.shields.io/npm/v/@fanfan4589/dsh-unread-badge)](https://www.npmjs.com/package/@fanfan4589/dsh-unread-badge) [![license](https://img.shields.io/npm/l/@fanfan4589/dsh-unread-badge)](./LICENSE)

English · [中文](./README.zh.md)

Adds the two things DeepSeek Harness does not answer on its own: **what is unread** and **where the work is**. A **Dock number badge**, a **task overview at the sidebar foot** (running / blocked / done, click through to the session), a **coloured dot on every Workspace row**, a **floating handle on the left edge while the sidebar is collapsed**, and **the last three sessions you visited**.

> Pure renderer-side patch: no Host route, no disk writes, no new data source. Every fact comes from the host's own `sessionStatus` / `sessions.list` / `workspaces.list`.

> **Scope — a restrained patch.** It does these few things and does not touch the DSH core: it only takes official extension seats (`sidebar.footer.action`, `settings.general.item`, `shell.overlay`) and never replaces layout, changes kernel behaviour or touches another plugin's data. Upgrading DSH normally needs no change here; disable or remove the plugin and the official UI is back.

## What it does

| Need | Implementation |
| --- | --- |
| The red number on the app icon = unread tasks | `navigator.setAppBadge(n)`: a finished reply you have not opened, or a run that errored, counts as one unread; all cleared once opened |
| A task overview at the sidebar foot | A persistent row in the `sidebar.footer.action` seat: `2 running · 1 blocked · 3 done`; open it for groups (blocked / failed / running / done) and click any row to jump to that session |
| A floating handle while the sidebar is collapsed | A small edge handle in the `shell.overlay` seat (only while the sidebar is collapsed): click for the same task panel, drag it up or down, position remembered locally |
| The last three sessions you visited | Automatically remembers the three sessions you actually opened (from the sidebar, from history, or from anywhere else) in `localStorage`; survives reloads; hide one or clear all |
| A dot on collapsed workspaces | A 7 px dot inserted at the right edge of every `data-row-key="workspace:<id>"` row, coloured by the group's status |
| Sound | Not reimplemented: it coexists with `dsh-notify-me` / `dsh-plugin-notify-sounds` and stays **silent**, so you never get a double chime |

Colour priority (one row shows only the highest-priority dot):

| Colour | Meaning |
| --- | --- |
| 🔴 Red | A session in the group **failed** (`api-session/error`) |
| 🟢 Green | The group has a **finished but unopened** reply |
| 🔵 Blue (breathing) | A session in the group is **running** (can be turned off in Settings) |

"Already seen" reuses the host's own verdict: the session is showing in the main view (`retainedBy.mainView > 0`) or the host cleared `completionUnread`. Failures have no native unread slot, so the plugin tracks them itself and clears on open; starting a new run in the same session also clears the previous failure mark.

Subagent sessions are ignored by default — they are steps of the turn you started, not tasks of yours. Archived sessions are ignored too.

## Task overview in the sidebar

A persistent row at the very bottom of the sidebar (above Settings), sharing the seat with DSH's own "Automated tasks":

```
● Tasks                            2 running · 1 blocked · 3 done
```

Clicking it opens a 320 px popover upwards with four priority-ordered groups:

```
Tasks
  Blocked 1
    ◐ Fix expired login       waiting for approval · dsh-unread-badge   3 min
  Running 2
    ● Refactor plugin panel   dsh-unread-badge                        12 min
    ● Proofread transcript    copy project                            4 min
  Done 3
    ✓ Generate weekly report  daily                                    8 min
  Recent                                        Clear
    ○ Weekly report read      daily                                   just now
```

| Group | Rule | Colour |
| --- | --- | --- |
| **Blocked** | `pendingInteraction`: approval / plan review / question all count | Amber |
| **Failed** | The run errored (`api-session/error`); cleared when opened | Red |
| **Running** | Running and not waiting for you | Blue (breathing) |
| **Done** | Finished but **never opened** (`completionUnread`); disappears on open | Green |
| **Recent** | The last three sessions you actually visited; only those not already in the four groups above | Neutral hollow ring |

- Click any row → `uiWorkspace.openSession(id)` opens that session and the popover closes; click outside or press `Esc` to close.
- Each row shows: status dot, session title (ellipsised), blocked reason and workspace name, relative time (how long it has run / waited).
- **Recent**: hovering a row reveals `×` to hide just that entry; "Clear" in the group header empties all of them. Clearing does not immediately write the current session back — recording resumes once you switch to another session.
- When the sidebar is a 56 px icon rail, only the icon and the "needs you" count remain (blocked + failed + done).
- Each group lists at most 30 rows; the rest show "N more".

## Floating handle while the sidebar is collapsed

Collapse the sidebar and the task row disappears with it — you had to expand the sidebar just to click a task. The floating handle covers that gap:

- Registered in `shell.overlay` (the frame-wide layer above every column), so it is **not affected by the sidebar width or `overflow`** and stays when the sidebar is fully hidden;
- Only appears while the sidebar is collapsed, and steps aside for the footer row once the sidebar is expanded — no duplication;
- Sits on the left edge, vertically centred, and **drags up and down**; the position is remembered (`dsh-unread-badge:float-top`);
- The button shows the "needs you" count (blocked + failed + done); the left edge uses the highest-priority colour;
- Clicking it opens the same task panel (history included); click any row to jump to that session;
- When the sidebar is a Windows-style 56 px icon rail, it moves to the right of the rail.

## History: the last three sessions

"Open a finished session → glance at it → get pulled away → come back and forget where I was" is what history catches:

- The trigger is not "which row you clicked" but the host's `retainedBy.mainView > 0` (the session the main view is showing). So every route counts: opened from the sidebar, reopened from history, or newly created;
- **Only three entries**, ordered by the last time you were there; deleted or archived sessions drop out automatically;
- Sessions already listed under blocked / failed / running / done are not repeated in history;
- Stored in `localStorage` (`dsh-unread-badge:history`), so reloads and restarts keep it;
- Each entry can be hidden on its own (`×` on hover) or cleared; the whole group can be switched off in Settings.

## Where the data comes from

```
uiSession.sessionStatus      Map<sessionId, {running, pendingInteraction, completionUnread}>
sessions.list                { ids, byId }  → retainedBy.mainView / origin / running
uiWorkspace.workspaces.list  { items: [{ workspaceId, sessionIds }] }  → which workspace a session belongs to
remote.$on('api-session/error')  (sessionId, message)                  → failure
retainedBy.mainView > 0      → the session the main view shows; history keys off it
data-sidebar-scrollport / data-sidebar-toggle  → sidebar expanded or collapsed (used by the floating handle)
```

The sidebar has no "workspace header row" slot (`sidebar.*` only has the session-row group), so the dot is a **DOM patch**: it locates the row through `data-row-key` and inserts before `row.lastElementChild`. If DSH changes either structure the dot disappears, but nothing throws and no native feature is affected.

## Install

From npm:

```bash
dsh plugin --profile <profile> add @fanfan4589/dsh-unread-badge
```

Or in the DSH desktop app: **Plugins** → add a plugin → point it at the checkout directory (for example `/absolute/path/to/dsh-unread-badge`), then refresh the window once.

Uninstall through Plugin Manager; preferences and history stay in `localStorage`.

## Settings

**Settings → General → Unread badge**:

- **Task overview in the sidebar**: master switch for the footer row;
- **Floating handle while the sidebar is collapsed**: master switch for the left-edge handle;
- **Dock number badge**: master switch;
- **Workspace dots**: master switch;
- **History (last 3 sessions)**: switches the history group; turning it off stops recording but keeps existing entries;
- **Show a blue dot for running sessions**: turn off to only surface unread and failed work.

Preferences live in `localStorage` under `dsh-unread-badge:prefs`.

## Self-check

In the DevTools console (⌘⌥I):

```js
__dshUnreadBadge.state()
// { badgeCount, badgeSupported, dock, dots, running, panel, float, history, recent, current, errors, workspaces }
__dshUnreadBadge.tasks()     // the snapshot the panel uses: { counts, groups, total }
__dshUnreadBadge.refresh()   // recompute immediately
__dshUnreadBadge.state().recent   // history entries [{ id, at }], newest first
__dshUnreadBadge.forget('id')     // hide one history entry
__dshUnreadBadge.clearHistory()   // clear history
```

- `badgeSupported: false` means the renderer has no `navigator.setAppBadge` (e.g. the web build is not installed as a PWA) — the badge is unavailable, the dots still work.
- `workspaces` exposes each workspace's current `{unread, error, running}` counts.

## Known limits

- **The Dock badge only works in the desktop app**: the web build must be installed as a Chrome PWA to have a Dock icon at all; a browser tab shows no badge.
- **No system notification permission is handled**: the badge does not go through the notification channel and needs no authorisation.
- **The dots are a DOM patch**: a major DSH sidebar restructure may need the selectors updated (`data-row-key` prefix / row-end action button).
- The workspace header row itself is not rendered in the 56 px rail, so its dots hide with it.
- **The task popover uses hand-computed anchors**: the sidebar clips `overflow`, so the popover is `position: fixed` above the trigger row and re-measures on resize/scroll. On very narrow windows it sticks to the edge and narrows to 240 px.
- **The floating handle infers the sidebar shape from DOM markers**: `[data-sidebar-scrollport]` (expanded) and the rail width measured from `[data-sidebar-toggle]`. A DSH sidebar restructure means updating those selectors; when detection fails it falls back to "expanded", so the handle stays hidden and nothing else breaks.
- **History is local**: it lives in `localStorage`, so another browser or a cache wipe loses it; only the session id and "last visited" time are stored, and titles always come from the live host.
- **Relative times refresh once a minute**; session titles resolve `title` → `displayTitle` → directory name → session id.

## Credits

This plugin is an independent implementation: no code was copied from other plugins. Two works in the same direction were read to confirm how the host APIs behave, and are credited here:

- **dsh-plugin-desktop-notify** (MIT, © chendaleiQ): the route of writing the Dock badge from the renderer through `navigator.setAppBadge()`, and the "unread = finished-unread + failed" fact model, were learned and verified from it.
- **dsh-notify-me** (MIT, © chromoany): reading host state safely from `uiSession.sessionStatus` / `sessions.list`, and the `inject` idiom, were informed by its implementation.

Both are MIT, so even snippet-level borrowing is permitted with attribution; this plugin is released under **MIT** itself, see [`LICENSE`](./LICENSE).

## Development

```sh
node --check client.js
node test/smoke.mjs      # offline smoke: host stubs + aggregation + dots + badge + error fallback + task snapshot (blocked/running/done/history + hiding history)
```

`client.js` is a module the browser can load directly (`window.__ModuleLoader__.load`); reload the page after edits, there is no build step. `index.js` is an empty Host half so the bundle row resolves.

## License

MIT © 2026 feifandiv
