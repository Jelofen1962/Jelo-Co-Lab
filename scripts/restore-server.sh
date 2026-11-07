#!/usr/bin/env bash
set -Eeuo pipefail
ARCHIVE="${1:-}"
SERVICE="${JELO_SERVICE:-jelo-colab}"
DATA_DIR="${DATA_DIR:-/var/lib/jelo-colab}"
ENV_FILE="${ENV_FILE:-/etc/jelo-colab.env}"

[[ "${EUID}" -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "Usage: sudo $0 /path/to/jelo-colab-backup.tar.gz" >&2; exit 1; }
[[ -f "$ARCHIVE.sha256" ]] || { echo "Backup checksum file is required." >&2; exit 1; }
(cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to validate archive members." >&2; exit 1; }
TMP="$(mktemp -d)"
WAS_ACTIVE=0
MOVED_DATA=0
MOVED_ENV=0
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DATA_BACKUP="${DATA_DIR}.pre-restore-${STAMP}"
ENV_BACKUP="${ENV_FILE}.pre-restore-${STAMP}"
cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    if [[ "$MOVED_DATA" -eq 1 && -d "$DATA_BACKUP" ]]; then rm -rf "$DATA_DIR"; mv "$DATA_BACKUP" "$DATA_DIR"; fi
    if [[ "$MOVED_ENV" -eq 1 && -f "$ENV_BACKUP" ]]; then rm -f "$ENV_FILE"; mv "$ENV_BACKUP" "$ENV_FILE"; fi
  fi
  if [[ "$WAS_ACTIVE" -eq 1 ]]; then systemctl start "$SERVICE" || true; fi
  rm -rf "$TMP"
  return "$status"
}
trap cleanup EXIT

python3 - "$ARCHIVE" "$DATA_DIR" "$ENV_FILE" <<'PY'
import pathlib, sys, tarfile
archive, data_dir, env_file = sys.argv[1:]
allowed = [pathlib.PurePosixPath(data_dir.lstrip('/')), pathlib.PurePosixPath(env_file.lstrip('/'))]
with tarfile.open(archive, 'r:gz') as source:
    for member in source.getmembers():
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts:
            raise SystemExit(f'Unsafe backup path: {member.name}')
        matches = False
        for root in allowed:
            if name == root or root in name.parents:
                matches = True
                break
        if not matches:
            raise SystemExit(f'Unexpected backup path: {member.name}')
        if not (member.isdir() or member.isfile()):
            raise SystemExit(f'Links and special files are not permitted: {member.name}')
    names = {pathlib.PurePosixPath(item.name) for item in source.getmembers()}
    if not any(name == allowed[0] or allowed[0] in name.parents for name in names):
        raise SystemExit(f'Missing workspace data: {data_dir}')
    if allowed[1] not in names:
        raise SystemExit(f'Missing environment file: {env_file}')
PY

mkdir -p "$TMP/root"
tar -xzf "$ARCHIVE" -C "$TMP/root" --no-same-owner
STAGED_DATA="$TMP/root/${DATA_DIR#/}"
STAGED_ENV="$TMP/root/${ENV_FILE#/}"
[[ -d "$STAGED_DATA" && -f "$STAGED_ENV" ]] || { echo "Validated archive is missing required paths." >&2; exit 1; }
if systemctl is-active --quiet "$SERVICE"; then WAS_ACTIVE=1; systemctl stop "$SERVICE"; fi
if [[ -d "$DATA_DIR" ]]; then mv "$DATA_DIR" "$DATA_BACKUP"; MOVED_DATA=1; fi
if [[ -f "$ENV_FILE" ]]; then mv "$ENV_FILE" "$ENV_BACKUP"; MOVED_ENV=1; fi
install -d -m 0750 "$(dirname "$DATA_DIR")" "$(dirname "$ENV_FILE")"
mv "$STAGED_DATA" "$DATA_DIR"
mv "$STAGED_ENV" "$ENV_FILE"
if id jelo-colab >/dev/null 2>&1; then chown -R jelo-colab:jelo-colab "$DATA_DIR"; fi
chmod 0750 "$DATA_DIR"
chmod 0600 "$ENV_FILE"
echo "Restore completed. Previous data: ${DATA_BACKUP}; previous environment: ${ENV_BACKUP}"
