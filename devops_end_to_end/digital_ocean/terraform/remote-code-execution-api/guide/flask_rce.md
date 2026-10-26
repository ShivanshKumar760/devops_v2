# Flask + dataset + JWT API — Complete Beginner's DevOps Guide

Build a Flask API with **dataset** (simple database access), **Flask-JWT-Extended** (login tokens), and deploy it on a **DigitalOcean droplet** using **Pyker** (process manager), **Nginx** (web server) and **Certbot** (free HTTPS).

Everything is in this one file: the explanations, every file's full code, and every command.

---

## 0. The big picture

```
Browser / curl
     │  HTTPS (port 443)
     ▼
  Nginx  ──────────►  waitress (127.0.0.1:8000)  ──►  your Flask app (app.py)
 (public, TLS             ▲                                  │
  from Certbot)           │ kept alive by Pyker              ▼
                                                      PostgreSQL (via dataset)
```

| Piece | Job in plain words |
|---|---|
| **Flask** | Your Python web app (the routes). |
| **dataset** | Lets you talk to the database with Python dicts instead of writing SQL strings. |
| **Flask-JWT-Extended** | After login, gives the user a signed token. They send it back to prove who they are. |
| **waitress** | A production-grade server that runs Flask, started from the bottom of `app.py` (never use `app.run()` in production). |
| **Pyker** | Starts your app in the background, restarts it if it crashes, keeps logs. |
| **Nginx** | Sits in front, handles HTTPS, rate limits, and forwards requests to waitress. |
| **Certbot** | Gets and renews a free Let's Encrypt HTTPS certificate. |

---

## 1. Project layout

```
flask-api/
├── app.py              # the API (Pyker runs this file directly)
├── requirements.txt
├── .env.example        # copy to .env and fill in
├── .gitignore
└── deploy/
    ├── nginx-api.conf  # goes to /etc/nginx/sites-available/api
    └── api-proxy.conf  # goes to /etc/nginx/snippets/api-proxy.conf
```

---

## 2. All the code

### `requirements.txt`
```text
Flask>=3.0
Flask-JWT-Extended>=4.6
dataset>=1.6.2
psycopg2-binary>=2.9
python-dotenv>=1.0
waitress>=3.0
```

### `.env.example`  (copy to `.env`, never commit `.env`)
```bash
# Generate the secret with:  python3 -c "import secrets; print(secrets.token_hex(32))"
JWT_SECRET_KEY=change-me
# SQLAlchemy-style URL (dataset uses SQLAlchemy underneath). DO managed DB needs sslmode=require.
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
```

### `.gitignore`
```text
.env
venv/
__pycache__/
*.pyc
```

> **No `init_db.py` needed:** the `users_test` table already exists, and `db["users_test"]` just attaches to it. (If the table were ever missing, `dataset` would create it automatically on the first insert, but without `NOT NULL`/`UNIQUE` constraints.)
>
> **Existing users:** any rows created by your *old* code have plain-text passwords, so they can't log in with the new hashed check. Delete them and sign up again, or the new `/signup` will create hashed ones.
>
> **Column size:** hashed passwords are ~100+ characters. If your `password` column is shorter than that (e.g. `VARCHAR(50)`), widen it first: `ALTER TABLE users_test ALTER COLUMN password TYPE VARCHAR(255);`

