# Security Policy

## Supported versions

Security fixes are developed against the latest tagged release.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Use GitHub's **Report a vulnerability** feature under the repository's Security tab, where private vulnerability reports are enabled, or contact the repository maintainer privately through GitHub.

Include the affected version, impact, reproduction steps, and any relevant logs with secrets removed. Do not include real workspace data, tokens, private keys, or personal information.

## Deployment guidance

- Keep the server bound to localhost behind a TLS reverse proxy for remote access.
- Use a unique, high-entropy server token and do not commit it.
- Restrict write access to the server data directory.
- Back up the server data directory before upgrades.
- Do not expose plain `ws://` to an untrusted network.
