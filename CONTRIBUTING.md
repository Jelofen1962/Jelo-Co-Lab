# Contributing to Jelo Co-Lab

Thanks for helping improve Jelo Co-Lab. Keep changes focused, testable and compatible with the supported VS Code and Node.js versions.

## Before opening a pull request

1. Explain the user-visible problem or security impact.
2. Keep protocol changes documented in `docs/PHASE-2-PROTOCOL.md` and add compatibility notes.
3. Add a regression test for each bug fix, especially in authentication, filesystem handling, OT and transfers.
4. Run the checks below.

```bash
cd server
node ../scripts/refresh-ws-lockfile.cjs
npm ci
npm run check
npm test

cd ../vscode-extension
node ../scripts/refresh-ws-lockfile.cjs
npm ci
npm run compile
```

For the Extension Host suite, install `@vscode/test-electron@2.5.2` without changing the lockfile and run `npm test`:

```bash
npm install --no-save --package-lock=false @vscode/test-electron@2.5.2
npm test
```

## Pull request guidelines

- Do not commit secrets, workspace data, VSIX packages, `node_modules`, or local VS Code state.
- Preserve the server's workspace-root and symlink protections.
- Do not reduce transfer quotas, message validation, authentication, or test coverage to make a test pass.
- Keep each PR focused. Large protocol changes should include a protocol version/compatibility assessment.
- Describe platform testing and known limitations in the PR description.

## Code of conduct

Be respectful, constructive, and welcoming. Harassment, discrimination, and personal attacks are not acceptable.
