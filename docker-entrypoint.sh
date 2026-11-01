#!/bin/sh
# Хостингтер (Render, Railway, Fly.io) деректер дискін root атынан қосады.
# Сондықтан алдымен /data құқығын `node` пайдаланушысына береміз, содан кейін
# қосымшаны root-сыз (қауіпсіз) іске қосамыз.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  if setpriv --reuid=node --regid=node --init-groups test -w "$DATA_DIR"; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  echo "⚠ $DATA_DIR бумасына node пайдаланушысы жаза алмайды — root ретінде іске қосылады" >&2
fi

exec "$@"
