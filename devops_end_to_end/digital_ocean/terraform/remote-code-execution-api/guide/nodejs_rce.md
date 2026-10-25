# Express + TypeScript + Prisma + JWT API — Complete Beginner's DevOps Guide

Build an **Express** API in **TypeScript** with a **single `server.ts`**, **Prisma** (type-safe database access) and **JWT** login, then deploy it on a **DigitalOcean droplet** using **pm2** (process manager), **Nginx** (web server), **Certbot** (free HTTPS) and optionally **Terraform** (create the server with code).

This is the Node.js version of the Flask + dataset guide. Everything is in this one file: explanations, every file's full code, and every command.

---

## 0. The big picture

```
Browser / curl
     │  HTTPS (port 443)
     ▼
  Nginx  ──────────►  Node.js + Express (127.0.0.1:8000)  ──►  PostgreSQL
 (public, TLS             ▲   (src/server.ts → dist/server.js)     ▲
  from Certbot)           │ kept alive by pm2                      │ via Prisma
```

| Piece | Job in plain words |
|---|---|
| **Express** | The web framework: your routes (`/signup`, `/signin`, ...). |
| **TypeScript** | JavaScript with types; catches mistakes before you run the code. |
| **Prisma** | Talks to the database using typed JavaScript calls instead of SQL strings. |
| **jsonwebtoken** | After login, gives the user a signed token (JWT). They send it back to prove who they are. |
| **bcryptjs** | Hashes passwords so the real password is never stored. |
| **pm2** | Starts your app in the background, restarts it if it crashes, keeps logs, restarts it on reboot. |
| **Nginx** | Sits in front, handles HTTPS and rate limits, and forwards requests to Express. |
| **Certbot** | Gets and renews a free Let's Encrypt HTTPS certificate. |
| **Terraform** | (Optional) Creates the droplet + firewall + DNS record from code. |

> **Versions this guide uses:** Node.js **22.18+** (24 recommended), Express **5**, Prisma **7**. Prisma 7 is pinned (`prisma@7`, `@prisma/client@7`) because Prisma 8 was still a release candidate when this was written.

---

## 1. Project layout

Your whole API is **one file**: `src/server.ts`.

```
express-api/
├── src/
│   └── server.ts            # the ONLY file with application code
├── prisma/
│   ├── schema.prisma        # describes your database tables
│   └── migrations/          # SQL history, created by `prisma migrate dev` (commit it)
├── prisma.config.ts         # tells the Prisma CLI where the schema and database are
├── ecosystem.config.cjs     # pm2 settings
├── tsconfig.json
├── package.json
├── .env.example             # copy to .env and fill in
├── .gitignore
└── deploy/
    ├── nginx-api.conf       # goes to /etc/nginx/sites-available/api
    └── api-proxy.conf       # goes to /etc/nginx/snippets/api-proxy.conf
```
`src/generated/` is created by `prisma generate` and is **not** committed.

---

## 2. Set up the whole project from zero