### `app.py`  — the API (Pyker starts this file)
```python
import os
import subprocess
import tempfile
import shutil
from datetime import timedelta

import dataset
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    create_refresh_token,
    get_jwt_identity,
    jwt_required,
)
from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

app = Flask(__name__)
app.config["JWT_SECRET_KEY"] = os.environ["JWT_SECRET_KEY"]
app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(minutes=30)
app.config["JWT_REFRESH_TOKEN_EXPIRES"] = timedelta(days=7)
jwt = JWTManager(app)

DATABASE_URL = os.environ["DATABASE_URL"]

# dataset.connect() = create the connection pool in one call.
# Connections are kept per-thread, so one module-level object is fine.
db = dataset.connect(DATABASE_URL, engine_kwargs={"pool_pre_ping": True})

# Table handle (the users_test table already exists in the database)
users = db["users_test"]


# ---------------------------------------------------------------- health
@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "Ok"})


# ---------------------------------------------------------------- auth
@app.route("/signup", methods=["POST"])
def signup():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""

    if not name or not password:
        return jsonify(error="name and password are required"), 400

    # SELECT * FROM users_test WHERE name = :name LIMIT 1
    if users.find_one(name=name):
        return jsonify(error="user already exists"), 409

    try:
        # INSERT INTO users_test (name, password) VALUES (...) RETURNING id
        user_id = users.insert(
            {"name": name, "password": generate_password_hash(password)}
        )
    except IntegrityError:  # two simultaneous signups with the same name
        return jsonify(error="user already exists"), 409

    return jsonify(message="signup success", id=user_id), 201


@app.route("/signin", methods=["POST"])
def signin():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""

    user = users.find_one(name=name)
    # Same error for "no such user" and "wrong password" -> no user enumeration
    if not user or not check_password_hash(user["password"], password):
        return jsonify(error="invalid credentials"), 401

    identity = str(user["id"])  # flask-jwt-extended wants a string subject
    return jsonify(
        access_token=create_access_token(identity=identity),
        refresh_token=create_refresh_token(identity=identity),
    )


@app.route("/refresh", methods=["POST"])
@jwt_required(refresh=True)
def refresh():
    return jsonify(access_token=create_access_token(identity=get_jwt_identity()))


@app.route("/me", methods=["GET"])
@jwt_required()
def me():
    user = users.find_one(id=int(get_jwt_identity()))
    if not user:
        return jsonify(error="user not found"), 404
    return jsonify(id=user["id"], name=user["name"])  # never return the hash


# ---------------------------------------------------------------- code runner
@app.route("/execute", methods=["POST"])
@jwt_required()
def execute():
    data = request.get_json(silent=True) or {}
    code = data.get("code")
    if not code:
        return jsonify(error="Please provide code to run"), 400
    if len(code) > 20_000:
        return jsonify(error="code too large"), 413

    tmp_dir = tempfile.mkdtemp()
    try:
        with open(os.path.join(tmp_dir, "script.py"), "w") as f:
            f.write(code)

        result = subprocess.run(
            ["python3", "-I", "script.py"],  # -I: isolated mode
            cwd=tmp_dir,
            capture_output=True,
            text=True,
            timeout=5,  # kill infinite loops
            env={"PATH": "/usr/bin:/bin"},  # do NOT leak DATABASE_URL / JWT secret
        )
        return jsonify(
            message="Success",
            stdout=result.stdout[:10_000],
            stderr=result.stderr[:10_000],
            returncode=result.returncode,
        )
    except subprocess.TimeoutExpired:
        return jsonify(error="execution timed out (5s)"), 408
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    # Pyker runs this file, so the server starts here.
    # waitress = production-grade server (unlike app.run()), pure Python, no extra file needed.
    from waitress import serve

    serve(app, host="127.0.0.1", port=8000, threads=8)  # localhost only; Nginx is the public face
```

### `deploy/api-proxy.conf`  → `/etc/nginx/snippets/api-proxy.conf`
```nginx
proxy_pass         http://127.0.0.1:8000;
proxy_set_header   Host              $host;
proxy_set_header   X-Real-IP         $remote_addr;
proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header   X-Forwarded-Proto $scheme;
proxy_read_timeout 30s;
```

