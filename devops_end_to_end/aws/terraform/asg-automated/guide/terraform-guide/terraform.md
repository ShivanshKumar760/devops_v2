# Additions for the Simple API ASG guide

Three paste-ready parts for `simple-api-asg-guide.md`:

- **Part 1** explains the `/load` endpoint line by line. Paste it right after the `src/server.js` listing in Step 1 (it replaces the short "Why `/load` is synchronous" paragraph).
- **Part 2** replaces the manual console work with code: **Packer** builds the golden AMI and **Terraform** creates the VPC, load balancer and Auto Scaling group. It uses the golden AMI approach only. Paste it as a new top-level section (for example "Step 11: Packer and Terraform") before **Cleanup**.
- **Part 3** is the **Node.js cluster-mode** section: how the cluster module works, how it compares with async, Docker, PM2 and the ASG, then a **banking API** (JWT, ACID transfers) that is deployed on the ASG at the end with the Packer and Terraform setup from Part 2. Paste it after Part 2.

---

# Part 1: How the `/load` endpoint works

```js
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
```

## The goal

`/load` exists to **burn a predictable amount of CPU on purpose**. One request keeps one CPU core completely busy for about `ms` milliseconds. That lets you reason about load with simple arithmetic and then watch the Auto Scaling Group react.

## Block 1: read and clamp the `ms` query parameter

```js
app.get('/load', (req, res) => {
  const requested = Number.parseInt(req.query.ms, 10);
  const ms = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_BURN_MS) : 100;
```

| Piece | What it does |
|---|---|
| `app.get('/load', ...)` | Registers a handler for `GET /load`. `req` is the incoming request and `res` is the response you send back. |
| `req.query.ms` | The `ms` value from the URL, for example `/load?ms=300` gives the **string** `"300"`. If the parameter is missing it is `undefined`. |
| `Number.parseInt(value, 10)` | Converts the string to an integer, using base 10. `"300"` becomes `300`. `"abc"` and `undefined` become `NaN` ("not a number"). `"100abc"` becomes `100` because parsing stops at the first non-digit. |
| `Number.isFinite(requested)` | True only for real numbers. It rejects `NaN` and `Infinity`, so garbage input falls back to the default. |
| `Math.max(requested, 1)` | Raises anything below 1 up to 1, so zero and negative numbers are not allowed. |
| `Math.min(..., MAX_BURN_MS)` | Caps the value at `MAX_BURN_MS` (2000). Nobody can ask for a 10-minute burn. |
| `: 100` | The default when `ms` is missing or invalid. |

Examples:

| Request | `requested` | `ms` used |
|---|---|---|
| `/load` | `NaN` | `100` (default) |
| `/load?ms=300` | `300` | `300` |
| `/load?ms=0` | `0` | `1` |
| `/load?ms=-50` | `-50` | `1` |
| `/load?ms=99999` | `99999` | `2000` (capped) |
| `/load?ms=abc` | `NaN` | `100` (default) |

The cap matters because this endpoint is public. Without it, anyone could send `ms=3600000` and freeze a worker for an hour.

## Block 2: the busy loop that burns the CPU

```js
  const started = process.hrtime.bigint();
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) {
    x += Math.sqrt(Math.random() * 1e6) * Math.sin(x); // pointless math to keep the CPU busy
  }
```

| Line | What it does |
|---|---|
| `process.hrtime.bigint()` | A high-resolution timer that returns the current time in **nanoseconds** as a `BigInt`. It is monotonic (it never jumps backwards), so it is the right tool for measuring how long something took. We save it as `started`. |
| `Date.now() + ms` | The current wall-clock time in milliseconds plus the burn duration. This is the **deadline** (`end`). |
| `let x = 0` | An accumulator. It exists so the math below has a visible result. |
| `while (Date.now() < end)` | Keep looping until the clock passes the deadline. The loop never sleeps or waits, it just keeps checking the time. This is called a **busy wait**. |
| `Math.random() * 1e6` | A random number between 0 and 1,000,000. |
| `Math.sqrt(...)` | Square root of that number, between 0 and 1000. |
| `Math.sin(x)` | Sine of the running total, a value between -1 and 1. |
| `x += ... * ...` | Multiplies the two and adds the result to `x`. |

Why the "pointless math"? Two reasons:

1. The loop itself would already use CPU (calling `Date.now()` over and over), but the extra arithmetic makes each pass do real floating-point work.
2. If `x` were never used, a modern JavaScript engine (V8) could decide the computation has no effect and optimize it away. Because each iteration depends on the previous value of `x`, and `x` is part of the program's state, the work stays in the compiled code. The numbers themselves do not matter. `x` just wanders around randomly and stays finite.

Why not `setTimeout` or a sleep? Sleeping uses **no CPU**. The thread would just wait and the instance's CPU graph would stay flat, which defeats the purpose.

## Block 3: measure how long it really took

```js
  const burnedMs = Number(process.hrtime.bigint() - started) / 1e6;
```

- `process.hrtime.bigint() - started` is the elapsed time in nanoseconds, still a `BigInt`. BigInt subtraction has to happen **before** converting, because JavaScript does not let you mix `BigInt` and normal numbers in one expression.
- `Number(...)` converts the BigInt to a normal number.
- `/ 1e6` divides by 1,000,000 to turn nanoseconds into milliseconds.

The result is usually slightly **larger** than `ms`, because the loop checks the clock on each pass and overshoots the deadline by a fraction of a millisecond.

## Block 4: send the answer

```js
  res.json({
    host: os.hostname(),
    pid: process.pid,
    requestedMs: ms,
    burnedMs: Math.round(burnedMs),
  });
});
```

| Field | Meaning |
|---|---|
| `host` | The instance's hostname (for example `ip-10-0-11-25`). Shows which EC2 instance answered. |
| `pid` | The process ID of the Node worker that handled the request. With PM2 cluster mode each vCPU has its own worker, so this shows which worker answered. |
| `requestedMs` | The burn time actually used after clamping (not necessarily what you asked for). |
| `burnedMs` | How long the loop really ran, rounded to a whole millisecond. |

A typical response:

```json
{ "host": "ip-10-0-12-44", "pid": 2187, "requestedMs": 100, "burnedMs": 100 }
```

## Why one request blocks everything else on that worker

Node.js runs your JavaScript on **one thread** with an event loop. Normally a request waits for I/O (database, network) and the event loop serves other requests in the meantime. A `while` loop is the opposite: it is **synchronous**, so while it runs, that worker cannot do anything else, including answering `/health`.

```
one PM2 worker, three requests arriving at about the same time

time ─────────────────────────────────────────────────────────────►
 /load (100 ms) ██████████
 /load (100 ms)           ██████████        <- waits 100 ms in the queue, then burns 100 ms
 /health                            ·       <- waits 200 ms, then answers in about 1 ms
```

This is exactly why the load test works (the CPU is genuinely saturated), and also why the guide warns that health checks can time out when the group is overloaded.

## Turning it into capacity numbers

One request occupies one core for `ms` milliseconds, so:

```
requests per second per core = 1000 / ms
```

| `ms` | Requests/s per core | Per 2-vCPU instance | Two instances |
|---|---|---|---|
| 20 | 50 | 100 | 200 |
| 100 | 10 | 20 | 40 |
| 500 | 2 | 4 | 8 |

That is the arithmetic behind the load test in Step 10: with `ms=100` and 40 connections, two instances can do at most about 40 requests per second, so the CPUs stay near 100% and the ASG scales out.

## Caveats

- **It is a synthetic load.** Real APIs spend most of their time waiting on databases and networks, so use this only to exercise scaling.
- **Time-boxed, not work-boxed.** The loop runs until a clock deadline. If the CPU is throttled (for example `t2` instances out of credits), it still holds the thread for `ms` milliseconds, but the hypervisor may give it less real CPU, so the CPU graph can look lower than expected.
- **Do not leave it in production.** It is a public endpoint that burns CPU on demand. Remove it or protect it once testing is done.

---

# Part 2: Build the AMI with Packer and the infrastructure with Terraform

This section replaces the manual console work with two tools:

- **Packer** builds the **golden AMI** automatically: it launches a temporary instance, installs Node.js and PM2, clones your code, smoke tests the app, and saves the image. No SSH session, no clicking "Create image".
- **Terraform** creates all the infrastructure around it (VPC, subnets, route tables, load balancer, Auto Scaling group) from three files, and launches every instance from the AMI Packer built.

```
  GitHub repo ──► Packer ──► golden AMI (simple-api-ami-<timestamp>)
                                        │
                                        ▼
                  Terraform ──► VPC + subnets + ALB + launch template + ASG (instances in private subnets)
```

Because the code is already inside the AMI, the running instances download nothing at boot. The only thing user data does is write a small `.env` file and start PM2. That means the private instances **do not need a NAT gateway**, and Terraform leaves it off by default.

## What is automated

| Manual step in the console guide | Done by |
|---|---|
| VPC wizard: VPC, subnets, route tables, internet gateway | Terraform (`aws_vpc`, `aws_subnet`, `aws_route_table`, `aws_internet_gateway`) |
| Security groups, target group, ALB, listener | Terraform |
| Launch the build instance, SSH in, run the build script | Packer (`amazon-ebs` builder and `shell` provisioner) |
| Smoke test, clean the box, `cloud-init clean` | Packer (`provision.sh`) |
| Actions → Create image, wait for Available, terminate the build box | Packer (it does all three and removes its temporary key and security group) |
| Launch template, ASG, 60% CPU scaling policy | Terraform |
| Cleanup | `terraform destroy` (plus deleting old AMIs, see the end of this section) |

## Prerequisites

