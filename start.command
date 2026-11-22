#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Для запуска нужен Node.js 24 или новее. Установите его и повторите запуск.'
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<24){console.error("Нужен Node.js 24 или новее.");process.exit(1)}'
if node scripts/check-local-port.mjs; then
  :
else
  portal_status=$?
  if [ "$portal_status" -eq 10 ]; then
    exit 0
  fi
  exit "$portal_status"
fi
node scripts/seed.mjs
exec node server/local.mjs
