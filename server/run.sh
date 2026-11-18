#!/usr/bin/env bash
# Install, build and (re)start the duel server from this checkout. Works anywhere with Node 18+:
#   - on the class box (STUDENT set, `svc` available): runs as the service <STUDENT>-duel on $PORT
#   - anywhere else: runs in the foreground (PORT defaults to 8080)
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
npm run build
if [ -n "${STUDENT:-}" ] && command -v svc >/dev/null; then
  # `svc start` leaves an already-running service alone, so restart it to load the new build
  svc start duel "node dist/server.js"
  svc restart duel
else
  exec npm start
fi
