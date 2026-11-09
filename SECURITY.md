# Security Policy

## Supported versions

Security fixes target the latest tagged release (`v1.8.x` at the time of this document). Older versions may not receive fixes; upgrade before requesting security support.

## Reporting a vulnerability

Do not publish exploit details, proof-of-concept payloads, credentials, private files or customer data in a public issue. Use GitHub's **Report a vulnerability** feature under the repository Security tab if private vulnerability reporting is enabled. Otherwise contact the repository maintainer privately through GitHub.

Include the affected version, deployment configuration, impact, reproduction steps and sanitized logs. Allow time for investigation and a fix before public disclosure. No formal bounty or response SLA is offered.

## Security boundaries

- The WebSocket server is trusted with plaintext workspace content. Transport TLS protects data in transit; it is not end-to-end encryption.
- The server is designed to bind to localhost behind a TLS reverse proxy for remote clients.
- Use `wss://` on untrusted networks. Do not expose plain `ws://`.
- Workspace tokens are random secrets; member tokens are stored as salted scrypt hashes. The bootstrap token is stored in `/etc/jelo-colab.env` with restrictive permissions.
- Workspace paths are relative; traversal, symlinks and special files are rejected. Built-in exclusions block common secret files and generated directories.
- The service account should be the only writer to the data directory. Do not expose `access.json`, `audit.jsonl`, workspace files or upload partials over HTTP.
- Keep the operating system, Node.js and reverse proxy updated. Restrict ports 80/443 to intended users where practical and keep SSH protected.
- Backups contain workspace content and authentication configuration. Treat backup archives as sensitive secrets, store them encrypted/off-host where appropriate, and test restore on a staging host.

## Operational controls

The application validates workspace membership and roles on the server, enforces per-role write permissions, size limits, control/bulk rate limits, checksums and bounded concurrent transfer quotas. Operational/security events are written to the local audit log. These controls reduce risk but do not replace host hardening, network controls, dependency review or an independent security assessment.
