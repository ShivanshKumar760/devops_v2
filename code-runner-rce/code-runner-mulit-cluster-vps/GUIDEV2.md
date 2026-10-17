# Simple Flask + JWT + Neon, Deployed in Two Regions (Cloudflare DNS)

A beginner-friendly version: raw SQL written directly inside each route, one token, no extras.

**What's in the API**

| Route | Auth | What it does |
|-------|------|--------------|
| `GET /` | none | Health check (also shows which region answered) |
| `GET /health/db` | none | Times one database query (for the latency demo) |
| `POST /auth/signup` | none | Creates a user |
| `POST /auth/login` | none | Returns a JWT |
| `GET /auth/me` | JWT | Returns the logged-in user |
| `POST /execute` | JWT | Runs Python code (your original endpoint) |

**What was removed:** refresh tokens, logout/blocklist, custom error handlers, connection pool, nginx, systemd, and the `run_sql` helper function (each route now runs its own SQL). We run it with plain `python app.py`. A final section lists what to add later.

**What was added in this version:** Section 13 (creating an SSH key with a custom name) and Section 14 (every Linux command used in this guide: what it does and how to install it).

---

## Table of contents

1. [How JWT works, and why tampering fails](#1-how-jwt-works-and-why-tampering-fails)
2. [Neon database](#2-neon-database)
3. [Project files](#3-project-files)
4. [The code](#4-the-code)
5. [Test locally](#5-test-locally)
6. [Try to break the token (class demo)](#6-try-to-break-the-token-class-demo)
7. [Deploy to two Droplets](#7-deploy-to-two-droplets)
8. [Global Load Balancer + Cloudflare DNS](#8-global-load-balancer--cloudflare-dns)
9. [Updating the app](#9-updating-the-app)
10. [Test from different regions](#10-test-from-different-regions)
11. [Wireshark](#11-wireshark)
12. [What to add later](#12-what-to-add-later)
13. [Create an SSH key with a custom name](#13-create-an-ssh-key-with-a-custom-name)
14. [Linux commands explained](#14-linux-commands-explained)

---

## 1. How JWT works, and why tampering fails

### The idea

After login, the server gives the client a **token**. The client sends it with every request. The server checks the token and knows who is calling, **without looking anything up in the database**.

### A token has 3 parts

```
HEADER . PAYLOAD . SIGNATURE
```

| Part | Example (decoded) | Meaning |
|------|-------------------|---------|
| Header | `{"alg":"HS256","typ":"JWT"}` | How it was signed |
| Payload | `{"sub":"12","exp":1760000900,...}` | **sub** = user id, **exp** = expiry time |
| Signature | `HMAC-SHA256(header + "." + payload, SECRET_KEY)` | A fingerprint made with the server's secret |

The payload is only **encoded**, not encrypted. Anyone can read it (paste a token into [jwt.io](https://jwt.io)). So never put passwords in a token.

### Why changing the token doesn't work

Imagine you are user `12` and you want to be user `1`.

1. You decode the payload and change `"sub":"12"` to `"sub":"1"`.
2. You send the new token.
3. The server **recalculates** the signature from the header and payload you sent, using its secret key.
4. The new payload gives a **different** signature than the one in your token, so they don't match.
5. The server rejects the request.

You can't fix the signature yourself because making a valid one needs the **secret key**, and only the server has it.

This is the same check the server does, in plain Python:

```python
import hmac, hashlib, base64

def b64e(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

secret = "THE_SECRET_KEY"
header_and_payload = token.split(".")[0] + "." + token.split(".")[1]

expected = b64e(hmac.new(secret.encode(), header_and_payload.encode(), hashlib.sha256).digest())
real_signature = token.split(".")[2]

print(expected == real_signature)   # True only if nobody changed the token
```

**Also fails:**

- Signing a fake token with your own secret: the server's secret is different, so the signatures don't match.
- Removing the signature: the library requires one.
- Using an old token: the `exp` claim is part of the signed payload. Flask-JWT-Extended's default is **15 minutes**, and after that the server returns "Token has expired". You can't extend it without breaking the signature.

**Honest limitation:** if someone *steals* a real token, they can use it until it expires. The signature stops *forging*, not *theft*. That's why tokens are short-lived and why you should use HTTPS in real apps.

### What the server returns (library defaults)

| Situation | Status | Body |
|-----------|--------|------|
| No `Authorization` header | 401 | `{"msg":"Missing Authorization Header"}` |
| Token changed (bad signature) | 422 | `{"msg":"Signature verification failed"}` |
| Token expired | 401 | `{"msg":"Token has expired"}` |

We write no extra code for these. `@jwt_required()` handles it.

---

## 2. Neon database

1. Create a project at [neon.tech](https://neon.tech). Pick the region closest to your main users.
2. Click **Connect** and copy the connection string:

```
postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
```

3. Open **SQL Editor** and run:

```sql
CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Neon's free tier sleeps when idle, so the first request after a pause can take a couple of seconds.

---

## 3. Project files

```
auth-api/
├── app.py
├── requirements.txt
├── .env            <- secrets, never commit
└── .gitignore
```

**requirements.txt**

```
Flask==3.0.3
Flask-JWT-Extended==4.7.1
psycopg[binary]==3.2.3
python-dotenv==1.0.1
```

**.gitignore**

```
.env
venv/
__pycache__/
```

**.env** (on your laptop)

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
JWT_SECRET_KEY=PASTE_A_LONG_RANDOM_STRING
REGION=local
PORT=5000
```

Make a secret:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(64))"
```

Install:

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

---

## 4. The code

There is no helper function in this version, and no `with` blocks. Every route does the same four plain steps: connect, make a cursor, execute the SQL, close the connection.

**app.py**

```python
import os
import sys
import shutil
import tempfile
import subprocess
import time

from dotenv import load_dotenv
load_dotenv()

import psycopg
from flask import Flask, request, jsonify
from flask_jwt_extended import JWTManager, create_access_token, jwt_required, get_jwt_identity
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)

# The secret key signs every token. It must be the SAME on every server.
app.config["JWT_SECRET_KEY"] = os.environ["JWT_SECRET_KEY"]
jwt = JWTManager(app)

DATABASE_URL = os.environ["DATABASE_URL"]
REGION = os.getenv("REGION", "local")


# ---------- Tell the client which server answered ----------
@app.after_request
def add_region_header(response):
    response.headers["X-Served-By"] = REGION
    return response


# ---------- Public routes ----------
@app.get("/")
def health():
    return jsonify(status="Ok", region=REGION)


@app.get("/health/db")
def health_db():
    start = time.perf_counter()

    conn = psycopg.connect(DATABASE_URL)    # open a connection
    cur = conn.cursor()                     # a cursor runs the SQL
    cur.execute("SELECT 1")
    conn.close()                            # always close it when done

    ms = round((time.perf_counter() - start) * 1000, 1)
    return jsonify(status="Ok", region=REGION, db_ms=ms)


@app.post("/auth/signup")
def signup():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    email = data.get("email")
    password = data.get("password")

    if not name or not email or not password:
        return jsonify(error="name, email and password are required"), 400

    password_hash = generate_password_hash(password)   # never store the real password

    conn = psycopg.connect(DATABASE_URL)
    cur = conn.cursor()

    try:
        # %s placeholders = safe from SQL injection
        cur.execute(
            "INSERT INTO users (name, email, password_hash) "
            "VALUES (%s, %s, %s) RETURNING id, name, email",
            (name, email.lower(), password_hash),
        )
        row = cur.fetchone()
        conn.commit()                     # save the new user
    except psycopg.errors.UniqueViolation:
        conn.close()
        return jsonify(error="Email already registered"), 409

    conn.close()

    return jsonify(message="User created", user={"id": row[0], "name": row[1], "email": row[2]}), 201


@app.post("/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email") or ""
    password = data.get("password") or ""

    conn = psycopg.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute(
        "SELECT id, password_hash FROM users WHERE email = %s",
        (email.lower(),),
    )
    row = cur.fetchone()                  # None if no user has this email
    conn.close()

    # Same message for "no such user" and "wrong password"
    if row is None or not check_password_hash(row[1], password):
        return jsonify(error="Invalid email or password"), 401

    # Put the user id inside the token (must be a string)
    token = create_access_token(identity=str(row[0]))
    return jsonify(access_token=token)


# ---------- Protected routes ----------
@app.get("/auth/me")
@jwt_required()                       # rejects missing / tampered / expired tokens
def me():
    user_id = int(get_jwt_identity())  # the "sub" claim from the verified token

    conn = psycopg.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute(
        "SELECT id, name, email FROM users WHERE id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    conn.close()

    if row is None:
        return jsonify(error="User not found"), 404
    return jsonify(id=row[0], name=row[1], email=row[2])


@app.post("/execute")
@jwt_required()
def execute():
    data = request.get_json(silent=True) or {}
    code = data.get("code")
    if not code:
        return jsonify(error="Please provide code to run"), 400

    tmp_dir = tempfile.mkdtemp()
    try:
        script_path = os.path.join(tmp_dir, "script.py")
        f = open(script_path, "w")
        f.write(code)
        f.close()

        result = subprocess.run(
            [sys.executable, "script.py"],
            cwd=tmp_dir,
            capture_output=True,
            text=True,
            timeout=5,                          # stop infinite loops
            env={"PATH": "/usr/bin:/bin"},      # hide our DB password and JWT secret
        )
        return jsonify(message="Success", stdout=result.stdout, stderr=result.stderr)
    except subprocess.TimeoutExpired:
        return jsonify(error="Code took longer than 5 seconds"), 408
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
```

### Points to explain

- **`conn = psycopg.connect(DATABASE_URL)`**: opens a connection to Neon.
- **`cur = conn.cursor()`**: a cursor is the object that sends SQL to the database and holds the result.
- **`cur.execute(sql, params)`**: runs one SQL statement. `SELECT` queries need nothing more; `INSERT` queries also need `conn.commit()`, otherwise the change is thrown away when the connection closes.
- **`cur.fetchone()`**: returns the first row of the result, or `None` if there is none. Rows are tuples, so `row[0]` is the first column in your `SELECT`.
- **`conn.close()`**: always close the connection when the route is done, or connections pile up on Neon. In `signup` we also close it inside the `except`, because `return` would otherwise skip the close.
- **`%s` placeholders**: the SQL text and the values travel separately, so a user can't turn input into SQL. Never build SQL with f-strings.

  ```python
  # BAD  (SQL injection):  f"SELECT * FROM users WHERE email = '{email}'"
  # GOOD:                  "SELECT * FROM users WHERE email = %s", (email,)
  ```
- **`create_access_token(identity=...)`**: builds and signs the token with `JWT_SECRET_KEY`.
- **`@jwt_required()`**: reads `Authorization: Bearer <token>`, checks signature and expiry, rejects the request if anything is wrong, otherwise runs the function.
- **`get_jwt_identity()`**: returns the `sub` claim. It's trustworthy because the signature was already verified.
- **One connection per request** is easy to read but slower than a pool, because every request does a new TLS handshake with Neon. That also makes `/health/db` numbers larger. Fine for learning.
- **Trade-off of inline SQL:** it is easier to follow because everything for a route is in one place, but the connect / cursor / close lines are repeated in every route. That repetition is why bigger apps use a helper or a pool later.

> **`/execute` is dangerous.** It runs code sent by users. The 5-second timeout and hidden environment help, but they are *not* a sandbox. Anyone who signs up can run code on your server. Use it only for a short demo, and delete the Droplets afterward. For real use, run code inside Docker with no network.

---

## 5. Test locally

```bash
python app.py
```

```bash
# Sign up
curl -s -X POST http://127.0.0.1:5000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Asha","email":"asha@example.com","password":"supersecret1"}'

# Log in -> copy the access_token
curl -s -X POST http://127.0.0.1:5000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"asha@example.com","password":"supersecret1"}'

# Use the token
TOKEN="paste_token_here"
curl -s http://127.0.0.1:5000/auth/me -H "Authorization: Bearer $TOKEN"

curl -s -X POST http://127.0.0.1:5000/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"code":"print(2+2)"}'

# No token -> 401
curl -i http://127.0.0.1:5000/auth/me
```

GUI option: **Postman** -> Authorization tab -> *Bearer Token*.

Check Neon: `SELECT id, email, left(password_hash, 30) FROM users;` Students see a hash, not the password.

---

## 6. Try to break the token (class demo)

Save as **tamper.py** (standard library only):

```python
import base64, json, sys

token = sys.argv[1]
header, payload, signature = token.split(".")

def b64decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def b64encode(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

data = json.loads(b64decode(payload))
print("Original payload:", data)

data["sub"] = "1"                                  # pretend to be user 1
fake_payload = b64encode(json.dumps(data).encode())

print("\nTampered token:")
print(header + "." + fake_payload + "." + signature)   # old signature, new payload
```

```bash
python tamper.py "$TOKEN"
# copy the tampered token, then:
curl -i http://127.0.0.1:5000/auth/me -H "Authorization: Bearer <tampered token>"
# -> 422  {"msg":"Signature verification failed"}
```

Students can read the payload, and edit it, but the server still refuses it. That is the signature doing its job.

**Other experiments**

1. Paste your token at [jwt.io](https://jwt.io). Enter the wrong secret and see "invalid signature"; enter the right one and see "signature verified".
2. Set `app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(seconds=20)` (import `timedelta` from `datetime`), wait 20 seconds, and watch it expire.
3. Give a second server a *different* `JWT_SECRET_KEY` and show that a token from server A is rejected by server B.

---

## 7. Deploy to two Droplets

> Before this section, create your SSH key (with a custom name) by following [Section 13](#13-create-an-ssh-key-with-a-custom-name) and add the public key to DigitalOcean. Every `ssh`, `scp` command below can take `-i ~/.ssh/YOUR_KEY_NAME`, or you can set up `~/.ssh/config` once so you never type it. Section 14 explains every command used here.

### 7.1 Put the code on GitHub

```bash
git init && git add . && git commit -m "auth api"
git remote add origin https://github.com/YOU/auth-api.git
git push -u origin main
```

Check that `.env` is **not** in the repo.

### 7.2 Create two Droplets (DigitalOcean dashboard)

**Create -> Droplets**, twice:

| Setting | Droplet 1 | Droplet 2 |
|---------|-----------|-----------|
| Region | **Bangalore (BLR1)** | **New York (NYC1)** (or any US region) |
| Image | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |
| Size | Basic, smallest is fine | same |
| Auth | SSH key (the custom-named one from Section 13) | SSH key (same one) |
| Hostname | `api-blr1` | `api-nyc1` |
| Tag | `flask-api` | `flask-api` |

### 7.3 Firewall

**Networking -> Firewalls -> Create**. Inbound rules:

- SSH (22) from **your IP only**
- HTTP (80) from all IPv4 and IPv6

Apply it to the tag `flask-api`.

> **Why port 80?** The Global Load Balancer allows only one forwarding rule, and it can use only port 80 or 443. So the app listens on **80**.

### 7.4 Set up each server (do this on BOTH)

```bash
ssh -i ~/.ssh/do_flask_api root@DROPLET_IP      # or just: ssh root@DROPLET_IP if you use ~/.ssh/config

apt update && apt install -y python3-venv git tmux
```

You stay logged in as **root** for everything in this guide. There is no second user to create.

Now clone the code (it lands in `/root/api`):

```bash
git clone https://github.com/YOU/auth-api.git api
cd api
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
nano .env
```

Put this in `.env`. `DATABASE_URL` and `JWT_SECRET_KEY` are **identical on both servers**; only `REGION` changes:

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
JWT_SECRET_KEY=THE_SAME_SECRET_ON_BOTH_SERVERS
REGION=blr1          # use nyc1 on the US droplet
PORT=80
```

Because we are root, Python is allowed to listen on port 80 directly, so no extra permission step is needed.

> Running the app as root is fine for a short classroom demo on a Droplet you delete afterward. For anything real, run it as a normal user behind nginx (see Section 12).

### 7.5 Run it

```bash
cd ~/api
tmux new -s api
./venv/bin/python app.py
```

Detach and leave it running: press **Ctrl+B, then D**. Come back later with `tmux attach -t api`.

> **Why tmux?** A program started in a normal SSH terminal stops when you disconnect. tmux keeps a terminal alive on the server, so the app keeps answering requests after you log out. Full explanation in [14.8](#148-tmux-keep-the-app-running-after-you-disconnect).

> Without systemd, the app **won't restart** if the server reboots or the app crashes. Good enough for today. systemd comes later.

Test each Droplet directly from your laptop:

```bash
curl -i http://BLR_DROPLET_IP/
curl -i http://NYC_DROPLET_IP/
# Look for the header  X-Served-By: blr1   /   X-Served-By: nyc1
```

---

## 8. Global Load Balancer + Cloudflare DNS

The Global Load Balancer (GLB) sends each user to the **nearest healthy Droplet**. It works for HTTP/HTTPS, and you can't write per-continent rules. Asia reaching Bangalore and the US reaching New York happens naturally. Europe is closer to New York, so it will normally land there.

### 8.1 Create the GLB (DigitalOcean dashboard)

1. **Create -> Load Balancer -> Global**.
2. **CDN caching: turn it OFF.** This is an API with logins, and you don't want responses cached.
3. Name it `api-global-lb`, choose a project, and click **Create Load Balancer**.

Then, on its detail page:

4. **Add backends:** search for the tag **`flask-api`** and add it. Both Droplets join automatically. (A GLB's backends must all be Droplets or all regional load balancers, and you can't mix them.)
5. **Forwarding rule:** `HTTP` port **80** -> `HTTP` port **80** (this is the default).
6. **Health check:** HTTP, port 80, path `/`. The `/` route doesn't touch the database, so it's a cheap check.
7. Copy the GLB's **two IPv4 and two IPv6 addresses** shown on the detail page.

### 8.2 Point your Cloudflare domain at it

DigitalOcean's "Connect a Domain" wizard is for domains using DigitalOcean DNS. For Cloudflare, you add the records yourself: two A records and two AAAA records pointing to the GLB's addresses.

In **Cloudflare dashboard -> your domain -> DNS -> Records -> Add record**:

| Type | Name | Content | Proxy status | TTL |
|------|------|---------|--------------|-----|
| A | `api` | GLB IPv4 #1 | **DNS only** (grey cloud) | Auto |
| A | `api` | GLB IPv4 #2 | **DNS only** | Auto |
| AAAA | `api` | GLB IPv6 #1 | **DNS only** | Auto |
| AAAA | `api` | GLB IPv6 #2 | **DNS only** | Auto |

**Keep the cloud grey (DNS only).** If it's orange, traffic goes through Cloudflare first, and your region tests would measure Cloudflare's network instead of the GLB.

Check that DNS works (can take a few minutes):

```bash
dig +short api.yourdomain.com
curl -i http://api.yourdomain.com/
# X-Served-By: blr1   (from India)    X-Served-By: nyc1   (from the US)
```

Use **`http://`** for now. Setting up HTTPS comes later (see 8.4).

### 8.3 Failover demo

On the BLR Droplet, attach to tmux (`tmux attach -t api`) and press **Ctrl+C** to stop the app. After a few failed health checks, requests from India are answered by `nyc1`. Slower, but still working. Start it again and traffic comes back. Show students the **Insights** tab on the load balancer too.

### 8.4 HTTPS later (two options)

- **Quick:** in Cloudflare, switch the records to **Proxied** (orange) and set **SSL/TLS -> Overview -> Flexible**. Visitors get HTTPS, and Cloudflare talks to your GLB over HTTP. It's easy, but Cloudflare now sits in the middle, so "nearest region" tests will reflect Cloudflare's path to your GLB.
- **Proper:** get a free Let's Encrypt certificate (certbot with the Cloudflare DNS plugin), upload it to DigitalOcean as a custom certificate, and change the GLB rule to `HTTPS 443`. Ask me and I'll write this as the next lesson.

---

## 9. Updating the app

**Code changes** (do one server at a time, so the GLB keeps serving from the other):

```bash
ssh root@DROPLET_IP
cd ~/api
tmux attach -t api            # then press Ctrl+C to stop the app
git pull
./venv/bin/pip install -r requirements.txt     # only needed if requirements changed
./venv/bin/python app.py      # start again, then Ctrl+B, D to detach
```

Check the server is healthy (`curl http://DROPLET_IP/`), then repeat on the second Droplet.

**Changing a setting** (like `JWT_SECRET_KEY`): edit `.env` on **both** servers, then restart both. Changing the secret logs everyone out, because old tokens no longer verify.

**Changing Cloudflare DNS:** Cloudflare dashboard -> DNS -> Records -> edit or delete a record. If the GLB IPs ever change, update all four records.

**Adding a third region:** create a Droplet with the `flask-api` tag, set it up as in 7.4, and the GLB picks it up automatically.

---

## 10. Test from different regions

### Online tools (GUI, nothing to install)

- **KeyCDN Performance Test:** <https://tools.keycdn.com/performance> runs a request from about 10 locations and shows timings.
- **KeyCDN cURL test:** <https://tools.keycdn.com/curl> shows the response **headers**, so you can read `X-Served-By`.

Use `http://api.yourdomain.com/health/db` (the HTTP URL, since HTTPS isn't set up yet). If these tools change, any multi-location "ping/HTTP test" site works the same way.

Fill in a table like this:

| Test location | `X-Served-By` | Time to first byte | `db_ms` |
|---------------|---------------|--------------------|---------|
| Singapore | | | |
| Frankfurt | | | |
| New York | | | |
| San Francisco | | | |

### From your laptop

```bash
curl -s -o /dev/null -D - http://api.yourdomain.com/ | grep -i x-served-by

curl -s -o /dev/null -w "connect:%{time_connect}s  ttfb:%{time_starttransfer}s  total:%{time_total}s\n" \
  http://api.yourdomain.com/health/db
```

A VPN set to another country simulates a user there.

### What to discuss

- `/` is fast near a server and slower far away. That's network distance.
- `/health/db` adds the **server -> Neon** time. If Neon is in Asia, the New York server pays a long trip to the database. The "nearest server" isn't automatically the fastest for database routes. Ideas: read replicas, caching, a database per region.

---

## 11. Wireshark

Wireshark records packets on **your own machine**. You'll see the TCP handshake and round-trip times. You'll **not** see inside HTTPS (that's what encryption is for). Since we're using plain HTTP in this lesson, you *can* read the requests, including the `Authorization: Bearer ...` header. That's a great way to show why HTTPS matters!

### Install

Download from <https://www.wireshark.org/download.html>. On Windows accept the **Npcap** prompt. On Linux add your user to the `wireshark` group.

### Capture a request

1. Find the IP: `nslookup api.yourdomain.com`
2. Open Wireshark, enter capture filter `host <that IP>`, and double-click your Wi-Fi/Ethernet interface.
3. Run: `curl http://api.yourdomain.com/`
4. Stop the capture (red square).

Useful display filters (green bar):

| Filter | Shows |
|--------|-------|
| `tcp.flags.syn == 1` | Start of the handshake (SYN, SYN-ACK) |
| `http` | The request and response in plain text |
| `http.request.method == "POST"` | Login/signup requests (the body is visible!) |
| `tcp.analysis.initial_rtt` | Handshake round-trip time |

The time from SYN to SYN-ACK is about one network round trip. It's small to a nearby region and large to a far one. Capture from different networks or a VPN and compare.

Handy menus: **Statistics -> Conversations**, **Statistics -> Flow Graph**, and (right-click a packet) **Follow -> TCP Stream**.

### Trace the route

Traceroute sends packets with a growing TTL (1, 2, 3, ...). Each router that reduces TTL to 0 replies "ICMP Time Exceeded", which reveals its address.

Capture, then run:

```bash
tracert api.yourdomain.com            # Windows
traceroute -n api.yourdomain.com      # macOS / Linux
mtr -rwzc 20 api.yourdomain.com       # per-hop loss and latency (needs mtr installed)
```

Filter: `icmp.type == 11 || icmp.type == 0 || udp`. Each Time Exceeded reply comes from a different router. A row of `* * *` just means that router ignores probes.

If probes get blocked, use `sudo traceroute -T -p 80 -n api.yourdomain.com`.

### Compare two locations

Run `mtr` from your laptop and from a Droplet in a different region. The last hops and total time differ, because the same address is reached through a nearby entry point from each place. Pair it with the `X-Served-By` header to show which server finally answered.

### Capture on the server

```bash
sudo tcpdump -i eth0 -nn port 80 -w /tmp/blr.pcap     # Ctrl+C when done
scp root@BLR_DROPLET_IP:/tmp/blr.pcap .               # open in Wireshark
```

Requests from India show up only in the BLR capture, and requests from the US only in the NYC capture.

---

## 12. What to add later

| Next lesson | What it adds |
|-------------|--------------|
| **Non-root user** | Run the app as a normal user instead of root, so a hacked app can't control the whole server |
| **nginx** | Reverse proxy in front of the app, so Python no longer needs port 80 |
| **gunicorn + systemd** | Production server that restarts automatically after a crash or reboot |
| **HTTPS** | Encrypted traffic, which protects tokens from being stolen on the network |
| **Refresh tokens** | Short access tokens plus a long refresh token |
| **Logout / blocklist** | Revoke a token before it expires (needs a DB table) |
| **Connection pool** | Reuse database connections to cut latency (also removes the repeated `psycopg.connect` line from every route) |
| **Sandboxed `/execute`** | Run user code in Docker with no network |

### Cleanup (to stop billing)

Delete the Global Load Balancer, both Droplets, the firewall, and the Cloudflare DNS records. Pause or delete the Neon project.

---

## 13. Create an SSH key with a custom name

An SSH key is a pair of files. The **private key** stays on your laptop and is never shared. The **public key** (ends in `.pub`) is copied to servers. When you connect, the server uses the public key to check that you hold the matching private key, so no password is needed.

By default `ssh-keygen` names the key `id_ed25519`. That is a problem if you already have a key for GitHub or work, because it would ask to overwrite it. Giving the key its own name keeps them separate.

### 13.1 Is SSH installed?

```bash
ssh -V
```

If you see a version number, you have it. If not:

| System | Install |
|--------|---------|
| Windows 10/11 | **Settings -> System -> Optional features -> Add a feature -> OpenSSH Client**. Or in an admin PowerShell: `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0` |
| macOS | Already installed |
| Ubuntu / Debian | `sudo apt update && sudo apt install -y openssh-client` |

### 13.2 Generate the key

macOS / Linux / Git Bash:

```bash
ssh-keygen -t ed25519 -C "flask-api-droplets" -f ~/.ssh/do_flask_api
```

Windows PowerShell:

```powershell
ssh-keygen -t ed25519 -C "flask-api-droplets" -f $env:USERPROFILE\.ssh\do_flask_api
```

What each part means:

| Part | Meaning |
|------|---------|
| `-t ed25519` | Key type. Ed25519 is modern, short and secure. (Use `-t rsa -b 4096` only for very old systems.) |
| `-C "flask-api-droplets"` | A comment label stored inside the public key, so you can recognise it later |
| `-f ~/.ssh/do_flask_api` | **The file name.** Change `do_flask_api` to any name you like |

It then asks for a **passphrase**. A passphrase encrypts the private key on disk, so a stolen laptop does not mean a stolen key. Press Enter twice to skip it for a classroom demo, but use one for real work.

This creates two files:

```
~/.ssh/do_flask_api          <- PRIVATE key (never share, never upload)
~/.ssh/do_flask_api.pub      <- PUBLIC key (safe to share)
```

If the `.ssh` folder does not exist, create it first: `mkdir -p ~/.ssh && chmod 700 ~/.ssh`.

### 13.3 Add the public key to DigitalOcean

Show the public key and copy the whole line:

```bash
cat ~/.ssh/do_flask_api.pub          # Windows PowerShell: type $env:USERPROFILE\.ssh\do_flask_api.pub
```

In DigitalOcean: **Settings -> Security -> SSH Keys -> Add SSH Key**. Paste the line, give it a name, and save. When you create the Droplets (7.2), tick this key under **Authentication**.

### 13.4 Connect using the custom key

Because the file is not named `id_ed25519`, SSH will not find it on its own. Tell it which key to use with `-i`:

```bash
ssh -i ~/.ssh/do_flask_api root@DROPLET_IP
scp -i ~/.ssh/do_flask_api root@DROPLET_IP:/tmp/blr.pcap .
```

### 13.5 Better: save it in `~/.ssh/config`

So you never type `-i` or the IP again, create or edit the file `~/.ssh/config`:

```
Host api-blr1
    HostName BLR_DROPLET_IP
    User root
    IdentityFile ~/.ssh/do_flask_api
    IdentitiesOnly yes

Host api-nyc1
    HostName NYC_DROPLET_IP
    User root
    IdentityFile ~/.ssh/do_flask_api
    IdentitiesOnly yes
```

Now connect with just:

```bash
ssh api-blr1
ssh api-nyc1
```

`IdentitiesOnly yes` tells SSH to use only this key instead of trying every key it has.

### 13.6 Optional: load the key into ssh-agent

If you set a passphrase, the agent remembers it so you type it once per session:

```bash
eval "$(ssh-agent -s)"                 # start the agent
ssh-add ~/.ssh/do_flask_api            # add your key (asks for the passphrase)
ssh-add -l                             # list loaded keys
```

On Windows PowerShell (admin): `Get-Service ssh-agent | Set-Service -StartupType Manual; Start-Service ssh-agent`, then `ssh-add $env:USERPROFILE\.ssh\do_flask_api`.

### 13.7 Fixing "permissions are too open"

SSH refuses a private key that other users can read. On macOS/Linux:

```bash
chmod 600 ~/.ssh/do_flask_api
chmod 700 ~/.ssh
```

### 13.8 Lost the key, or want to stop using it

- Delete the public key in DigitalOcean (**Settings -> Security**). This does not remove it from existing Droplets.
- To remove it from a server, delete its line from `~/.ssh/authorized_keys` on that server.
- Remove it locally: `rm ~/.ssh/do_flask_api ~/.ssh/do_flask_api.pub`.

---

## 14. Linux commands explained

Where it says "install", the command is for Ubuntu/Debian (what the Droplets run). Most commands on the Droplets are already there; the installs happen in step 7.4. Everything on the Droplets runs as root.

> **Reading the symbols:** `#` starts a comment. `&&` means "run the next command only if the first one worked". `\` at the end of a line continues the command on the next line. `$(...)` runs a command and pastes its output. `sudo` means "run as administrator"; you are already root on a fresh Droplet, so you don't need it there.

### 14.1 Quick reference

| Command | What it does | Installed? |
|---------|--------------|------------|
| `ssh` | Log in to a remote server | Built in (see 13.1) |
| `ssh-keygen` | Create SSH key pairs | Comes with ssh |
| `scp` | Copy files over SSH | Comes with ssh |
| `apt` | Install and update software on Ubuntu | Built in |
| `git` | Download and track code | `apt install git` |
| `tmux` | Keep programs running after you disconnect | `apt install tmux` |
| `exit` | Leave the current shell/user | Built in |
| `cd`, `ls`, `cat`, `mkdir`, `rm` | Move around, list, read, create, delete | Built in |
| `nano` | Simple text editor | Built in on Ubuntu |
| `python3 -m venv` | Create an isolated Python environment | `apt install python3-venv` |
| `pip` | Install Python packages | Inside the venv |
| `chmod` | Change file permissions | Built in |
| `curl` | Send HTTP requests from the terminal | `apt install curl` |
| `dig`, `nslookup` | Look up DNS records | `apt install dnsutils` |
| `traceroute` | Show the network path to a host | `apt install traceroute` |
| `mtr` | Traceroute plus live loss/latency stats | `apt install mtr-tiny` |
| `tcpdump` | Record network packets | `apt install tcpdump` |
| `grep` | Filter text for a word | Built in |

### 14.2 Connecting and copying

**`ssh`** logs in to another computer and gives you a terminal on it.

```bash
ssh root@DROPLET_IP                       # user "root" on that IP
ssh -i ~/.ssh/do_flask_api root@IP        # use a specific key file (see Section 13)
ssh api-blr1                              # use a saved name from ~/.ssh/config
```

**`scp`** copies a file between your laptop and a server, over SSH.

```bash
scp root@BLR_DROPLET_IP:/tmp/blr.pcap .   # server -> here ("." means current folder)
scp ./file.txt root@IP:/root/              # here -> server
```

Add `-i ~/.ssh/KEY_NAME` if your key has a custom name.

### 14.3 Installing software on the Droplet

```bash
apt update && apt install -y python3-venv git tmux
```

| Part | Meaning |
|------|---------|
| `apt update` | Refreshes the list of available packages. Run this before installing. |
| `apt install` | Downloads and installs packages. |
| `-y` | Answers "yes" to the confirmation question automatically. |
| `python3-venv` | The module that makes virtual environments. Ubuntu ships Python without it. |
| `git` | Version control, used to `git clone` your code onto the server. |
| `tmux` | A terminal that keeps running after you close SSH (see below). |

Remove a package: `apt remove tmux`. Upgrade everything: `apt upgrade -y`.

On your laptop: macOS uses `brew install git tmux` (get Homebrew from <https://brew.sh>). Windows: install Git from <https://git-scm.com/download/win>; for Linux commands use WSL (`wsl --install` in PowerShell) or Git Bash.

### 14.4 Logging in as root and leaving

On a fresh Droplet, `ssh root@DROPLET_IP` logs you in as **root**, the administrator account that can do anything. This guide does everything as root, so there are no extra users to create or switch between.

```bash
whoami        # prints "root"
pwd           # prints "/root", your home folder
exit          # leave the server (closes the SSH connection)
```

| Command | Meaning |
|---------|---------|
| `whoami` | Prints which user you are logged in as. |
| `pwd` | Prints the folder you are currently in. Root's home folder is `/root`, which is where `git clone` puts `api/`. |
| `exit` | Closes the SSH session and returns you to your laptop's terminal. |

Because you are root, you don't need `sudo` in front of commands on the Droplet, and Python can listen on port 80 without any special setup.

**Trade-off:** root can read and change anything, so if the app were ever hacked, the attacker would own the whole server. That is why `/execute` must only run on a throwaway demo Droplet, and why a real deployment uses a normal user (listed in Section 12).

### 14.5 Files, folders and permissions

```bash
cd api                  # change directory into "api"
cd ..                   # go up one folder
ls -la                  # list files, including hidden ones, with details
cat ~/.ssh/key.pub      # print a file's contents
mkdir -p ~/.ssh         # make a folder (-p = no error if it already exists)
rm file.txt             # delete a file (no recycle bin!)
rm -r folder            # delete a folder and everything in it
nano .env               # open a simple text editor
```

In **nano**: type normally, **Ctrl+O** then Enter to save, **Ctrl+X** to exit.

**`~`** is shorthand for your home folder. **`.`** means the current folder.

**`chmod`** changes who may read, write or run a file. Numbers: 4 = read, 2 = write, 1 = run; add them. Three digits = owner, group, everyone.

```bash
chmod 600 ~/.ssh/do_flask_api    # owner can read+write, nobody else can do anything
chmod 700 ~/.ssh                 # owner full access, nobody else
```

### 14.6 Git commands

```bash
git init                                  # turn the current folder into a git repository
git add .                                 # stage all files for the next commit
git commit -m "auth api"                  # save a snapshot with a message
git remote add origin https://github.com/YOU/auth-api.git   # name the GitHub address "origin"
git push -u origin main                   # upload the main branch to GitHub
git clone https://github.com/YOU/auth-api.git api           # download the repo into a folder called "api"
git pull                                  # download new commits and update your files
```

Install on Windows/macOS/Linux: <https://git-scm.com/downloads>, or `apt install git` on Ubuntu. The first time you commit, set your identity: `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.

### 14.7 Python environment

```bash
python3 -m venv venv                          # create a virtual environment in a folder called "venv"
source venv/bin/activate                      # "turn it on" (Windows: venv\Scripts\activate)
pip install -r requirements.txt               # install every package listed in the file
./venv/bin/pip install -r requirements.txt    # same, without activating: call that venv's pip directly
./venv/bin/python app.py                      # run the app with that venv's Python
```

A **virtual environment** keeps this project's packages separate from the system's Python, so installs don't break each other. On the Droplet we skip `activate` and call `./venv/bin/python` directly, which is simpler and works in scripts and tmux.

### 14.8 tmux: keep the app running after you disconnect

**What it is:** `tmux` (terminal multiplexer) creates a terminal session that lives **on the server**, not inside your SSH connection. You can leave it and come back later, and whatever is running inside keeps running.

**The problem it solves in this guide:** we start the app with `./venv/bin/python app.py`. That command runs in the **foreground**: it only lives as long as your terminal does. Without tmux:

1. You SSH into the Droplet and run `python app.py`. It works.
2. You close your laptop, lose Wi-Fi, or type `exit`.
3. The SSH connection drops, the server closes your terminal, and **the app is killed**.
4. The load balancer's health check fails and the Droplet stops receiving traffic.

With tmux, the app runs inside a session that does not care whether you are connected. Step 3 never happens.

**Why it's important here:**

- The Droplets must answer requests **all day**, not just while you have a terminal open. The Global Load Balancer depends on `/` responding.
- It lets you **log out and back in** to check logs, update code (Section 9) or stop the app for the failover demo (8.3), by re-attaching to the same session.
- It is the simplest "keep it running" tool: nothing to configure, one command to install. It is a stand-in until we add **systemd**, which also restarts the app after crashes and reboots (see Section 12). tmux does **not** do that: if the server reboots, you must start the session again yourself.

**Commands:**

```bash
tmux new -s api          # create a session named "api" and enter it
./venv/bin/python app.py # start the app inside it
# Press Ctrl+B, release, then press D   -> detach (app keeps running, you return to a normal shell)
tmux ls                  # list sessions that are running
tmux attach -t api       # reconnect to the "api" session (see the app's output again)
# inside the session: Ctrl+C stops the app
tmux kill-session -t api # remove the session completely
```

The key combo is **Ctrl+B** (the "prefix"), let go, **then** the next key. `-s api` gives the session a name; `-t api` means "target the session called api". Install: `apt install -y tmux`.

**Simple picture:** closing SSH without tmux is like hanging up the phone on someone mid-sentence. tmux is leaving the call running in the other room and picking it up again later.

### 14.9 Network and testing commands

**`curl`** sends web requests from the terminal.

```bash
curl http://IP/                                        # GET and print the body
curl -i http://IP/                                     # -i also shows response headers
curl -s http://IP/                                     # -s silent: hides the progress bar
curl -X POST URL -H "Content-Type: application/json" -d '{"a":1}'
                                                       # -X method, -H header, -d body
curl -s -o /dev/null -D - URL                          # -o /dev/null hides the body, -D - prints headers
curl -w "ttfb:%{time_starttransfer}s\n" URL            # -w prints timings after the request
```

Install: `apt install curl` (Ubuntu), already on macOS and Windows 10+.

**`grep`** shows only lines that match a word. `... | grep -i x-served-by` keeps just the header line (`-i` ignores upper/lower case). The `|` (pipe) sends one command's output into the next.

**`dig` and `nslookup`** ask DNS which IP addresses a name points to.

```bash
dig +short api.yourdomain.com       # just the IP addresses
nslookup api.yourdomain.com         # friendlier output, works on Windows too
```

Install `dig`: `apt install dnsutils` (Ubuntu) or `brew install bind` (macOS). `nslookup` is already on Windows.

**`traceroute` / `tracert`** lists every router between you and the target. `-n` skips name lookups (faster); `-T -p 80` uses TCP port 80 in case normal probes are blocked. Install: `apt install traceroute`. Windows uses the built-in `tracert`; macOS has `traceroute` built in.

**`mtr`** is traceroute that keeps running and shows packet loss and delay per hop.

```bash
mtr -rwzc 20 api.yourdomain.com
```

`-r` report mode (print and exit), `-w` wide output, `-z` show AS numbers, `-c 20` send 20 probes. Install: `apt install mtr-tiny`, macOS `brew install mtr`.

**`tcpdump`** records packets on a server.

```bash
sudo tcpdump -i eth0 -nn port 80 -w /tmp/blr.pcap
```

`-i eth0` which network interface, `-nn` don't convert numbers to names, `port 80` only HTTP traffic, `-w FILE` save to a file you can open in Wireshark. Stop with **Ctrl+C**. Install: `apt install tcpdump`. If `eth0` isn't your interface name, list them with `ip a`.

### 14.10 Handy extra commands for this setup

```bash
ss -tlnp | grep :80          # is something listening on port 80? which process?
ps aux | grep app.py         # is the app process running?
pwd                          # print the folder you are currently in
whoami                       # which user am I?
history                      # recent commands you typed
```

Press **Ctrl+C** to stop a running program, **Ctrl+L** to clear the screen, and **Tab** to auto-complete file names.