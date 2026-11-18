# Changelog

## 0.3.0 (2026-11-18)

- Sidebar task overview in `sidebar.footer.action`: blocked / failed / running / done groups, relative times, click-through to the session, 30 rows per group (this is the 0.2.0 work, folded in — it was never published)
- Floating handle in `shell.overlay` while the sidebar is collapsed: opens the same task panel, drags up and down, position persisted
- History: the last three sessions you actually visited (tracked through `retainedBy.mainView`), persisted in `localStorage`, de-duplicated against the live groups, per-entry hide and clear-all
- Settings: two new switches (floating handle, history)
- Subagent and archived sessions are excluded from counts, dots and history
- Docs: English and Chinese README, CHANGELOG, CONTRIBUTING, RELEASING

## 0.1.1 (2026-11-13)

- Point the bundle row and docs at the `@fanfan4589` package name
- Add npm and license badges

## 0.1.0 (2026-11-13)

- First public release: Dock number badge (finished-unread + failed) and a coloured dot on every Workspace row
- Settings switches for the Dock badge, workspace dots, and running-only dots
