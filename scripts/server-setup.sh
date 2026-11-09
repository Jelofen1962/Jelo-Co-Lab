#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${JELO_REPO:-Jelofen1962/Jelo-Co-Lab}"
BRANCH="${JELO_BRANCH:-main}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
SCRIPT_DIR=""
if [[ "${BASH_SOURCE[0]:-}" != "-" && -f "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi
INSTALL_DIR="/opt/jelo-colab"
DATA_DIR="/var/lib/jelo-colab"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/server-setup.sh | sudo bash" >&2
  exit 1
fi
command -v apt-get >/dev/null 2>&1 || { echo "This guided setup supports Ubuntu/Debian servers." >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "This guided setup requires systemd (systemctl)." >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo "systemd is not running. Use a supported Ubuntu/Debian host with systemd enabled." >&2; exit 1; }

INTERACTIVE=0
if [[ -r /dev/tty && -w /dev/tty ]]; then INTERACTIVE=1; fi
if [[ "$INTERACTIVE" -eq 0 ]]; then
  if [[ -z "${JELO_WORKSPACE_ID:-}" || -z "${JELO_ADMIN_USER_ID:-}" || "${JELO_CONFIRM:-}" != "yes" ]]; then
    echo "No controlling terminal detected. Set JELO_WORKSPACE_ID, JELO_ADMIN_USER_ID, and JELO_CONFIRM=yes for non-interactive setup." >&2
    exit 2
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
PREREQUISITES=(ca-certificates curl util-linux openssl)
if [[ "$INTERACTIVE" -eq 1 ]]; then PREREQUISITES+=(whiptail); fi
apt-get install -y --no-install-recommends "${PREREQUISITES[@]}"

TITLE="Jelo Co-Lab Server Setup"

# whiptail normally writes its selected value to stderr. Route that value to
# stdout for command substitution, and attach the dialog to the controlling
# terminal so `curl | sudo bash` still works when the caller has a TTY.
ui() {
  [[ "$INTERACTIVE" -eq 1 ]] || { echo "Interactive setup requires a controlling terminal." >&2; return 2; }
  command whiptail "$@" </dev/tty 3>&1 1>&2 2>&3
}

if [[ "$INTERACTIVE" -eq 1 ]]; then
  ui --title "$TITLE" --msgbox "Welcome to Jelo Co-Lab.\n\nThis guided setup installs Node.js, downloads and verifies the server release, runs checks and tests, creates the first workspace administrator, validates service health, and displays network addresses.\n\nSupported server platform: Ubuntu/Debian with systemd." 16 74
  VERSION="$(ui --title "$TITLE" --inputbox "Release tag to install (leave empty for latest GitHub release):" 10 74 "${JELO_VERSION:-}")" || exit 1
  WORKSPACE="$(ui --title "$TITLE" --inputbox "Initial workspace ID (letters, numbers, _ and -):" 10 74 "${JELO_WORKSPACE_ID:-team-workspace}")" || exit 1
  ADMIN="$(ui --title "$TITLE" --inputbox "Initial administrator user ID:" 10 74 "${JELO_ADMIN_USER_ID:-admin}")" || exit 1
  DOMAIN="$(ui --title "$TITLE" --inputbox "Optional public DNS domain for automatic HTTPS/WSS. Leave blank to configure TLS later:" 10 74 "${JELO_DOMAIN:-}")" || exit 1
else
  VERSION="${JELO_VERSION:-}"
  WORKSPACE="${JELO_WORKSPACE_ID:-}"
  ADMIN="${JELO_ADMIN_USER_ID:-}"
  DOMAIN="${JELO_DOMAIN:-}"
fi

if [[ -n "$VERSION" && ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  if [[ "$INTERACTIVE" -eq 1 ]]; then ui --title "$TITLE" --msgbox "Invalid release tag: $VERSION" 8 60 || true; fi
  echo "Invalid release tag: $VERSION" >&2
  exit 1
fi
VERSION="${VERSION#v}"
for value in "$WORKSPACE" "$ADMIN"; do
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
    if [[ "$INTERACTIVE" -eq 1 ]]; then ui --title "$TITLE" --msgbox "Invalid workspace or administrator ID." 8 60 || true; fi
    echo "Invalid workspace or administrator ID." >&2
    exit 1
  fi
done
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; then
  if [[ "$INTERACTIVE" -eq 1 ]]; then ui --title "$TITLE" --msgbox "Invalid DNS hostname." 8 60 || true; fi
  echo "Invalid DNS hostname: $DOMAIN" >&2
  exit 1
fi

VERSION_LABEL="${VERSION:-latest}"
SUMMARY="Release: ${VERSION_LABEL}\nWorkspace: ${WORKSPACE}\nFirst admin: ${ADMIN}\nDomain: ${DOMAIN:-not configured}\n\nThe installer binds the application to localhost. Remote access is enabled only through a TLS reverse proxy."
if [[ "$INTERACTIVE" -eq 1 ]]; then
  ui --title "$TITLE" --yesno "Review setup:\n\n${SUMMARY}\n\nContinue?" 18 74 || exit 1
else
  printf '%b\n' "$SUMMARY"
  [[ "${JELO_CONFIRM:-}" == "yes" ]] || { echo "Set JELO_CONFIRM=yes to approve non-interactive installation." >&2; exit 2; }
fi

BOOTSTRAP_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
log() { printf '\n\033[1;36m[Jelo Setup]\033[0m %s\n' "$*"; }

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/install-server.sh" ]]; then
  log "Using the bundled checksum-verifying server installer"
  cp "$SCRIPT_DIR/install-server.sh" "$TMP/install-server.sh"
else
  log "Downloading the verified server installer from ${REPO}/${BRANCH}"
  curl -fsSL --retry 3 "${RAW_BASE}/scripts/install-server.sh" -o "$TMP/install-server.sh"
fi
chmod 0700 "$TMP/install-server.sh"

log "Installing server release ${VERSION_LABEL}; staging tests and SHA-256 checks run before activation"
if [[ -n "$VERSION" ]]; then
  COLLAB_TOKEN="$BOOTSTRAP_TOKEN" JELO_VERSION="v${VERSION}" JELO_REPO="$REPO" bash "$TMP/install-server.sh"
else
  COLLAB_TOKEN="$BOOTSTRAP_TOKEN" JELO_REPO="$REPO" bash "$TMP/install-server.sh"
fi

[[ -x /usr/bin/node && -f "${INSTALL_DIR}/manage-access.js" ]] || { echo "Server installation did not produce the expected runtime files." >&2; exit 1; }
log "Creating the initial workspace administrator"
ADMIN_INVITATION="$(runuser -u jelo-colab -- env DATA_DIR="$DATA_DIR" /usr/bin/node "${INSTALL_DIR}/manage-access.js" add "$WORKSPACE" "$ADMIN" admin)"
INVITATION_FILE="/root/jelo-colab-${WORKSPACE}-${ADMIN}-invitation.txt"
printf '%s\n' "$ADMIN_INVITATION" > "$INVITATION_FILE"
chmod 0600 "$INVITATION_FILE"

if [[ -n "$DOMAIN" ]]; then
  log "Configuring Caddy TLS for ${DOMAIN}"
  bash "${INSTALL_DIR}/scripts/configure-caddy.sh" "$DOMAIN"
fi

log "Running final service and health checks"
systemctl is-active --quiet jelo-colab
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/healthz -o "$TMP/health.json"; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:3000/healthz -o "$TMP/health.json"
HEALTH="$(cat "$TMP/health.json")"
LAN_IPS="$(hostname -I 2>/dev/null | xargs || true)"
LAN_IPS="${LAN_IPS:-No LAN address detected}"
PUBLIC_IP=""
LOOKUP_PUBLIC_IP="${JELO_LOOKUP_PUBLIC_IP:-false}"
if [[ "$INTERACTIVE" -eq 1 ]]; then
  if ui --title "$TITLE" --yesno "Look up this server's public IP using api.ipify.org? This contacts a third-party IP lookup service." 10 74; then
    LOOKUP_PUBLIC_IP="true"
  fi
fi
if [[ "$LOOKUP_PUBLIC_IP" == "true" ]]; then
  if curl -fsS --max-time 4 https://api.ipify.org -o "$TMP/public-ip" 2>/dev/null; then PUBLIC_IP="$(cat "$TMP/public-ip")"; fi
fi

cat > "$TMP/final.txt" <<INFO
Jelo Co-Lab installation completed.

Release: ${VERSION_LABEL}
Workspace: ${WORKSPACE}
Admin user: ${ADMIN}
Invitation token file: ${INVITATION_FILE}

Health: ${HEALTH}
LAN addresses: ${LAN_IPS}
Public IP: ${PUBLIC_IP:-not detected (optional lookup unavailable)}

Local endpoint: ws://127.0.0.1:3000 (local development only)
Remote endpoint: ${DOMAIN:+wss://${DOMAIN}}${DOMAIN:-configure a DNS name and TLS with the server manager}

Server manager: sudo jelo-colab
Live logs: sudo journalctl -u jelo-colab -f
Health check: curl http://127.0.0.1:3000/healthz

The administrator invitation token is shown in the secure root-only file above.
Copy it into VS Code SecretStorage during Jelo Co-Lab onboarding. Do not commit or share it publicly.
INFO
if [[ "$INTERACTIVE" -eq 1 ]]; then
  ui --title "$TITLE · Complete" --textbox "$TMP/final.txt" 24 86
  if ui --title "$TITLE" --yesno "Open the server management TUI now?" 8 60; then
    /usr/local/bin/jelo-colab
  fi
else
  cat "$TMP/final.txt"
fi