- **Terraform 1.5 or newer** ([install](https://developer.hashicorp.com/terraform/install)): `terraform version`.
- **Packer 1.10 or newer** ([install](https://developer.hashicorp.com/packer/install)): `packer version`.
- **AWS credentials** on your machine (`aws configure`, environment variables, or SSO), with permission to create EC2, VPC, load balancer and Auto Scaling resources and AMIs. **AWS CloudShell** works too. For learning, an administrator-level user is simplest.
- **Your code on GitHub** (see Step 2 of the guide). The repository must contain `ecosystem.config.cjs`, `package.json` and `package-lock.json`. A public repo needs no credentials. For a private repo, Packer accepts a read-only token.
- **A default VPC in the region** is the easiest way to run Packer (it builds there). If your account has none, see the note in "Build the AMI".

## Folder layout

Add two folders to the project from Step 1 of the guide:

```
simple-asg-api/
├── src/server.js            # the API from Step 1
├── ecosystem.config.cjs     # PM2 config (cwd /opt/simple-api)
├── package.json
├── package-lock.json
├── packer/
│   ├── simple-api.pkr.hcl   # Packer template
│   └── provision.sh         # runs inside the temporary build instance
└── terraform/
    ├── main.tf
    ├── variables.tf
    └── outputs.tf
```

---

## Packer: build the golden AMI

### `packer/simple-api.pkr.hcl`

```hcl
packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type        = string
  default     = "ap-south-1"
  description = "Region to build and store the AMI in. Must match Terraform's aws_region."
}

variable "instance_type" {
  type        = string
  default     = "t3.micro"
  description = "Instance type of the temporary build instance."
}

variable "ami_name_prefix" {
  type        = string
  default     = "simple-api-ami"
  description = "AMIs are named <prefix>-<timestamp>. Must match Terraform's ami_name_prefix."
}

variable "repo_url" {
  type        = string
  description = "HTTPS clone URL of the app repository, for example https://github.com/you/simple-asg-api.git"
}

variable "repo_branch" {
  type    = string
  default = "master"
}

variable "github_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Only for PRIVATE repositories: a read-only token. Leave empty for public repositories."
}

variable "vpc_id" {
  type        = string
  default     = ""
  description = "Optional. Only needed if the account has no default VPC."
}

variable "subnet_id" {
  type        = string
  default     = ""
  description = "Optional. A PUBLIC subnet (one that auto-assigns public IPs), needed together with vpc_id."
}

variable "app_dir" {
  type        = string
  default     = "/opt/simple-api"
  description = "Directory on the instance where the repository is cloned. Must match the cwd in the repo's ecosystem.config.cjs and Terraform's app_dir."
}

variable "smoke_test" {
  type        = bool
  default     = true
  description = "Start the app during the build and curl /health and /load. Set false for apps that need a database or secrets to start (for example the banking API)."
}

locals {
  timestamp = formatdate("YYYYMMDD-hhmmss", timestamp())
}

source "amazon-ebs" "simple_api" {
  region        = var.region
  instance_type = var.instance_type
  ami_name      = "${var.ami_name_prefix}-${local.timestamp}"
  ami_description = "Ubuntu 24.04 + Node 22 + PM2 + simple-asg-api (built by Packer)"

  # Newest Ubuntu Server 24.04 LTS from Canonical
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"]
    most_recent = true
  }

  # Networking for the temporary build instance (empty values = use the default VPC)
  vpc_id                      = var.vpc_id
  subnet_id                   = var.subnet_id
  associate_public_ip_address = true

  # Packer creates a temporary key pair and a temporary security group that
  # allows SSH only from your current public IP, and deletes both afterwards.
  ssh_username                              = "ubuntu"
  ssh_clear_authorized_keys                 = true
  temporary_security_group_source_public_ip = true

  tags = {
    Name      = "${var.ami_name_prefix}-${local.timestamp}"
    BuiltBy   = "packer"
    Project   = "simple-asg-api"
  }
  snapshot_tags = {
    Name    = "${var.ami_name_prefix}-${local.timestamp}"
    BuiltBy = "packer"
  }
  run_tags = {
    Name = "packer-build-${var.ami_name_prefix}"
  }
}

build {
  name    = "simple-api"
  sources = ["source.amazon-ebs.simple_api"]

  provisioner "shell" {
    script = "${path.root}/provision.sh"
    environment_vars = [
      "REPO_URL=${var.repo_url}",
      "BRANCH=${var.repo_branch}",
      "GITHUB_TOKEN=${var.github_token}",
      "APP_DIR=${var.app_dir}",
      "SMOKE_TEST=${var.smoke_test}",
    ]
    # run as root, keeping the variables above
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E {{ .Path }}"
  }

  # Writes manifest.json with the new AMI ID
  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
  }
}
```

### `packer/provision.sh`

This is the script Packer runs inside the temporary instance. If any command fails (including the smoke test), the build stops and **no AMI is created**, so a broken image can never reach your ASG.

```bash
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
```

### Build the AMI

Run from the `packer/` folder:

```bash
cd packer
packer init .           # downloads the Amazon plugin

packer validate -var 'repo_url=https://github.com/YOUR_GITHUB_USER/simple-asg-api.git' .
packer build    -var 'repo_url=https://github.com/YOUR_GITHUB_USER/simple-asg-api.git' .
```

Use `-var 'repo_branch=main'` if your branch is not `master`. For a **private repo** add a read-only token, ideally through the environment so it stays out of your shell history:

```bash
export PKR_VAR_github_token='github_pat_...'
packer build -var 'repo_url=https://github.com/YOU/private-repo.git' .
```

What you will see, in order: Packer finds the newest Ubuntu 24.04 image, creates a temporary key pair and security group, launches a `t3.micro`, waits for SSH, runs `provision.sh` (the output of every step streams to your terminal, including the smoke test responses), stops the instance, creates the AMI and its snapshot, terminates the instance, and deletes the key pair and security group. It takes roughly 5 to 8 minutes. The last lines look like:

```
==> simple-api.amazon-ebs.simple_api: Creating AMI simple-api-ami-20260101-101500 from instance i-0abc...
==> simple-api.amazon-ebs.simple_api: AMI: ami-0123456789abcdef0
Build 'simple-api.amazon-ebs.simple_api' finished after 6 minutes 12 seconds.
```

`manifest.json` in the same folder records the AMI ID. You can also check it in **EC2 → AMIs** (status **Available**).

**If your account has no default VPC:** Packer fails with a message about a missing VPC or subnet. Create the network first with Terraform (next section, with `-var create_asg=false`), then pass its IDs to Packer:

```bash
packer build \
  -var 'repo_url=https://github.com/YOUR_GITHUB_USER/simple-asg-api.git' \
  -var "vpc_id=$(terraform -chdir=../terraform output -raw vpc_id)" \
  -var "subnet_id=$(terraform -chdir=../terraform output -json public_subnet_ids | jq -r '.[0]')" .
```

---

## Terraform: build the infrastructure

Exactly three files in `terraform/`.

### What the console's "VPC and more" wizard becomes

| Console wizard item | Terraform resource(s) in `main.tf` |
|---|---|
| VPC `10.0.0.0/16`, DNS hostnames on | `aws_vpc.this` |
| 2 public + 2 private subnets in 2 AZs | `aws_subnet.public`, `aws_subnet.private` (`count` and `cidrsubnet()`) |
| Internet gateway | `aws_internet_gateway.this` |
| Public route table with `0.0.0.0/0 → igw` | `aws_route_table.public`, `aws_route.public_internet`, `aws_route_table_association.public` |
| NAT gateway and Elastic IP (optional here) | `aws_eip.nat`, `aws_nat_gateway.this` |
| Private route tables (with `0.0.0.0/0 → nat` only if NAT is enabled) | `aws_route_table.private`, `aws_route.private_nat`, `aws_route_table_association.private` |

### `terraform/variables.tf`

```hcl
variable "aws_region" {
  description = "AWS region to deploy into. Must be the region where Packer stored the AMI."
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Prefix for every resource name (simple-vpc, simple-alb, simple-asg, ...)."
  type        = string
  default     = "simple"
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC. Subnets are carved out of it as /24 blocks."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of Availability Zones to use (this many public and this many private subnets)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (the load balancer needs at least two AZs)."
  }
}

variable "enable_nat_gateway" {
  description = "Create NAT gateway(s) so private instances can reach the internet. The golden AMI needs no internet at runtime, so this is off by default. Turn it on if the app later calls external services (for example MongoDB Atlas)."
  type        = bool
  default     = false
}

variable "single_nat_gateway" {
  description = "Only used when enable_nat_gateway is true. true = one shared NAT gateway (cheaper). false = one per AZ (survives an AZ outage, costs more)."
  type        = bool
  default     = true
}

variable "create_asg" {
  description = "Create the launch template, Auto Scaling group and scaling policy. Set false to build only the network and load balancer (for example before running Packer in this VPC)."
  type        = bool
  default     = true
}

variable "ami_name_prefix" {
  description = "Name prefix of the AMIs built by Packer. The newest AMI in this account whose name starts with it is used."
  type        = string
  default     = "simple-api-ami"
}

variable "instance_type" {
  description = "EC2 instance type. Prefer t3 (t2 throttles CPU and distorts the load test)."
  type        = string
  default     = "t3.micro"
}

variable "min_size" {
  description = "Minimum number of instances."
  type        = number
  default     = 2
}

variable "max_size" {
  description = "Maximum number of instances."
  type        = number
  default     = 4
}

variable "desired_capacity" {
  description = "Initial number of instances (the scaling policy changes it afterwards)."
  type        = number
  default     = 2
}

variable "cpu_target" {
  description = "Target average CPU utilization (percent) for the target tracking scaling policy."
  type        = number
  default     = 60
}

variable "health_check_grace_seconds" {
  description = "Seconds the ASG waits after launch before counting load balancer health checks, and the scaling warmup."
  type        = number
  default     = 120
}

variable "app_name" {
  description = "Value written to APP_NAME in each instance's .env file."
  type        = string
  default     = "simple-asg-api"
}

variable "app_dir" {
  description = "Directory on the instance where Packer cloned the repository (Packer's app_dir)."
  type        = string
  default     = "/opt/simple-api"
}

variable "app_env" {
  description = "Extra settings written to each instance's .env file, for example MONGO_URI and JWT_SECRET. Marked sensitive so Terraform hides the values in plan output."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}
```

### `terraform/main.tf`

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge({ Project = var.project_name, ManagedBy = "terraform" }, var.tags)
  }
}

############################################################
# Lookups and calculated values
############################################################

data "aws_availability_zones" "available" {
  state = "available"
}

# The newest AMI built by Packer: its name starts with ami_name_prefix
data "aws_ami" "app" {
  count       = var.create_asg ? 1 : 0
  most_recent = true
  owners      = ["self"]

  filter {
    name   = "name"
    values = ["${var.ami_name_prefix}*"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

locals {
  name = var.project_name
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # one NAT gateway, or one per AZ, or none
  nat_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : var.az_count) : 0

  ami_id = one(data.aws_ami.app[*].id)

  # Contents of the instance's .env file: three fixed settings plus everything in var.app_env
  env_file = join("\n", concat(
    ["PORT=3000", "NODE_ENV=production", "APP_NAME=${var.app_name}"],
    [for k, v in var.app_env : "${k}=${v}"]
  ))

  # Runs once, as root, on first boot of every instance. Node, PM2 and the code are already in the AMI.
  # The quoted 'EOF' stops bash from expanding $ or backticks inside secret values.
  user_data = <<-EOT
    #!/bin/bash
    set -eu
    export HOME=/root

    APP_DIR='${var.app_dir}'

    cat > "$APP_DIR/.env" <<'EOF'
    ${local.env_file}
    EOF
    chmod 600 "$APP_DIR/.env"

    cd "$APP_DIR"
    pm2 start ecosystem.config.cjs
    pm2 save
  EOT
}

############################################################
# Network: what the console's "VPC and more" wizard creates
############################################################

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.name}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.name}-igw" }
}

# Public subnets: 10.0.1.0/24, 10.0.2.0/24 (one per AZ)
resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 1)
  map_public_ip_on_launch = true # lets Packer's build instance get a public IP here; the ALB does not need it

  tags = {
    Name = "${local.name}-public-${substr(local.azs[count.index], -1, -1)}"
    Tier = "public"
  }
}

# Private subnets: 10.0.11.0/24, 10.0.12.0/24 (one per AZ)
resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 11)
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-private-${substr(local.azs[count.index], -1, -1)}"
    Tier = "private"
  }
}

# One public route table: everything not local goes to the internet gateway
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.name}-rtb-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Optional NAT gateway(s): live in public subnets and need an Elastic IP each
resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"

  tags       = { Name = "${local.name}-nat-eip-${count.index + 1}" }
  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags       = { Name = "${local.name}-nat-${count.index + 1}" }
  depends_on = [aws_internet_gateway.this]
}

# One private route table per AZ. It only gets a default route when NAT is enabled.
resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.name}-rtb-private-${substr(local.azs[count.index], -1, -1)}" }
}

resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? var.az_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

############################################################
# Security groups
############################################################

# The load balancer: HTTP from anywhere
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "Application Load Balancer: HTTP from the internet"
  vpc_id      = aws_vpc.this.id

  ingress {
    description      = "HTTP from anywhere"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb-sg" }
}

# The instances: port 3000 only from the load balancer, no SSH, no public IP
resource "aws_security_group" "app" {
  name        = "${local.name}-app-sg"
  description = "ASG instances: TCP 3000 from the load balancer only"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "App port from the ALB security group"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-app-sg" }
}

############################################################
# Target group, load balancer, listener
############################################################

resource "aws_lb_target_group" "app" {
  name                 = "${local.name}-tg"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  target_type          = "instance"
  deregistration_delay = 30 # seconds, so scale-in finishes sooner (default is 300)

  health_check {
    enabled             = true
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-tg" }
}

resource "aws_lb" "app" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id # the ALB lives in the PUBLIC subnets

  tags = { Name = "${local.name}-alb" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

############################################################
# Launch template, Auto Scaling group, scaling policy
############################################################

resource "aws_launch_template" "app" {
  count = var.create_asg ? 1 : 0

  name                   = "${local.name}-lt"
  description            = "Simple API from the Packer-built AMI"
  image_id               = local.ami_id
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.app.id]
  user_data              = base64encode(local.user_data)
  update_default_version = true

  # 1-minute CPU metrics, so scaling reacts in minutes
  monitoring {
    enabled = true
  }

  # IMDSv2 only
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-api" }
  }
}

resource "aws_autoscaling_group" "app" {
  count = var.create_asg ? 1 : 0

  name                      = "${local.name}-asg"
  min_size                  = var.min_size
  max_size                  = var.max_size
  desired_capacity          = var.desired_capacity
  vpc_zone_identifier       = aws_subnet.private[*].id # instances run in the PRIVATE subnets
  target_group_arns         = [aws_lb_target_group.app.arn]
  health_check_type         = "ELB"
  health_check_grace_period = var.health_check_grace_seconds
  default_instance_warmup   = var.health_check_grace_seconds

  launch_template {
    id      = aws_launch_template.app[0].id
    version = aws_launch_template.app[0].latest_version
  }

  # A new AMI or new user data changes the launch template, which rolls the instances automatically
  instance_refresh {
    strategy = "Rolling"

    preferences {
      min_healthy_percentage = 50
      instance_warmup        = var.health_check_grace_seconds
    }
  }

  tag {
    key                 = "Name"
    value               = "${local.name}-api"
    propagate_at_launch = true
  }

  # The scaling policy changes the desired capacity, so do not treat that as drift
  lifecycle {
    ignore_changes = [desired_capacity]
  }

  depends_on = [aws_lb_listener.http]
}

resource "aws_autoscaling_policy" "cpu" {
  count = var.create_asg ? 1 : 0

  name                      = "${local.name}-cpu-target"
  autoscaling_group_name    = aws_autoscaling_group.app[0].name
  policy_type               = "TargetTrackingScaling"
  estimated_instance_warmup = var.health_check_grace_seconds

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = var.cpu_target
  }
}
```

### `terraform/outputs.tf`

```hcl
output "alb_dns_name" {
  description = "DNS name of the load balancer."
  value       = aws_lb.app.dns_name
}

output "alb_url" {
  description = "Base URL of the API (HTTP)."
  value       = "http://${aws_lb.app.dns_name}"
}

output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs (the ALB and any NAT gateways live here; also usable for Packer if there is no default VPC)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (the ASG instances live here)."
  value       = aws_subnet.private[*].id
}

output "nat_gateway_public_ips" {
  description = "Elastic IP(s) of the NAT gateway(s). Empty when NAT is disabled."
  value       = aws_eip.nat[*].public_ip
}

output "alb_security_group_id" {
  description = "Security group of the load balancer."
  value       = aws_security_group.alb.id
}

output "app_security_group_id" {
  description = "Security group of the ASG instances."
  value       = aws_security_group.app.id
}

output "ami_in_use" {
  description = "The Packer-built AMI used by the launch template (null while create_asg = false)."
  value       = local.ami_id
}

output "asg_name" {
  description = "Name of the Auto Scaling group (null while create_asg = false)."
  value       = one(aws_autoscaling_group.app[*].name)
}

output "target_group_arn" {
  description = "ARN of the target group."
  value       = aws_lb_target_group.app.arn
}

output "try_it" {
  description = "Commands to test the API once instances are healthy."
  value       = <<-EOT
    curl http://${aws_lb.app.dns_name}/
    curl http://${aws_lb.app.dns_name}/health
    curl "http://${aws_lb.app.dns_name}/load?ms=100"
  EOT
}

output "load_test_command" {
  description = "autocannon command that saturates the group and triggers scale-out."
  value       = "npx autocannon -c 40 -d 600 -t 60 \"http://${aws_lb.app.dns_name}/load?ms=100\""
}
```

---

## Run it, start to finish

**1. Push your code to GitHub** (Step 2 of the guide). Packer clones whatever is on the branch.

**2. Build the AMI** (about 5 to 8 minutes):

```bash
cd packer
packer init .
packer build -var 'repo_url=https://github.com/YOUR_GITHUB_USER/simple-asg-api.git' .
```

**3. Create the infrastructure:**

```bash
cd ../terraform
terraform init          # downloads the AWS provider
terraform fmt           # optional: tidy formatting
terraform validate      # catches mistakes before touching AWS
terraform plan          # shows the ~25 resources it would create
terraform apply         # type "yes" to confirm
```

With the NAT gateway off (the default) this takes about 2 to 3 minutes. Terraform finds your newest `simple-api-ami*` image, creates the VPC, subnets, route tables, load balancer, launch template and ASG, and prints the outputs. The two instances become healthy within a minute or so of launching, because everything is already on disk. Watch them under **EC2 → Target Groups → `simple-tg` → Targets**.

**4. Test it and load test it:**

```bash
terraform output alb_url
terraform output -raw try_it
$(terraform output -raw load_test_command)     # autocannon: saturates the group, triggers scale-out
```

Then watch **ASG → Activity** and **Monitoring** exactly as in Step 10 of the guide. The 60% CPU policy, detailed monitoring and health checks are already configured. To change limits, edit variables (for example `-var max_size=6 -var cpu_target=50`) and run `terraform apply` again.

## Shipping a new version

1. Push your change to GitHub.
2. Build a new AMI: `cd packer && packer build -var 'repo_url=...' .` (a new AMI named `simple-api-ami-<new timestamp>`).
3. `cd ../terraform && terraform apply`.

Terraform's `most_recent` lookup finds the new image, the launch template gets a new version, and the ASG's `instance_refresh` block replaces the instances in rolling batches, keeping at least half of them healthy. You can watch it under **ASG → Instance refresh**.

## Optional: use a NAT gateway

The app in this guide makes no outbound calls, so the instances need no internet access. If you later add something that does (a MongoDB Atlas connection, a call to an external API), enable NAT:

```bash
terraform apply -var enable_nat_gateway=true                          # one shared NAT gateway
terraform apply -var enable_nat_gateway=true -var single_nat_gateway=false   # one per AZ
terraform output nat_gateway_public_ips                               # add these to the Atlas IP allow-list
```

## Destroy everything

```bash
cd terraform
terraform destroy       # add the same -var flags you used for apply
```

This removes everything Terraform created (ASG and its instances, launch template, load balancer, target group, NAT gateway and Elastic IP if any, subnets, route tables, internet gateway, security groups, VPC) in the right order.

Terraform does **not** know about the AMIs and snapshots Packer created. Delete them yourself (they bill for snapshot storage):

```bash
for ami in $(aws ec2 describe-images --owners self \
    --filters "Name=name,Values=simple-api-ami*" --query 'Images[].ImageId' --output text); do
  snaps=$(aws ec2 describe-images --image-ids "$ami" \
    --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text)
  aws ec2 deregister-image --image-id "$ami"
  for s in $snaps; do aws ec2 delete-snapshot --snapshot-id "$s"; done
