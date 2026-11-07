#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${EUID}" -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
SCRIPT="/opt/jelo-colab/scripts/backup-server.sh"
[[ -x "$SCRIPT" ]] || { echo "Backup script not found at $SCRIPT. Install the matching server release first." >&2; exit 1; }
cat > /etc/systemd/system/jelo-colab-backup.service <<'UNIT'
[Unit]
Description=Create a consistent Jelo Co-Lab backup
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/opt/jelo-colab/scripts/backup-server.sh
UNIT
cat > /etc/systemd/system/jelo-colab-backup.timer <<'UNIT'
[Unit]
Description=Daily Jelo Co-Lab backup

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now jelo-colab-backup.timer
systemctl list-timers jelo-colab-backup.timer --no-pager