Needs Node.js 22.18+ on your computer (<https://nodejs.org>) and a PostgreSQL database URL.

```bash
mkdir express-api && cd express-api
mkdir -p src prisma deploy
npm init -y

# runtime packages
npm install express @prisma/client@7 @prisma/adapter-pg pg dotenv jsonwebtoken bcryptjs

# development-only packages (compiler, types, Prisma CLI, dev runner)
npm install -D typescript tsx prisma@7 @types/node @types/express @types/jsonwebtoken @types/pg
```

Now create the files from Section 4 (copy each one in), in this order:

1. Replace the generated `package.json` with the one below (keep the dependency versions npm wrote; only the top part changes: `"type"`, `"scripts"`, `"engines"`).
2. `tsconfig.json`, `prisma.config.ts`, `prisma/schema.prisma`
3. `.env.example` → `cp .env.example .env` and fill it in
4. `src/server.ts`
5. `ecosystem.config.cjs`, `.gitignore`

Then follow Section 3 (Prisma) to create the table and generate the client, and run it:

```bash
npm run dev          # auto-restarting dev server (tsx watch)
curl http://127.0.0.1:8000/     # → {"status":"Ok"}
```

For production the commands are `npm run build` (generates the Prisma client and compiles TypeScript into `dist/`) and `npm start` (runs `dist/server.js`). pm2 does that for you on the server (Section 5).

---

## 3. Prisma, step by step

### 3.1 What Prisma is
Prisma has three parts:

| Part | What it is | You touch it with |
|---|---|---|
| **Schema** | `prisma/schema.prisma`: one place describing your tables as `model`s. | your editor |
| **Prisma CLI** | The `prisma` command: creates migrations, applies them, generates the client. | `npx prisma ...` |
| **Prisma Client** | Auto-generated, fully typed code (`prisma.user.create(...)`) that runs SQL for you. | `import` in `server.ts` |

Unlike a "dataset"-style library, Prisma is **schema-first**: you define columns once, the database is changed only through migrations, and TypeScript knows exactly which fields exist. A typo like `prisma.user.findUnique({ where: { nmae } })` is a compile error, not a surprise at runtime.

### 3.2 The files Prisma needs

**`prisma/schema.prisma`** defines the client generator, the database type, and your tables (`model User` ↔ table `users_test`, matching the table used in the Flask guide). The connection URL is *not* here; in Prisma 7 it lives in `prisma.config.ts`.

**`prisma.config.ts`** is read by the CLI: where the schema is, where migrations go, and which `DATABASE_URL` to use.

**`.env`** holds `DATABASE_URL`. Examples:
```bash
# local Postgres
DATABASE_URL="postgresql://postgres:secret@localhost:5432/mydb"
# DigitalOcean managed Postgres (needs sslmode=require)
DATABASE_URL="postgresql://doadmin:password@host.db.ondigitalocean.com:25060/defaultdb?sslmode=require"
```

All three files are in Section 4.

### 3.3 Create the table (pick ONE path)

**Path A: new, empty database (recommended for beginners)**
```bash
npx prisma migrate dev --name init
```
This (1) compares your schema with the database, (2) writes `prisma/migrations/<timestamp>_init/migration.sql`, and (3) runs it. **It does not generate the client in Prisma 7**, so run this right after:
```bash
npx prisma generate     # creates src/generated/prisma/client.ts
```
**Commit the `prisma/migrations` folder** because the server uses it.

**Path B: the table already exists (e.g. from the Flask version)**
Tell Prisma the table is already there ("baselining") so it doesn't try to create it again:
```bash
# 1. Make sure schema.prisma matches the real table (compare columns/types).
#    Or generate the schema FROM the database:  npx prisma db pull
# 2. Create a migration that represents the current state, without running it:
mkdir -p prisma/migrations/0_init
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql
# 3. Mark it as already applied:
npx prisma migrate resolve --applied 0_init
npx prisma generate
```
(Flag names for `migrate diff` have changed between Prisma versions; if one is rejected, run `npx prisma migrate diff --help`.) Existing rows created by the Flask app have Python-style password hashes that **bcrypt cannot verify**, so delete them and sign up again.

### 3.4 The commands you will use

| Command | When | What it does |
|---|---|---|
| `npx prisma migrate dev --name add_email` | on your laptop, after editing `schema.prisma` | creates + runs a migration (then run `npx prisma generate` yourself) |
| `npx prisma migrate deploy` | on the server / CI | applies committed migrations only; never prompts, never resets |
| `npx prisma generate` | after install, or after the schema changes | rebuilds the typed client into `src/generated/prisma` |
| `npx prisma studio` | on your laptop | opens a web UI to browse/edit rows |
| `npx prisma db pull` | existing database | writes `schema.prisma` from the database |
| `npx prisma migrate status` | any time | shows which migrations are applied |

> Never run `migrate dev` or `migrate reset` against your production database. Production uses `migrate deploy` only.

**Typical change workflow:** edit `schema.prisma` → `npx prisma migrate dev --name what_changed` → `npx prisma generate` → commit → on the server `git pull && npm ci && npm run build && npx prisma migrate deploy && pm2 reload express-api`.

### 3.5 Using the client (and the SQL behind it)

In `server.ts` the client is created once (Prisma 7 uses a small *driver adapter* for Postgres):
```ts
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});
```

| Prisma code | SQL it runs |
|---|---|
| `prisma.user.create({ data: { name, password } })` | `INSERT INTO users_test (name, password) VALUES ($1,$2) RETURNING *` |
| `prisma.user.findUnique({ where: { name: "a" } })` | `SELECT * FROM users_test WHERE name = 'a' LIMIT 1` (field must be `@id` or `@unique`) |
| `prisma.user.findFirst({ where: { name: { startsWith: "a" } } })` | `... WHERE name LIKE 'a%' LIMIT 1` |
| `prisma.user.findMany({ where: { id: { in: [1,3,7] } } })` | `... WHERE id IN (1,3,7)` |
| `prisma.user.findMany({ where: { id: { gte: 18 } }, orderBy: { id: "desc" }, take: 10, skip: 20 })` | `... WHERE id>=18 ORDER BY id DESC LIMIT 10 OFFSET 20` |
| `prisma.user.findUnique({ where: { id }, select: { id: true, name: true } })` | `SELECT id, name FROM users_test WHERE id = $1` |
| `prisma.user.update({ where: { id: 5 }, data: { name: "b" } })` | `UPDATE users_test SET name='b' WHERE id=5 RETURNING *` |
| `prisma.user.upsert({ where: { name }, update: {...}, create: {...} })` | insert, or update if it exists |
| `prisma.user.delete({ where: { id: 5 } })` | `DELETE FROM users_test WHERE id=5` |
| `prisma.user.count()` | `SELECT COUNT(*) FROM users_test` |
| `prisma.$transaction([a, b])` | `BEGIN` … `COMMIT` (or `ROLLBACK` if any fails) |
| ``prisma.$queryRaw`SELECT * FROM users_test WHERE id = ${id}` `` | raw SQL escape hatch; `${id}` is sent as a safe parameter, not pasted into the string |

**Things to know**
1. **Types are generated.** After changing `schema.prisma`, run `npx prisma generate` (`migrate dev` does not do it in Prisma 7) or TypeScript won't see your changes.
2. **Errors have codes.** Duplicate value in a `@unique` column → `P2002` (used in `/signup` to return 409). Record not found on `update`/`delete` → `P2025`.
3. **Create the client once.** One `new PrismaClient()` per process (like in `server.ts`); it manages its own connection pool. Creating one per request exhausts database connections.
4. **`findUnique` returns `null`** if nothing matches; `findMany` returns `[]`.
5. **Never `select` the password hash** into responses (see `/me`).

### 3.6 Common Prisma errors

| Error | Meaning / fix |
|---|---|
| `Cannot find module './generated/prisma/client.js'` | You haven't run `npx prisma generate` yet (or `npm run build`). |
| `Missing environment variable: DATABASE_URL` / `datasource.url` error | `.env` missing, or you ran the command from the wrong folder. |
| `P1001: Can't reach database server` | Wrong host/port, or the database firewall ("Trusted Sources" on DO) doesn't include your IP/droplet. |
| `P1000: Authentication failed` | Wrong username/password in `DATABASE_URL`. |
| `P3005: The database schema is not empty` | The database already has tables: use **Path B** (baseline). |
| `P2002: Unique constraint failed` | You tried to insert a duplicate in a `@unique` column. |

---

## 4. All the code

### `package.json`
```json
{
  "name": "express-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "prisma generate && tsc",
    "start": "node dist/server.js",
    "migrate:dev": "prisma migrate dev",
    "migrate:deploy": "prisma migrate deploy"
  },
  "engines": {
    "node": ">=22.18"
  }
}
```
Your file also has a `dependencies` and `devDependencies` section written by `npm install`; keep those.

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

### `prisma/schema.prisma`
```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model User {
  id       Int    @id @default(autoincrement())
  name     String @unique @db.VarChar(80)
  password String @db.VarChar(255)

  @@map("users_test")
}
```
Starting a brand-new project? Rename the model to your own table and delete the `@@map` line (then the table is just called `User`).

### `prisma.config.ts`
```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
```

### `.env.example`  (copy to `.env`, never commit `.env`)
```bash
# Generate the secret with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=change-me
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
PORT=8000
```

### `.gitignore`
```text
node_modules/
dist/
.env
src/generated/
```

### `src/server.ts`  — the whole API
```ts
import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import express, { type NextFunction, type Request, type Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";

import { Prisma, PrismaClient } from "./generated/prisma/client.js";

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------ config
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

const JWT_SECRET = requireEnv("JWT_SECRET");
const DATABASE_URL = requireEnv("DATABASE_URL");
const PORT = Number(process.env.PORT ?? 8000);
const HOST = "127.0.0.1"; // localhost only; Nginx is the public face
const ACCESS_TTL = "30m";
const REFRESH_TTL = "7d";

// ------------------------------------------------------------------ database
// Prisma 7 talks to Postgres through a driver adapter (the `pg` package).
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

// ------------------------------------------------------------------ auth helpers
type TokenType = "access" | "refresh";

function signToken(userId: number, type: TokenType): string {
  return jwt.sign({ type }, JWT_SECRET, {
    subject: String(userId),
    expiresIn: type === "access" ? ACCESS_TTL : REFRESH_TTL,
  });
}

function verifyToken(token: string, type: TokenType): JwtPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload === "string" || payload.type !== type) return null;
    return payload;
  } catch {
    return null; // expired, tampered, malformed ...
  }
}

// Express request with the logged-in user's id attached by requireAuth
type AuthedRequest = Request & { userId: number };

function requireAuth(type: TokenType = "access") {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = token ? verifyToken(token, type) : null;
    if (!payload?.sub) {
      res.status(401).json({ error: "missing or invalid token" });
      return;
    }
    (req as AuthedRequest).userId = Number(payload.sub);
    next();
  };
}

function readCredentials(req: Request): { name: string; password: string } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    password: typeof body.password === "string" ? body.password : "",
  };
}

// ------------------------------------------------------------------ app
const app = express();
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => {
  res.json({ status: "Ok" });
});

app.post("/signup", async (req, res) => {
  const { name, password } = readCredentials(req);
  if (!name || !password || name.length > 80) {
    res.status(400).json({ error: "name (max 80 chars) and password are required" });
    return;
  }

  try {
    // INSERT INTO users_test (name, password) VALUES (...) RETURNING *
    const user = await prisma.user.create({
      data: { name, password: await bcrypt.hash(password, 10) },
    });
    res.status(201).json({ message: "signup success", id: user.id });
  } catch (err) {
    // P2002 = unique constraint violation (name already taken)
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "user already exists" });
      return;
    }
    throw err;
  }
});

app.post("/signin", async (req, res) => {
  const { name, password } = readCredentials(req);

  // SELECT * FROM users_test WHERE name = $1 LIMIT 1
  const user = await prisma.user.findUnique({ where: { name } });

  // Same error for "no such user" and "wrong password" -> no user enumeration
  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  res.json({
    access_token: signToken(user.id, "access"),
    refresh_token: signToken(user.id, "refresh"),
  });
});

app.post("/refresh", requireAuth("refresh"), (req, res) => {
  res.json({ access_token: signToken((req as AuthedRequest).userId, "access") });
});

app.get("/me", requireAuth(), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: (req as AuthedRequest).userId },
    select: { id: true, name: true }, // never select the password hash
  });
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json(user);
});

// WARNING: runs user-supplied JavaScript on your server. See the security notes.
app.post("/execute", requireAuth(), async (req, res) => {
  const code = (req.body as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string" || !code) {
    res.status(400).json({ error: "Please provide code to run" });
    return;
  }
  if (code.length > 20_000) {
    res.status(413).json({ error: "code too large" });
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "run-"));
  try {
    await writeFile(join(dir, "script.js"), code);
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, ["script.js"], {
        cwd: dir,
        timeout: 5000, // kill infinite loops
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin" }, // do NOT leak DATABASE_URL / JWT_SECRET
      });
      res.json({
        message: "Success",
        stdout: stdout.slice(0, 10_000),
        stderr: stderr.slice(0, 10_000),
        returncode: 0,
      });
    } catch (err) {
      const e = err as { killed?: boolean; code?: number | string; stdout?: string; stderr?: string };
      if (e.killed) {
        res.status(408).json({ error: "execution timed out (5s)" });
        return;
      }
      // the script ran but exited non-zero (e.g. it threw an error)
      res.json({
        message: "Success",
        stdout: (e.stdout ?? "").slice(0, 10_000),
        stderr: (e.stderr ?? "").slice(0, 10_000),
        returncode: typeof e.code === "number" ? e.code : 1,
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Anything thrown inside a route lands here (Express 5 forwards async errors automatically)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ------------------------------------------------------------------ start + graceful shutdown
const server = app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force-exit if connections hang
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
```

### `ecosystem.config.cjs`  — pm2 settings
```js
// pm2 config (.cjs because package.json has "type": "module")
module.exports = {
  apps: [
    {
      name: "express-api",
      script: "dist/server.js",
      cwd: __dirname,          // so dotenv finds .env next to this file
      instances: 1,            // "max" = one per CPU core (cluster mode)
      exec_mode: "fork",       // use "cluster" together with instances: "max"
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
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

### How the code works
- **Passwords:** `bcrypt.hash(password, 10)` stores a salted hash; `bcrypt.compare(plain, hash)` verifies it.
- **JWT:** `/signin` returns an *access token* (30 min) and a *refresh token* (7 days). The client sends `Authorization: Bearer <access_token>` on protected routes. When it expires, call `/refresh` with the refresh token. The `type` claim stops someone using a refresh token as an access token.
- **Express 5** forwards errors thrown inside `async` routes to the error handler automatically, so there is no `try/catch` boilerplate.
- **Graceful shutdown:** on `SIGTERM`/`SIGINT` (what pm2 sends on stop/reload) the server finishes current requests and closes the database connection.
- **`/execute`** runs user-supplied **JavaScript** with Node (the Flask version ran Python). Same limits: 5 second timeout, empty environment, 20 KB cap, and it needs a login.

> **Testing note:** I type-checked this code and exercised every route (signup, duplicate signup, signin, `/me`, `/refresh`, token-type checks, `/execute` including timeout) against an in-memory stand-in for the Prisma client. I could **not** run `prisma generate` or a real PostgreSQL in my environment (Prisma's engine downloads were blocked), so the Prisma commands and the first real database run are untested. If `npm run build` complains about import file extensions in the generated client, add `importFileExtension = "js"` and `moduleFormat = "esm"` to the `generator client` block in `schema.prisma` and run `npx prisma generate` again, then check Prisma's "Generating Prisma Client" docs.

---

## 5. Deploying on DigitalOcean (Ubuntu 24.04), as root

Before starting: create a droplet (2 GB RAM is comfortable for building), and point your domain's **A record** at its IP. Your code must be in a git repo the server can clone, including `package-lock.json` and `prisma/migrations/`.

### Step 1: Server prep and Node.js
```bash
ssh root@<droplet-ip>
ufw allow OpenSSH && ufw allow "Nginx Full" && ufw enable
apt update && apt install -y git nginx certbot python3-certbot-nginx curl

# Node.js 24 (LTS) from NodeSource, then pm2
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
npm install -g pm2
node -v && pm2 -v
```

### Step 2: Get the app, configure, build
```bash
cd ~ && git clone <your-repo-url> express-api && cd express-api
cp .env.example .env && nano .env && chmod 600 .env     # real JWT_SECRET and DATABASE_URL
npm ci                         # installs exactly what package-lock.json says
npm run build                  # prisma generate + tsc  → dist/
npx prisma migrate deploy      # applies committed migrations (Path A) - skip if you baselined (Path B)
```

### Step 3: Start with pm2
```bash
pm2 start ecosystem.config.cjs
pm2 list                       # status should be "online"
pm2 logs express-api           # live logs (Ctrl+C to leave)
curl http://127.0.0.1:8000/    # → {"status":"Ok"}
```
Make it survive reboots:
```bash
pm2 save                       # remember the current process list
pm2 startup systemd -u root --hp /root
# pm2 prints (or runs) a systemd command; if it only prints one, copy-paste and run it, then run `pm2 save` again
```
Everyday pm2 commands:
```bash
pm2 reload express-api      # restart with no downtime (use after deploys)
pm2 restart express-api
pm2 stop express-api
pm2 delete express-api
pm2 monit                   # CPU / memory dashboard
pm2 logs express-api --lines 100
```

### Step 4: Nginx
```bash
cp deploy/api-proxy.conf /etc/nginx/snippets/api-proxy.conf
cp deploy/nginx-api.conf /etc/nginx/sites-available/api
sed -i 's/api.example.com/YOUR.DOMAIN/' /etc/nginx/sites-available/api
ln -s /etc/nginx/sites-available/api /etc/nginx/sites-enabled/api
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```
`nginx -t` checks the config for typos before you reload.

### Step 5: HTTPS with Certbot
```bash
certbot --nginx -d YOUR.DOMAIN      # adds the port-443 block and HTTP→HTTPS redirect
certbot renew --dry-run             # confirms auto-renewal works
```

### Step 6: Test it
```bash
curl -X POST https://YOUR.DOMAIN/signup -H 'Content-Type: application/json' \
  -d '{"name":"shivansh","password":"s3cret"}'

TOKEN=$(curl -s -X POST https://YOUR.DOMAIN/signin -H 'Content-Type: application/json' \
  -d '{"name":"shivansh","password":"s3cret"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

curl https://YOUR.DOMAIN/me -H "Authorization: Bearer $TOKEN"
curl -X POST https://YOUR.DOMAIN/execute -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"console.log(1+1)"}'
```

### Updating the app later
```bash
cd ~/express-api && git pull
npm ci && npm run build
npx prisma migrate deploy
pm2 reload express-api
```

---

## 6. Deploy with Terraform (automated alternative to Section 5)

Instead of typing Section 5's commands, Terraform creates the droplet, a firewall (and optionally the DNS record), and cloud-init runs the setup on first boot. You run **Certbot once** at the end (it needs DNS to point at the droplet first).

> **Not tested.** I couldn't run `terraform validate` or a real `apply`, and the pm2 startup step in cloud-init is unverified. Run `terraform validate` and `terraform plan` first, and read `/var/log/cloud-init-output.log` on the droplet if anything is missing.

### Prerequisites
- Terraform ≥ 1.5 on your laptop (<https://developer.hashicorp.com/terraform/install>).
- A DigitalOcean **API token** (Control Panel → API → Generate New Token, read+write).
- An SSH key already in DigitalOcean named **`digital_ocean_key`**, with the private key on your laptop (e.g. `~/.ssh/digital_ocean_key`). Terraform only *looks it up*; it never creates or uploads a key.
- Your code in a git repo the droplet can clone (public HTTPS is simplest; a private repo needs a token in the URL or a deploy key), **including `package-lock.json` and `prisma/migrations/`**.
- A domain name, e.g. `api.example.com`.

### Layout and `.gitignore` additions
```
terraform/
├── versions.tf
├── variables.tf
├── main.tf
├── outputs.tf
├── cloud-init.yaml.tftpl
└── terraform.tfvars.example
```
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
  description = "Git URL the droplet clones, e.g. https://github.com/you/express-api.git"
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
  default = "s-1vcpu-2gb" # 2 GB RAM so npm install + tsc don't run out of memory
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
  name     = "express-api"
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
  name        = "express-api-fw"
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

  # Allow all outbound (apt, npm, git, DNS, database, Let's Encrypt)
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
Runs once, as root, on the droplet's first boot.
```yaml
#cloud-config
package_update: true
packages:
  - git
  - curl
  - ca-certificates
  - nginx
  - certbot
  - python3-certbot-nginx

write_files:
  # Secrets file; moved into the app folder after the repo is cloned
  - path: /root/express-api.env
    permissions: "0600"
    content: |
      JWT_SECRET=${jwt_secret}
      DATABASE_URL=${database_url}
      PORT=8000

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

  - path: /root/bootstrap.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      set -e
      export HOME=/root

      # Node.js 24 + pm2
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
      apt-get install -y nodejs
      npm install -g pm2

      # App
      git clone ${repo_url} /root/express-api
      mv /root/express-api.env /root/express-api/.env
      cd /root/express-api
      npm ci
      npm run build
      npx prisma migrate deploy

      # Nginx
      ln -sf /etc/nginx/sites-available/api /etc/nginx/sites-enabled/api
      rm -f /etc/nginx/sites-enabled/default
      nginx -t
      systemctl reload nginx

      # pm2: start, remember, and start again after reboot
      pm2 start ecosystem.config.cjs
      pm2 save
      pm2 startup systemd -u root --hp /root

runcmd:
  - /root/bootstrap.sh
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
repo_url          = "https://github.com/YOUR-USER/express-api.git"
database_url      = "postgresql://user:password@host:5432/dbname?sslmode=require"
fqdn              = "api.example.com"
dns_zone          = "example.com"          # "" if your DNS is NOT in DigitalOcean
ssh_allowed_cidrs = ["203.0.113.7/32"]     # your own public IP; find it with: curl ifconfig.me
# ssh_key_name    = "digital_ocean_key"    # already the default
# region          = "blr1"
# size            = "s-1vcpu-2gb"
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
Wait ~5 minutes after `apply` finishes: cloud-init keeps running on the droplet (it installs Node and builds the app). Then:

```bash
# 1. SSH in (use the ssh_command output) and check the setup finished
ssh -i ~/.ssh/digital_ocean_key root@<droplet_ip>
cloud-init status --wait            # "status: done"
pm2 list                            # express-api should be "online"
curl http://127.0.0.1:8000/         # {"status":"Ok"}

# 2. If you did NOT use dns_zone: create an A record  fqdn -> droplet_ip at your DNS provider, wait a few minutes

# 3. Get HTTPS (once DNS resolves to the droplet)
certbot --nginx -d api.example.com
certbot renew --dry-run

# 4. Test from your laptop with the curl commands in Section 5, Step 6
```
If something is missing: `less /var/log/cloud-init-output.log`.

### Updating and tearing down
- **New app version:** SSH in and follow "Updating the app later" in Section 5 (Terraform only manages the infrastructure).
- **Change firewall, size, DNS:** edit the `.tf`/`tfvars` and run `terraform apply`.
- **Delete everything:** `terraform destroy`. This removes the droplet and anything stored on it.

### Things to know
- **Secrets:** the `.env` contents travel as droplet `user_data`, which is stored in Terraform state and readable from inside the droplet through the metadata service. Keep `terraform.tfstate` private (never commit it).
- **Managed Postgres:** if `database_url` points at a DigitalOcean managed database, add the droplet (or its IP) under the database's **Trusted Sources**, or the migration step will fail with `P1001`.
- **Migrations:** the bootstrap runs `prisma migrate deploy`. If your table already existed, baseline it first (Section 3.3, Path B) and commit the migration folder.

---

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Missing environment variable: JWT_SECRET` | `.env` missing in the app folder, or pm2 started from another folder (the config sets `cwd`, so start with `pm2 start ecosystem.config.cjs`). |
| `Cannot find module './generated/prisma/client.js'` | Run `npm run build` (it runs `prisma generate`). |
| `Cannot find module '.../dist/server.js'` | Run `npm run build` first. |
| `pm2 list` shows `errored` | `pm2 logs express-api --lines 50`: usually a missing env var or database error. |
| `502 Bad Gateway` from Nginx | App isn't running on port 8000. Check `pm2 list` and `curl 127.0.0.1:8000`. |
| `nginx -t` fails | Typo in the config; the error gives the line number. |
| Certbot fails | DNS not pointing at the droplet yet, or port 80 blocked by `ufw`. |
| `P1001` can't reach database | Wrong host/port, or DB "Trusted Sources" doesn't include the droplet. |
| `P3005` schema not empty | Table exists already: baseline it (Section 3.3, Path B). |
| App isn't back after reboot | You skipped `pm2 save` / `pm2 startup`. Run them again. |
| `401` on `/me` | Missing `Authorization: Bearer ...`, token expired (use `/refresh`), or you sent a refresh token to an access-only route. |
| `terraform plan` says SSH key not found | The key name in DigitalOcean must exactly match `ssh_key_name` (`digital_ocean_key`). |
| `Unable to authenticate` from Terraform | `DIGITALOCEAN_TOKEN` not exported in the same shell, or token is read-only. |
| Droplet is up but the API isn't | `cloud-init status --wait`, then `less /var/log/cloud-init-output.log`. |
| `429`/`503` on `/signin` | Nginx rate limit (5 requests/min per IP). Edit `rate=` to loosen. |

---

## 8. Security checklist

- **`/execute` is dangerous.** It runs arbitrary JavaScript from users on your server. The 5-second timeout and empty environment help, but it is **not a sandbox**: code can still read files and use the network.
- **You deploy as root** (as chosen), so the app, pm2 and anything `/execute` runs have full control of the server. Strongly consider removing `/execute`, or at least running the subprocess as an unprivileged user inside a container (Docker/nsjail) or on a separate droplet with nothing valuable on it.
- Keep `.env` out of git and `chmod 600`.
- Use a long random `JWT_SECRET` (32+ bytes). Changing it logs everyone out.
- The app listens on `127.0.0.1` only; keep the firewall open for just SSH, 80 and 443.
- Use SSH keys instead of password login for root, and restrict `ssh_allowed_cidrs` to your own IP.
- Never run `prisma migrate dev` / `migrate reset` on production; use `migrate deploy`.
- Run `apt update && apt upgrade` regularly, and `npm audit` now and then.