done
```

Run it in the same region as the build (add `--region ap-south-1` to each command if your CLI default differs). Over time, also delete old AMIs from earlier builds you no longer need.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Packer: `VPCIdNotSpecified` or "no default VPC" | The account has no default VPC. Create the network with `terraform apply -var create_asg=false`, then pass `vpc_id` and `subnet_id` to Packer (see "Build the AMI"). |
| Packer: timeout waiting for SSH | The build subnet is not public or the instance got no public IP. Use the default VPC, or one of Terraform's public subnets. Also check your corporate network allows outbound SSH. |
| Packer: `UnauthorizedOperation` | Your AWS credentials lack EC2 permissions (run instances, create images, key pairs, security groups). |
| Packer build fails at the smoke test | The app did not start. Read the streamed output (PM2 logs and curl errors). Common causes: `package-lock.json` not committed, wrong branch, or `ecosystem.config.cjs` missing from the repo. A failed build creates no AMI. |
| Terraform: `Your query returned no results` for the AMI | No AMI whose name starts with `ami_name_prefix` exists in this account and region. Run the Packer build, and make sure Packer's `region` equals Terraform's `aws_region`. |
| Terraform: target group or load balancer name already exists | A previous manual or Terraform build left resources with the same names. Delete them or use `-var project_name=...`. |
| Targets stay unhealthy | Check `simple-app-sg` allows TCP 3000 from `simple-alb-sg` (Terraform sets this), and that the instance started PM2. There is no shell by default: add an EC2 Instance Connect Endpoint (see the guide's optional section) and read `/var/log/cloud-init-output.log`. |
| Instances do not pick up the new AMI after `terraform apply` | Confirm the new AMI name starts with the same prefix and its state is Available. Then check **ASG → Instance refresh**. |
| `terraform destroy` stalls on a subnet or security group | A leftover instance or network interface still uses it. Terminate stray instances (for example a manually launched debug box) and retry. |

## Notes

- **State.** Terraform records what it created in `terraform.tfstate` in the working folder. Keep that file safe and do not commit it. For a team, use a remote backend such as an S3 bucket.
- **Cost.** The load balancer, detailed monitoring and instances bill by the hour (plus the NAT gateway if you enabled it). Run `terraform destroy` when you are done, and delete old AMIs.
- **Subnet math.** `cidrsubnet(var.vpc_cidr, 8, n)` carves `/24` blocks out of the `/16`: public subnets use blocks 1 and 2 (`10.0.1.0/24`, `10.0.2.0/24`) and private subnets use blocks 11 and 12 (`10.0.11.0/24`, `10.0.12.0/24`), matching the console version of this guide.
- **Secrets.** The simple API has none. For an app that does (like the banking API in Part 3), pass them through the sensitive `app_env` variable, for example `export TF_VAR_app_env='{"MONGO_URI":"...","JWT_SECRET":"..."}'`. Each entry becomes a line in the instance's `.env` file. Anyone who can read the launch template, or log in to an instance, can read them, and they are stored in `terraform.tfstate`, so keep state private and restrict IAM access.
- **Why the AMI is built in a separate tool.** Packer gives you a repeatable, scripted image with a built-in smoke test, and Terraform stays in charge of the long-lived infrastructure. The two meet only through the AMI name prefix.


---

# Part 3: Scaling with Node.js cluster mode, then deploying a banking API on the ASG

Part 2 ran the API under PM2 in cluster mode without explaining what that really is. This part fills the gap. It starts with how the Node.js **cluster module** works and how it differs from async code, Docker, PM2 and an AWS Auto Scaling Group. It then builds a **banking API** (JWT sign-up, $200 welcome credit, ACID money transfers) that stays correct when many workers write at the same time. It ends by deploying that API on an ASG with the Packer and Terraform setup from Part 2.

## How this fits the rest of the guide

| Layer | Tool | What it scales |
|---|---|---|
| Inside one instance | Node.js cluster module (or PM2 cluster mode) | Uses every CPU core of one VM (vertical) |
| Across instances | AWS Auto Scaling Group + ALB | Adds and removes whole VMs (horizontal) |
| Shared state | MongoDB Atlas | The one source of truth every worker and instance talks to |

Sections 3.1 to 3.13 run on your laptop (the banking API is 3.12 and the Atlas setup is 3.13). The AWS deployment is section 3.14.

> Image placeholders in this part use `images/...` paths like the rest of the guide. Save your own diagrams under those names, for example `images/cluster-vs-spawn-diagram.png`.

---

## 3.1 What is the Node.js cluster module?

The cluster module is a built-in tool that lets you scale a Node.js application by starting multiple child processes (workers) that share the same server port.

Node.js runs your JavaScript on a single thread, on a single CPU core, so a standard app cannot use all the cores of a multi-core server. The cluster module solves this by launching one copy of your app per core.

### How it works

- **Primary (master) process:** does not run your routes. It finds out how many cores exist, forks the workers, and distributes incoming connections.
- **Worker processes:** independent child processes created with `child_process.fork()`. Each has its own V8 instance, event loop and memory, but they all share the primary's server port (for example 3000).

### Load balancing

By default the primary accepts incoming connections and hands them to the workers in **round-robin** order (except on Windows). If one worker is stuck on a heavy CPU task, the others keep serving requests.

### Core benefits

1. **Multi-core use:** use all of the machine's processing capacity.
2. **High availability:** if a worker crashes, the primary hears the `exit` event and forks a replacement.
3. **Inter-process communication:** workers have isolated memory but can talk to the primary with `process.send()` and `process.on('message')`.

### Basic example

```javascript
const cluster = require('node:cluster');
const http = require('node:http');
const { availableParallelism } = require('node:os');
const process = require('node:process');

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  console.log(`Primary process ${process.pid} is running. Forking ${numCPUs} workers...`);

  // Fork workers for each CPU core
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Restart a worker if it crashes
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Spawning a replacement...`);
    cluster.fork();
  });

} else {
  // Workers share the same TCP connection/HTTP server port
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end(`Handled by worker ${process.pid}\n`);
  }).listen(8000);

  console.log(`Worker ${process.pid} started.`);
}
```

### The important trade-off

Workers do not share memory. In-memory state such as sessions or global variables does not work out of the box: a request handled by worker A will not see data stored by worker B. Production apps keep shared state in an external store such as **Redis** or a database.

> In production, a process manager such as **PM2** can do the clustering from the command line without changing your application code (see 3.8).

---

## 3.2 Cluster vs `spawn`

A computer's CPU contains multiple physical or logical cores, each able to execute instructions independently.

![Image placeholder: Diagram of a computer and its CPU cores, showing how the cluster module and child_process.spawn() use the cores and handle incoming web traffic](images/cluster-vs-spawn-diagram.png)

| Feature | `cluster` module | `child_process.spawn()` |
|---|---|---|
| **Primary purpose** | Horizontal scaling of the same network application to handle heavy user traffic. | Running external commands or separate scripts (a Python script, `ffmpeg`). |
| **Port sharing** | Yes. Every worker shares the same server port (for example 8000). | No. Child processes are isolated command-line instances and do not natively share server ports. |
| **Load balancing** | Built in. The primary distributes requests round-robin. | None. You coordinate data streams (stdin, stdout) yourself. |
| **Code execution** | Clones the whole application environment (V8 instance, event loop). | Launches a completely new command outside the current Node.js file. |

**Analogy.** Cluster is like opening four identical checkout lines in a grocery store. They share the store's main entrance (the port), and a manager (the primary) directs incoming customers evenly to each line. Spawn is like a cashier hiring a delivery driver: the cashier (main process) hands a heavy package to the driver (child process) and carries on ringing up items.

---

## 3.3 CPU cores and ports: who owns what?

### The hardware: CPU chip and cores

A **CPU chip** is a piece of silicon divided into independent processing units called **cores**.

- Cores are isolated when executing instructions. Each has its own ALU, execution pipelines and private L1/L2 caches.
- Cores have **no concept of network ports**. A port such as 8000 does not exist in hardware. It is purely a software concept managed by the OS kernel.

![Image placeholder: Diagram of a CPU chip with multiple cores (Core 0 to Core N), each with its own ALU and L1/L2 cache, sitting below the OS kernel layer that owns the network ports](images/cpu-chip-and-cores.png)

### The software: how workers "share" a port

Because ports are managed by the OS kernel, hardware isolation does not stop processes on different cores from sharing one.

**Method A: file descriptor passing (default Node.js round-robin).** Workers do not actually bind to the port.

1. The primary process binds to the port (for example 8000).
2. When a client connects, the kernel hands the connection to the primary.
3. The primary accepts it and takes the socket handle (file descriptor).
4. Over an IPC channel the primary passes that handle to a worker running on another core.

**Method B: kernel-level sharing (`SO_REUSEPORT`).** If the OS is told to allow it:

1. The kernel keeps a central port mapping table.
2. Several worker processes on different cores can bind to `0.0.0.0:8000` at once without conflict.
3. The kernel itself load-balances, using a hash to spread incoming connections.

### Direct answers

- **Is every port isolated to its core?** No. Ports belong to the OS kernel, not to a CPU core. The kernel can route traffic from one port to any process on any core.
- **How do different cores share the same port?** They are not talking to the network wire directly. They either go through a primary process that is the single gateway to the port, or use `SO_REUSEPORT` so the OS distributes traffic among several listeners.

---

## 3.4 A simple scalable API with Express and cluster

```bash
mkdir express-cluster-api
cd express-cluster-api
npm init -y
npm install express
```

`server.js`:

```javascript
const cluster = require('node:cluster');
const { availableParallelism } = require('node:os');
const process = require('node:process');
const express = require('express');

// 1. PRIMARY (MASTER) PROCESS CODE
if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  console.log(`[Primary ${process.pid}] Central Manager is running.`);
  console.log(`[Primary ${process.pid}] Spawning ${numCPUs} worker processes...\n`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Self-healing: if a worker dies, spawn a replacement
  cluster.on('exit', (worker, code, signal) => {
    console.error(`[Primary] Worker ${worker.process.pid} died (Code: ${code} | Signal: ${signal}).`);
    console.log('[Primary] Spawning a healthy replacement worker...');
    cluster.fork();
  });

// 2. WORKER PROCESS CODE (The Actual Express Instance)
} else {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Logging middleware to see which worker handles which request
  app.use((req, res, next) => {
    console.log(`[Worker ${process.pid}] Handling request for: ${req.url}`);
    next();
  });

  app.get('/api/health', (req, res) => {
    res.status(200).json({
      status: 'Healthy',
      message: 'API is running optimally',
      meta: {
        workerPid: process.pid,
        platform: process.platform,
        uptime: Math.floor(process.uptime()) + 's'
      }
    });
  });

  // Heavy computation that would normally block a single thread
  app.get('/api/compute', (req, res) => {
    let sum = 0;
    for (let i = 0; i < 1e7; i++) {
      sum += i;
    }
    res.json({
      success: true,
      result: sum,
      handledByWorker: process.pid
    });
  });

  app.listen(PORT, () => {
    console.log(`  └─> [Worker ${process.pid}] Express server bound and listening on port ${PORT}`);
  });
}
```

Run it with `node server.js`. On a 4-core CPU the output looks like:

```text
[Primary 14204] Central Manager is running.
[Primary 14204] Spawning 4 worker processes...

  └─> [Worker 14212] Express server bound and listening on port 3000
  └─> [Worker 14216] Express server bound and listening on port 3000
  └─> [Worker 14220] Express server bound and listening on port 3000
  └─> [Worker 14224] Express server bound and listening on port 3000
```

### How the scaling works under the hood

1. **Port virtualization:** when you hit `http://localhost:3000/api/health`, the OS directs the traffic to the primary, which hands the socket to one of the workers in round-robin order.
2. **Non-blocking scaling:** a request to `/api/compute` monopolises the single thread of one worker, but the other workers keep serving other users with no added latency.

---

## 3.5 Async vs cluster

They solve **different problems**. Async (the event loop) gives you **concurrency** on one thread. Cluster gives you **parallelism** across multiple processes.

### Async (event loop): concurrency

- Node.js runs your JavaScript on a **single thread** with one event loop.
- When your code reaches an I/O operation (database query, file read, HTTP call), it hands the work to the OS or libuv and **moves on to the next request** instead of waiting. When the result is ready, a callback or promise resolution is queued back onto the event loop.
- Only **one piece of JS runs at any instant**, but many requests can be "in flight" because most of their time is spent waiting.
- Network I/O is handled by the OS (epoll/kqueue/IOCP). Some operations (`fs`, `crypto`, `zlib`, `dns.lookup`) run on libuv's small **thread pool** (4 threads by default), but your JavaScript still runs on the one main thread.

**Analogy:** one cashier who takes an order, hands it to the kitchen, and immediately serves the next customer while the food cooks. One person, many orders in progress.

```javascript
// Async: the thread is free while MongoDB works
app.get('/api/products', async (req, res) => {
  const products = await Product.find(); // thread is NOT blocked while waiting
  res.json(products);
});
```

### Cluster mode: parallelism

- Multiple **separate processes**, each with its own V8 instance, event loop and memory, running on different cores.
- Several pieces of JS genuinely execute at the **same instant**, one per core.

**Analogy:** four cashiers working independently. Four people, four orders truly processed at once.

### Why async alone isn't enough

Async only helps when the code is **waiting**. It does nothing for **CPU-bound** work, because a long synchronous computation blocks the single thread and every other request waits behind it.

```javascript
// CPU-bound: async/await does NOT help here
app.get('/api/compute', (req, res) => {
  let sum = 0;
  for (let i = 0; i < 1e9; i++) sum += i; // blocks the event loop completely
  res.json({ sum });                       // all other requests are frozen meanwhile
});
```

- **Without cluster:** while this loop runs, the whole server is unresponsive, even to `/api/health`.
- **With cluster:** only the worker running the loop is busy. The others keep serving.

Wrapping blocking code in `async` or a `Promise` does **not** make it non-blocking. It still runs on the main thread. (This is exactly why the `/load` endpoint from Part 1 saturates a worker.)

### Comparison

| Feature | Async (event loop) | Cluster mode |
|---|---|---|
| **Concept** | Concurrency (juggling many waiting tasks) | Parallelism (running tasks at the same time) |
| **Threads/processes** | 1 thread running your JS | N processes, one per core |
| **Memory** | Shared within one process | Isolated per worker (no shared variables) |
| **Best for** | I/O-bound work (DB queries, API calls, file reads) | CPU-bound work, and using all cores for throughput |
| **CPU-heavy code** | Blocks everything | Blocks only that one worker |
| **Fault tolerance** | One uncaught crash kills the whole app | One worker dies, the others keep running |
| **Setup** | Built into the language (`async/await`, promises) | `cluster` module or PM2 `-i max` |
| **Cost** | Very cheap | Each worker uses its own RAM and DB connection pool |

