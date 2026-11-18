# Contributing

Issues and pull requests are welcome at <https://github.com/feifandiv/dsh-unread-badge>.

Ground rules for this codebase:

- **Stay renderer-side.** No Host route, no disk writes, no new data source. Every fact comes from `uiSession.sessionStatus`, `sessions.list`, `uiWorkspace.workspaces.list` and the `api-session/error` event. The only local state is preferences and the history list, both in `localStorage`.
- **Stay on the seams.** Only take the official seats: `sidebar.footer.action`, `settings.general.item` and `shell.overlay`. Do not replace layout, fork built-in plugins, or touch another plugin's data.
- **No Harness package imports** from plugin code. React comes from the client module table; everything else is plain DOM and `localStorage`.
- Style with `--dsw-alias-*` theme tokens and keep the two locale dictionaries (zh/en) in sync — every visible string goes through the locale service.
- **DOM patches must degrade silently.** The workspace dot and the sidebar-shape detection are best-effort; a changed selector may make a decoration disappear, but it must never throw or block a native feature.
- Keep the history cap at three entries and the panel's per-group cap at thirty unless the change is explicitly about those numbers.
- Run `node --check client.js` and `node test/smoke.mjs` before submitting; keep the smoke test green and extend it for new behaviour.
