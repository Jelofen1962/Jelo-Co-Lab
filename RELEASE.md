# Release preparation

This repository supports Windows and Ubuntu CI targets only.

Before committing a release, run:

```bash
node scripts/prepare-release.cjs v1.7.10
(cd server && npm install --package-lock-only --ignore-scripts && npm ci)
(cd vscode-extension && npm install --package-lock-only --ignore-scripts && npm ci)
node scripts/verify-release-version.cjs v1.7.10
```

Then commit the changed manifests and lockfiles and push the matching tag:

```bash
git add server/package.json server/package-lock.json vscode-extension/package.json vscode-extension/package-lock.json
git commit -m "Prepare release v1.7.10"
git tag v1.7.10
git push origin main --tags
```

The GitHub release workflow also runs `scripts/prepare-release.cjs` against the tag in each clean job checkout as a defensive measure, refreshes lockfile integrity metadata from the npm registry, verifies both package manifests and lockfile roots, then runs `npm ci`. The helper scripts are checked into `scripts/` and included in the source archive.

`ws` is pinned to exactly `8.22.1` in both packages. Do not hand-edit or fabricate npm `integrity` values; npm generates them from registry metadata during lockfile refresh.