### They work together

Cluster does not replace async. Every worker **still uses the async event loop internally**:

```text
Cluster (parallelism across cores)
 ├── Worker 1 → event loop → handles 1000s of concurrent async I/O requests
 ├── Worker 2 → event loop → handles 1000s of concurrent async I/O requests
 ├── Worker 3 → event loop → handles 1000s of concurrent async I/O requests
 └── Worker 4 → event loop → handles 1000s of concurrent async I/O requests
```

### Related: `worker_threads`

For CPU-heavy work inside a single process, Node also offers **`worker_threads`**: separate threads that **can share memory** (for example `SharedArrayBuffer`) and are lighter than full processes. Rule of thumb:

- **Async/await:** waiting on I/O.
- **Cluster / PM2:** scale a whole server across cores and survive crashes.
- **Worker threads:** offload one heavy computation without starting another full server.

---

## 3.6 Vertical vs horizontal scaling, and where the ASG fits

The cluster module is **vertical scaling at the software level** (use every core of one machine). An **AWS Auto Scaling Group** is **horizontal scaling at the infrastructure level** (add more machines).

- **Vertical (scaling up):** make one machine bigger (more cores, RAM, storage). The cluster module takes advantage of this by using every core on that machine.
- **Horizontal (scaling out):** add more machines. An ASG is built for this.

| Feature | Vertical (Node.js cluster) | Horizontal (AWS ASG) |
|---|---|---|
| **Action** | Upgrade hardware, or use all cores on one machine. | Add or remove whole machines (EC2 instances). |
| **Limit** | Hard hardware ceiling. | Practically unlimited capacity. |
| **Cost model** | Expensive hardware replacement, downtime during upgrades. | Pay as you go, scale down at night to save money. |
| **Fault tolerance** | If the host crashes, everything goes offline. | If one machine dies, the others keep running. |

### How an ASG works

The ASG watches infrastructure health and traffic and changes the number of EC2 instances according to your rules.

1. **Target-tracking metric**, for example "keep average CPU at 60%".
2. **Traffic surge:** CPU jumps to 85%.
3. **Scale-out:** the ASG boots new identical instances from a blueprint (an AMI that contains your Node.js app).
4. **Load balancer update:** the ASG registers the new servers with the Application Load Balancer, which spreads traffic over the larger fleet.

### The combined architecture

- **AWS ASG (horizontal):** the right number of VMs for the traffic.
- **Node.js cluster (vertical):** each VM uses all of its CPU cores.

That is exactly what Part 2 builds: PM2 (or the cluster module) fills every vCPU of an instance, and the ASG adds instances when the average CPU passes the target.

---

## 3.7 Cluster inside Docker

Docker containers do not have their own physical CPU cores. They **borrow and share the host's cores**. A Node.js cluster inside a container uses whatever cores the container is allowed to see.

### How Docker CPU works

Docker is not a heavy VM. It is a process isolation layer on the host Linux kernel (**cgroups** and **namespaces**).

1. **Host sharing:** by default a container can use 100% of the host's cores. On an 8-core host the cluster module sees 8 cores and forks 8 workers.
2. **CPU limits (cgroups):** `--cpus="2"` restricts the container to the equivalent of 2 cores. `os.availableParallelism()` or `os.cpus().length` may report 2 or the host's total, depending on how Node reads it, so limit your fork loop explicitly to avoid thrashing.

### The trap: cluster inside Docker

Using cluster inside a container is often considered an anti-pattern:

- **Process manager clash:** Docker tracks health through the PID 1 process. With a cluster (1 primary and N workers), a crashing worker may be respawned, or if the primary dies the container may exit unpredictably without the orchestrator (Kubernetes/ECS) handling it cleanly.
- **Redundant scaling layers:** best practice is one single-core Node.js process per container, with Docker/Kubernetes/ECS running N lightweight containers behind a load balancer (Nginx, AWS ALB, Traefik).

| Feature | Cluster inside 1 container | 1 Node.js process per container |
|---|---|---|
| **Process model** | 1 primary and N workers in one container. | 1 app process per container, scaled to N containers. |
| **Resource isolation** | Shared memory; if the container runs out of RAM, all workers die. | Full isolation; a leak or crash in one container doesn't affect others. |
| **Orchestration** | Harder for health checks to monitor individual workers. | Native health checks, auto-healing, rolling updates. |
| **Best for** | Quick local scripts or single-node monoliths. | Modern production cloud deployments (Compose, ECS, Kubernetes). |

> In this guide the instances are plain EC2 virtual machines, not containers, so running cluster (or PM2 cluster) on each instance is the right choice.

---

## 3.8 PM2 cluster mode and `ecosystem.config.js`

PM2's cluster mode is built on the **same Node.js cluster module**. PM2 acts as the primary process, and your application runs in the workers. The difference is **how you write the code**.

### The big difference: code complexity

With the native cluster module you add `if (cluster.isPrimary)` logic to your code. With PM2 you write a normal single-process Express app and PM2 does the clustering.

| Strategy | Your application code | How you start it |
|---|---|---|
| **Native cluster module** | You write `isPrimary`, `fork()` and `exit` handling yourself. | `node server.js` |
| **PM2 cluster mode** | Plain Node.js code with no cluster code. | `pm2 start server.js -i max` |

### What PM2 adds

- **Zero-downtime reloads:** `pm2 reload` restarts workers one at a time so the API stays online during deploys.
- **Automatic core detection:** `-i max` detects the core count and forks the right number of workers.
- **Monitoring:** `pm2 monit` shows real-time CPU, RAM and logs per worker.
- **Process persistence:** PM2 can restart all workers when the server reboots (this is what `pm2 startup` and `pm2 save` do in Part 2).

### Clean code for PM2

```javascript
// server.js (standard Express app, no cluster code)
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// Every worker instance spawned by PM2 runs this connection independently
mongoose.connect('mongodb://127.0.0.1:27017/myDB');

app.get('/api/health', (req, res) => {
  res.json({ status: 'Healthy', workerPid: process.pid });
});

app.listen(3000, () => console.log(`Server running on port 3000`));
```

```bash
npm install pm2 -g
pm2 start server.js -i max
```

### `ecosystem.config.js`

This is PM2's configuration file. Instead of typing long flags (`pm2 start server.js -i max --env production`), you save the settings in the file.

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'express-crud-api',       // Display name inside PM2
      script: './server.js',          // Entry point

      // --- CLUSTER MANAGEMENT ---
      instances: 'max',               // 'max' (all cores) or a number like 2, 4
      exec_mode: 'cluster',           // Activates the Node.js Cluster Module

      // --- AUTO-RESTART & MEMORY ---
      watch: false,                   // true = reload on code changes (dev)
      max_memory_restart: '1G',       // Restart a worker that leaks past 1GB
      autorestart: true,              // Revive workers if they crash

      // --- LOG FILES ---
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,               // Merge logs from all workers

      // --- ENVIRONMENT VARIABLES ---
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        MONGO_URI: 'mongodb://127.0.0.1:27017/devDB'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 80,
        MONGO_URI: 'mongodb://your-live-production-db-url/prodDB'
      }
    }
  ]
};
```

> If your project has `"type": "module"` in `package.json` (as the API in Part 2 does), name the file `ecosystem.config.cjs` instead, because PM2 loads it with `require()`.

### Core PM2 commands

```bash
# Start
pm2 start ecosystem.config.js
pm2 start ecosystem.config.js --env production    # applies env_production

# Monitor
pm2 status                  # apps, mode (cluster/fork), status, uptime, restarts, CPU, memory
pm2 monit                   # real-time dashboard with per-worker metrics
pm2 logs --lines 50         # stream output from all processes

# Maintain without disrupting traffic
pm2 reload all              # zero-downtime restart, one worker at a time
pm2 restart all             # hard reset: all workers together (brief downtime)
pm2 delete all              # stop everything and remove it from PM2's list
```

> **Do not combine the two.** If your code already uses the cluster module (`cluster.fork()`), run it under PM2 in **fork mode with one instance**, and let your code create the workers. Using PM2 cluster mode on top would create workers of workers. The banking API in 3.14 does exactly this.

---

## 3.9 A CRUD API with the cluster module and MongoDB

A scalable REST CRUD API using Express, cluster and MongoDB (Mongoose).

### The rule for database connections

**Never connect to the database in the primary process.** Each worker runs in its own memory sandbox, so connections cannot be shared. Each worker must create its own connection pool.

```bash
mkdir express-cluster-crud
cd express-cluster-crud
npm init -y
npm install express mongoose dotenv
```

`server.js`:

```javascript
const cluster = require('node:cluster');
const { availableParallelism } = require('node:os');
const process = require('node:process');
const express = require('express');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/clusterCrudDB';
const PORT = process.env.PORT || 3000;

