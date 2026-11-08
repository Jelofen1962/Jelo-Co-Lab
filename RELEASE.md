# Release preparation

This repository supports Windows and Ubuntu CI targets only.

Before committing a release, run the following from the repository root (with access to the public npm registry):

```bash
node scripts/prepare-release.cjs v1.7.12
node scripts/verify-release-version.cjs v1.7.12
(cd server && npm ci)
(cd vscode-extension && npm ci)
```

`verify-release-version.cjs` refreshes the official `ws@8.22.1` tarball URL and SHA-512 integrity directly from `https://registry.npmjs.org` before validating both packages. Do not hand-edit or fabricate npm integrity values.

Then commit the changed manifests and lockfiles and push the matching tag:

```bash
git add -A
git commit -m "Prepare release v1.7.12"
git tag v1.7.12
git push origin main --tags
```

Each clean GitHub Actions job repeats the tag alignment and metadata verification before running `npm ci`. Both Windows and Ubuntu Extension Host jobs must pass before the release is published.
