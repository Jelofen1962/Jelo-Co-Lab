#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -H /usr/local/bin/jelo-colab "$@"
fi
exec /usr/bin/node /opt/jelo-colab/manager.js "$@"