// 1. PRIMARY (MASTER) PROCESS LAYER
if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  console.log(`[Primary ${process.pid}] Central Manager started.`);
  console.log(`[Primary ${process.pid}] Spawning ${numCPUs} CRUD API workers...\n`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Auto-healing
  cluster.on('exit', (worker, code, signal) => {
    console.error(`[Primary] Worker ${worker.process.pid} disconnected. Spawning replacement...`);
    cluster.fork();
  });

// 2. WORKER PROCESS LAYER (Express Apps & DB Pools)
} else {
  const app = express();
  app.use(express.json());

  // A. Schema and Model
  const ProductSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    inStock: { type: Boolean, default: true }
  }, { timestamps: true });

  const Product = mongoose.model('Product', ProductSchema);

  // B. Connect to DB (independent pool per worker)
  mongoose.connect(MONGO_URI)
    .then(() => {
      console.log(`  └─> [Worker ${process.pid}] Successfully connected to MongoDB.`);
    })
    .catch(err => {
      console.error(`[Worker ${process.pid}] MongoDB connection failed:`, err);
    });

  // C. CRUD Endpoints

  // CREATE
  app.post('/api/products', async (req, res) => {
    try {
      const newProduct = new Product(req.body);
      const savedProduct = await newProduct.save();
      res.status(201).json({ success: true, data: savedProduct, handledBy: process.pid });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // READ ALL
  app.get('/api/products', async (req, res) => {
    try {
      const products = await Product.find();
      res.status(200).json({ success: true, data: products, count: products.length, handledBy: process.pid });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // READ SINGLE
  app.get('/api/products/:id', async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      res.status(200).json({ success: true, data: product, handledBy: process.pid });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // UPDATE
  app.put('/api/products/:id', async (req, res) => {
    try {
      const updatedProduct = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
      if (!updatedProduct) return res.status(404).json({ success: false, message: 'Product not found' });
      res.status(200).json({ success: true, data: updatedProduct, handledBy: process.pid });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // DELETE
  app.delete('/api/products/:id', async (req, res) => {
    try {
      const deletedProduct = await Product.findByIdAndDelete(req.params.id);
      if (!deletedProduct) return res.status(404).json({ success: false, message: 'Product not found' });
      res.status(200).json({ success: true, message: 'Product successfully deleted', handledBy: process.pid });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // D. Bind to the shared port
  app.listen(PORT, () => {
    console.log(`  └─> [Worker ${process.pid}] API operational on port ${PORT}`);
  });
}
```

Start it with `node server.js`. The boot log shows one `API operational` and one `Successfully connected to MongoDB` line per worker:

```text
[Primary 43100] Central Manager started.
[Primary 43100] Spawning 4 CRUD API workers...

  └─> [Worker 43108] API operational on port 3000
  └─> [Worker 43112] API operational on port 3000
  └─> [Worker 43116] API operational on port 3000
  └─> [Worker 43120] API operational on port 3000
  └─> [Worker 43108] Successfully connected to MongoDB.
  └─> [Worker 43112] Successfully connected to MongoDB.
  └─> [Worker 43116] Successfully connected to MongoDB.
  └─> [Worker 43120] Successfully connected to MongoDB.
```

Make repeated requests with Postman, curl or a browser and watch `handledBy` change:

```json
{
  "success": true,
  "data": [],
  "count": 0,
  "handledBy": 43116
}
```

The next request will likely show a different PID, because the primary spreads requests across the workers.

---

## 3.10 What happens when two workers write at the same time?

Each worker has its own database connection, so to MongoDB they look like two separate computers talking to the same server. MongoDB handles this with concurrency control.

### 1. Concurrent reads

Worker 1 and Worker 2 both run `find()`. MongoDB serves them at the same time using shared read locks. Neither blocks the other.

### 2. Concurrent writes to different documents

MongoDB's **WiredTiger** storage engine uses document-level concurrency control, so writes to different documents run in parallel.

### 3. The real challenge: concurrent updates to the same document

Example: only 1 item is left in stock and two users click "Buy" at the same instant. This is a **race condition**.

**The dangerous way (do not do this)**

```javascript
// Worker 1 and Worker 2 both fetch the item at the same time: { stock: 1 }
const product = await Product.findById(id);

product.stock = product.stock - 1; // Both compute 1 - 1 = 0 in Node memory

await product.save();
// Both save { stock: 0 }. Two items sold, but stock only went down by 1!
```

Result: data corruption, because the workers overwrote each other's changes.

**The correct way (atomic operations)**

```javascript
// Both workers send this instruction to MongoDB at the same time:
await Product.findByIdAndUpdate(id, { $inc: { stock: -1 } });
```

MongoDB briefly locks that one document, applies Worker 1's request (1 → 0), then Worker 2's (0 → -1). You can then check whether stock dropped below zero and reject the second order.

| Scenario | How the database reacts | A problem? |
|---|---|---|
| Two reads | Processes them simultaneously. | No, completely safe. |
| Two writes (different data) | Processes them simultaneously. | No, completely safe. |
| Two updates (same data) | Queues them using document locks. | Only if the Node.js code relies on outdated in-memory variables. |

### What is an atomic operation?

An **atomic operation** executes as a single indivisible step with an all-or-nothing guarantee: either the whole operation succeeds, or it fails and leaves the data untouched. No concurrent process can see the data half-modified.

**In MongoDB**, single-document writes are atomic, including nested sub-documents and arrays. Common atomic operators:

- `$inc`: increment or decrement a number.
- `$set`: overwrite a field.
- `$push` / `$pull`: add or remove an array item atomically.
- `$rename`: rename a field.

```javascript
// Subtract 1 from stock ONLY if the product is in stock
db.products.updateOne(
  { _id: ObjectId("123"), stock: { $gt: 0 } }, // Filter (condition check)
  { $inc: { stock: -1 } }                      // Atomic action
);
```

If two workers run this at once, the first reduces stock to 0. The second's filter (`stock: { $gt: 0 }`) fails, which prevents overselling.

**In PostgreSQL**, every single SQL statement is implicitly atomic. Concurrency is handled by **MVCC** (multi-version concurrency control): an update creates a new row version, and other processes keep reading the old one until the write completes.

```sql
-- Subtract 1 from stock only if there is inventory available
UPDATE products
SET stock = stock - 1
WHERE id = 123 AND stock > 0;
```

With two simultaneous workers, Postgres takes a brief row-level lock. The first transaction updates the row. The second re-checks the fresh row, finds `stock > 0` no longer true, and updates 0 rows.

| Feature | MongoDB | PostgreSQL |
|---|---|---|
| **Native scope** | Single document (including nested arrays and sub-documents). | Single SQL statement (one or many matching rows). |
| **Concurrency engine** | WiredTiger (optimistic concurrency control and document locks). | MVCC and row locks. |
| **Avoiding overwrites** | Operators like `$inc` or `$set`. | Plain SQL (`SET stock = stock - 1`). |
| **Multi-resource scope** | Multi-document transactions (since v4.0). | Multi-statement blocks (`BEGIN ... COMMIT`). |

---

## 3.11 Demo: an atomic route vs a non-atomic route, tested with Autocannon

An API with a **non-atomic route** (race condition) and an **atomic route** (safe), plus a test script that fires concurrent requests at both.

```bash
npm install express mongoose autocannon axios
```

`server.js`:

```javascript
// server.js
const cluster = require('node:cluster');
const { availableParallelism } = require('node:os');
const process = require('node:process');
const express = require('express');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/raceConditionTest';
const PORT = 3000;

// 1. PRIMARY LAYER
if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  console.log(`[Primary ${process.pid}] Master node active. Booting ${numCPUs} cluster workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

// 2. WORKER LAYER
} else {
  const app = express();
  app.use(express.json());

  // Bank Account Schema
  const AccountSchema = new mongoose.Schema({
    name: String,
    balance: { type: Number, default: 0 }
  });
  const Account = mongoose.model('Account', AccountSchema);

  // Each worker connects locally
  mongoose.connect(MONGO_URI).catch(err => console.error(err));

  // Helper route to reset the target account balance to $0
  app.post('/api/reset', async (req, res) => {
    await Account.deleteMany({});
    const newAcc = await Account.create({ name: 'Target Account', balance: 0 });
    res.json({ message: 'Database Reset Successfully!', id: newAcc._id });
  });

  // ROUTE 1: NON-ATOMIC (Vulnerable to Race Conditions)
  app.post('/api/deposit-non-atomic', async (req, res) => {
    try {
      const { id } = req.body;

      // Step A: Fetch document into Node.js worker memory
      const account = await Account.findById(id);

      // Step B: Arithmetic in JS memory
      const currentBalance = account.balance;
      const updatedBalance = currentBalance + 1;

      // Artificial micro-delay to let other workers fetch the old state
      await new Promise(resolve => setTimeout(resolve, 5));

      // Step C: Push overwritten balance back to DB
      account.balance = updatedBalance;
      await account.save();

      res.json({ success: true, worker: process.pid, finalMemoryValue: updatedBalance });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ROUTE 2: ATOMIC UPDATE OPERATOR (Concurrency-Safe)
  app.post('/api/deposit-atomic', async (req, res) => {
    try {
      const { id } = req.body;

      // Single atomic instruction executed inside the MongoDB engine
      const updated = await Account.findByIdAndUpdate(
        id,
        { $inc: { balance: 1 } },
        { new: true }
      );

      res.json({ success: true, worker: process.pid, finalDbValue: updated.balance });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => console.log(`  └─> [Worker ${process.pid}] Online.`));
}
```

`test.js`:

```javascript
// test.js
const autocannon = require('autocannon');
const axios = require('axios');

async function runExperiment() {
  console.log("1. Starting API server and resetting MongoDB document...");

  // Initialize the target document
  const resetRes = await axios.post('http://localhost:3000/api/reset');
  const targetId = resetRes.data.id;
  console.log(`Target document created with ID: ${targetId} | Initial Balance: $0\n`);

  const totalRequests = 200;

  // EXPERIMENT A: NON-ATOMIC ROUTE
  console.log(`Executing ${totalRequests} concurrent updates via NON-ATOMIC route...`);
  await executeLoadTest('http://localhost:3000/api/deposit-non-atomic', targetId, totalRequests);

  // Verify Database State
  const finalStateA = await mongooseConnectionCheck(targetId);
  console.log(`🚨 EXPECTED BALANCE: $${totalRequests}`);
  console.log(`🚨 ACTUAL DATABASE BALANCE: $${finalStateA}\n`);
  console.log(`Data lost: $${totalRequests - finalStateA} due to cluster workers overriding each other!`);

  // EXPERIMENT B: ATOMIC ROUTE
  console.log(`\nResetting DB for Atomic Test...`);
  const resetB = await axios.post('http://localhost:3000/api/reset');
  const targetIdB = resetB.data.id;

  console.log(`Executing ${totalRequests} concurrent updates via ATOMIC route...`);
  await executeLoadTest('http://localhost:3000/api/deposit-atomic', targetIdB, totalRequests);

  const finalStateB = await mongooseConnectionCheck(targetIdB);
  console.log(`✅ EXPECTED BALANCE: $${totalRequests}`);
  console.log(`✅ ACTUAL DATABASE BALANCE: $${finalStateB}`);
  console.log(`Data lost: $${totalRequests - finalStateB} (Perfect Execution).\n`);

  process.exit(0);
}

function executeLoadTest(url, id, total) {
  return new Promise((resolve) => {
    autocannon({
      url: url,
      connections: 20, // 20 concurrent users hitting different workers
      amount: total,   // Stop exactly after total requests
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id })
    }, () => resolve());
  });
}

async function mongooseConnectionCheck(id) {
  // Mini client query to get the current value directly
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect('mongodb://127.0.0.1:27017/raceConditionTest');
  }
  const Account = mongoose.models.Account
    || mongoose.model('Account', new mongoose.Schema({ name: String, balance: Number }));
  const doc = await Account.findById(id);
  return doc.balance;
}

runExperiment();
```

Terminal 1: `node server.js`. Terminal 2: `node test.js`. Expected result:

```text
1. Starting API server and resetting MongoDB document...
Target document created with ID: 65d83f... | Initial Balance: $0

Executing 200 concurrent updates via NON-ATOMIC route...
🚨 EXPECTED BALANCE: $200
🚨 ACTUAL DATABASE BALANCE: $14

Data lost: $186 due to cluster workers overriding each other!

Resetting DB for Atomic Test...
Executing 200 concurrent updates via ATOMIC route...
✅ EXPECTED BALANCE: $200
✅ ACTUAL DATABASE BALANCE: $200
Data lost: $0 (Perfect Execution).
```

I made two small fixes to the script from the original notes: the experiment now uses the id returned by each reset (the atomic test recreates the document, so the old id would no longer exist), and the final check defines the `Account` model on the test script's own connection. The exact "actual balance" in the non-atomic run varies from run to run, because it depends on how requests interleave.

### Why did this happen?

- **Non-atomic route:** Worker 4321 (core 1) and Worker 4322 (core 2) fetched the document at the same time when `balance = 10`. Both computed `10 + 1 = 11` in their own RAM and both saved `balance = 11`. One overwrote the other: two requests, but the data only incremented once.
- **Atomic route:** the workers never fetched the data into local memory. They sent a direct command (`$inc: 1`) to MongoDB, which serialized the updates so every one was applied.

---

## 3.12 The banking API: JWT sign-up, a $200 credit, and ACID transfers in cluster mode

An API where a user signs up with JWT auth, receives a **$200 credit**, and can transfer money to another user. Transfers must stay correct when different cluster workers (and later different EC2 instances) handle requests at the same time.

### Design overview

| Concern | Decision |
|---|---|
| **Auth** | Sign-up and login return a **JWT**. JWTs are stateless, so any cluster worker can verify them (in-memory sessions would break across workers). |
| **Passwords** | Hashed with `bcryptjs`, never stored in plain text. |
| **Welcome credit** | New accounts start with **$200.00**, stored as `20000` cents. |
| **Money type** | **Integer cents**, never floats, to avoid rounding bugs (`0.1 + 0.2 !== 0.3`). |
| **Transfer** | One **MongoDB multi-document transaction**: debit the sender, credit the receiver, write a ledger record. All succeed or all roll back. |
| **No overdraft** | The debit is a conditional atomic update: `{ balance: { $gte: amount } }` plus `$inc`. |
| **Double-submit safety** | An `Idempotency-Key` header, so a retried request can't move money twice. |
| **Cluster** | The primary forks one worker per core. Each worker has its own DB connection pool. |

### How ACID is achieved

| Property | How it is handled |
|---|---|
| **Atomicity** | `session.withTransaction()` wraps debit, credit and ledger insert. If any step fails, everything rolls back. |
| **Consistency** | The balance can't go negative (the `$gte` guard in the filter), a unique email index, input validation, and self-transfers are blocked. |
| **Isolation** | Snapshot isolation inside the transaction. If two transfers touch the same account at once, MongoDB raises a write conflict (`TransientTransactionError`) and `withTransaction` **automatically retries** the loser. |
| **Durability** | `writeConcern: { w: 'majority' }`: the commit is acknowledged only after a majority of replica-set members have it. |

### Transactions need a replica set

MongoDB multi-document transactions **do not work on a standalone `mongod`**. You would see `Transaction numbers are only allowed on a replica set member or mongos`. Use **MongoDB Atlas** (even the free tier is a replica set), or run a single-node replica set locally:

```bash
docker run -d --name mongo-rs -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec mongo-rs mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"
```

### Endpoints

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup` | No | Create an account, receive the $200 credit and a JWT |
| POST | `/api/auth/login` | No | Log in, receive a JWT |
| GET | `/api/account/me` | Yes | View profile and balance |
| POST | `/api/transfer` | Yes | Transfer money to another user by email |
| GET | `/api/transactions` | Yes | Last 50 transactions involving you |

### Setup

```bash
mkdir banking-cluster-api
cd banking-cluster-api
npm init -y
npm install express mongoose bcryptjs jsonwebtoken dotenv
```

`.env`:

```text
PORT=3000
MONGO_URI=mongodb://127.0.0.1:27017/bankDB?replicaSet=rs0
JWT_SECRET=replace_this_with_a_long_random_string
```

### Learning version of `server.js`

This is the version to run on your laptop. Section 3.14 shows the ASG-ready version with the extra changes an Auto Scaling Group needs.

```javascript
// server.js
require('dotenv').config();
const cluster = require('node:cluster');
const { availableParallelism } = require('node:os');
const process = require('node:process');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bankDB?replicaSet=rs0';
const JWT_SECRET = process.env.JWT_SECRET;

// =========================================================================
// 1. PRIMARY PROCESS: only forks and heals workers (NO database connection)
// =========================================================================
if (cluster.isPrimary) {
  if (!JWT_SECRET) {
    console.error('[Primary] JWT_SECRET is missing. Set it in .env and restart.');
    process.exit(1);
  }

  const numCPUs = availableParallelism();
  console.log(`[Primary ${process.pid}] Starting ${numCPUs} banking API workers...`);

  for (let i = 0; i < numCPUs; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[Primary] Worker ${worker.process.pid} died (code ${code}, signal ${signal}). Respawning...`);
    cluster.fork();
  });

// =========================================================================
// 2. WORKER PROCESS: Express app + its own MongoDB connection pool
// =========================================================================
} else {
  const express = require('express');
  const mongoose = require('mongoose');
  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');

  // ---------- Constants & helpers ----------
  const SIGNUP_BONUS_CENTS = 20000;            // $200.00
  const MAX_TRANSFER_CENTS = 1_000_000_00;     // $1,000,000.00 safety cap
  const TXN_OPTIONS = {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },           // Durability
    readPreference: 'primary'
  };

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  const toDollars = (cents) => (cents / 100).toFixed(2);

  // Converts a dollar amount (e.g. 10.5) to integer cents. Returns null if invalid.
  function parseAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const cents = Math.round(n * 100);
    if (Math.abs(n * 100 - cents) > 1e-6) return null;   // more than 2 decimals
    if (cents < 1 || cents > MAX_TRANSFER_CENTS) return null;
    return cents;
  }

  const signToken = (user) =>
    jwt.sign({ sub: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: '1h' });

  const publicUser = (user) => ({
    id: user._id,
    name: user.name,
    email: user.email,
    balance: toDollars(user.balance)
  });

  // ---------- Models ----------
  const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    balance: { type: Number, default: SIGNUP_BONUS_CENTS, min: 0 }   // stored in cents
  }, { timestamps: true });

  const transactionSchema = new mongoose.Schema({
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 1 },                // cents
    status: { type: String, default: 'COMPLETED' },
    idempotencyKey: { type: String }
  }, { timestamps: true });

  // One idempotency key per sender (only enforced when a key is provided)
  transactionSchema.index(
    { from: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
  );

  const User = mongoose.model('User', userSchema);
  const Transaction = mongoose.model('Transaction', transactionSchema);

  // ---------- App & middleware ----------
  const app = express();
  app.use(express.json());

  function auth(req, res, next) {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ success: false, error: 'Missing or malformed Authorization header' });
    }
    try {
      req.user = jwt.verify(token, JWT_SECRET);   // stateless: works on ANY worker
      next();
    } catch {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
  }

  // ---------- Routes ----------

  // SIGN UP: creates the user with the $200 welcome credit
  app.post('/api/auth/signup', async (req, res, next) => {
    try {
      const { name, email, password } = req.body;
      if ([name, email, password].some((v) => typeof v !== 'string') || !name || !email || password.length < 8) {
        throw new HttpError(400, 'name, email and password (min 8 characters) are required');
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({ name, email, passwordHash });   // balance defaults to 20000 cents

      res.status(201).json({
        success: true,
        message: `Account created. $${toDollars(SIGNUP_BONUS_CENTS)} welcome credit added!`,
        token: signToken(user),
        user: publicUser(user),
        handledBy: process.pid
      });
    } catch (err) {
      if (err.code === 11000) return next(new HttpError(409, 'Email already registered'));
      next(err);
    }
  });

  // LOGIN
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const { email, password } = req.body;
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new HttpError(400, 'email and password are required');
      }
      const user = await User.findOne({ email: email.toLowerCase().trim() });
      const valid = user && (await bcrypt.compare(password, user.passwordHash));
      if (!valid) throw new HttpError(401, 'Invalid credentials');

      res.json({ success: true, token: signToken(user), user: publicUser(user), handledBy: process.pid });
    } catch (err) {
      next(err);
    }
  });

  // PROFILE / BALANCE
  app.get('/api/account/me', auth, async (req, res, next) => {
    try {
      const user = await User.findById(req.user.sub);
      if (!user) throw new HttpError(404, 'User not found');
      res.json({ success: true, user: publicUser(user), handledBy: process.pid });
    } catch (err) {
      next(err);
    }
  });

  // TRANSFER MONEY (ACID transaction)
  app.post('/api/transfer', auth, async (req, res, next) => {
    const session = await mongoose.startSession();
    try {
      const { toEmail } = req.body;
      const cents = parseAmount(req.body.amount);
      const idempotencyKey = req.get('Idempotency-Key') || undefined;
      const senderId = req.user.sub;

      if (typeof toEmail !== 'string' || cents === null) {
        throw new HttpError(400, 'toEmail and a valid positive amount (max 2 decimals) are required');
      }

      // Replay protection: same key from the same sender returns the original result
      if (idempotencyKey) {
        const existing = await Transaction.findOne({ from: senderId, idempotencyKey });
        if (existing) {
          return res.status(200).json({
            success: true,
            replayed: true,
            transaction: { id: existing._id, amount: toDollars(existing.amount) },
            handledBy: process.pid
          });
        }
      }

      const receiver = await User.findOne({ email: toEmail.toLowerCase().trim() }).select('_id');
      if (!receiver) throw new HttpError(404, 'Receiver not found');
      if (String(receiver._id) === senderId) throw new HttpError(400, 'You cannot transfer money to yourself');

      let transaction;
      let senderBalance;

      // withTransaction commits on success, aborts on error, and
      // automatically RETRIES on transient errors (e.g. write conflicts).
      await session.withTransaction(async () => {
        // 1) DEBIT: atomic conditional update. Only matches if funds are sufficient.
        const sender = await User.findOneAndUpdate(
          { _id: senderId, balance: { $gte: cents } },
          { $inc: { balance: -cents } },
          { new: true, session }
        );
        if (!sender) throw new HttpError(400, 'Insufficient funds');

        // 2) CREDIT: atomic increment on the receiver
        const credit = await User.updateOne(
          { _id: receiver._id },
          { $inc: { balance: cents } },
          { session }
        );
        if (credit.matchedCount !== 1) throw new HttpError(404, 'Receiver not found');

        // 3) LEDGER: audit record, part of the SAME transaction
        const [tx] = await Transaction.create(
          [{ from: senderId, to: receiver._id, amount: cents, idempotencyKey }],
          { session }
        );

        transaction = tx;
        senderBalance = sender.balance;
      }, TXN_OPTIONS);

      res.status(201).json({
        success: true,
        message: `Transferred $${toDollars(cents)} to ${toEmail}`,
        transaction: { id: transaction._id, amount: toDollars(cents), to: toEmail, createdAt: transaction.createdAt },
        yourNewBalance: toDollars(senderBalance),
        handledBy: process.pid
      });
    } catch (err) {
      if (err.code === 11000) {
        return next(new HttpError(409, 'A request with this Idempotency-Key is already being processed'));
      }
      next(err);
    } finally {
      await session.endSession();
    }
  });

  // TRANSACTION HISTORY
  app.get('/api/transactions', auth, async (req, res, next) => {
    try {
      const me = req.user.sub;
      const txs = await Transaction.find({ $or: [{ from: me }, { to: me }] })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      res.json({
        success: true,
        count: txs.length,
        data: txs.map((t) => ({
          id: t._id,
          direction: String(t.from) === me ? 'SENT' : 'RECEIVED',
          amount: toDollars(t.amount),
          at: t.createdAt
        })),
        handledBy: process.pid
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Error handler ----------
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, error: err.message, handledBy: process.pid });
    }
    console.error(`[Worker ${process.pid}]`, err);
    res.status(500).json({ success: false, error: 'Internal server error', handledBy: process.pid });
  });

  // ---------- Boot: connect, build indexes, THEN accept traffic ----------
  (async () => {
    try {
      await mongoose.connect(MONGO_URI);
      await Promise.all([User.init(), Transaction.init()]);   // make sure unique indexes exist
      app.listen(PORT, () => console.log(`  └─> [Worker ${process.pid}] Bank API ready on port ${PORT}`));
    } catch (err) {
      console.error(`[Worker ${process.pid}] Startup failed:`, err.message);
      process.exit(1);
    }
  })();
}
```

### Try it with curl

```bash
# Sign up two users (each gets $200.00 and a JWT)
curl -X POST localhost:3000/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@test.com","password":"password123"}'

curl -X POST localhost:3000/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"Bob","email":"bob@test.com","password":"password123"}'

# Alice sends Bob $25.50 (use Alice's token)
curl -X POST localhost:3000/api/transfer \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ALICE_TOKEN>" \
  -H "Idempotency-Key: transfer-001" \
  -d '{"toEmail":"bob@test.com","amount":25.50}'

# Check balance
curl localhost:3000/api/account/me -H "Authorization: Bearer <ALICE_TOKEN>"
```

### Concurrency test (`test.js`)

This fires **50 simultaneous $10 transfers** from Alice (who only has $200) to Bob, spread across all cluster workers. The correct outcome is exactly **20 successes**, **30 rejections** for insufficient funds, Alice at **$0.00**, Bob at **$400.00**, and the total money still **$400.00**. It needs Node 18+ for the built-in `fetch`.

```javascript
// test.js
const BASE = process.env.API_BASE || 'http://localhost:3000/api';

async function call(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` })
    },
    body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

(async () => {
  const stamp = Date.now();
  const aliceEmail = `alice${stamp}@test.com`;
  const bobEmail = `bob${stamp}@test.com`;

  const alice = await call('POST', '/auth/signup', { body: { name: 'Alice', email: aliceEmail, password: 'password123' } });
  const bob = await call('POST', '/auth/signup', { body: { name: 'Bob', email: bobEmail, password: 'password123' } });
  console.log(`Alice starts with $${alice.data.user.balance}, Bob starts with $${bob.data.user.balance}\n`);

  const N = 50;
  const AMOUNT = 10;
  console.log(`Firing ${N} concurrent transfers of $${AMOUNT} from Alice to Bob...`);

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      call('POST', '/transfer', { token: alice.data.token, body: { toEmail: bobEmail, amount: AMOUNT } })
    )
  );

  const succeeded = results.filter((r) => r.status === 201).length;
  const rejected = results.filter((r) => r.status === 400).length;
  const other = N - succeeded - rejected;
  const workers = new Set(results.map((r) => r.data.handledBy));

  const a = await call('GET', '/account/me', { token: alice.data.token });
  const b = await call('GET', '/account/me', { token: bob.data.token });
  const aliceBal = Number(a.data.user.balance);
  const bobBal = Number(b.data.user.balance);

  console.log(`\nSucceeded: ${succeeded} | Rejected (insufficient funds): ${rejected} | Other: ${other}`);
  console.log(`Handled by ${workers.size} different workers: ${[...workers].join(', ')}`);
  console.log(`Alice final: $${aliceBal.toFixed(2)} | Bob final: $${bobBal.toFixed(2)}`);
  console.log(`Total money in system: $${(aliceBal + bobBal).toFixed(2)} (expected $400.00)`);
  console.log(aliceBal + bobBal === 400 && succeeded === 20 ? '\nPASS: no lost updates, no overdraft, money conserved.' : '\nFAIL: check logs.');
})();
```

Run `node test.js` in a second terminal. Expected output:

```text
Alice starts with $200.00, Bob starts with $200.00

Firing 50 concurrent transfers of $10 from Alice to Bob...

Succeeded: 20 | Rejected (insufficient funds): 30 | Other: 0
Handled by 4 different workers: 51204, 51208, 51212, 51216
Alice final: $0.00 | Bob final: $400.00
Total money in system: $400.00 (expected $400.00)

PASS: no lost updates, no overdraft, money conserved.
```

(The only change from the original script is the `API_BASE` environment variable, so you can later point it at the load balancer.)

### Why this is safe, and the naive version is not

The **naive** version reads balances into Node memory, checks them in JavaScript, and saves them back:

```javascript
// UNSAFE: read-modify-write across cluster workers
const sender = await User.findById(senderId);
if (sender.balance >= amount) {            // two workers can both pass this check
  sender.balance -= amount;                // both compute from the same stale value
  await sender.save();
  receiver.balance += amount;              // crash here = money vanished (no atomicity)
  await receiver.save();
}
```

Problems: **lost updates** (two workers overwrite each other), **overdraft** (both pass the balance check), and **partial failure** (debit saved, credit never happens).

The **safe** version fixes each one:

- **Check and debit in one atomic DB operation** (`{ balance: { $gte: amount } }` with `$inc`), so the check and the subtraction can't be separated.
- **Debit, credit and ledger in one transaction**, so a crash between steps rolls everything back.
- **Retries on write conflicts**, so two transfers touching the same account serialize correctly instead of corrupting data.

### What `session.withTransaction()` does

It runs a group of database operations as **one all-or-nothing unit** and handles commit, rollback and retry for you:

1. Starts a transaction on the session.
2. Runs your callback, which holds all the DB operations.
3. If the callback finishes without error, it **commits** and all changes become visible at once.
4. If the callback throws, it **aborts** and every change inside is rolled back.
5. If MongoDB reports a **transient error** (for example a write conflict with another transaction), it aborts and **re-runs your whole callback** from the start.
6. If the commit result is unknown (a network hiccup at the moment of commit), it retries the commit.
7. It gives up retrying after about 120 seconds.

Without a transaction, a transfer is three separate writes, and a crash between them loses money:

```javascript
await User.updateOne({ _id: senderId }, { $inc: { balance: -cents } });   // succeeds
// server crashes or DB connection drops here
await User.updateOne({ _id: receiverId }, { $inc: { balance: cents } });  // never runs
```

You could write `startTransaction` / `commitTransaction` / `abortTransaction` by hand, but then the retry logic is yours to write. In a cluster, two workers moving money from the same account will regularly hit write conflicts, and the helper retries the loser so the second transfer simply runs after the first.

Two rules to remember:

- **Pass `{ session }` to every operation** inside the callback. Any call without it runs outside the transaction and won't be rolled back.
- **Keep the callback free of side effects other than DB writes.** It can run more than once, so don't send emails, call payment APIs, or push to a queue inside it. Do those after `withTransaction` returns. That is why the code sets `transaction = tx` inside the callback and sends the HTTP response only after it finishes.

### Do you need a sharded cluster for `withTransaction`?

No. `withTransaction` is the driver's helper for running a transaction safely, and you should use it on **any** deployment that supports transactions:

| Deployment | Multi-document transactions |
|---|---|
| Standalone `mongod` | Not supported |
| Replica set | Supported (MongoDB 4.0+) |
| Sharded cluster | Supported (MongoDB 4.2+) |

The word "cluster" means three different things here:

1. **Node.js cluster module:** several Node processes on one machine (the Express app).
2. **MongoDB replica set:** copies of the same data on several servers for failover. This is what the banking API needs. Atlas calls this a "cluster" even on the free tier, which causes confusion.
3. **MongoDB sharded cluster:** data split across shards, for very large datasets or write throughput beyond one replica set.

The Node cluster module and MongoDB sharding are independent. If you ever did shard, the same code would work through `mongos`, but a transfer between users on different shards becomes a slower distributed transaction. Most apps never need sharding.

### Where does the `Idempotency-Key` come from?

The **client** generates it. The server never creates or hands out a key. It is a header the caller chooses to send, and the server uses it to recognise "I've already processed this exact request."

1. Before sending a transfer, the client generates a unique value, usually a UUID v4.
2. It sends the value in the `Idempotency-Key` header.
3. If the request times out, the user double-taps the button, or the network retries, the client sends the **same key** again.
4. The server sees that this sender already has a transaction with that key and returns the original result (`"replayed": true`) instead of moving money again.

Rules for the client:

- Generate **one key per user action** (one "Send $25" click), not one per HTTP attempt.
- **Reuse the same key** when retrying that same action.
- Use a **new key** for a genuinely new transfer, otherwise it is treated as a replay of the old one.

In the learning version the header is optional. In a real banking API (and in the ASG-ready version below) it is **mandatory** for money-moving endpoints, because retries are common. The concurrency test above sends no key because its 50 requests are meant to be 50 separate transfers (the deployment test in 3.14 adds a fresh key to each).

A client script that creates the key once per action and reuses it across retries (`idempotent-client.js`, Node 18+):

```javascript
// idempotent-client.js
// KEY IDEA: the Idempotency-Key is created ONCE per user action (when the
// action object is created), NOT inside the HTTP retry loop.

const { randomUUID } = require('node:crypto');

const BASE = process.env.API_BASE || 'http://localhost:3000/api';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Statuses worth retrying: 409 (same key still processing), 429 (rate limit), 5xx (server error)
const isRetryable = (status) => status === 409 || status === 429 || status >= 500;

// Sends ONE transfer action. The key is passed in; it is never generated here.
async function sendTransferWithRetry({ token, toEmail, amount, idempotencyKey, maxAttempts = 4, timeoutMs = 5000 }) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${BASE}/transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey            // SAME key on every attempt
        },
        body: JSON.stringify({ toEmail, amount }),
        signal: AbortSignal.timeout(timeoutMs)         // a timeout may still have succeeded server-side,
      });                                              // which is exactly why the key must stay the same

      const data = await res.json().catch(() => ({}));

      if (res.ok || !isRetryable(res.status)) {
        // Success, or a business error (400 insufficient funds, 404, 401...) that retrying won't fix
        return { attempt, status: res.status, data };
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;                                  // network failure or timeout
    }

    if (attempt < maxAttempts) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 250;  // backoff + jitter
      console.log(`   attempt ${attempt} failed (${lastError.message}); retrying in ${Math.round(delay)}ms with the SAME key`);
      await sleep(delay);
    }
  }

  throw new Error(`Transfer failed after ${maxAttempts} attempts: ${lastError.message}`);
}

// One "Send money" click = one action = one key.
// Call submit() as many times as you like (retry button, double-click, reconnect):
// the key never changes, so the money can move at most once.
function createTransferAction({ token, toEmail, amount }) {
  const key = randomUUID();                             // generated ONCE, here
  return {
    key,
    submit: () => sendTransferWithRetry({ token, toEmail, amount, idempotencyKey: key })
  };
}

// ----------------------------- Demo -----------------------------
async function call(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` })
    },
    body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

async function balance(token) {
  const r = await call('GET', '/account/me', { token });
  return r.data.user.balance;
}

(async () => {
  const stamp = Date.now();
  const bobEmail = `bob${stamp}@test.com`;

  const alice = await call('POST', '/auth/signup', { body: { name: 'Alice', email: `alice${stamp}@test.com`, password: 'password123' } });
  await call('POST', '/auth/signup', { body: { name: 'Bob', email: bobEmail, password: 'password123' } });
  const token = alice.data.token;
  console.log(`Alice starts with $${await balance(token)}\n`);

  // ACTION 1: user clicks "Send $25" -> one action, one key
  const action1 = createTransferAction({ token, toEmail: bobEmail, amount: 25 });
  console.log(`Action 1 key: ${action1.key}`);

  const first = await action1.submit();
  console.log(`  submit #1 -> HTTP ${first.status}, replayed: ${first.data.replayed ?? false}`);

  // User double-clicks / app retries the SAME action -> same key -> no second transfer
  const second = await action1.submit();
  console.log(`  submit #2 -> HTTP ${second.status}, replayed: ${second.data.replayed ?? false}`);
  console.log(`  Alice balance after action 1: $${await balance(token)} (expected 175.00, charged once)\n`);

  // ACTION 2: a genuinely NEW transfer -> new action -> new key
  const action2 = createTransferAction({ token, toEmail: bobEmail, amount: 25 });
  console.log(`Action 2 key: ${action2.key} (different from action 1: ${action2.key !== action1.key})`);

  const third = await action2.submit();
  console.log(`  submit #1 -> HTTP ${third.status}, replayed: ${third.data.replayed ?? false}`);
  console.log(`  Alice balance after action 2: $${await balance(token)} (expected 150.00)`);
})().catch((err) => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});
```

Action 1 sends $25, and submitting the same action again returns `replayed: true` (Alice stays at $175.00). Action 2 gets a new key and moves another $25 (Alice at $150.00). In a real frontend, create the action when the user submits the form and keep it in state until the transfer succeeds.

### Production notes

This is a learning-grade implementation. A real banking system would also add rate limiting and login lockout, refresh tokens and revocation, a validation library and `helmet`, a double-entry ledger with reconciliation jobs, audit logging and monitoring, proper secrets management, and tests for opposite-direction concurrent transfers (A to B and B to A at the same time) to confirm the conflict retries work.

---

## 3.13 MongoDB Atlas free tier: will it work, and how do I check?

Yes, it should work. An Atlas free (M0) cluster is a **replica set**, not a standalone server, so it is the kind of deployment that supports transactions. The documentation pages I found don't list transactions for M0 explicitly, so run the check script below (or your first transfer) to confirm. If it fails, the error message will say why.

### Changes to make

1. **Connection string:** use the `mongodb+srv://` string from Atlas (Connect, then Drivers), and drop `?replicaSet=rs0` from the local example. Atlas sets that up for you.

   ```text
   MONGO_URI=mongodb+srv://<dbUser>:<password>@cluster0.xxxxx.mongodb.net/bankDB?retryWrites=true&w=majority
   ```

2. **Database user:** create one under Database Access with read/write permission. URL-encode special characters in the password.
3. **Network access:** add the IP your app connects from under Network Access. For the ASG deployment that is the NAT gateway's Elastic IP (see 3.14). `0.0.0.0/0` is for quick local testing only.
4. **Limit the connection pool:** each cluster worker opens its own pool, and free clusters cap concurrent connections (current docs say 500, an older page says 100).

   ```javascript
   await mongoose.connect(MONGO_URI, { maxPoolSize: 10 });
   ```

### Free-tier limits that affect the demo

- **Throughput is capped at 100 read/write operations per second.** Atlas throttles anything above that rather than rejecting it. Each transfer uses several operations (lookup, debit, credit, ledger insert, commit), so the 50-transfer test runs noticeably slower than on a paid tier. It should still finish with the same correct result: 20 successes, 30 rejections, $400 total.
- **Storage is capped at 512 MB**, plenty for this.
- **Idle clusters may be paused or terminated by Atlas.** If the app can't connect after a period of no use, check the Atlas dashboard.

Sources: [Atlas Free Cluster Limits](https://mongodb.com/docs/atlas/reference/free-shared-limitations/); [Create an Ephemeral Cluster (M0 limits)](https://www.mongodb.com/docs/atlas/tutorial/create-ephemeral-cluster/); [Atlas M0, M2 and M5 Limitations (older docs)](https://docs.atlas.mongodb.com/reference/free-shared-limitations).

### What a healthy cluster overview looks like

In the Atlas cluster overview, a free tier cluster on MongoDB 8.0.x in an AWS region such as Mumbai (`ap-south-1`) with **three nodes (1 primary, 2 secondaries)** is a replica set, and transactions will work. The hostnames contain `shard-00-0x`, but that is only Atlas's naming convention. The cluster is **not** sharded. A Mumbai region also keeps latency low from instances in `ap-south-1`.

### How to check it is a replica set

**1. Look at the cluster in the Atlas UI.** Three nodes means a replica set. A standalone server would show one.

**2. Ask the server with `mongosh`:**

```bash
mongosh "mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/bankDB"
```

```javascript
db.hello()
```

Look for `setName` (the replica set name, something like `atlas-xxxx-shard-0`), `hosts` (the members), `isWritablePrimary: true`, and `logicalSessionTimeoutMinutes` (sessions, and so transactions, are available). `db.hello()` is used instead of `rs.status()` because some admin commands are restricted on free clusters.

**3. Run a real transaction (the only proof).** Save as `check-transactions.js` in your project folder and run `MONGO_URI="your-atlas-uri" node check-transactions.js`:

```javascript
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  // 1) Replica set info
  const info = await db.admin().command({ hello: 1 });
  console.log('Replica set name:', info.setName || 'NONE (standalone!)');
  console.log('Members:', info.hosts);
  console.log('Sessions supported:', info.logicalSessionTimeoutMinutes !== undefined);

  // 2) Real transaction test
  const col = db.collection('txn_check');
  await col.deleteMany({});

  const session = await mongoose.startSession();
  try {
    // Aborted transaction: the insert should be rolled back
    session.startTransaction();
    await col.insertOne({ t: 'rolled-back' }, { session });
    await session.abortTransaction();
    console.log('After abort, docs found:', await col.countDocuments({ t: 'rolled-back' }), '(expected 0)');

    // Committed transaction: the insert should persist
    await session.withTransaction(async () => {
      await col.insertOne({ t: 'committed' }, { session });
    });
    console.log('After commit, docs found:', await col.countDocuments({ t: 'committed' }), '(expected 1)');

    console.log('\nTransactions work on this cluster.');
  } catch (err) {
    console.error('\nTransactions failed:', err.message);
  } finally {
    await session.endSession();
    await col.drop().catch(() => {});
    await mongoose.disconnect();
  }
})();
```

| Result | Meaning |
|---|---|
| Set name shown, abort gives 0, commit gives 1 | Transactions work. The banking API will run fine. |
| `Replica set name: NONE (standalone!)` | Not a replica set, so transactions won't work. |
| `Transaction numbers are only allowed on a replica set member or mongos` | Same cause: connected to a standalone server. |
| Connection or auth errors | Fix the connection string, database user or IP allow-list first. |

---

## 3.14 Deploy the banking API on the ASG with Packer and Terraform

You now have a correct banking API. This section runs it on the Auto Scaling Group from Part 2: **Packer** bakes the AMI from your GitHub repo, **Terraform** creates the VPC, load balancer and ASG, and the instances reach MongoDB Atlas through a **NAT gateway with a fixed Elastic IP** that you allow-list in Atlas.

```
 Client ──► ALB ──► EC2 instance (private subnet)               ──► NAT gateway (fixed Elastic IP) ──► MongoDB Atlas
                     PM2 (fork, 1 process)                                                              (allows only the NAT IP)
                       └─ primary → 2 cluster workers (one per vCPU), each with its own Mongo pool
```

### What the ASG changes about the API

The API is already mostly ready, because JWT auth is stateless and idempotency keys live in MongoDB rather than in memory. These are the things that need attention.

| Concern | What to change |
|---|---|
| **Secrets** | Every instance needs the same `JWT_SECRET` (otherwise a token issued by one instance fails on another) and the Atlas `MONGO_URI`. They are written to `.env` by user data (Terraform's `app_env` variable). Nothing secret goes into the AMI. |
| **Health checks** | Add `/health` (no database check, used by the ALB) and `/ready` (pings MongoDB, for your own monitoring). If the ALB checked the database, a brief Atlas outage could make the ASG replace every instance at once. |
| **Graceful shutdown** | On scale-in or an instance refresh the instance gets a stop signal. The primary must drain its workers so in-flight transfers finish instead of being cut off. |
| **Mandatory `Idempotency-Key`** | With scale-in, deployments and retries, a request can be cut off after the money has moved. A retry is only safe with the same key. |
| **Keep-alive timeouts** | The ALB idle timeout is 60 s. If Node closes a connection first, the ALB can send a request down a dead connection and the client sees intermittent 502s. Set Node's timeout longer than the ALB's. |
| **Trust the proxy** | Behind the ALB, `req.ip` is the load balancer unless Express reads `X-Forwarded-For`. HTTPS would end at the ALB. |
| **Connection budget** | Total DB connections can reach **instances × workers per instance × pool size**. Four instances with 2 workers and a pool of 5 is 40 connections, which fits Atlas's free-tier limit. Cap the ASG's maximum size so it can't scale past what the database allows. |
| **Respawn backoff** | If the database is unreachable, workers exit at startup. Respawning instantly would loop in a tight crash cycle, so the primary waits a second first. |

### Repository layout

Put the banking API at the root of its own GitHub repo, and copy the `packer/` and `terraform/` folders from Part 2 into it (they are unused on the instances, so it does no harm that they ride along):

```
banking-cluster-api/
├── server.js                  # ASG-ready version (below)
├── ecosystem.config.cjs       # PM2 in fork mode (below)
├── package.json
├── package-lock.json          # commit it: npm ci uses it
├── .gitignore                 # node_modules/ and .env
├── test.js                    # the concurrency test from 3.12, with the patch below
├── packer/
│   ├── simple-api.pkr.hcl
│   └── provision.sh
└── terraform/
    ├── main.tf
    ├── variables.tf
    └── outputs.tf
```

### `package.json`

```json
{
  "name": "banking-cluster-api",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "dotenv": "^16.4.5",
    "express": "^4.21.2",
    "jsonwebtoken": "^9.0.2",
    "mongoose": "^8.8.0"
  }
}
```

Run `npm install` once so `package-lock.json` exists, and commit both files. (This API uses CommonJS `require`, as in the notes above, so there is no `"type": "module"`.)

### `server.js` (ASG-ready)

The same banking logic as 3.12, with the changes from the table: required secrets, `/health` and `/ready`, graceful shutdown in both the primary and the workers, a mandatory idempotency key, longer keep-alive timeouts, `trust proxy`, and a pool size from the environment.

```javascript
// server.js  (ASG-ready banking API)
require('dotenv').config();
const cluster = require('node:cluster');
const { availableParallelism, hostname } = require('node:os');
const process = require('node:process');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;                       // required, no localhost default in production
const JWT_SECRET = process.env.JWT_SECRET;                     // required, must be identical on every instance
const DB_POOL_SIZE = Number(process.env.DB_POOL_SIZE) || 10;   // connections PER WORKER
const WORKERS = Number(process.env.WORKERS) || availableParallelism();

// =========================================================================
// 1. PRIMARY PROCESS: forks workers, heals them, and drains them on shutdown
// =========================================================================
if (cluster.isPrimary) {
  for (const [name, value] of Object.entries({ MONGO_URI, JWT_SECRET })) {
    if (!value) {
      console.error(`[Primary] ${name} is missing. Set it in .env and restart.`);
      process.exit(1);
    }
  }

  let shuttingDown = false;
  console.log(`[Primary ${process.pid}] Starting ${WORKERS} banking API workers on ${hostname()}...`);

  for (let i = 0; i < WORKERS; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      if (Object.keys(cluster.workers).length === 0) process.exit(0);
      return;                                   // never respawn while shutting down
    }
    console.error(`[Primary] Worker ${worker.process.pid} died (code ${code}, signal ${signal}). Respawning in 1s...`);
    setTimeout(() => cluster.fork(), 1000);     // small delay avoids a tight crash loop
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Primary] ${signal} received, draining workers...`);
    const ids = Object.keys(cluster.workers);
    if (ids.length === 0) process.exit(0);
    for (const id of ids) cluster.workers[id].disconnect();   // each worker finishes in-flight requests, then exits
    setTimeout(() => process.exit(1), 25_000).unref();        // hard stop if something is stuck
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

// =========================================================================
// 2. WORKER PROCESS: Express app + its own MongoDB connection pool
// =========================================================================
} else {
  const express = require('express');
  const mongoose = require('mongoose');
  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');

  // ---------- Constants & helpers ----------
  const SIGNUP_BONUS_CENTS = 20000;            // $200.00
  const MAX_TRANSFER_CENTS = 1_000_000_00;     // $1,000,000.00 safety cap
  const TXN_OPTIONS = {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },           // Durability
    readPreference: 'primary'
  };

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  const toDollars = (cents) => (cents / 100).toFixed(2);

  // Converts a dollar amount (e.g. 10.5) to integer cents. Returns null if invalid.
  function parseAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const cents = Math.round(n * 100);
    if (Math.abs(n * 100 - cents) > 1e-6) return null;   // more than 2 decimals
    if (cents < 1 || cents > MAX_TRANSFER_CENTS) return null;
    return cents;
  }

  const signToken = (user) =>
    jwt.sign({ sub: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: '1h' });

  const publicUser = (user) => ({
    id: user._id,
    name: user.name,
    email: user.email,
    balance: toDollars(user.balance)
  });

  // ---------- Models ----------
  const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    balance: { type: Number, default: SIGNUP_BONUS_CENTS, min: 0 }   // stored in cents
  }, { timestamps: true });

  const transactionSchema = new mongoose.Schema({
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 1 },                // cents
    status: { type: String, default: 'COMPLETED' },
    idempotencyKey: { type: String }
  }, { timestamps: true });

  // One idempotency key per sender
  transactionSchema.index(
    { from: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
  );

  const User = mongoose.model('User', userSchema);
  const Transaction = mongoose.model('Transaction', transactionSchema);

  // ---------- App & middleware ----------
  const app = express();
  app.set('trust proxy', 1);                   // one proxy hop: the Application Load Balancer
  app.use(express.json({ limit: '100kb' }));

  function auth(req, res, next) {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ success: false, error: 'Missing or malformed Authorization header' });
    }
    try {
      req.user = jwt.verify(token, JWT_SECRET);   // stateless: works on ANY worker and ANY instance
      next();
    } catch {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
  }

  // ---------- Health checks ----------

  // ALB health check: must NOT touch the database (an Atlas blip should not replace every instance)
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', host: hostname(), pid: process.pid });
  });

  // For your own monitoring: is MongoDB reachable?
  app.get('/ready', async (req, res) => {
    try {
      await mongoose.connection.db.admin().ping();
      res.json({ status: 'ready', host: hostname() });
    } catch {
      res.status(503).json({ status: 'db-unavailable', host: hostname() });
    }
  });

  // ---------- Routes ----------

  // SIGN UP: creates the user with the $200 welcome credit
  app.post('/api/auth/signup', async (req, res, next) => {
    try {
      const { name, email, password } = req.body;
      if ([name, email, password].some((v) => typeof v !== 'string') || !name || !email || password.length < 8) {
        throw new HttpError(400, 'name, email and password (min 8 characters) are required');
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({ name, email, passwordHash });   // balance defaults to 20000 cents

      res.status(201).json({
        success: true,
        message: `Account created. $${toDollars(SIGNUP_BONUS_CENTS)} welcome credit added!`,
        token: signToken(user),
        user: publicUser(user),
        handledBy: process.pid
      });
    } catch (err) {
      if (err.code === 11000) return next(new HttpError(409, 'Email already registered'));
      next(err);
    }
  });

  // LOGIN
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const { email, password } = req.body;
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new HttpError(400, 'email and password are required');
      }
      const user = await User.findOne({ email: email.toLowerCase().trim() });
      const valid = user && (await bcrypt.compare(password, user.passwordHash));
      if (!valid) throw new HttpError(401, 'Invalid credentials');

      res.json({ success: true, token: signToken(user), user: publicUser(user), handledBy: process.pid });
    } catch (err) {
      next(err);
    }
  });

  // PROFILE / BALANCE
  app.get('/api/account/me', auth, async (req, res, next) => {
    try {
      const user = await User.findById(req.user.sub);
      if (!user) throw new HttpError(404, 'User not found');
      res.json({ success: true, user: publicUser(user), handledBy: process.pid });
    } catch (err) {
      next(err);
    }
  });

  // TRANSFER MONEY (ACID transaction, idempotency key REQUIRED)
  app.post('/api/transfer', auth, async (req, res, next) => {
    const session = await mongoose.startSession();
    try {
      const { toEmail } = req.body;
      const cents = parseAmount(req.body.amount);
      const idempotencyKey = req.get('Idempotency-Key');
      const senderId = req.user.sub;

      if (!idempotencyKey || idempotencyKey.length > 128) {
        throw new HttpError(400, 'A valid Idempotency-Key header (max 128 characters) is required');
      }
      if (typeof toEmail !== 'string' || cents === null) {
        throw new HttpError(400, 'toEmail and a valid positive amount (max 2 decimals) are required');
      }

      // Replay protection: the same key from the same sender returns the original result
      const existing = await Transaction.findOne({ from: senderId, idempotencyKey });
      if (existing) {
        return res.status(200).json({
          success: true,
          replayed: true,
          transaction: { id: existing._id, amount: toDollars(existing.amount) },
          handledBy: process.pid
        });
      }

      const receiver = await User.findOne({ email: toEmail.toLowerCase().trim() }).select('_id');
      if (!receiver) throw new HttpError(404, 'Receiver not found');
      if (String(receiver._id) === senderId) throw new HttpError(400, 'You cannot transfer money to yourself');

      let transaction;
      let senderBalance;

      // withTransaction commits on success, aborts on error, and
      // automatically RETRIES on transient errors (e.g. write conflicts).
      await session.withTransaction(async () => {
        // 1) DEBIT: atomic conditional update. Only matches if funds are sufficient.
        const sender = await User.findOneAndUpdate(
          { _id: senderId, balance: { $gte: cents } },
          { $inc: { balance: -cents } },
          { new: true, session }
        );
        if (!sender) throw new HttpError(400, 'Insufficient funds');

        // 2) CREDIT: atomic increment on the receiver
        const credit = await User.updateOne(
          { _id: receiver._id },
          { $inc: { balance: cents } },
          { session }
        );
        if (credit.matchedCount !== 1) throw new HttpError(404, 'Receiver not found');

        // 3) LEDGER: audit record, part of the SAME transaction
        const [tx] = await Transaction.create(
          [{ from: senderId, to: receiver._id, amount: cents, idempotencyKey }],
          { session }
        );

        transaction = tx;
        senderBalance = sender.balance;
      }, TXN_OPTIONS);

      res.status(201).json({
        success: true,
        message: `Transferred $${toDollars(cents)} to ${toEmail}`,
        transaction: { id: transaction._id, amount: toDollars(cents), to: toEmail, createdAt: transaction.createdAt },
        yourNewBalance: toDollars(senderBalance),
        handledBy: process.pid
      });
    } catch (err) {
      if (err.code === 11000) {
        return next(new HttpError(409, 'A request with this Idempotency-Key is already being processed'));
      }
      next(err);
    } finally {
      await session.endSession();
    }
  });

  // TRANSACTION HISTORY
  app.get('/api/transactions', auth, async (req, res, next) => {
    try {
      const me = req.user.sub;
      const txs = await Transaction.find({ $or: [{ from: me }, { to: me }] })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      res.json({
        success: true,
        count: txs.length,
        data: txs.map((t) => ({
          id: t._id,
          direction: String(t.from) === me ? 'SENT' : 'RECEIVED',
          amount: toDollars(t.amount),
          at: t.createdAt
        })),
        handledBy: process.pid
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Error handler ----------
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, error: err.message, handledBy: process.pid });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, error: 'Malformed JSON body', handledBy: process.pid });
    }
    console.error(`[Worker ${process.pid}]`, err);
    res.status(500).json({ success: false, error: 'Internal server error', handledBy: process.pid });
  });

  // ---------- Graceful shutdown ----------
  // Stop accepting, let in-flight requests finish, then close the DB and exit.
  // Triggered by the primary (worker.disconnect()) or by a signal sent straight to this worker.
  // Registered BEFORE connecting, so a worker that is still booting also stops promptly.
  let server = null;
  let closing = false;
  const drain = () => {
    if (closing) return;
    closing = true;
    if (!server) process.exit(0);               // still booting: nothing to drain
    server.close();                             // stop accepting new connections; in-flight requests finish
    server.closeIdleConnections?.();            // drop idle keep-alive sockets (Node 18.2+)
    setTimeout(() => process.exit(1), 20_000).unref();
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
  process.on('disconnect', drain);

  // ---------- Boot: connect, build indexes, THEN accept traffic ----------
  (async () => {
    try {
      await mongoose.connect(MONGO_URI, { maxPoolSize: DB_POOL_SIZE });
      await Promise.all([User.init(), Transaction.init()]);   // make sure unique indexes exist

      server = app.listen(PORT, () =>
        console.log(`  └─> [Worker ${process.pid}] Bank API ready on port ${PORT}`)
      );

      // Must be LONGER than the ALB idle timeout (60 s), or the ALB can hit a closed connection and return 502
      server.keepAliveTimeout = 65_000;
      server.headersTimeout = 66_000;

      // Once the server has fully closed (all in-flight requests done), close the DB and exit
      server.on('close', async () => {
        await mongoose.disconnect().catch(() => {});
        process.exit(0);
      });
    } catch (err) {
      console.error(`[Worker ${process.pid}] Startup failed:`, err.message);
      process.exit(1);
    }
  })();
}
```

### `ecosystem.config.cjs`

The app clusters itself, so PM2 runs it in **fork mode with one instance**. PM2 only supervises: it restarts the primary if it crashes and starts it again after a reboot.

```javascript
module.exports = {
  apps: [
    {
      name: 'banking-api',
      script: 'server.js',
      cwd: '/opt/banking-api',
      exec_mode: 'fork',          // NOT 'cluster': server.js creates its own workers
      instances: 1,
      autorestart: true,
      kill_timeout: 30000,        // longer than the app's own 25 s hard stop, so it can drain first
      treekill: false,            // signal only the primary, which drains its workers itself
    },
  ],
};
```

### Packer and Terraform: what changed in Part 2

So the same code can deploy either API, Part 2 got a few small, general additions:

- **Packer:** new `app_dir` variable (where the code lives on the instance) and `smoke_test` variable. The banking API needs a database to start, so its AMI is built with `smoke_test=false`, which only checks that the dependencies installed.
- **Terraform:** new `app_dir` variable and a new sensitive **`app_env`** variable, a map of extra settings written to the instance's `.env` file. This is how `MONGO_URI`, `JWT_SECRET` and `DB_POOL_SIZE` reach the instances, without ever being baked into the AMI.

### Run it, step by step

**1. Atlas.** Create the database user and copy the connection string (see 3.13), with the database name in it, for example `.../bankDB?retryWrites=true&w=majority`. Leave Network Access for step 4.

**2. Push the repo to GitHub** (the banking API, with `packer/` and `terraform/` copied in).

**3. Create the network and load balancer first, with the NAT gateway on.** The instances can only reach Atlas through the NAT gateway, so it is needed, and you need its IP before the instances start. In `terraform/`, create a `terraform.tfvars` with these non-secret values (keep the three `.tf` files as they are; secrets never go in this file):

```hcl
project_name       = "bank"                 # resource names: bank-vpc, bank-alb, bank-asg ...
app_name           = "banking-api"
app_dir            = "/opt/banking-api"
ami_name_prefix    = "bank-api-ami"         # must match the Packer ami_name_prefix below
enable_nat_gateway = true                   # needed to reach Atlas
```

Then:

```bash
cd terraform
terraform init
terraform apply -var create_asg=false       # VPC, subnets, NAT gateway, ALB. No instances yet.
terraform output nat_gateway_public_ips
```

**4. Allow the NAT IP in Atlas.** Atlas, Network Access, Add IP Address: enter the NAT gateway's Elastic IP followed by `/32` (for example `13.201.10.20/32`) and wait for the status to become **Active**.

![Image placeholder: Atlas Network Access list showing the NAT gateway Elastic IP as active](images/banking-atlas-network-access.png)

If you skip this, the workers can't connect to Atlas, they exit at startup, the ALB health check fails, and the ASG keeps replacing instances.

**5. Build the AMI with Packer.**

```bash
cd ../packer
packer init .
packer build \
  -var 'repo_url=https://github.com/YOUR_GITHUB_USER/banking-cluster-api.git' \
  -var 'app_dir=/opt/banking-api' \
  -var 'smoke_test=false' \
  -var 'ami_name_prefix=bank-api-ami' .