### `deploy/nginx-api.conf`  → `/etc/nginx/sites-available/api`
Replace `api.example.com` with your domain.
```nginx
# per-IP rate limits (this file is included inside the http{} context)
limit_req_zone $binary_remote_addr zone=auth_zone:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=exec_zone:10m rate=10r/m;

server {
    listen 80;
    listen [::]:80;
    server_name api.example.com;

    client_max_body_size 1m;

    location = /signin {
        limit_req zone=auth_zone burst=5 nodelay;
        include /etc/nginx/snippets/api-proxy.conf;
    }

    location = /signup {
        limit_req zone=auth_zone burst=5 nodelay;
        include /etc/nginx/snippets/api-proxy.conf;
    }

    location = /execute {
        limit_req zone=exec_zone burst=5 nodelay;
        include /etc/nginx/snippets/api-proxy.conf;
    }

    location / {
        include /etc/nginx/snippets/api-proxy.conf;
    }
}
```

---

## 3. Understanding `dataset` (and the SQL behind it)

`dataset` sits on top of SQLAlchemy Core. You hand it plain Python dicts and keyword filters; it writes and runs the SQL. There are no model classes (so it is *not* an ORM), and you don't write SQL strings (so it is *not* raw SQL).

| dataset code | SQL it runs |
|---|---|
| `db = dataset.connect(url)` | open a connection pool |
| `t = db["users_test"]` | get a table handle (creates the table if missing) |
| `t.insert({"name": "a", "password": "h"})` | `INSERT INTO users_test (name, password) VALUES ('a','h')` — returns the new id |
| `t.find_one(name="a")` | `SELECT * FROM users_test WHERE name='a' LIMIT 1` |
| `t.find(country="IN")` | `SELECT * FROM t WHERE country='IN'` |
| `t.find(age={">=": 18}, order_by="-id", _limit=10)` | `... WHERE age>=18 ORDER BY id DESC LIMIT 10` |
| `t.find(id=[1, 3, 7])` | `... WHERE id IN (1,3,7)` |
| `t.update({"id": 5, "name": "b"}, ["id"])` | `UPDATE users_test SET name='b' WHERE id=5` |
| `t.upsert(row, ["name"])` | insert, or update if `name` already exists |
| `t.delete(name="a")` | `DELETE FROM users_test WHERE name='a'` |
| `t.count()` | `SELECT COUNT(*) FROM users_test` |
| `with db as tx: tx["t"].insert(...)` | `BEGIN` … `COMMIT` (or `ROLLBACK` on error) |
| `db.query("SELECT ... WHERE x = :x", x=1)` | raw SQL escape hatch for joins / aggregates |

**Three things beginners should know**

1. **Auto-creating columns.** If you insert a dict with a key that isn't a column, `dataset` adds the column. Handy for prototypes, risky in production (a typo creates a new column). Since your table already exists, create it yourself with `NOT NULL` and `UNIQUE` on `name` if you want the database to enforce that.
2. **Auto-commit.** Each `dataset` call commits on its own. When several writes must succeed or fail together, wrap them in `with db as tx:`.
3. **Driver.** The URL stays `postgresql://...` and the driver is `psycopg2-binary`. If `pip` installs a SQLAlchemy that conflicts, pin `sqlalchemy<2`.

**How passwords work here:** we never store the real password. `generate_password_hash("1234")` stores a salted hash; `check_password_hash(stored_hash, "1234")` verifies it.

**How JWT works here:** `/signin` returns an *access token* (valid 30 min) and a *refresh token* (7 days). The client sends `Authorization: Bearer <access_token>` on every protected request. When it expires, call `/refresh` with the refresh token to get a new one.

---

## 4. Deploying on DigitalOcean (Ubuntu 24.04)

Before starting: create a droplet, and point your domain's **A record** at its IP (e.g. `api.example.com → 203.0.113.10`). Wait a few minutes for DNS.

### Step 1 — Server prep
```bash
ssh root@<droplet-ip>
ufw allow OpenSSH && ufw allow "Nginx Full" && ufw enable
apt update && apt install -y python3-venv python3-dev libpq-dev build-essential git nginx certbot python3-certbot-nginx
```

