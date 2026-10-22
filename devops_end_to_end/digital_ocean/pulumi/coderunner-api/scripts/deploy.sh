#!/usr/bin/env bash
# Run on the server as root: bash scripts/deploy.sh
set -euo pipefail

APP_DIR=/opt/code-runner
IMAGES="node:22-alpine python:3.13-alpine"   # keep in sync with src/languages.js

cd "$APP_DIR"
git fetch --all --prune
git reset --hard origin/main
npm ci --omit=dev

for img in $IMAGES; do docker pull "$img"; done   # refresh language runtimes
docker image prune -f                              # remove old, unused layers

pm2 startOrReload ecosystem.config.cjs --env production --update-env
pm2 save
pm2 status