```

Add `-var 'repo_branch=main'` if your branch is not `master`. The AMI is named `bank-api-ami-<timestamp>`.

**6. Create the secrets once and apply.**

Generate the JWT secret **once**, keep it somewhere safe (a password manager), and reuse it. Changing it logs every user out and replaces all instances:

```bash
cd ../terraform
openssl rand -base64 48 > ../jwt.secret && chmod 600 ../jwt.secret     # add jwt.secret to .gitignore
```

Pass the secrets through the environment, building the JSON with `jq` so special characters in the connection string are escaped correctly:

```bash
export MONGO_URI='mongodb+srv://<dbUser>:<password>@cluster0.xxxxx.mongodb.net/bankDB?retryWrites=true&w=majority'

export TF_VAR_app_env="$(jq -nc \
  --arg uri "$MONGO_URI" \
  --arg jwt "$(cat ../jwt.secret)" \
  '{MONGO_URI: $uri, JWT_SECRET: $jwt, DB_POOL_SIZE: "5"}')"

terraform apply          # creates the launch template, the ASG and the 60% CPU policy
```

`DB_POOL_SIZE=5` and 2 workers per `t3.micro` give 10 connections per instance, so the maximum of 4 instances uses 40.

**7. Watch it come up.** Under **EC2, Target Groups, `bank-tg`, Targets** both instances should become healthy within a minute or two. On a failure, the reason is in `/var/log/cloud-init-output.log` and `pm2 logs` on the instance (use an EC2 Instance Connect Endpoint, see the guide's optional section, or check the Atlas Network Access list first, which is the usual cause).

![Image placeholder: Target group showing both banking API instances healthy](images/banking-target-group-healthy.png)

**8. Smoke test through the load balancer.**

```bash
ALB=$(terraform output -raw alb_url)

