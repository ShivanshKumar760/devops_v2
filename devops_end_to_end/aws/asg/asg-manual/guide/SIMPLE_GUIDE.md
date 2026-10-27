# Simple API on an AWS Auto Scaling Group: two ways to deploy (user data only, or golden AMI), tested with autocannon

A tiny Express API with exactly three endpoints (`/`, `/health`, `/load`) running on EC2 instances in **private subnets** behind an **Application Load Balancer**, managed by an **Auto Scaling Group (ASG)**. You will learn **both** ways to get the code onto each instance, and you can follow either one (or both, one after the other):

- **Path A: user data only.** Use the stock Ubuntu image. A cloud-init/user data script installs Node.js, PM2 and your code on first boot of every instance. No custom image to build.
- **Path B: golden AMI.** Configure one "golden" instance once, turn it into an AMI, and launch every ASG instance from that image. User data shrinks to a few lines.

Then you will hammer the `/load` endpoint with **autocannon** and watch the ASG scale out and back in.

The console flow (AMI, launch template, target group, ALB, ASG) follows Shivam Bhadani's article [AWS Part 4: Step-by-Step Guide to Create Your First AWS Auto Scaling Group](https://medium.com/@shivambhadani_/aws-part-4-step-by-step-guide-to-create-your-first-aws-auto-scaling-group-826c1effc0ec), adapted to a custom VPC with private subnets.

```
                          Internet
                             │
                    ┌────────▼────────┐
                    │ Internet Gateway│
                    └────────┬────────┘
┌────────────────────────────┼──────────────────────────────────────────┐
│ VPC simple-vpc  10.0.0.0/16│                                          │
│   ┌────────────────────────▼───────────────────────┐                  │
│   │  Application Load Balancer (simple-alb, :80)   │  PUBLIC subnets  │
│   │  public-a 10.0.1.0/24     public-b 10.0.2.0/24 │                  │
│   │  [NAT Gateway in public-a]                     │                  │
│   └────────────┬──────────────────────┬────────────┘                  │
│                │ :3000 (from ALB SG only)                             │
│   ┌────────────▼────────────┐ ┌───────▼─────────────────┐             │
│   │ private-a 10.0.11.0/24  │ │ private-b 10.0.12.0/24  │  PRIVATE    │
│   │ EC2 (ASG): Node + PM2   │ │ EC2 (ASG): Node + PM2   │  subnets    │
│   └─────────────────────────┘ └─────────────────────────┘             │
└───────────────────────────────────────────────────────────────────────┘
        autocannon (your laptop)  ──►  ALB DNS  ──►  /load  ──►  CPU rises  ──►  ASG scales out
```

## Table of contents

