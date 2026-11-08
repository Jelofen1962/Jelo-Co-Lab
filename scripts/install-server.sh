#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${JELO_REPO:-Jelofen1962/Jelo-Co-Lab}"
VERSION="${JELO_VERSION:-}"
SERVICE="jelo-colab"
INSTALL_DIR="/opt/jelo-colab"
DATA_DIR="/var/lib/jelo-colab"
LOG_FILE="/var/log/jelo-colab-install.log"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root, for example: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install-server.sh | sudo bash" >&2
  exit 1
fi
command -v apt-get >/dev/null 2>&1 || { echo "Supported platforms: Ubuntu/Debian with apt-get." >&2; exit 1; }

install -d -m 0755 /var/log
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'status=$?; echo; echo "INSTALL FAILED (exit ${status}). Full log: ${LOG_FILE}"; exit "$status"' ERR

log() { printf '\n[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

log "Starting Jelo Co-Lab server installation"
log "Repository: ${REPO}"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip coreutils diffutils

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

TOKEN="${COLLAB_TOKEN:-}"
if [[ -z "$TOKEN" && -f /etc/jelo-colab.env ]]; then
  TOKEN="$(sed -n 's/^COLLAB_TOKEN=//p' /etc/jelo-colab.env | head -n 1)"
fi
if [[ -z "$TOKEN" && -r /dev/tty ]]; then
  read -rsp "Enter shared server token (minimum 24 safe characters): " TOKEN </dev/tty
  echo
fi
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  log "Generated a new random server token; it is stored in /etc/jelo-colab.env and is not printed to the install log."
fi
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]{24,256}$ ]] || { echo "Token must be 24-256 characters using letters, numbers, _ or -." >&2; exit 1; }

if [[ -n "$VERSION" ]]; then
  RELEASE_API="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
else
  RELEASE_API="https://api.github.com/repos/${REPO}/releases/latest"
fi
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

