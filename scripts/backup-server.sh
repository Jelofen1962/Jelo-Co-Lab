#!/usr/bin/env bash
set -Eeuo pipefail
SERVICE="${JELO_SERVICE:-jelo-colab}"
DATA_DIR="${DATA_DIR:-/var/lib/jelo-colab}"
ENV_FILE="${ENV_FILE:-/etc/jelo-colab.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/jelo-colab}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

[[ "${EUID}" -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS must be an integer." >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "flock is required (install util-linux)." >&2; exit 1; }
mkdir -p "$BACKUP_DIR" /run/lock
chmod 0700 "$BACKUP_DIR"
exec 9>/run/lock/jelo-colab-backup.lock
flock -n 9 || { echo "A Jelo Co-Lab backup/restore is already running." >&2; exit 1; }
[[ -d "$DATA_DIR" ]] || { echo "Data directory not found: $DATA_DIR" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Environment/secret file not found: $ENV_FILE" >&2; exit 1; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/jelo-colab-$STAMP.tar.gz"
WAS_ACTIVE=0
if systemctl is-active --quiet "$SERVICE"; then WAS_ACTIVE=1; systemctl stop "$SERVICE"; fi
restart_service() { if [[ "$WAS_ACTIVE" -eq 1 ]]; then systemctl start "$SERVICE"; fi; }
trap restart_service EXIT

tar --numeric-owner -czf "$OUT" -C / "${DATA_DIR#/}" "${ENV_FILE#/}"
gzip -t "$OUT"
tar -tzf "$OUT" >/dev/null
chmod 0600 "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
chmod 0600 "$OUT.sha256"
find "$BACKUP_DIR" -type f -name 'jelo-colab-*.tar.gz*' -mtime "+$RETENTION_DAYS" -delete
printf 'Backup created: %s\nChecksum: %s\n' "$OUT" "$OUT.sha256"
