#!/usr/bin/env bash
# Runs ON the Packer build instance, as root (see execute_command in the template).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME=/root   # sudo -E keeps the ubuntu user's HOME, so set it explicitly for PM2

: "${REPO_URL:?REPO_URL is required}"
BRANCH="${BRANCH:-master}"
APP_DIR="${APP_DIR:-/opt/simple-api}"
SMOKE_TEST="${SMOKE_TEST:-true}"

echo "==> Waiting for the instance's first-boot cloud-init to finish"
cloud-init status --wait || true

echo "==> System packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ca-certificates gnupg

echo "==> Node.js 22 and PM2"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pm2

echo "==> App code (branch: $BRANCH)"
rm -rf "$APP_DIR"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  # Private repo: put the token in the clone URL, hide it in the log, then remove it from the saved remote
  CLONE_URL="${REPO_URL/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"
  git clone --depth 1 --branch "$BRANCH" "$CLONE_URL" "$APP_DIR" 2>&1 | sed "s/${GITHUB_TOKEN}/***/g"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git rev-parse HEAD > .deployed-commit
echo "Deployed commit: $(cat .deployed-commit)"

echo "==> Production dependencies"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

echo "==> PM2 starts on every boot (user data starts the app itself once .env exists)"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root
systemctl enable pm2-root

if [ "$SMOKE_TEST" = "true" ]; then
  echo "==> Smoke test (the app has defaults, so no .env is needed)"
  pm2 start ecosystem.config.cjs
  sleep 5
  curl -fsS http://localhost:3000/health
  echo
  curl -fsS "http://localhost:3000/load?ms=20"
  echo
  pm2 status
else
  echo "==> Smoke test skipped (SMOKE_TEST=$SMOKE_TEST). Checking that the dependencies installed instead"
  npm ls --omit=dev --depth=0
fi
# Empty PM2's saved process list so the image does not start a stale process before user data runs
pm2 delete all || true
pm2 save --force

echo "==> Clean up so the image is small and user data runs again on every new instance"
rm -f "$APP_DIR/.env"
apt-get autoremove -y
apt-get clean
rm -rf /var/lib/apt/lists/*
cloud-init clean --logs

echo "==> Provisioning complete"