log "Resolving GitHub release asset"
RELEASE_JSON="$(curl -fsSL --retry 3 "$RELEASE_API")"
mapfile -t ASSETS < <(printf '%s' "$RELEASE_JSON" | node -e '
  let input=""; process.stdin.on("data", c => input += c).on("end", () => {
    const release=JSON.parse(input);
    const assetName=release.assets.find(a => /^jelo-colab-server-v.*\.zip$/.test(a.name));
    if (!assetName) process.exit(2);
    const checksum=release.assets.find(a => a.name === `${assetName.name}.sha256`);
    if (!checksum) process.exit(3);
    console.log(assetName.browser_download_url);
    console.log(checksum.browser_download_url);
    console.log(assetName.name);
  });
')
[[ "${#ASSETS[@]}" -eq 3 ]] || { echo "Could not locate the server ZIP and checksum in the selected GitHub release." >&2; exit 1; }
SERVER_URL="${ASSETS[0]}"
CHECKSUM_URL="${ASSETS[1]}"
ASSET_NAME="${ASSETS[2]}"

log "Downloading ${ASSET_NAME}"
curl -fL --retry 3 "$SERVER_URL" -o "$TMP/server.zip"
curl -fsSL --retry 3 "$CHECKSUM_URL" -o "$TMP/server.zip.sha256"
EXPECTED_HASH="$(awk '{print $1}' "$TMP/server.zip.sha256")"
ACTUAL_HASH="$(sha256sum "$TMP/server.zip" | awk '{print $1}')"
[[ "$EXPECTED_HASH" =~ ^[a-fA-F0-9]{64}$ && "$EXPECTED_HASH" == "$ACTUAL_HASH" ]] || { echo "Server ZIP checksum verification failed." >&2; exit 1; }
log "SHA-256 checksum verified"

while IFS= read -r entry; do
  [[ "$entry" == server/* && "$entry" != *"../"* && "$entry" != *"/.."* ]] || { echo "Unsafe path in release archive: ${entry}" >&2; exit 1; }
done < <(unzip -Z1 "$TMP/server.zip")
mkdir -p "$TMP/extracted"
unzip -q "$TMP/server.zip" -d "$TMP/extracted"
test -f "$TMP/extracted/server/index.js"
test -f "$TMP/extracted/server/package-lock.json"

log "Installing and testing the release in a temporary staging directory"
(
  cd "$TMP/extracted/server"
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund
  node -e 'const p=require("./package-lock.json").packages["node_modules/ws"]; if (p?.version !== "8.22.1" || !p.integrity) { console.error("Expected ws 8.22.1 with registry integrity metadata"); process.exit(1); }'
  npm ci --omit=dev --no-audit --no-fund
  npm run check
  npm test
)

log "Preparing service account and persistent data directory"
if ! id jelo-colab >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/jelo-colab --create-home --shell /usr/sbin/nologin jelo-colab
fi
install -d -o jelo-colab -g jelo-colab -m 0750 "$DATA_DIR"
# Refuse ambiguous data merges before stopping an existing service.
if [[ -d "$INSTALL_DIR/data/workspaces" && -d "$DATA_DIR/workspaces" ]] &&
   ! diff -qr "$INSTALL_DIR/data/workspaces" "$DATA_DIR/workspaces" >/dev/null; then
  echo "Legacy and new workspace data both exist and differ. Refusing to guess or overwrite either copy." >&2
  echo "Merge ${INSTALL_DIR}/data/workspaces into ${DATA_DIR}/workspaces manually, then rerun the installer." >&2
  exit 1
fi
if systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
  log "Stopping the existing service for a safe upgrade"
  systemctl stop "$SERVICE"
fi
# Migrate data created by the earlier Phase 1 installer, which stored it under /opt/jelo-colab/data.
if [[ -d "$INSTALL_DIR/data/workspaces" ]]; then
  if [[ ! -d "$DATA_DIR/workspaces" ]]; then
    log "Migrating existing workspace data to ${DATA_DIR}"
    cp -a "$INSTALL_DIR/data/." "$DATA_DIR/"
  fi
  install -d -m 0700 /var/backups
  LEGACY_BACKUP="/var/backups/jelo-colab-data-legacy-$(date +%Y%m%d%H%M%S)"
  mv "$INSTALL_DIR/data" "$LEGACY_BACKUP"
  log "Preserved legacy data copy at ${LEGACY_BACKUP}"
fi
chown -R jelo-colab:jelo-colab "$DATA_DIR"
chmod 0750 "$DATA_DIR"
install -d -o root -g root -m 0755 "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/node_modules"
cp -a "$TMP/extracted/server/." "$INSTALL_DIR/"
chown -R root:root "$INSTALL_DIR"
chmod -R a+rX "$INSTALL_DIR"

umask 077
printf 'COLLAB_TOKEN=%s\nHOST=127.0.0.1\nPORT=3000\nDATA_DIR=%s\n' "$TOKEN" "$DATA_DIR" > /etc/jelo-colab.env
chmod 0600 /etc/jelo-colab.env

cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=Jelo Co-Lab collaboration server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jelo-colab
Group=jelo-colab
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=/etc/jelo-colab.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ${INSTALL_DIR}/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT

log "Starting systemd service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
systemctl --no-pager --full status "$SERVICE"

log "Checking local health endpoint"
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/healthz; then
    echo
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:3000/healthz >/dev/null || { echo "Health check failed. See journalctl output below." >&2; systemctl --no-pager --full status "$SERVICE" || true; journalctl -u "$SERVICE" -n 100 --no-pager || true; exit 1; }

log "Installation completed successfully"
echo "Service status: sudo systemctl status ${SERVICE}"
echo "Live logs:      sudo journalctl -u ${SERVICE} -f"
echo "Recent logs:    sudo journalctl -u ${SERVICE} -n 200 --no-pager"
echo "Restart:        sudo systemctl restart ${SERVICE}"
echo "Health:         curl http://127.0.0.1:3000/healthz"
echo "Read token:     sudo awk -F= '/^COLLAB_TOKEN=/ {print \$2}' /etc/jelo-colab.env"
echo "Secret file:    sudoedit /etc/jelo-colab.env"
echo "Workspace data: ${DATA_DIR}/workspaces"
echo "Remote access:  configure HTTPS/WSS reverse proxy; do not expose plain ws:// to the internet."
