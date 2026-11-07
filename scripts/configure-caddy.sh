#!/usr/bin/env bash
set -Eeuo pipefail
DOMAIN="${1:-}"
if [[ "${EUID}" -ne 0 ]]; then echo "Run as root: sudo $0 collab.example.com" >&2; exit 1; fi
[[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]] || { echo "Provide a valid public DNS hostname." >&2; exit 1; }
command -v apt-get >/dev/null 2>&1 || { echo "This helper supports Ubuntu/Debian." >&2; exit 1; }
command -v gpg >/dev/null 2>&1 || apt-get install -y gnupg
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl debian-archive-keyring apt-transport-https
install -d -m 0755 /etc/apt/keyrings
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
if [[ -f /etc/caddy/Caddyfile ]]; then cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup-$(date -u +%Y%m%dT%H%M%SZ)"; fi
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
CADDY
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy
cat <<INFO
Caddy is configured for ${DOMAIN}.
Ensure DNS A/AAAA records point to this server and inbound TCP ports 80 and 443 are reachable.
Configure the VS Code extension with: wss://${DOMAIN}
INFO
