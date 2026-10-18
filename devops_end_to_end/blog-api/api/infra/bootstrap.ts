import * as pulumi from '@pulumi/pulumi';

export interface BootstrapArgs {
  repoUrl: string;
  branch: string;
  jwtSecret: pulumi.Input<string>;
  mongodbUri: pulumi.Input<string>;
  enableStress: boolean;
  /** When set, installs Nginx + Certbot and serves HTTPS on the Droplet itself (Phase 4).
   *  When omitted, the app listens on :3000 and a load balancer terminates TLS (Phase 5). */
  nginx?: { domain: string; email: string };
}

const nginxSection = (domain: string, email: string) => `
# ---- Nginx reverse proxy ----
cat > /etc/nginx/sites-available/blog-api <<'NGINXEOF'
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
    }
}
NGINXEOF
ln -sf /etc/nginx/sites-available/blog-api /etc/nginx/sites-enabled/blog-api
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

export function buildBootstrapScript(args: BootstrapArgs): pulumi.Output<string> {
  return pulumi.all([args.jwtSecret, args.mongodbUri]).apply(([jwtSecret, mongodbUri]) => {
    const extraPackages = args.nginx ? 'nginx certbot python3-certbot-nginx' : '';
    const nginx = args.nginx ? nginxSection(args.nginx.domain, args.nginx.email) : '';

    return `#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/blog-bootstrap.log) 2>&1
export HOME=/root
export DEBIAN_FRONTEND=noninteractive

APP_DIR=/opt/blog-api

# ---- 1 GB swap (the $4 Droplet only has 512 MB RAM) ----
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

# ---- Application ----
git clone --depth 1 --branch ${args.branch} ${args.repoUrl} $APP_DIR

cat > $APP_DIR/.env <<'ENVEOF'
NODE_ENV=production
PORT=3000
JWT_EXPIRES_IN=1d
JWT_SECRET=${jwtSecret}
MONGODB_URI=${mongodbUri}
ENABLE_STRESS=${args.enableStress}
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
  });
}