### Step 2 — Get the app and install it
```bash
cd ~ && git clone <your-repo-url> flask-api && cd flask-api     # or copy the folder with scp
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env && nano .env && chmod 600 .env             # fill in the real values
```

### Step 3 — Install Pyker and start the API
Install Pyker following the README at <https://github.com/mrvi0/pyker> (read any installer script before running it):
```bash
git clone https://github.com/mrvi0/pyker.git    # then follow its README install steps
```
Start the app (run `pyker start --help` to confirm the flag names for your version):
```bash
cd ~/flask-api
pyker start flask-api app.py --venv venv --auto-restart
pyker list                    # is it running?
pyker logs flask-api          # see output / errors
curl http://127.0.0.1:8000/   # → {"status":"Ok"}
```
Everyday commands:
```bash
pyker restart flask-api    # after git pull
pyker stop flask-api
pyker info flask-api
pyker delete flask-api
```
**After a server reboot:** check Pyker's README for a built-in startup option. A safe fallback is cron:
```bash
crontab -e
@reboot cd /root/flask-api && /root/.local/bin/pyker start flask-api app.py --venv venv --auto-restart
```
(use `which pyker` to find the real path)

### Step 4 — Nginx
```bash
cp deploy/api-proxy.conf /etc/nginx/snippets/api-proxy.conf
cp deploy/nginx-api.conf /etc/nginx/sites-available/api
sed -i 's/api.example.com/YOUR.DOMAIN/' /etc/nginx/sites-available/api
ln -s /etc/nginx/sites-available/api /etc/nginx/sites-enabled/api
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```
`nginx -t` checks the config for typos before you reload.

### Step 5 — HTTPS with Certbot
```bash
certbot --nginx -d YOUR.DOMAIN      # adds the port-443 block and HTTP→HTTPS redirect
certbot renew --dry-run             # confirms auto-renewal works
```

### Step 6 — Test it
```bash
# create a user
curl -X POST https://YOUR.DOMAIN/signup -H 'Content-Type: application/json' \
  -d '{"name":"shivansh","password":"s3cret"}'

# log in and save the token
TOKEN=$(curl -s -X POST https://YOUR.DOMAIN/signin -H 'Content-Type: application/json' \
  -d '{"name":"shivansh","password":"s3cret"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# protected routes
curl https://YOUR.DOMAIN/me -H "Authorization: Bearer $TOKEN"
curl -X POST https://YOUR.DOMAIN/execute -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"print(1+1)"}'
```

### Updating the app later
```bash
cd ~/flask-api && git pull
./venv/bin/pip install -r requirements.txt
pyker restart flask-api
```

---

## 5. Deploy with Terraform (automated alternative to Section 4)

Instead of typing Section 4's commands by hand, Terraform can create the droplet, firewall (and optionally the DNS record) and run the setup automatically on first boot using **cloud-init**.

