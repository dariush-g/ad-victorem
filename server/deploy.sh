#!/usr/bin/env bash
# From your own computer: get the latest pushed code onto the class box and restart the server there.
#   DUEL_HOST=<class account>@<server> STUDENT=<your student name> server/deploy.sh
# Keep the address and account in your environment, never in the repo (class rules).
# Deploys what is pushed to GitHub, not local changes: commit and push first.
set -euo pipefail
: "${DUEL_HOST:?set DUEL_HOST=<account>@<server>}" "${STUDENT:?set STUDENT=<your student name>}"
REPO=${DUEL_REPO:-$(git -C "$(dirname "$0")" remote get-url origin)}
BRANCH=${DUEL_BRANCH:-$(git -C "$(dirname "$0")" rev-parse --abbrev-ref HEAD)}
ssh -o SetEnv=STUDENT="$STUDENT" "$DUEL_HOST" "set -e
  cd ~/projects
  [ -d ad-victorem/.git ] || git clone '$REPO' ad-victorem
  cd ad-victorem && git fetch --quiet origin && git checkout --quiet '$BRANCH' && git pull --quiet --ff-only origin '$BRANCH'
  server/run.sh"