curl $ALB/health                       # which instance answered (run it a few times)
curl $ALB/ready                        # {"status":"ready"...}: the instance can reach Atlas

curl -X POST $ALB/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@test.com","password":"password123"}'
```

### Run the concurrency test against the load balancer

The transfer endpoint now requires an `Idempotency-Key`, so patch `test.js` from 3.12: add a fresh key to every transfer (each of the 50 requests is a separate transfer, so each gets its own key). The two changes are the `randomUUID` import and the extra header in `call()`:

```javascript
// top of test.js
const { randomUUID } = require('node:crypto');
const BASE = process.env.API_BASE || 'http://localhost:3000/api';

async function call(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(path === '/transfer' && { 'Idempotency-Key': randomUUID() })   // one NEW key per transfer
    },
    body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}
// ...the rest of test.js is unchanged
```

```bash
API_BASE="$(terraform output -raw alb_url)/api" node ../test.js
```

The expected result is the same as on your laptop: **20 succeed, 30 rejected, Alice at $0.00, Bob at $400.00, total $400.00**. This time the requests are spread across **different instances as well as different workers**, so the `handledBy` PIDs come from several machines. On the Atlas free tier (100 operations per second) it will be slower than on a laptop, but the result must be identical.

### Load test: make the ASG scale

The banking API is not CPU-heavy by default, but **bcrypt** makes `login` expensive. Use it as the load:

```bash
# create the test user once
curl -X POST $ALB/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"Load","email":"load@test.com","password":"password123"}'

