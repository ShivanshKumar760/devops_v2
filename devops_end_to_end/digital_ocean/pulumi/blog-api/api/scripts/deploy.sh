#!/usr/bin/env bash
# Run on the server as root: bash scripts/deploy.sh
set -euo pipefail

APP_DIR=/opt/blog-api
cd "$APP_DIR"

git fetch --all --prune
git reset --hard origin/master
npm ci --omit=dev
pm2 startOrReload ecosystem.config.cjs --env production --update-env
pm2 save
pm2 status
