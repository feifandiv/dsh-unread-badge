# Releasing

1. Bump `version` in `package.json` (SemVer) and add a `CHANGELOG.md` entry.
2. `node --check client.js && node test/smoke.mjs` — all green.
3. `npm publish --dry-run` — check the packed file list matches `files` in `package.json` (runtime files, icon, README, LICENSE, CHANGELOG).
4. `npm publish` (already logged in as `fanfan4589`; `publishConfig.access` is `public`). Wait for registry propagation before `npm view` — a 404 right after publish is normal, do not republish.
5. Commit, tag `v<version>`, push with tags:

   ```bash
   git add -A && git commit -m "release: v<version>"
   git tag "v<version>"
   git push origin main --tags
   ```

This bundle is installed from the checkout through a `link:` dependency. Users who install from npm get the published tarball; after upgrading, reload the page once to pick up the new client module.