# hammer login (each request does a bcrypt comparison plus one DB read)
npx autocannon -c 30 -d 300 -t 30 -m POST \
  -H 'content-type: application/json' \
  -b '{"email":"load@test.com","password":"password123"}' \
  "$ALB/api/auth/login"
```

Watch **ASG, Activity** and **Monitoring** as in Step 10 of the guide. Average CPU rises above 60%, the ASG adds instances (up to `max_size`), and each new instance brings 2 workers and their connection pools. Keep an eye on the Atlas free-tier cap of 100 operations per second: if latency climbs while CPU stays low, the database is the bottleneck, and more app instances will not help.

![Image placeholder: ASG activity history showing new banking API instances launched during the login load test](images/banking-asg-scale-out.png)

### Shipping a new version, or rotating a secret

- **New code:** push to GitHub, run `packer build` again (same `-var` flags), then `terraform apply`. Terraform finds the newest `bank-api-ami*`, updates the launch template, and the ASG replaces the instances in rolling batches (at least 50% healthy). Because the API drains gracefully, in-flight transfers finish.
- **New secret or pool size:** change the value in `TF_VAR_app_env` and run `terraform apply`. The user data changes, the launch template changes, and the instances are refreshed. Rotating `JWT_SECRET` invalidates every issued token.

### Destroy everything

```bash
cd terraform
terraform destroy
```

Then clean up what Terraform does not manage:

- **AMIs and snapshots** built by Packer (use the loop from Part 2, with `bank-api-ami*`).
- **Atlas:** remove the NAT gateway IP from Network Access, and delete the database user or cluster if you no longer need them.
- **Secrets on disk:** delete `jwt.secret` if you will not use it again.

Terraform state now contains your secrets (`app_env` ends up in the launch template's user data in `terraform.tfstate`), so keep that file private, never commit it, and use an encrypted remote backend for anything shared.

### Things to know before real traffic

- **Secrets in user data.** Anyone who can read the launch template or log in to an instance can read the `.env`. IMDSv2-only is already enforced and the file is mode 600. Restrict IAM access, rotate if exposed, and consider Secrets Manager later.
- **One NAT gateway** is a single point of failure for reaching Atlas. `-var single_nat_gateway=false` creates one per AZ (add all their Elastic IPs to Atlas).
- **The Atlas free tier is not production-grade:** 100 operations per second, no backups. Plan to move to M10 or higher before real traffic.
- **HTTPS:** the ALB listener is HTTP only. Add an ACM certificate and an HTTPS listener before real users send passwords and JWTs.
- **Rate limiting:** an in-memory limiter counts per worker and per instance, so the real limit is multiplied. Use AWS WAF at the ALB or Redis.
- **Containers later:** if you move to ECS or EKS, drop the cluster module and run one Node process per container (see 3.7).