What it does:
1. Looks up your **existing** DigitalOcean SSH key named `digital_ocean_key` (it does not create or upload a key).
2. Creates an Ubuntu 24.04 droplet with that key, so you can `ssh root@<ip>`.
3. Creates a DigitalOcean cloud firewall (SSH, 80, 443 only).
4. On first boot, cloud-init installs packages, clones your repo, creates the venv, writes `.env`, configures Nginx, installs Pyker and starts `app.py`.
5. You run **Certbot once** at the end (it needs DNS to already point at the droplet, so it isn't automated).

> **Not tested.** I couldn't run `terraform validate` or a real `apply` in my environment, and the Pyker install step in cloud-init follows its README and is unverified. Run `terraform validate` and `terraform plan` first, and check `/var/log/cloud-init-output.log` on the droplet if anything is missing.

### Prerequisites
- Terraform ≥ 1.5 installed on your laptop (<https://developer.hashicorp.com/terraform/install>).
- A DigitalOcean **API token** (Control Panel → API → Generate New Token, read+write).
- Your SSH key already added in DigitalOcean (Settings → Security) with the name **`digital_ocean_key`**, and the matching private key on your laptop (e.g. `~/.ssh/digital_ocean_key`).
- Your code pushed to a git repo the droplet can clone. A **public** HTTPS URL is simplest; a private repo needs a deploy key or token in the URL.
- A domain name (e.g. `api.example.com`).

### Extra layout
```
terraform/
├── versions.tf
├── variables.tf
├── main.tf
├── outputs.tf
├── cloud-init.yaml.tftpl
└── terraform.tfvars.example
```
Add these lines to `.gitignore` (state and tfvars contain secrets):
```text
terraform/.terraform/
terraform/*.tfstate*
terraform/terraform.tfvars
```

### `terraform/versions.tf`
```hcl
terraform {
  required_version = ">= 1.5"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# The API token is read from the DIGITALOCEAN_TOKEN environment variable.
provider "digitalocean" {}
```

### `terraform/variables.tf`
```hcl
variable "ssh_key_name" {
  description = "Name of the SSH key that already exists in your DigitalOcean account"
  type        = string
  default     = "digital_ocean_key"
}

variable "repo_url" {
  description = "Git URL the droplet clones, e.g. https://github.com/you/flask-api.git"
  type        = string
}

variable "database_url" {
  description = "postgresql://user:pass@host:5432/db?sslmode=require"
  type        = string
  sensitive   = true
}

variable "fqdn" {
  description = "Public hostname for the API, e.g. api.example.com"
  type        = string
}

variable "dns_zone" {
  description = "Domain managed in DigitalOcean DNS (e.g. example.com). Leave empty to manage DNS yourself."
  type        = string
  default     = ""
}

variable "region" {
  type    = string
  default = "blr1" # Bangalore. Others: nyc3, sfo3, fra1, sgp1, ...
}

variable "size" {
  type    = string
  default = "s-1vcpu-1gb"
}

variable "ssh_allowed_cidrs" {
  description = "Who may SSH in. Restrict to your own IP, e.g. [\"203.0.113.7/32\"]"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}
```

### `terraform/main.tf`
```hcl
# Look up the key you already uploaded to DigitalOcean (no new key is created)
data "digitalocean_ssh_key" "main" {
  name = var.ssh_key_name
}

# Random JWT signing secret, generated once and stored in Terraform state
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "digitalocean_droplet" "api" {
  name     = "flask-api"
  image    = "ubuntu-24-04-x64"
  region   = var.region
  size     = var.size
  ssh_keys = [data.digitalocean_ssh_key.main.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    repo_url     = var.repo_url
    fqdn         = var.fqdn
    jwt_secret   = random_password.jwt.result
    database_url = var.database_url
  })

  # Editing cloud-init later must not destroy and recreate a running server
  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "digitalocean_firewall" "api" {
  name        = "flask-api-fw"
  droplet_ids = [digitalocean_droplet.api.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_cidrs
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Allow all outbound (apt, git, DNS, database, Let's Encrypt)
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# Optional: only if the domain's DNS is hosted in DigitalOcean
resource "digitalocean_record" "api" {
  count  = var.dns_zone == "" ? 0 : 1
  domain = var.dns_zone
  type   = "A"
  name   = trimsuffix(var.fqdn, ".${var.dns_zone}")
  value  = digitalocean_droplet.api.ipv4_address
  ttl    = 300
}
```

### `terraform/cloud-init.yaml.tftpl`
This runs once, as root, on the droplet's first boot.
```yaml
#cloud-config
package_update: true
packages:
  - python3-venv
  - python3-dev
  - libpq-dev
  - build-essential
  - git
  - curl
  - nginx
  - certbot
  - python3-certbot-nginx

write_files:
  # Secrets file; moved into the app folder after the repo is cloned
  - path: /root/flask-api.env
    permissions: "0600"
    content: |
      JWT_SECRET_KEY=${jwt_secret}
      DATABASE_URL=${database_url}

  - path: /etc/nginx/snippets/api-proxy.conf
    content: |
      proxy_pass         http://127.0.0.1:8000;
      proxy_set_header   Host              $host;
      proxy_set_header   X-Real-IP         $remote_addr;
      proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
      proxy_set_header   X-Forwarded-Proto $scheme;
      proxy_read_timeout 30s;

  - path: /etc/nginx/sites-available/api
    content: |
      limit_req_zone $binary_remote_addr zone=auth_zone:10m rate=5r/m;
      limit_req_zone $binary_remote_addr zone=exec_zone:10m rate=10r/m;

      server {
          listen 80;
          listen [::]:80;
          server_name ${fqdn};
          client_max_body_size 1m;

          location = /signin {
              limit_req zone=auth_zone burst=5 nodelay;
              include /etc/nginx/snippets/api-proxy.conf;
          }
          location = /signup {
              limit_req zone=auth_zone burst=5 nodelay;
              include /etc/nginx/snippets/api-proxy.conf;
          }
          location = /execute {
              limit_req zone=exec_zone burst=5 nodelay;
              include /etc/nginx/snippets/api-proxy.conf;
          }
          location / {
              include /etc/nginx/snippets/api-proxy.conf;
          }
      }

  - path: /root/start-api.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      # Installs Pyker (per its README) and starts app.py. Unverified: check
      # https://github.com/mrvi0/pyker if this fails.
      export HOME=/root
      export PATH="$PATH:/root/.local/bin"
      curl -sSL https://raw.githubusercontent.com/mrvi0/pyker/main/install.py | python3
      cd /root/flask-api
      pyker start flask-api app.py --venv venv --auto-restart
      PYKER_BIN=$(command -v pyker)
      (crontab -l 2>/dev/null; echo "@reboot cd /root/flask-api && $PYKER_BIN start flask-api app.py --venv venv --auto-restart") | crontab -

runcmd:
  - git clone ${repo_url} /root/flask-api
  - mv /root/flask-api.env /root/flask-api/.env
  - python3 -m venv /root/flask-api/venv
  - /root/flask-api/venv/bin/pip install -r /root/flask-api/requirements.txt
  - ln -sf /etc/nginx/sites-available/api /etc/nginx/sites-enabled/api
  - rm -f /etc/nginx/sites-enabled/default
  - nginx -t && systemctl reload nginx
  - /root/start-api.sh
```

### `terraform/outputs.tf`
```hcl
output "droplet_ip" {
  value = digitalocean_droplet.api.ipv4_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/digital_ocean_key root@${digitalocean_droplet.api.ipv4_address}"
}

output "certbot_command" {
  value = "certbot --nginx -d ${var.fqdn}"
}

output "api_url" {
  value = "https://${var.fqdn}"
}
```
(Change `~/.ssh/digital_ocean_key` if your private key lives elsewhere.)

### `terraform/terraform.tfvars.example`  (copy to `terraform.tfvars`)
```hcl
repo_url          = "https://github.com/YOUR-USER/flask-api.git"
database_url      = "postgresql://user:password@host:5432/dbname?sslmode=require"
fqdn              = "api.example.com"
dns_zone          = "example.com"          # "" if your DNS is NOT in DigitalOcean
ssh_allowed_cidrs = ["203.0.113.7/32"]     # your own public IP; find it with: curl ifconfig.me
# ssh_key_name    = "digital_ocean_key"    # already the default
# region          = "blr1"
# size            = "s-1vcpu-1gb"
```

### Run it
```bash
cd terraform
export DIGITALOCEAN_TOKEN="dop_v1_xxxxxxxx"      # your API token (don't commit it)
cp terraform.tfvars.example terraform.tfvars && nano terraform.tfvars

terraform init          # downloads the providers
terraform validate      # syntax check
terraform plan          # shows what will be created: droplet, firewall, (DNS record)
terraform apply         # type "yes"
```
Wait ~3–5 minutes after `apply` finishes: cloud-init keeps running on the droplet after Terraform reports success. Then:

```bash
# 1. SSH in (use the ssh_command output) and check the setup finished
ssh -i ~/.ssh/digital_ocean_key root@<droplet_ip>
cloud-init status --wait            # "status: done"
pyker list                          # flask-api should be running
curl http://127.0.0.1:8000/         # {"status":"Ok"}

# 2. If you did NOT use dns_zone: create an A record  fqdn -> droplet_ip at your DNS provider, wait a few minutes

# 3. Get HTTPS (once DNS resolves to the droplet)
certbot --nginx -d api.example.com
certbot renew --dry-run

# 4. Test from your laptop with the curl commands in Section 4, Step 6
```
If something is missing, read the log: `less /var/log/cloud-init-output.log`.

### Updating and tearing down
- **New app version:** SSH in, `cd /root/flask-api && git pull && pyker restart flask-api` (Terraform is only for the infrastructure).
- **Change the firewall, size, DNS:** edit the `.tf`/`tfvars` and run `terraform apply`.
- **Delete everything:** `terraform destroy`. This removes the droplet and anything stored on it.

### Things to know
- **Secrets:** the `.env` contents are passed as droplet `user_data`, which is stored in Terraform state and readable from inside the droplet via the metadata service. Keep `terraform.tfstate` private (don't commit it), or use a remote encrypted backend for team use.
- **Managed Postgres:** if `database_url` points at a DigitalOcean managed database, add the droplet (or its IP) under the database's **Trusted Sources**, or connections will be refused.
- **Root:** this deploys as root, as you chose, so see the `/execute` warning in the security checklist.

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `KeyError: 'DATABASE_URL'` or `'JWT_SECRET_KEY'` | `.env` missing or not in the app folder. |
| `pyker list` shows stopped | `pyker logs flask-api` — usually an import error or bad `.env`. |
| `502 Bad Gateway` from Nginx | The app isn't running on port 8000. Check `pyker list` and `curl 127.0.0.1:8000`. |
| `nginx -t` fails | Typo in the config; the error gives the line number. |
| Certbot fails | DNS not pointing at the droplet yet, or port 80 blocked by `ufw`. |
| `connection refused` to database | DB firewall ("Trusted Sources" on DO managed DB) doesn't include the droplet. |
| `401` on `/me` | Missing `Authorization: Bearer ...` header, or the token expired (use `/refresh`). |
| `terraform plan` says SSH key not found | The key name in DigitalOcean must exactly match `ssh_key_name` (`digital_ocean_key`). |
| `Unable to authenticate` from Terraform | `DIGITALOCEAN_TOKEN` not exported in the same shell, or token is read-only. |
| Droplet is up but the API isn't | `cloud-init status --wait`, then `less /var/log/cloud-init-output.log`. |
| `429`/`503` on `/signin` | Nginx rate limit (5 requests/min per IP). Edit `rate=` to loosen. |

---

## 7. Security checklist

- **`/execute` is dangerous.** It runs arbitrary Python from users on your server. The 5-second timeout and empty environment help, but it is **not a sandbox**: code can still read files and use the network. For anything public, run it in Docker/nsjail or on a separate droplet with nothing valuable on it.
- Keep `.env` out of git and `chmod 600`.
- Use a long random `JWT_SECRET_KEY` (32+ bytes). Changing it logs everyone out.
- Keep the firewall on: only SSH, 80 and 443 should be open (waitress listens on localhost only).
- You are deploying as **root** (as chosen), so the app and everything it runs has full control of the server. Combined with `/execute`, a logged-in user's code runs as root. Strongly consider removing `/execute`, or at least running that subprocess as an unprivileged user.
- Use SSH keys instead of password login for root.
- Run `apt update && apt upgrade` regularly.