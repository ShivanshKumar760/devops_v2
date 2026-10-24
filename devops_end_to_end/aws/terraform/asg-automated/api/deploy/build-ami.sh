#!/usr/bin/env bash
# PATH B: runs ON THE BUILD INSTANCE (as root) to prepare the golden image.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:?Set REPO_URL, e.g. https://github.com/you/simple-asg-api.git}"
BRANCH="${BRANCH:-master}"
APP_DIR=/opt/simple-api

echo "==> System packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ca-certificates gnupg

echo "==> Node.js 22 and PM2"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pm2

echo "==> App code ($REPO_URL, branch $BRANCH)"
rm -rf "$APP_DIR"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
git rev-parse HEAD > .deployed-commit

# If you cloned with a token (private repo), reset the remote so the token is not baked into the image
CLEAN_URL="$(printf '%s' "$REPO_URL" | sed -E 's#(https?://)[^@/]+@#\1#')"
git remote set-url origin "$CLEAN_URL"

echo "==> Production dependencies"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

echo "==> PM2 will start on every boot (user data starts the app itself)"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root
systemctl enable pm2-root

echo "==> Done. Deployed commit: $(cat .deployed-commit)"
