# Simple Flask + JWT + Neon, Deployed in Two Regions (Cloudflare DNS)

A beginner-friendly version: raw SQL, one token, no extras.

**What's in the API**

| Route | Auth | What it does |
|-------|------|--------------|
| `GET /` | none | Health check (also shows which region answered) |
| `GET /health/db` | none | Times one database query (for the latency demo) |
| `POST /auth/signup` | none | Creates a user |
| `POST /auth/login` | none | Returns a JWT |
| `GET /auth/me` | JWT | Returns the logged-in user |
| `POST /execute` | JWT | Runs Python code (your original endpoint) |

**What was removed:** refresh tokens, logout/blocklist, custom error handlers, connection pool, nginx, systemd. We run it with plain `python app.py`. A final section lists what to add later.

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


# ---------- Database helper (raw SQL) ----------
def run_sql(sql, params=(), fetch=False):
    """Open a connection, run one SQL statement, close the connection."""
    conn = None
    try:
        conn = psycopg.connect(DATABASE_URL)
        cur = conn.cursor()
        cur.execute(sql, params)          # %s placeholders = safe from SQL injection
        row = cur.fetchone() if fetch else None
        conn.commit()
        return row
    except Exception:
        if conn is not None:
            conn.rollback()
        raise                             # let the caller decide what to do
    finally:
        if conn is not None:
            conn.close()


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
    run_sql("SELECT 1")
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

    try:
        row = run_sql(
            "INSERT INTO users (name, email, password_hash) VALUES (%s, %s, %s) RETURNING id, name, email",
            (name, email.lower(), password_hash),
            fetch=True,
        )
    except psycopg.errors.UniqueViolation:
        return jsonify(error="Email already registered"), 409

    return jsonify(message="User created", user={"id": row[0], "name": row[1], "email": row[2]}), 201


@app.post("/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email") or ""
    password = data.get("password") or ""

    row = run_sql(
        "SELECT id, password_hash FROM users WHERE email = %s",
        (email.lower(),),
        fetch=True,
    )

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
    row = run_sql(
        "SELECT id, name, email FROM users WHERE id = %s",
        (user_id,),
        fetch=True,
    )
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

- **`run_sql`**: open -> execute -> commit -> close. `try/except` rolls back on error; `finally` always closes the connection.
- **`%s` placeholders**: the SQL text and the values travel separately, so a user can't turn input into SQL. Never build SQL with f-strings.

  ```python
  # BAD  (SQL injection):  f"SELECT * FROM users WHERE email = '{email}'"
  # GOOD:                  "SELECT * FROM users WHERE email = %s", (email,)
  ```
- **`create_access_token(identity=...)`**: builds and signs the token with `JWT_SECRET_KEY`.
- **`@jwt_required()`**: reads `Authorization: Bearer <token>`, checks signature and expiry, rejects the request if anything is wrong, otherwise runs the function.
- **`get_jwt_identity()`**: returns the `sub` claim. It's trustworthy because the signature was already verified.
- **One connection per request** is easy to read but slower than a pool, because every request does a new TLS handshake with Neon. That also makes `/health/db` numbers larger. Fine for learning.

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
| Auth | SSH key | SSH key |
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
ssh root@DROPLET_IP

apt update && apt install -y python3-venv git tmux

# a normal user to run the app (not root)
adduser --disabled-password --gecos "" deploy
su - deploy
```

Now, as `deploy`:

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

Go back to root and allow Python to use port 80 without being root:

```bash
exit        # back to root
setcap 'cap_net_bind_service=+ep' "$(readlink -f /home/deploy/api/venv/bin/python3)"
```

(This lets that Python binary open port 80. It's fine for a classroom demo. nginx replaces it later.)

### 7.5 Run it

```bash
su - deploy
cd api
tmux new -s api
./venv/bin/python app.py
```

Detach and leave it running: press **Ctrl+B, then D**. Come back later with `tmux attach -t api`.

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
ssh deploy@DROPLET_IP
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
| **nginx** | Reverse proxy in front of the app, so Python no longer needs port 80 |
| **gunicorn + systemd** | Production server that restarts automatically after a crash or reboot |
| **HTTPS** | Encrypted traffic, which protects tokens from being stolen on the network |
| **Refresh tokens** | Short access tokens plus a long refresh token |
| **Logout / blocklist** | Revoke a token before it expires (needs a DB table) |
| **Connection pool** | Reuse database connections to cut latency |
| **Sandboxed `/execute`** | Run user code in Docker with no network |

### Cleanup (to stop billing)

Delete the Global Load Balancer, both Droplets, the firewall, and the Cloudflare DNS records. Pause or delete the Neon project.