1. [Which path should I pick?](#which-path-should-i-pick)
2. [Naming cheat sheet](#naming-cheat-sheet)
3. [About the image placeholders](#about-the-image-placeholders)
4. [Step 1: The API code](#step-1-the-api-code)
5. [Step 2: Push the code to GitHub](#step-2-push-the-code-to-github)
6. [Step 3: Create the VPC](#step-3-create-the-vpc)
7. [Step 4: Security groups](#step-4-security-groups)
8. [Step 5: Target group](#step-5-target-group)
9. [Step 6: Application Load Balancer](#step-6-application-load-balancer)
10. [Step 7A: Launch template, user data only](#step-7a-launch-template-user-data-only-path-a)
11. [Step 7B: Golden AMI, then launch template](#step-7b-golden-ami-then-launch-template-path-b)
12. [Step 8: Auto Scaling Group](#step-8-auto-scaling-group)
13. [Step 9: Test the three endpoints](#step-9-test-the-three-endpoints)
14. [Step 10: Load test with autocannon](#step-10-load-test-with-autocannon)
15. [Updating the app](#updating-the-app)
16. [Optional: get a shell on private instances](#optional-get-a-shell-on-private-instances)
17. [Troubleshooting](#troubleshooting)
18. [Cleanup](#cleanup)
19. [Notes and trade-offs](#notes-and-trade-offs)
20. [Screenshot checklist](#screenshot-checklist)

---

## Which path should I pick?

| | Path A: user data only | Path B: golden AMI |
|---|---|---|
| Extra setup | None, one script | Build box, build script, clean-up, create image |
| Time until an instance is healthy | Roughly 2 to 4 minutes | Roughly 30 to 60 seconds |
| What must be reachable at scale-out time | apt mirrors, NodeSource, npm registry, GitHub **and** the NAT gateway | Nothing external |
| Do private instances need a NAT gateway? | **Yes** (to download packages) | **No** (everything is already on disk) |
| Every instance identical? | Not guaranteed: apt and npm fetch "latest" at each boot, and the branch may have moved | Yes, same image every time |
| Pushing new code | New instances pick up the branch automatically, existing ones need an instance refresh | Build a new AMI and a new launch template version, then instance refresh |
| Repo visibility | Must be public (or you put a token in user data) | Can be private (token only used on the build box) |
| ASG health check grace period | 300 s | 120 s |

Rule of thumb: Path A is the easiest way to learn and demo. Path B is what you want when scale-out speed and reliability matter. A third, middle option is to bake only Node.js and PM2 into the image and let user data do just the `git clone`, `npm ci` and start, which is not covered step by step here.

You can do both: finish with Path A, delete the ASG and launch template, and then do Path B. Steps 1 to 6 and 8 to 10 are shared.

---

## Naming cheat sheet

Region: **Asia Pacific (Mumbai) `ap-south-1`**, Availability Zones `ap-south-1a` and `ap-south-1b`. Change them if you use another region.

| Thing | Name | Value |
|---|---|---|
| VPC | `simple-vpc` | `10.0.0.0/16` |
| Public subnets | `simple-public-a`, `simple-public-b` | `10.0.1.0/24`, `10.0.2.0/24` |
| Private subnets | `simple-private-a`, `simple-private-b` | `10.0.11.0/24`, `10.0.12.0/24` |
| Security group (ALB) | `simple-alb-sg` | HTTP 80 from the internet |
| Security group (instances) | `simple-app-sg` | TCP 3000 from `simple-alb-sg` only |
| Security group (build box, Path B only) | `simple-build-sg` | SSH from your IP |
| Target group | `simple-tg` | HTTP 3000, health check `/health` |
| Load balancer | `simple-alb` | internet-facing, public subnets |
| Launch template | `simple-lt` | Path A: stock Ubuntu. Path B: `simple-api-ami` |
| Auto Scaling Group | `simple-asg` | min 2, desired 2, max 4, CPU target 60% |

---

## About the image placeholders

Every console step has an image slot like `![description](images/NN-name.png)`. Create an `images/` folder next to this file and save your own screenshot under each file name (the [Screenshot checklist](#screenshot-checklist) at the end lists every file and what to capture). Until a file exists, the slot shows as a broken image. That is expected.

---

## Step 1: The API code

Everything is ES modules. There is **no database and no secrets**, so the app is easy to run anywhere. It still reads a small `.env` file (written by the user data script) to show the pattern, and the app works without one.

```
simple-asg-api/
├── .gitignore
├── .env.example
├── package.json
├── ecosystem.config.cjs
├── deploy/
│   ├── build-ami.sh          # Path B
│   ├── user-data-path-a.sh   # Path A (installs everything)
│   └── user-data-path-b.sh   # Path B (just writes .env and starts)
└── src/
    └── server.js
```

### The three endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Hello message plus the instance hostname and PID, so you can see load balancing |
| GET | `/health` | Always `200 OK` quickly. Used by the target group health check |
| GET | `/load` | Burns CPU for `?ms=` milliseconds (default 100, max 2000). Use it to load test |

### `package.json`

```json
{
  "name": "simple-asg-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^5.1.0"
  }
}
```

### `src/server.js`

```js
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional: <project root>/.env. A missing file is fine, defaults are used.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || 'simple-asg-api';
const MAX_BURN_MS = 2000;
const startedAt = new Date();

const app = express();
app.set('trust proxy', 1); // one proxy hop: the Application Load Balancer

// 1) Hello. Shows which instance (and which PM2 worker) answered.
app.get('/', (_req, res) => {
  res.json({
    app: APP_NAME,
    message: 'Hello from an Auto Scaling Group instance',
    host: os.hostname(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: startedAt.toISOString(),
  });
});

// 2) Health check for the load balancer. Keep it trivial and fast.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// 3) Load generator. Busy-loops for ?ms= milliseconds (default 100) on purpose.
//    One request = about <ms> ms of one CPU core, which makes CPU usage easy to predict.
app.get('/load', (req, res) => {
  const requested = Number.parseInt(req.query.ms, 10);
  const ms = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_BURN_MS) : 100;

  const started = process.hrtime.bigint();
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) {
    x += Math.sqrt(Math.random() * 1e6) * Math.sin(x); // pointless math to keep the CPU busy
  }
  const burnedMs = Number(process.hrtime.bigint() - started) / 1e6;

  res.json({
    host: os.hostname(),
    pid: process.pid,
    requestedMs: ms,
    burnedMs: Math.round(burnedMs),
  });
});

// Only three endpoints exist
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// 0.0.0.0 so the load balancer can reach the instance's private IP.
// The security group only lets the ALB in on this port.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} listening on :${PORT} (pid ${process.pid})`);
});

// PM2 sends SIGINT on reload/stop: finish in-flight requests first
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

Why `/load` is synchronous: a Node.js process runs JavaScript on one thread, so one busy-loop request keeps one CPU core fully busy. That makes the effect of each request easy to reason about when you load test.

### `ecosystem.config.cjs`

PM2 loads this file with `require()`, so it uses the `.cjs` extension even though the app is ESM. **Cluster mode** with `instances: 'max'` starts one worker per vCPU. That matters here: a `t3.micro` has 2 vCPUs, and a single Node process could only ever use one of them, so the instance could never go above about 50% CPU and the ASG policy (60%) would never fire.

```js
module.exports = {
  apps: [
    {
      name: 'simple-api',
      script: 'src/server.js',
      cwd: '/opt/simple-api',
      exec_mode: 'cluster',
      instances: 'max', // one worker per vCPU
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 10000,
    },
  ],
};
```

> If your PM2 version has trouble running an ESM app in cluster mode, change `exec_mode` to `'fork'` and `instances` to `1`. Everything else still works, but then pick a 1-vCPU instance type or lower the ASG CPU target so scaling can still trigger.

### `.env.example`

```ini
PORT=3000
NODE_ENV=production
APP_NAME=simple-asg-api
```

### `.gitignore`

```gitignore
node_modules/
.env
.deployed-commit
```

### Run it locally first

```bash
npm install
npm run dev
curl localhost:3000/
curl localhost:3000/health
curl "localhost:3000/load?ms=200"
```

Commit the generated `package-lock.json`, because both paths use `npm ci`.

---

## Step 2: Push the code to GitHub

```bash
cd simple-asg-api
git init -b master
git add .
git commit -m "Simple ASG API"
git remote add origin https://github.com/YOUR_GITHUB_USER/simple-asg-api.git
git push -u origin master
```

Use `main` instead of `master` everywhere below if that is your branch name. **Make the repository public** if you follow Path A (the instances clone it with no credentials). Path B can use a private repo because only the build box needs to clone it.

---

## Step 3: Create the VPC

The console wizard builds the VPC, 4 subnets, an internet gateway, a NAT gateway with an Elastic IP, and the route tables in one go.

1. **VPC → Create VPC → VPC and more.**

   ![VPC wizard, "VPC and more" selected](images/01-vpc-wizard.png)

2. Fill in:

   | Setting | Value |
   |---|---|
   | Name tag auto-generation | tick it, enter `simple` |
   | IPv4 CIDR block | `10.0.0.0/16` |
   | IPv6 CIDR block | No IPv6 |
   | Number of Availability Zones | **2** (`ap-south-1a`, `ap-south-1b`) |
   | Number of public subnets | **2** |
   | Number of private subnets | **2** |
   | Customize subnets CIDR blocks | public `10.0.1.0/24`, `10.0.2.0/24`; private `10.0.11.0/24`, `10.0.12.0/24` |
   | NAT gateways | **In 1 AZ** for Path A. For Path B only, **None** is enough (private instances need no internet). |
   | VPC endpoints | None |
   | DNS options | keep **Enable DNS hostnames** and **Enable DNS resolution** ticked |

3. Check the **Preview** panel: 4 subnets, route tables, an internet gateway, and (if chosen) a NAT gateway.

   ![VPC preview showing 2 public and 2 private subnets](images/02-vpc-preview.png)

4. Click **Create VPC** and wait until it finishes (a few minutes if a NAT gateway is created).

### Verify the routing (once)

- Public route table: contains `0.0.0.0/0 → igw-...` and is associated with both public subnets.
- Each private route table: contains `0.0.0.0/0 → nat-...` (if you created a NAT gateway) and is associated with one private subnet.

![Private route table with 0.0.0.0/0 pointing at the NAT gateway](images/03-route-table-private.png)

If a private route table lacks the NAT route and you follow Path A, add it (Edit routes → Add route → `0.0.0.0/0` → NAT Gateway), or the instances cannot install anything at boot.

---

## Step 4: Security groups

**EC2 → Security Groups → Create security group.** Use VPC `simple-vpc` for each. Create them in this order, because the second is referenced by the third.

![Security groups list showing three groups in simple-vpc](images/04-security-groups.png)

**`simple-alb-sg`** (the load balancer)

| Direction | Type | Port | Source |
|---|---|---|---|
| Inbound | HTTP | 80 | `0.0.0.0/0` (and `::/0` if you want IPv6) |
| Outbound | All traffic | all | `0.0.0.0/0` (default) |

**`simple-app-sg`** (the ASG instances)

| Direction | Type | Port | Source |
|---|---|---|---|
| Inbound | Custom TCP | 3000 | **`simple-alb-sg`** (select the security group, not an IP) |
| Outbound | All traffic | all | `0.0.0.0/0` (default) |

**`simple-build-sg`** (Path B only, the temporary build box)

| Direction | Type | Port | Source |
|---|---|---|---|
| Inbound | SSH | 22 | **My IP** |
| Outbound | All traffic | all | `0.0.0.0/0` (default) |

The instances have no SSH rule and no public IP. Their only visitor is the load balancer on port 3000.

---

## Step 5: Target group

The target group is the list of instances the load balancer sends traffic to. The ASG registers and deregisters instances for you.

1. **EC2 → Target Groups → Create target group.**

   ![Target group creation, basic settings](images/05-target-group-create.png)

2. Settings:

   | Setting | Value |
   |---|---|
   | Target type | **Instances** |
   | Name | `simple-tg` |
   | Protocol : Port | `HTTP` : `3000` |
   | VPC | `simple-vpc` |
   | Protocol version | HTTP1 |
   | Health check path | `/health` |
   | Advanced: healthy / unhealthy threshold | 2 / 3 |
   | Advanced: timeout / interval | 5 s / 15 s |
   | Advanced: success codes | 200 |

   ![Target group health check settings](images/06-target-group-health.png)

3. **Next**, register **no** targets, **Create target group**.
4. Open the group → **Attributes → Edit**, set **Deregistration delay** to `30` seconds so scale-in finishes sooner (default 300).

---

## Step 6: Application Load Balancer

1. **EC2 → Load Balancers → Create load balancer → Application Load Balancer.**

   ![ALB creation, scheme and network mapping](images/07-alb-create.png)

2. Settings:

   | Setting | Value |
   |---|---|
   | Name | `simple-alb` |
   | Scheme | **Internet-facing** |
   | IP address type | IPv4 |
   | VPC | `simple-vpc` |
   | Mappings | `ap-south-1a` → **`simple-public-a`**, `ap-south-1b` → **`simple-public-b`** |
   | Security groups | **`simple-alb-sg`** (remove the default one) |
   | Listener | `HTTP : 80` → forward to `simple-tg` |

   The ALB must use the **public** subnets even though the instances behind it are private.

   ![ALB listener forwarding HTTP 80 to simple-tg](images/08-alb-listener.png)

3. **Create load balancer.** When the state is **Active**, copy the **DNS name**, for example `simple-alb-123456789.ap-south-1.elb.amazonaws.com`.

Now choose your path: continue with **Step 7A** or **Step 7B**.

---

## Step 7A: Launch template, user data only (Path A)

No image to build. The launch template uses the stock Ubuntu AMI, and user data installs everything on each instance's first boot.

### 7A.1 The user data script

Save this as `deploy/user-data-path-a.sh`. It runs **once, as root, at the first boot** of every instance.

```bash
#!/bin/bash
# PATH A: stock Ubuntu 24.04 AMI. Installs everything on first boot of each instance.
set -eu
export DEBIAN_FRONTEND=noninteractive
export HOME=/root

# ======== EDIT THESE ========
REPO_URL='https://github.com/YOUR_GITHUB_USER/simple-asg-api.git'   # must be public
BRANCH='master'
GIT_REF=''          # optional: a tag or commit SHA to pin, so a bad push can't break the next scale-out
APP_NAME='simple-asg-api'
# ============================

APP_DIR=/opt/simple-api

# The first minutes after boot can have flaky networking, so retry downloads
retry() {
  for i in 1 2 3 4 5; do
    "$@" && return 0
    echo "attempt $i failed: $*" >&2
    sleep 10
  done
  return 1
}

retry apt-get update -y
retry apt-get install -y curl git ca-certificates gnupg

retry bash -c 'set -o pipefail; curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
retry apt-get install -y nodejs
retry npm install -g pm2

rm -rf "$APP_DIR"
retry git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
if [ -n "$GIT_REF" ]; then git checkout "$GIT_REF"; fi
git rev-parse HEAD > .deployed-commit
retry npm ci --omit=dev

# App settings (no secrets in this app, but this is where they would go)
cat > "$APP_DIR/.env" <<EOF
PORT=3000
NODE_ENV=production
APP_NAME=${APP_NAME}
EOF

pm2 start ecosystem.config.cjs
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root
pm2 save
```

Output of the script lands in `/var/log/cloud-init-output.log` on each instance.

### 7A.2 Create the launch template

1. **EC2 → Launch Templates → Create launch template.**

   ![Launch templates list with Create launch template button](images/09-lt-create.png)

2. **Name** `simple-lt`, description `Path A: user data only`. Tick **Provide guidance to help me set up a template that I can use with EC2 Auto Scaling**.
3. **Application and OS Images:** the **Quick Start** tab → **Ubuntu** → **Ubuntu Server 24.04 LTS** (64-bit x86).

   ![Choosing the stock Ubuntu Server 24.04 AMI](images/10-lt-ami-ubuntu.png)

4. **Instance type:** `t3.micro`. (If your account's free tier uses `t2.micro`, that works for deploying, but `t2` throttles sustained CPU, which distorts the load test. Prefer `t3`.)
5. **Key pair:** "Don't include in launch template" (you will not SSH in).
6. **Network settings:** Subnet "Don't include in launch template" (the ASG chooses). Security groups: **`simple-app-sg`**. No public IP.

   ![Launch template network settings with simple-app-sg](images/11-lt-security-group.png)

7. **Storage:** default.
8. **Resource tags:** `Name = simple-api`, resource type Instances.
9. **Advanced details:**
   - **Detailed CloudWatch monitoring:** **Enable**. This gives 1-minute CPU metrics, so scaling reacts in minutes instead of much longer (it costs a little extra).
   - **Metadata version:** **V2 only (token required)**.
   - **User data:** paste the script from 7A.1 (after editing the repo URL).

   ![Launch template advanced details: detailed monitoring, IMDSv2, user data](images/12-lt-advanced-user-data-a.png)

10. **Create launch template.** Continue to [Step 8](#step-8-auto-scaling-group) and use the **Path A** values.

---

## Step 7B: Golden AMI, then launch template (Path B)

Configure one server by hand (well, by script), freeze it as an image, and launch every ASG instance from that image.

### 7B.1 Key pair (for the build box)

**EC2 → Key pairs → Create key pair.** Name `simple-key`, `.pem` format, then `chmod 400 simple-key.pem`.

### 7B.2 Launch the build instance

**EC2 → Instances → Launch instances.**

![Launching the build instance with the Ubuntu AMI](images/13-build-launch.png)

| Setting | Value |
|---|---|
| Name | `simple-build` |
| AMI | **Ubuntu Server 24.04 LTS** |
| Instance type | `t3.micro` |
| Key pair | `simple-key` |
| Network | VPC `simple-vpc`, subnet **`simple-public-a`**, **Auto-assign public IP: Enable** |
| Security group | existing: `simple-build-sg` |

The build box lives in a **public** subnet only so you can SSH in and download packages. The ASG instances will be private.

### 7B.3 SSH in and run the build script

```bash
ssh -i simple-key.pem ubuntu@<build-instance-public-ip>
nano build-ami.sh      # paste the script below, then Ctrl+O, Enter, Ctrl+X
```

`deploy/build-ami.sh`:

```bash
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
```

Run it as root:

```bash
sudo REPO_URL=https://github.com/YOUR_GITHUB_USER/simple-asg-api.git BRANCH=master bash build-ami.sh
```

![Build script finishing successfully on the build instance](images/14-build-script-output.png)

For a private repo, set `REPO_URL=https://<read-only-token>@github.com/YOUR_USER/simple-asg-api.git`. The script then resets the saved remote to the same URL without the token. Confirm with `git -C /opt/simple-api remote -v` that no token remains, and clear your shell history (`history -c`) afterwards, since the token appeared on the command line.

### 7B.4 Smoke test (this app needs no database, so it is easy)

```bash
cd /opt/simple-api
sudo pm2 start ecosystem.config.cjs
sleep 3
curl -s localhost:3000/
curl -s localhost:3000/health
curl -s "localhost:3000/load?ms=50"
sudo pm2 status        # you should see one worker per vCPU, all "online"
```

### 7B.5 Clean the box before imaging (do not skip)

Stop PM2 and empty its saved process list, remove the `.env`, and reset cloud-init so user data runs again on every new instance.

```bash
sudo pm2 delete all || true
sudo pm2 save --force
sudo rm -f /opt/simple-api/.env
sudo cloud-init clean --logs
rm -f ~/build-ami.sh
history -c
```

### 7B.6 Create the image

1. Select `simple-build` → **Actions → Image and templates → Create image**.

   ![Actions menu: Image and templates, Create image](images/15-create-image-menu.png)

2. **Image name** `simple-api-ami`, description `Ubuntu 24.04 + Node 22 + PM2 + simple-asg-api`. Leave **No reboot** unticked. **Create image**.

   ![Create image form with the name simple-api-ami](images/16-create-image-form.png)

3. **EC2 → AMIs**: wait until `simple-api-ami` is **Available**.

   ![AMI list showing simple-api-ami as available](images/17-ami-available.png)

4. **Terminate `simple-build`** so it stops billing.

### 7B.7 The (short) user data script

`deploy/user-data-path-b.sh`. The app is already on disk, so user data only writes `.env` and starts PM2:

```bash
#!/bin/bash
# PATH B: runs once, as root, on first boot. Code and Node are already in the AMI.
set -eu
export HOME=/root

APP_NAME='simple-asg-api'
APP_DIR=/opt/simple-api

cat > "$APP_DIR/.env" <<EOF
PORT=3000
NODE_ENV=production
APP_NAME=${APP_NAME}
EOF

cd "$APP_DIR"
pm2 start ecosystem.config.cjs
pm2 save
```

### 7B.8 Create the launch template

Same as 7A.2, with these differences:

1. **Name** `simple-lt`, description `Path B: golden AMI`.
2. **Application and OS Images:** **My AMIs** → `simple-api-ami`.

   ![Launch template using My AMIs: simple-api-ami](images/18-lt-ami-custom.png)

3. **Instance type** `t3.micro`, no key pair, security group **`simple-app-sg`**, no public IP.
4. **Advanced details:** Detailed CloudWatch monitoring **Enable**, Metadata **V2 only**, **User data** = the script from 7B.7.

   ![Launch template advanced details with the short user data](images/19-lt-advanced-user-data-b.png)

5. **Create launch template**. Continue to Step 8 and use the **Path B** values.

---

## Step 8: Auto Scaling Group

The steps are the same for both paths, only two numbers differ (marked **A / B**).

1. **EC2 → Auto Scaling Groups → Create Auto Scaling group.**

   ![Auto Scaling groups page with Create button](images/20-asg-create.png)

2. **Name and template.** Name `simple-asg`, launch template `simple-lt`, version **Default**. **Next**.

   ![ASG step 1: name and launch template](images/21-asg-name-template.png)

3. **Network.** VPC `simple-vpc`. **Select only `simple-private-a` and `simple-private-b`.** Keep **Balanced best effort**. **Next**.

   ![ASG step 2: the two private subnets selected](images/22-asg-network.png)

4. **Load balancing.** **Attach to an existing load balancer → Choose from your load balancer target groups → `simple-tg`**. Tick **Turn on Elastic Load Balancing health checks**. Set **Health check grace period**: **A: `300` seconds / B: `120` seconds**. **Next**.

   ![ASG step 3: attach simple-tg and enable ELB health checks](images/23-asg-load-balancer.png)

5. **Group size and scaling.**

   | Setting | Value |
   |---|---|
   | Desired / Minimum / Maximum capacity | 2 / 2 / 4 |
   | Automatic scaling | **Target tracking scaling policy** |
   | Metric type | Average CPU utilization |
   | Target value | **60** |
   | Instance warmup | **A: 300 seconds / B: 120 seconds** |

   Also tick **Enable group metrics collection within CloudWatch** if the wizard offers it. **Next**.

   ![ASG step 4: capacity 2/2/4 and target tracking at 60% CPU](images/24-asg-size-scaling.png)

6. Skip notifications. Add the tag `Name = simple-api` (tick **Tag new instances**). **Create Auto Scaling group**.
7. Open the ASG → **Activity**: two instances are launching. In **Instance management** wait for both to be **InService** and **Healthy**. Then **Target Groups → `simple-tg` → Targets**: both should be **healthy**.

   ![ASG instance management with two healthy instances](images/25-asg-instances-healthy.png)

   Path A takes a few minutes for this (it installs software first). Path B is much quicker.

---

## Step 9: Test the three endpoints

```bash
ALB=http://simple-alb-123456789.ap-south-1.elb.amazonaws.com

# 1) hello
curl -s $ALB/

# 2) health
curl -i $ALB/health

# 3) load (burns about 100 ms of CPU, the default)
curl -s "$ALB/load"
curl -s "$ALB/load?ms=300"

# anything else is a 404
curl -i $ALB/nope
```

![Browser showing the JSON response from the ALB DNS name](images/26-browser-alb-response.png)

See the load balancing in action: run `/` twenty times and count which hosts answered.

```bash
for i in $(seq 1 20); do curl -s $ALB/ | jq -r .host; done | sort | uniq -c
```

You should see two `ip-10-0-11-x` / `ip-10-0-12-x` style hostnames, one per private subnet. The `pid` field also changes because PM2 cluster mode runs one worker per vCPU.

---

## Step 10: Load test with autocannon

[autocannon](https://github.com/mcollina/autocannon) is a fast HTTP benchmarking tool written in Node.js. Run it from your laptop (or any machine outside the VPC), pointing at the ALB.

```bash
npx autocannon --help      # npx downloads it on first use
# or install once: npm install -g autocannon
```

### The flags you will use

| Flag | Meaning |
|---|---|
| `-c 40` | 40 concurrent connections (clients sending requests in a loop) |
| `-d 600` | Run for 600 seconds |
| `-t 60` | Per-request timeout in seconds (default 10, too short once requests queue up) |
| `-R 60` | Cap the total request rate at 60 requests per second (optional) |
| `-w 2` | Use 2 worker threads in autocannon itself (only needed for very high rates) |
| `-p 1` | Pipelining, leave at the default 1 |

### 10.1 Baseline: the cheap endpoint

```bash
npx autocannon -c 10 -d 20 $ALB/health
```

This does almost no work. Expect thousands of requests per second (limited by your network) and very low latency. CPU on the instances stays low, so no scaling happens.

![autocannon result for /health with low latency](images/27-autocannon-health.png)

### 10.2 Light load: confirm `/load` works

```bash
npx autocannon -c 10 -d 30 "$ALB/load?ms=20"
```

Each request costs about 20 ms of CPU, so a 2-vCPU instance can handle about 100 requests per second. Easy for two instances, so still no scale-out.

### 10.3 Heavy load: trigger scale-out

```bash
npx autocannon -c 40 -d 600 -t 60 "$ALB/load?ms=100"
```

Why this saturates the group: each request burns about 100 ms of one core, so one vCPU completes about 10 requests per second. Two instances with 2 vCPUs each give about 4 cores, so roughly **40 requests per second** at most. autocannon keeps 40 requests in flight at all times, which is more than 4 cores can work on at once, so the CPUs sit near 100%.

![autocannon running the heavy /load test](images/28-autocannon-load-running.png)

**What to watch while it runs** (open these in separate tabs):

- **ASG → Monitoring** tab (and **EC2 → select an instance → Monitoring → CPU utilization**): average CPU climbs above 60%.
- **ASG → Activity** tab: after the CloudWatch alarm fires (roughly 3 to 5 minutes with detailed monitoring, longer without it) you see "Launching a new EC2 instance". The group grows toward 4.
- **Target group → Targets**: the new instances show *initial* and then *healthy*.
- A second terminal: count hosts again, and new hostnames appear.

  ```bash
  for i in $(seq 1 40); do curl -s $ALB/ | jq -r .host; done | sort | uniq -c
  ```

![ASG activity history showing instances launched by the scaling policy](images/29-asg-activity-scale-out.png)

![EC2 / ASG CPU graph rising above the 60% target](images/30-cloudwatch-cpu.png)

### 10.4 Reading the autocannon output

At the end autocannon prints a table of latency percentiles, requests per second and totals, followed by a summary line like `N requests in 600s, X MB read`. Read it like this:

| Line | What it tells you |
|---|---|
| **Latency 50% / 97.5% / 99%** | How long requests took. Under saturation these are large because requests queue behind the busy-loops. |
| **Req/Sec** | Throughput. With about 4 cores and 100 ms per request you should see roughly 40/s before scale-out and roughly double with 4 instances. |
| **2xx / non-2xx** | Non-2xx means errors. A few `502/503/504` are possible during scale events. |
| **errors / timeouts** | Connection errors and requests that exceeded `-t`. Many timeouts mean the load is too heavy for the group's current size. |

A useful rule (Little's law): average latency is about *connections divided by throughput*. With 40 connections at 40 requests per second, latency is about 1 second. After the group grows to 4 instances, throughput roughly doubles and latency roughly halves. You can see this change in the autocannon progress line when the new instances join.

### 10.5 Watch out: health checks can fail under load

`/health` is served by the same Node workers that are busy with `/load`, so it waits in the same queue. If you push the load so high that `/health` takes longer than 5 seconds three times in a row (the settings from Step 5), the ALB marks the instance **unhealthy**. Because ELB health checks are enabled on the ASG, the ASG then **terminates and replaces it**, which makes the overload worse.

If instances start flapping during a test:

- Lower the load: fewer connections (`-c 20`) or smaller bursts (`ms=50`).
- Or raise the target group health check timeout and unhealthy threshold a little.
- Keep the total demand moderate: `connections × ms` should not be many times the group's CPU capacity.

That is a real-world lesson too: use a lightweight health endpoint, and don't let one saturated process starve it.

### 10.6 Scale-in

Stop autocannon (or let it finish). With the policy's built-in scale-in cooldown, the group removes the extra instances only after the CPU has been low for a sustained period (target tracking waits for a long run of low data points, on the order of 15 minutes), and then it shrinks back to the minimum of 2. Be patient: scale-in is deliberately slower than scale-out.

![ASG activity history showing instances terminated after the load stopped](images/31-asg-activity-scale-in.png)

### 10.7 Try self-healing

Terminate one instance from the EC2 console. The ALB keeps serving from the other instance, and the ASG notices and launches a replacement.

![Terminating one instance and the ASG launching a replacement](images/32-self-healing.png)

---

## Updating the app

**Path A (user data only):** push your change to the branch. **New** instances pick it up automatically at boot. To roll the running ones: **ASG → Instance refresh → Start instance refresh** (minimum healthy percentage 50, warmup 300 s). If you pinned `GIT_REF`, update it in a new launch template version first.

**Path B (golden AMI):**

1. Push your change.
2. Launch a new build instance (7B.2), run `build-ami.sh` (7B.3), smoke test (7B.4), clean (7B.5), create `simple-api-ami-v2` (7B.6), terminate the build box.
3. **Launch Templates → `simple-lt` → Actions → Modify template (create new version)**, select the new AMI, save, and set it as the **default** version.
4. **ASG → Instance refresh → Start instance refresh** (minimum healthy percentage 50, warmup 120 s).

---

## Optional: get a shell on private instances

Private instances have no public IP and no SSH rule. For debugging, use an **EC2 Instance Connect Endpoint** (it needs no NAT gateway and no bastion host).

1. Create security group `simple-eice-sg` in `simple-vpc` with **no inbound rules** and one outbound rule: SSH (22) to `simple-app-sg`.
2. Edit `simple-app-sg`: add inbound SSH (22) from `simple-eice-sg`.
3. **VPC → Endpoints → Create endpoint**: service category **EC2 Instance Connect Endpoint**, VPC `simple-vpc`, security group `simple-eice-sg`, one private subnet.
4. Select an instance → **Connect → EC2 Instance Connect → Connect using EC2 Instance Connect Endpoint**.

Useful commands once connected:

```bash
sudo tail -100 /var/log/cloud-init-output.log   # user data output
sudo pm2 status                                 # one worker per vCPU
sudo pm2 logs simple-api --lines 100
curl -s localhost:3000/health
cat /opt/simple-api/.deployed-commit
top                                             # watch CPU during a load test
```

There may be an hourly charge for the endpoint. Check current pricing and delete it when you are done.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| ALB returns `502` or `503` | No healthy targets yet. Check **Target groups → Targets** and wait for boot to finish. |
| Targets stay **unhealthy** | `simple-app-sg` must allow TCP 3000 from `simple-alb-sg`. The target group port must be 3000 and the path `/health`. Confirm PM2 is running on the instance. |
| **Path A:** instances never become healthy | The private subnets cannot reach the internet: check the NAT gateway exists and each private route table has `0.0.0.0/0 → nat-...`. Read `/var/log/cloud-init-output.log`. |
| **Path A:** ASG keeps replacing instances | The grace period (300 s) is too short for the install, or a package download keeps failing. Raise the grace period and read the log. |
| **Path B:** user data did not run | `cloud-init clean` was skipped before imaging. Rebuild the AMI with step 7B.5. |
| **Path B:** app not running after boot | PM2 saved list was empty and user data failed. Check `/var/log/cloud-init-output.log` and that `/opt/simple-api` exists in the AMI. |
| Scaling never triggers | CPU did not reach 60%. Use a heavier test (`-c 40`, `ms=100`), confirm PM2 cluster mode is using all vCPUs, and note `t2` instances throttle CPU. Without detailed monitoring, reaction is much slower. |
| Instances flap during the load test | Health checks time out under saturation, see [10.5](#105-watch-out-health-checks-can-fail-under-load). |
| autocannon shows many timeouts | Raise `-t`, or lower `-c` / `ms`. The group is saturated until the new instances join. |
| `npm ci` fails | `package-lock.json` was not committed. Run `npm install` locally and push it. |

---

## Cleanup

Delete in this order. The ALB and NAT gateway charge by the hour even when idle.

![AWS console showing resources being deleted](images/33-cleanup.png)

1. **Auto Scaling group:** edit `simple-asg`, set minimum, desired and maximum to **0**, wait for the instances to terminate, then **Delete** the group.
2. **Launch template:** delete `simple-lt`.
3. **Load balancer:** delete `simple-alb`.
4. **Target group:** delete `simple-tg`.
5. **Instances:** terminate anything left (for example `simple-build`).
6. **AMI (Path B):** **EC2 → AMIs → Deregister AMI**, then **EC2 → Snapshots**, delete the snapshot that belonged to it.
7. **NAT gateway:** **VPC → NAT gateways → Delete**. Wait until it is **Deleted**, then **VPC → Elastic IPs → Release** the address.
8. **EC2 Instance Connect Endpoint** (if you created one): delete it under **VPC → Endpoints**.
9. **VPC:** **Actions → Delete VPC** (the console offers to remove the subnets, route tables and internet gateway). Delete the security groups first if the delete is blocked.
10. **Key pair** `simple-key`: delete if you are done.

---

## Notes and trade-offs

- **Running as root.** PM2 and the app run as root to keep the setup simple. A dedicated unprivileged user is a sensible hardening step. The private subnet and security group limit what can reach the app.
- **HTTP only.** The ALB listener serves plain HTTP. For anything real, request a free certificate in AWS Certificate Manager, add an HTTPS : 443 listener, open 443 in `simple-alb-sg`, and redirect port 80 to 443.
- **Secrets.** This app has none. If you add some later, the same pattern applies: write them into `.env` from the user data script. Anyone who can read the launch template or log in to an instance can then read them, so restrict IAM access and rotate if exposed.
- **Path A and the moving target.** `apt` and `npm` fetch whatever is current at each boot, and a branch can change between two scale-outs. Pin `GIT_REF` to a tag or commit for predictable instances.
- **One NAT gateway** is a single point of failure for outbound access. With Path B you can skip it entirely, because running instances need no internet.
- **Cost.** The ALB, NAT gateway (if created), detailed monitoring and EC2 instances all bill, and the load test adds ALB and data transfer charges. Run the cleanup when you are done and check current AWS pricing for your region.
- **Burstable instances.** `t3` instances run in "unlimited" credit mode by default and can bill for surplus CPU during a long load test. That is fine for a short demo.
- **Why not scale on request count?** CPU is the metric used here because `/load` makes it predictable. For real APIs, `ALBRequestCountPerTarget` is often a better scaling signal, and the ASG policy dialog offers it.

---

## Screenshot checklist

Save each file in an `images/` folder next to this guide.

| File | Step | What to capture |
|---|---|---|
| `01-vpc-wizard.png` | 3 | VPC → Create VPC with "VPC and more" selected and the settings filled in |
| `02-vpc-preview.png` | 3 | The wizard's preview panel showing 4 subnets, route tables, IGW, NAT |
| `03-route-table-private.png` | 3 | A private route table's Routes tab with `0.0.0.0/0 → nat-...` |
| `04-security-groups.png` | 4 | The security groups list with the three groups in `simple-vpc` |
| `05-target-group-create.png` | 5 | Target group basic settings (instances, HTTP 3000, VPC) |
| `06-target-group-health.png` | 5 | Health check path `/health` and advanced thresholds |
| `07-alb-create.png` | 6 | ALB basic config and the two public subnet mappings |
| `08-alb-listener.png` | 6 | Listener HTTP:80 forwarding to `simple-tg` |
| `09-lt-create.png` | 7A | Launch templates page with the Create button |
| `10-lt-ami-ubuntu.png` | 7A | Quick Start AMI selection: Ubuntu Server 24.04 LTS |
| `11-lt-security-group.png` | 7A | Network settings with `simple-app-sg` |
| `12-lt-advanced-user-data-a.png` | 7A | Advanced details: detailed monitoring, IMDSv2, the long user data |
| `13-build-launch.png` | 7B | Launching `simple-build` in the public subnet with a public IP |
| `14-build-script-output.png` | 7B | Terminal showing `build-ami.sh` finishing and the deployed commit |
| `15-create-image-menu.png` | 7B | Actions → Image and templates → Create image |
| `16-create-image-form.png` | 7B | Create image form with `simple-api-ami` |
| `17-ami-available.png` | 7B | AMI list showing `simple-api-ami` as Available |
| `18-lt-ami-custom.png` | 7B | Launch template with My AMIs → `simple-api-ami` |
| `19-lt-advanced-user-data-b.png` | 7B | Advanced details with the short user data |
| `20-asg-create.png` | 8 | Auto Scaling groups page with the Create button |
| `21-asg-name-template.png` | 8 | ASG step 1: name and launch template |
| `22-asg-network.png` | 8 | ASG step 2: the two private subnets selected |
| `23-asg-load-balancer.png` | 8 | ASG step 3: `simple-tg` attached, ELB health checks on |
| `24-asg-size-scaling.png` | 8 | ASG step 4: capacity 2/2/4 and the 60% CPU target tracking policy |
| `25-asg-instances-healthy.png` | 8 | Instance management with two healthy InService instances |
| `26-browser-alb-response.png` | 9 | Browser showing the JSON from `http://<alb-dns>/` |
| `27-autocannon-health.png` | 10.1 | autocannon result for `/health` |
| `28-autocannon-load-running.png` | 10.3 | autocannon running the heavy `/load` test |
| `29-asg-activity-scale-out.png` | 10.3 | ASG Activity tab showing new instances launched by the policy |
| `30-cloudwatch-cpu.png` | 10.3 | CPU utilization graph rising above 60% |
| `31-asg-activity-scale-in.png` | 10.6 | ASG Activity showing instances terminated after the test |
| `32-self-healing.png` | 10.7 | An instance terminated and a replacement launching |
| `33-cleanup.png` | Cleanup | Any cleanup screen, such as deleting the ASG |