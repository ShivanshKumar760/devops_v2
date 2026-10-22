export interface BootstrapArgs {
  repoUrl: string;
  branch: string;
  images: string[];
  maxConcurrentRuns: number;
  rateLimitPerMin: number;
  /** When set, installs Nginx + Certbot and serves HTTPS on the Droplet itself (Phase 4).
   *  When omitted, the app listens on :3000 and a load balancer terminates TLS (Phase 5). */
  nginx?: { domain: string; email: string };
}

const nginxSection = (domain: string, email: string) => `
# ---- Nginx reverse proxy ----
cat > /etc/nginx/sites-available/code-runner <<'NGINXEOF'
limit_req_zone $binary_remote_addr zone=runner_zone:10m rate=5r/s;

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    client_max_body_size 200k;
    location / {
        limit_req zone=runner_zone burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 30s;
    }
}
NGINXEOF
ln -sf /etc/nginx/sites-available/code-runner /etc/nginx/sites-enabled/code-runner
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---- Your DNS is managed by hand, so WAIT (up to 30 min) until the A record for this
# hostname points at this machine, THEN ask Let's Encrypt. (Let's Encrypt rate-limits
# repeated failed validations, so we don't hammer it.)
PUBLIC_IP=$(curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)
for i in $(seq 1 120); do
  RESOLVED=$(getent ahostsv4 ${domain} | awk 'NR==1{print $1}' || true)
  if [ "$RESOLVED" = "$PUBLIC_IP" ]; then break; fi
  echo "waiting for DNS: ${domain} -> '$RESOLVED' (want $PUBLIC_IP). Create the A record at your DNS provider."
  sleep 15
done
certbot --nginx -d ${domain} --non-interactive --agree-tos --no-eff-email -m ${email} --redirect
`;

// No secrets in this app, so the script is a plain string (no pulumi.Output needed).
export function buildBootstrapScript(args: BootstrapArgs): string {
  const extraPackages = args.nginx ? 'nginx certbot python3-certbot-nginx' : '';
  const nginx = args.nginx ? nginxSection(args.nginx.domain, args.nginx.email) : '';
  const pulls = args.images.map((img) => `docker pull ${img}`).join('\n');

  return `#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/runner-bootstrap.log) 2>&1
export HOME=/root
export DEBIAN_FRONTEND=noninteractive

APP_DIR=/opt/code-runner

# ---- 1 GB swap (for npm ci and spikes; user containers have swap disabled) ----
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---- System packages + Node.js 24 + PM2 ----
apt-get update -y
apt-get install -y curl git jq ca-certificates gnupg ${extraPackages}
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm install -g pm2

# ---- Docker Engine + language images ----
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
${pulls}

# Folder the Docker daemon bind-mounts into containers (must be a real host path)
mkdir -p /var/lib/code-runner
chmod 755 /var/lib/code-runner

# ---- Application (NO secrets: nothing sensitive lives on this server) ----
git clone --depth 1 --branch ${args.branch} ${args.repoUrl} $APP_DIR

cat > $APP_DIR/.env <<'ENVEOF'
NODE_ENV=production
PORT=3000
RUN_DIR=/var/lib/code-runner
MAX_CONCURRENT_RUNS=${args.maxConcurrentRuns}
RATE_LIMIT_PER_MIN=${args.rateLimitPerMin}
ENVEOF
chmod 600 $APP_DIR/.env

cd $APP_DIR
npm ci --omit=dev
pm2 start ecosystem.config.cjs --env production
pm2 startup systemd -u root --hp /root
pm2 save
${nginx}
echo "bootstrap complete"
`;
}