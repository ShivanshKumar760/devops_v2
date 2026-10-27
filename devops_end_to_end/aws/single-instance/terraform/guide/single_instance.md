# Learn Terraform by deploying a JWT blog API on AWS

Build a small **blog API** (JWT login, MongoDB Atlas, plus a `/load` endpoint for load testing) and deploy it on AWS with Terraform, while learning the Terraform language one block at a time.

What Terraform will create:

- a **VPC** `10.0.0.0/16` with **2 public** and **2 private** subnets,
- an **internet gateway** and a **NAT gateway** (in a public subnet) with the route tables that connect them,
- **one EC2 instance in a private subnet** that runs the API,
- an **Application Load Balancer** in the public subnets, which is how you reach the API from the internet.

Everything you need is in this one file: the API (`server.js`), the three Terraform files (`variables.tf`, `main.tf`, `outputs.tf`), the commands, and an explanation of every piece of Terraform syntax that appears.

## Contents

1. [What you will build](#1-what-you-will-build)
2. [Project layout](#2-project-layout)
3. [The API: `server.js`](#3-the-api-serverjs)
4. [MongoDB Atlas setup](#4-mongodb-atlas-setup)
5. [Terraform syntax crash course](#5-terraform-syntax-crash-course)
6. [`variables.tf`, explained](#6-variablestf-explained)
7. [`main.tf`, explained section by section](#7-maintf-explained-section-by-section)
8. [`outputs.tf`, explained](#8-outputstf-explained)
9. [In what order does Terraform build things?](#9-in-what-order-does-terraform-build-things)
10. [The complete files in one go](#10-the-complete-files-in-one-go)
11. [Deploy it](#11-deploy-it)
12. [Test the API](#12-test-the-api)
13. [Load test it](#13-load-test-it)
14. [Experiments to learn the syntax](#14-experiments-to-learn-the-syntax)
15. [Troubleshooting](#15-troubleshooting)
16. [Destroy everything](#16-destroy-everything)
17. [Terraform cheat sheet](#17-terraform-cheat-sheet)

---

## 1. What you will build

```
                         Internet
                            │
                   ┌────────▼────────┐
                   │ Internet Gateway│
                   └────────┬────────┘
┌───────────────────────────┼────────────────────────────────────────────────┐
│ VPC  10.0.0.0/16          │                                                │
│                           │                                                │
│  PUBLIC subnets           │   route table: 0.0.0.0/0 → internet gateway    │
│  ┌──────────────────────────────────────────────────┐                      │
│  │ blog-public-a 10.0.1.0/24   blog-public-b 10.0.2.0/24                   │
│  │   Application Load Balancer (port 80) spans both                        │
│  │   NAT gateway + Elastic IP (in blog-public-a)                           │
│  └───────────────┬──────────────────────────────────┘                      │
│                  │ port 3000, only from the load balancer's security group │
│  PRIVATE subnets ▼    route table: 0.0.0.0/0 → NAT gateway                 │
│  ┌──────────────────────────────────────────────────┐                      │
│  │ blog-private-a 10.0.11.0/24         blog-private-b 10.0.12.0/24         │
│  │   EC2 instance (Node.js API)         (spare, ready for more servers)    │
│  └───────────────┬──────────────────────────────────┘                      │
│                  │ outbound only: apt, npm, MongoDB Atlas                  │
└──────────────────┼─────────────────────────────────────────────────────────┘
                   ▼
        NAT gateway → internet → MongoDB Atlas (allows only the NAT's fixed IP)
```

### Why a load balancer and not API Gateway

Either can sit in front of a private server, but they work differently:

| | Application Load Balancer (used here) | API Gateway (HTTP API) |
|---|---|---|
| Reaches a private EC2 instance | Directly, through a target group | Only through a **VPC link** plus a load balancer or service registry in front of the instance |
| Terraform resources needed | 4 (load balancer, target group, listener, attachment) | More (API, stage, integration, route, VPC link, and still a load balancer behind it) |
| Good at | Plain HTTP traffic to servers | Auth, throttling, per-request pricing, serverless backends |

For one server in a private subnet the load balancer is the simpler fit, and it is what you would scale out later.

### Resources and what each one does

| # | Terraform resource | Purpose |
|---|---|---|
| 1 | `aws_vpc` | The private network, `10.0.0.0/16` |
| 2 | `aws_internet_gateway` | The VPC's door to the internet |
| 3 | `aws_subnet.public` ×2 | Subnets for the load balancer and the NAT gateway |
| 4 | `aws_subnet.private` ×2 | Subnets for the server (no public IPs) |
| 5 | `aws_route_table.public` + `aws_route` + associations ×2 | Sends internet traffic of the public subnets to the internet gateway |
| 6 | `aws_eip` | A fixed public IP address for the NAT gateway |
| 7 | `aws_nat_gateway` | Lets the private server make outbound connections |
| 8 | `aws_route_table.private` + `aws_route` + associations ×2 | Sends internet traffic of the private subnets to the NAT gateway |
| 9 | `aws_security_group.alb` and `.app` | Firewalls: the internet reaches the load balancer, only the load balancer reaches the server |
| 10 | `aws_lb`, `aws_lb_target_group`, `aws_lb_listener`, `aws_lb_target_group_attachment` | The load balancer and the link to the server |
| 11 | `aws_instance` | The EC2 server that runs the API |

Plus two **data sources** (read-only lookups): the list of Availability Zones, and the newest Ubuntu 24.04 image. In total Terraform will plan **23 resources** to create.

> **Cost warning.** The NAT gateway and the load balancer bill by the hour while they exist, and so does the EC2 instance. Run [`terraform destroy`](#16-destroy-everything) when you finish experimenting.

---

## 2. Project layout

One folder, four files. Terraform reads every `.tf` file in the folder, and `main.tf` also reads `server.js` from the same folder.

```
blog-api-aws/
├── server.js        # the whole API (section 3)
├── variables.tf     # the inputs (section 6)
├── main.tf          # all the infrastructure (section 7)
└── outputs.tf       # the values printed at the end (section 8)
```

Create the folder:

```bash
mkdir blog-api-aws && cd blog-api-aws
```

A `.gitignore` for when you put this in Git (it keeps Terraform's state and your secrets out of the repository):

```gitignore
.terraform/
*.tfstate
*.tfstate.*
*.tfvars
crash.log
```

There is no `package.json` in the project. The boot script on the server creates one, so `server.js` is the only application file.

---

## 3. The API: `server.js`

Save this as `server.js` in the project folder. It is one file with everything: models, authentication, blog routes, health checks and the load endpoint. It uses ES modules (`import`), Express 5 and Mongoose 8.

```javascript
// server.js - JWT blog API on MongoDB Atlas (Express 5 + Mongoose), plus a /load endpoint for load testing.
import os from 'node:os';
import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// ---------- Configuration (environment variables) ----------
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

if (!MONGODB_URI || !JWT_SECRET) {
  console.error('MONGODB_URI and JWT_SECRET are required');
  process.exit(1);
}

// ---------- Models ----------
const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
}, { timestamps: true }));

const Post = mongoose.model('Post', new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  content: { type: String, required: true, maxlength: 20000 },
  tags: { type: [String], default: [], index: true },
  published: { type: Boolean, default: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
}, { timestamps: true }));

// ---------- Helpers ----------
const signToken = (user) =>
  jwt.sign({ sub: String(user._id) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });

// Requires "Authorization: Bearer <token>"; sets req.userId
function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }).sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const cleanTags = (tags) => tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // one proxy in front: the load balancer
app.use(express.json({ limit: '100kb' }));

app.get('/', (_req, res) => res.json({ app: 'blog-api', host: os.hostname(), docs: 'see /health, /ready, /load, /api/auth/*, /api/posts' }));

// Load balancer health check: never touches the database
app.get('/health', (_req, res) => res.json({ status: 'ok', host: os.hostname() }));

// Is MongoDB connected? (503 until it is)
app.get('/ready', (_req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({ db: ok ? 'connected' : 'disconnected' });
});

// Load test endpoint: busy-loops for ?ms= milliseconds (default 100, max 2000) to burn CPU on purpose
app.get('/load', (req, res) => {
  const asked = Number.parseInt(req.query.ms, 10);
  const ms = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 2000) : 100;
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(Math.random() * 1e6) * Math.sin(x);
  res.json({ host: os.hostname(), pid: process.pid, burnedMs: ms });
});

// ----- Auth -----
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 10) });
  res.status(201).json({ user: { id: user.id, name: user.name, email: user.email }, token: signToken(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ user: { id: user.id, name: user.name, email: user.email }, token: signToken(user) });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

// ----- Blog posts -----
// GET /api/posts?page=1&limit=10&tag=aws  (public, published posts only)
app.get('/api/posts', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const filter = { published: true };
  if (typeof req.query.tag === 'string') filter.tags = req.query.tag.toLowerCase();
  const [items, total] = await Promise.all([
    Post.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('author', 'name'),
    Post.countDocuments(filter),
  ]);
  res.json({ items, page, limit, total, pages: Math.ceil(total / limit) });
});

// Your own posts, drafts included. Declared BEFORE /:id so "mine" is not treated as an id.
app.get('/api/posts/mine', requireAuth, async (req, res) => {
  res.json({ items: await Post.find({ author: req.userId }).sort({ createdAt: -1 }) });
});

app.get('/api/posts/:id', async (req, res) => {
  const post = await Post.findOne({ _id: req.params.id, published: true }).populate('author', 'name');
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ post });
});

app.post('/api/posts', requireAuth, async (req, res) => {
  const { title, content, tags, published } = req.body ?? {};
  const post = await Post.create({
    title, content,
    tags: Array.isArray(tags) ? cleanTags(tags) : [],
    published: published === undefined ? true : Boolean(published),
    author: req.userId,
  });
  res.status(201).json({ post });
});

// Only the author can change or delete a post
app.put('/api/posts/:id', requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (String(post.author) !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  const { title, content, tags, published } = req.body ?? {};
  if (title !== undefined) post.title = title;
  if (content !== undefined) post.content = content;
  if (Array.isArray(tags)) post.tags = cleanTags(tags);
  if (published !== undefined) post.published = Boolean(published);
  await post.save();
  res.json({ post });
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (String(post.author) !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  await post.deleteOne();
  res.status(204).end();
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.name === 'ValidationError') return res.status(400).json({ error: 'Validation failed', details: Object.values(err.errors).map((e) => e.message) });
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ error: 'Already exists' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- Start ----------
// Listen first so /health answers at once; keep trying to reach Atlas until it works
// (the Atlas allow-list may not contain this server's IP yet when it first boots).
const server = app.listen(PORT, '0.0.0.0', () => console.log(`blog-api listening on :${PORT}`));

(async function connectToMongo() {
  for (;;) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      console.log('MongoDB connected');
      return;
    } catch (err) {
      console.error('MongoDB connection failed, retrying in 5s:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
})();

// Graceful shutdown (systemd sends SIGTERM): finish in-flight requests, then exit
const shutdown = () => {
  server.close(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

### Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/` | none | Small info message with the server's hostname |
| GET | `/health` | none | `200 OK` always. The load balancer's health check. Never touches the database |
| GET | `/ready` | none | `200` when MongoDB is connected, `503` otherwise |
| GET | `/load?ms=100` | none | Burns CPU for `ms` milliseconds (default 100, maximum 2000) |
| POST | `/api/auth/register` | none | Create an account, returns a JWT |
| POST | `/api/auth/login` | none | Returns a JWT |
| GET | `/api/auth/me` | JWT | The logged-in user |
| GET | `/api/posts?page=1&limit=10&tag=aws` | none | Published posts, paginated |
| GET | `/api/posts/mine` | JWT | Your posts, drafts included |
| GET | `/api/posts/:id` | none | One published post |
| POST | `/api/posts` | JWT | Create a post |
| PUT | `/api/posts/:id` | JWT (author only) | Update a post |
| DELETE | `/api/posts/:id` | JWT (author only) | Delete a post |

A JWT is sent as the header `Authorization: Bearer <token>`.

### Design choices worth knowing

- **Settings come from environment variables** (`MONGODB_URI`, `JWT_SECRET`, `PORT`, `JWT_EXPIRES_IN`). Nothing secret is in the code. On the server a `.env` file feeds them to the process (section 7, part 3).
- **The server starts listening first and connects to MongoDB in the background**, retrying every 5 seconds. That matters here: on its first boot the server's IP is not yet in the Atlas allow-list, so the first connection attempts fail. Because `/health` does not depend on the database, the load balancer still sees a healthy server, and `/ready` tells you the real database state.
- **`/load` is a busy loop.** One request keeps one CPU core fully busy for `ms` milliseconds, so you can raise the server's CPU on purpose. The value is capped at 2000 ms so nobody can freeze the server.
- **Only an author can edit or delete a post**, and `/api/posts/mine` is declared before `/api/posts/:id`, otherwise Express would treat the word `mine` as an id.
- **Passwords are hashed** with bcrypt and never returned by the API.

### Try it on your laptop first (optional)

Do this in a scratch folder, so `node_modules` does not end up next to your Terraform files:

```bash
mkdir /tmp/blog-local && cp server.js /tmp/blog-local/ && cd /tmp/blog-local
npm init -y
npm pkg set type=module
npm install express mongoose bcryptjs jsonwebtoken

export MONGODB_URI='mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/blogdb?retryWrites=true&w=majority'
export JWT_SECRET='any-long-random-string-of-at-least-32-characters'
node server.js
```

In another terminal: `curl localhost:3000/health` and `curl "localhost:3000/load?ms=300"`. For this local run, add your own IP in Atlas under Network Access.

---

## 4. MongoDB Atlas setup

1. In Atlas, create a cluster (the free **M0** tier is enough). Choose a region near the AWS region you deploy to (Mumbai for `ap-south-1`).
2. **Database Access, Add New Database User.** Username `blog_app`, a long random password (letters and digits only avoids escaping problems), and the privilege **Read and write to any database**.
3. **Connect, Drivers** and copy the connection string. Replace `<password>` with the real password and add the database name `blogdb` before the `?`:

   ```
   mongodb+srv://blog_app:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/blogdb?retryWrites=true&w=majority
   ```

   If the password contains special characters, URL-encode them (`@` is `%40`, `/` is `%2F`, `#` is `%23`).
4. **Do not touch Network Access yet.** The server will reach Atlas through the NAT gateway, and its fixed IP only exists after `terraform apply`. You add it in [section 11](#11-deploy-it).

---

## 5. Terraform syntax crash course

Read this once before the code. Every item here appears in the files below.

### 5.1 What Terraform does with your files

Terraform reads **every `.tf` file in the folder** as if they were one file. The file names (`main.tf`, `variables.tf`, `outputs.tf`) are only a convention for humans. Order inside or between files does not matter either: Terraform works out the order itself from the references between things (section 9).

You describe the **desired end state**. Terraform compares it with what it has recorded in its **state file** (`terraform.tfstate`) and with what really exists, and works out the changes needed. That is why you can run `terraform apply` again safely: if nothing changed, nothing happens.

### 5.2 Blocks, labels and arguments

Everything in Terraform is a **block**:

```hcl
resource "aws_vpc" "this" {          # block type, then two labels, then { }
  cidr_block = var.vpc_cidr          # an argument:  name = value
  tags = {                           # an argument whose value is a map
    Name = "blog-vpc"
  }

  lifecycle {                        # a nested block (no "=" sign)
    prevent_destroy = false
  }
}
```

| Part | Meaning |
|---|---|
| `resource` | The **block type**. It says what kind of block this is |
| `"aws_vpc"` | The first label: the **resource type** (what to create). The `aws_` prefix says which provider owns it |
| `"this"` | The second label: **your name** for it. Together with the type it is the resource's address: `aws_vpc.this` |
| `cidr_block = ...` | An **argument**: a setting, written `name = value` |
| `lifecycle { ... }` | A **nested block**: a group of related settings, with no `=` |

Comments: `# like this`, `// or this`, and `/* for several lines */`. Style note: run `terraform fmt` and it aligns the `=` signs for you.

### 5.3 The block types in this project

| Block | What it is for | Used in |
|---|---|---|
| `terraform { }` | Settings for Terraform itself: the minimum version and which providers to download | `main.tf`, section 1 |
| `provider "aws" { }` | Configures a provider (the plugin that talks to AWS): the region, default tags | `main.tf`, section 1 |
| `variable "x" { }` | An **input** to your configuration | `variables.tf` |
| `locals { }` | **Named values** you calculate once and reuse | `main.tf`, section 3 |
| `data "type" "name" { }` | A **read-only lookup** of something that already exists | `main.tf`, section 2 |
| `resource "type" "name" { }` | Something Terraform **creates and manages** | `main.tf`, sections 4 to 8 |
| `output "x" { }` | A value Terraform **prints** at the end | `outputs.tf` |

There is also `module`, which reuses a packaged set of resources. This project does not need one.

### 5.4 Values and types

| Type | Example | Note |
|---|---|---|
| `string` | `"ap-south-1"` | Always in double quotes |
| `number` | `3000` | No quotes |
| `bool` | `true`, `false` | No quotes |
| `list` | `["a", "b"]` | Ordered, indexed from 0: `list[0]` |
| `map` | `{ Name = "x", Tier = "y" }` | Keys and values |
| `object` | `{ name = string, size = number }` | A map with a fixed shape (used in type constraints) |

A string can contain **interpolation**: `"${local.name}-vpc"` becomes `blog-vpc`. Terraform replaces whatever is inside `${ }` with its value.

### 5.5 References: how things point at other things

| You write | It means |
|---|---|
| `var.vpc_cidr` | The value of the input variable `vpc_cidr` |
| `local.name` | The value of the local named `name` |
| `aws_vpc.this.id` | The `id` attribute of the resource `aws_vpc.this` (known after it is created) |
| `data.aws_ami.ubuntu.id` | The `id` read by the data source `aws_ami.ubuntu` |
| `aws_subnet.public[0].id` | The `id` of the **first** subnet created by a `count` resource |
| `aws_subnet.public[*].id` | A **splat**: the list of `id`s of all the instances (`["subnet-1", "subnet-2"]`) |
| `count.index` | Inside a resource with `count`, the number of the copy being created: 0, 1, ... |
| `path.module` | The folder that holds the current `.tf` file |

References do more than fetch a value. They create a **dependency**: if resource B uses `aws_vpc.this.id`, Terraform knows the VPC must exist before B.

### 5.6 Expressions and functions

**Conditional** (an if/else in one line):

```hcl
condition ? value_if_true : value_if_false
```

**For expression** (build a list or map from another):

```hcl
[for i in range(2) : cidrsubnet(var.vpc_cidr, 8, i + 1)]   # → ["10.0.1.0/24", "10.0.2.0/24"]
```

**Functions** are called `name(arguments)`. The ones used here:

| Function | What it does | Example in this project |
|---|---|---|
| `merge(map1, map2)` | Combines maps | the provider's default tags |
| `slice(list, start, end)` | Part of a list (`end` is exclusive) | the first two Availability Zones |
| `range(n)` | `[0, 1, ..., n-1]` | `range(2)` is `[0, 1]` |
| `cidrsubnet(prefix, bits, number)` | Carves a smaller network out of a bigger one | the subnet ranges |
| `file(path)` | Reads a file's text | reading `server.js` |
| `base64encode(text)` | Encodes text as base64 | embedding `server.js` safely |
| `length(x)` | Number of items or characters | the user data size check |
| `substr(text, start, length)` | Part of a string | the zone letter in tag names |
| `startswith(text, prefix)` | True if text begins with prefix | validating the MongoDB URI |
| `can(expression)` | True if the expression works without an error | validating the CIDR |
| `regex(pattern, text)` | Matches a regular expression | validating the CIDR |

You can try any function interactively with `terraform console` (section 14).

### 5.7 Meta-arguments: settings every resource understands

| Meta-argument | What it does |
|---|---|
| `count = N` | Creates **N copies** of the resource, numbered by `count.index`, addressed as `name[0]`, `name[1]` |
| `for_each = map_or_set` | Creates one copy per item, addressed by the item's key (not used here) |
| `depends_on = [...]` | An **explicit** dependency, for when a dependency exists that Terraform cannot see from references |
| `lifecycle { ... }` | Controls how Terraform treats the resource. This project uses `precondition` (a check that must pass before creating) |

### 5.8 Heredocs: multi-line strings

```hcl
user_data = <<-EOT
  line one with ${var.something}
  line two
EOT
```

- `<<EOT` starts a multi-line string that ends at a line containing only `EOT` (any word works instead of `EOT`).
- `<<-EOT` (with the dash) also **removes the common leading indentation**, so you can indent the text to match your code.
- `${ ... }` is still **interpolation** inside a heredoc. If the text must contain a literal `${`, write `$${`. This is why the boot script in this project uses plain `$APP_DIR` and not `${APP_DIR}` for its shell variables.

### 5.9 Plan, apply and state

| Command | What it does |
|---|---|
| `terraform init` | Downloads the providers you declared into `.terraform/` and writes `.terraform.lock.hcl`. Run it first, and again after adding a provider |
| `terraform fmt` | Re-formats the files to the standard style |
| `terraform validate` | Checks syntax and references, without touching AWS |
| `terraform plan` | Shows what Terraform **would** do. Changes nothing |
| `terraform apply` | Does it (after you type `yes`) |
| `terraform output` | Prints the outputs again later |
| `terraform destroy` | Deletes everything Terraform created |

How to read a plan:

| Symbol | Meaning |
|---|---|
| `+` | will be **created** |
| `-` | will be **destroyed** |
| `~` | will be **changed in place** |
| `-/+` | will be **replaced** (destroyed and created again) |

The **state file** (`terraform.tfstate`) is Terraform's memory of what it created. Never edit it by hand, never delete it while resources exist, and never commit it to Git, because it contains the real values of your secrets.

---

## 6. `variables.tf`, explained

Variables are the **inputs** of your configuration. Save this as `variables.tf`:

```hcl
variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Prefix for the names of all resources (blog-vpc, blog-alb, ...)."
  type        = string
  default     = "blog"
}

variable "vpc_cidr" {
  description = "IP range of the VPC. The subnets are /24 blocks carved out of it, so use a /16 (or larger)."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(regex("^[0-9]{1,3}([.][0-9]{1,3}){3}/(8|9|1[0-6])$", var.vpc_cidr))
    error_message = "vpc_cidr must look like 10.0.0.0/16 (a prefix length between /8 and /16)."
  }
}

variable "app_port" {
  description = "Port the Node.js API listens on. Used by the app, the target group and the security group."
  type        = number
  default     = 3000

  validation {
    condition     = var.app_port >= 1024 && var.app_port <= 65535
    error_message = "app_port must be between 1024 and 65535."
  }
}

variable "instance_type" {
  description = "EC2 instance type. t3 is recommended, t2 throttles the CPU during load tests."
  type        = string
  default     = "t3.micro"
}

variable "mongodb_uri" {
  description = "MongoDB Atlas connection string, including the database name. No default: you must supply it."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.mongodb_uri, "mongodb")
    error_message = "mongodb_uri must start with mongodb:// or mongodb+srv://."
  }
}

variable "jwt_secret" {
  description = "Secret used to sign JWTs. Use at least 32 random characters (openssl rand -base64 48)."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.jwt_secret) >= 32
    error_message = "jwt_secret must be at least 32 characters long."
  }
}

variable "jwt_expires_in" {
  description = "How long a login token stays valid (for example 15m, 1h, 7d)."
  type        = string
  default     = "1h"
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}
```

### Anatomy of a variable

```hcl
variable "app_port" {                 # the name you use as var.app_port
  description = "..."                 # documentation, shown when Terraform asks for the value
  type        = number                # the type Terraform enforces
  default     = 3000                  # used when you provide nothing; without a default the variable is REQUIRED

  validation {                        # a rule the value must pass
    condition     = var.app_port >= 1024 && var.app_port <= 65535
    error_message = "app_port must be between 1024 and 65535."
  }
}
```

### What each variable is for

| Variable | Type | Default | Used for |
|---|---|---|---|
| `aws_region` | string | `ap-south-1` | The provider's region |
| `project_name` | string | `blog` | The prefix of every resource name (`blog-vpc`, `blog-alb`) |
| `vpc_cidr` | string | `10.0.0.0/16` | The VPC range, and the base the subnets are calculated from |
| `app_port` | number | `3000` | The port in three places: the app's `PORT`, the target group and the security group. One variable keeps them in sync |
| `instance_type` | string | `t3.micro` | The EC2 size |
| `mongodb_uri` | string, **sensitive** | none | Written to the server's `.env` |
| `jwt_secret` | string, **sensitive** | none | Written to the server's `.env` |
| `jwt_expires_in` | string | `1h` | Login token lifetime |
| `tags` | map(string) | `{}` | Extra tags on everything |

### Validation, step by step

- **`vpc_cidr`:** `can(regex("^[0-9]{1,3}([.][0-9]{1,3}){3}/(8|9|1[0-6])$", var.vpc_cidr))`. `regex()` fails with an error if the text does not match, and `can()` turns "failed with an error" into `false`. So the rule reads "the text must look like four numbers, a slash, and a prefix length from 8 to 16". The subnet maths adds 8 bits, so a longer prefix such as `/24` would not work.
- **`mongodb_uri`:** `startswith(var.mongodb_uri, "mongodb")` catches a mistyped or empty value before anything is created.
- **`jwt_secret`:** `length(var.jwt_secret) >= 32` refuses a weak secret.

### `sensitive = true`

Terraform prints `(sensitive value)` instead of the real value in `plan` and `apply` output, and any value calculated from it (like the user data) is hidden too. This only hides it on screen. The real value is still stored in the state file and in the instance's user data, so treat both as secret.

### How to give a variable its value

Terraform looks in this order (later wins):

| Way | Example | Good for |
|---|---|---|
| The `default` in the file | `default = "blog"` | Safe defaults |
| A `terraform.tfvars` file | `project_name = "shop"` | Non-secret values |
| An environment variable `TF_VAR_<name>` | `export TF_VAR_jwt_secret="..."` | **Secrets** (this guide) |
| The command line | `terraform apply -var 'instance_type=t3.small'` | One-off changes |
| Asking you | (when there is no value and no default) | Quick tests |

---

## 7. `main.tf`, explained section by section

`main.tf` holds all the infrastructure. It is shown here in **eight sections**. Put them in **one file named `main.tf`, in this order**, one after the other. The finished file is 385 lines long, and `terraform fmt` should leave it unchanged. The whole file is also shown in one piece in [section 10](#10-the-complete-files-in-one-go).

### Section 1: Terraform settings and the provider

```hcl
############################################################
# 1. Terraform settings and the AWS provider
############################################################

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

  # Tags added automatically to every resource that supports tags
  default_tags {
    tags = merge({ Project = var.project_name, ManagedBy = "terraform" }, var.tags)
  }
}
```

| Piece | Explanation |
|---|---|
| `required_version = ">= 1.5.0"` | Refuses to run with an older Terraform |
| `required_providers { aws = { ... } }` | Declares that this configuration uses the AWS provider. `source` says where `terraform init` downloads it from (the Terraform Registry) |
| `version = "~> 5.0"` | The **pessimistic constraint**: any 5.x version from 5.0 up, but never 6.0. You get bug fixes without breaking changes |
| `provider "aws" { region = var.aws_region }` | Configures the provider. The region comes from the variable. AWS credentials come from your environment (the same ones the AWS CLI uses) |
| `default_tags { tags = merge(...) }` | Tags added to **every** resource that supports tags. `merge()` joins the fixed tags with whatever you pass in `var.tags` |

### Section 2: Data sources

```hcl

############################################################
# 2. Data sources: read-only lookups of things that already exist
############################################################

# The Availability Zones of the region that are currently usable
data "aws_availability_zones" "available" {
  state = "available"
}

# The newest official Ubuntu 24.04 image published by Canonical
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical's AWS account ID

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}
```

A **data source** reads something that already exists. It never creates anything, and you refer to it with the `data.` prefix.

| Piece | Explanation |
|---|---|
| `data "aws_availability_zones" "available"` | Asks AWS which Availability Zones are usable in your region. Used as `data.aws_availability_zones.available.names` |
| `state = "available"` | A filter: skip zones that are impaired |
| `data "aws_ami" "ubuntu"` | Looks up a machine image (AMI) |
| `owners = ["099720109477"]` | Only consider images published by Canonical (Ubuntu's publisher). Without this, anyone's image with a matching name could be picked |
| `most_recent = true` | If several images match, take the newest |
| `filter { name = ... values = [...] }` | Nested blocks that narrow the search. The `*` in the name pattern is a wildcard for the date part |

### Section 3: Locals

```hcl

############################################################
# 3. Locals: named values calculated once and reused
############################################################

locals {
  name = var.project_name

  # The first two zones of the region, for example ["ap-south-1a", "ap-south-1b"]
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  # Carve /24 subnets out of the /16 VPC range
  public_subnet_cidrs  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 8, i + 1)]  # 10.0.1.0/24, 10.0.2.0/24
  private_subnet_cidrs = [for i in range(2) : cidrsubnet(var.vpc_cidr, 8, i + 11)] # 10.0.11.0/24, 10.0.12.0/24

  # server.js is read from disk and embedded as base64 text
  server_js_b64 = base64encode(file("${path.module}/server.js"))

  # The script the instance runs once, as root, on its first boot
  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    export HOME=/root

    APP_DIR=/opt/blog-api
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"

    # 1) Install Node.js 22. A private instance only reaches the internet through the NAT gateway.
    apt-get -o DPkg::Lock::Timeout=300 update -y
    apt-get -o DPkg::Lock::Timeout=300 install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get -o DPkg::Lock::Timeout=300 install -y nodejs

    # 2) The application: Terraform embedded server.js as base64, so quotes inside it cannot break this script
    echo '${local.server_js_b64}' | base64 -d > server.js

    cat > package.json <<'EOF'
    {
      "name": "blog-api",
      "private": true,
      "type": "module",
      "dependencies": {
        "bcryptjs": "^2.4.3",
        "express": "^5.1.0",
        "jsonwebtoken": "^9.0.2",
        "mongoose": "^8.8.0"
      }
    }
    EOF
    npm install --omit=dev

    # 3) Settings and secrets (the quoted 'EOF' stops bash from expanding a $ inside the values)
    cat > .env <<'EOF'
    PORT=${var.app_port}
    NODE_ENV=production
    MONGODB_URI=${var.mongodb_uri}
    JWT_SECRET=${var.jwt_secret}
    JWT_EXPIRES_IN=${var.jwt_expires_in}
    EOF
    chmod 600 .env

    # 4) Run the app as a systemd service: starts now, restarts after a crash, starts again after a reboot
    cat > /etc/systemd/system/blog-api.service <<'EOF'
    [Unit]
    Description=Blog API
    After=network-online.target
    Wants=network-online.target

    [Service]
    WorkingDirectory=/opt/blog-api
    EnvironmentFile=/opt/blog-api/.env
    ExecStart=/usr/bin/node server.js
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    EOF
    systemctl daemon-reload
    systemctl enable --now blog-api
  EOT
}
```

**Locals** are named values calculated once and reused, referenced as `local.name`. They are like variables, but computed, not supplied.

| Local | Explanation |
|---|---|
| `name` | Just a shorter name for `var.project_name` |
| `azs` | `slice(list, 0, 2)` takes the first two zone names, for example `["ap-south-1a", "ap-south-1b"]` |
| `public_subnet_cidrs` | A **for expression**: for each `i` in `range(2)` (that is 0 and 1) compute `cidrsubnet(var.vpc_cidr, 8, i + 1)`. `cidrsubnet` adds 8 bits to the `/16`, giving `/24` blocks, and `i + 1` picks the slice: `10.0.1.0/24` and `10.0.2.0/24` |
| `private_subnet_cidrs` | The same with `i + 11`: `10.0.11.0/24` and `10.0.12.0/24`, a clearly separate block |
| `server_js_b64` | `file("${path.module}/server.js")` reads your API file from the same folder, and `base64encode()` turns it into plain safe text |
| `user_data` | A heredoc: the boot script for the server |

**Why `server.js` travels as base64.** The script embeds the whole file inside shell quotes. Real code is full of quotes, dollar signs and backticks that would break the script. Base64 uses only letters, digits, `+`, `/` and `=`, so it can never break anything. The server decodes it with `base64 -d`.

**The boot script, part by part** (it runs once, as root, the first time the instance starts):

| Part | What it does |
|---|---|
| `set -euo pipefail` | Stop at the first error, and treat a failure anywhere in a pipe as a failure |
| 1) Install Node.js | `apt-get ... install nodejs` after adding NodeSource's repository. `-o DPkg::Lock::Timeout=300` makes apt wait for Ubuntu's own start-up updates instead of failing. **This needs the internet, which is why the private route to the NAT gateway must exist first** |
| 2) The application | `echo '...' \| base64 -d > server.js` recreates your file. A `package.json` is written with the four dependencies, and `npm install --omit=dev` installs them |
| 3) Settings and secrets | Writes `/opt/blog-api/.env` with the port, the MongoDB URI and the JWT secret taken from Terraform variables. `chmod 600` makes the file readable only by root |
| 4) systemd service | Describes the app as a service. `EnvironmentFile=` loads the `.env`, `Restart=always` restarts the app after a crash, and `systemctl enable --now` starts it immediately and on every future boot |

**Two heredocs, one inside the other.** The outer one is Terraform's `<<-EOT ... EOT`. The inner ones (`<<'EOF' ... EOF`) belong to the shell script. They use different end words, so they do not clash. The single quotes in `<<'EOF'` tell the shell **not to expand `$` or backticks** inside, which keeps a password containing `$` intact.

**Where the `${...}` come from.** Terraform replaces `${local.server_js_b64}`, `${var.app_port}`, `${var.mongodb_uri}`, `${var.jwt_secret}` and `${var.jwt_expires_in}` while it builds the script. That is how the variables travel into the server. Shell variables in the script are written without braces (`$APP_DIR`) so that Terraform leaves them alone.

### Section 4: The VPC, the internet gateway and the subnets

```hcl

############################################################
# 4. The VPC, the internet gateway and the four subnets
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

# Two public subnets, one per Availability Zone
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.public_subnet_cidrs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name}-public-${substr(local.azs[count.index], -1, -1)}"
    Tier = "public"
  }
}

# Two private subnets, one per Availability Zone
resource "aws_subnet" "private" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.private_subnet_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-private-${substr(local.azs[count.index], -1, -1)}"
    Tier = "private"
  }
}
```

| Piece | Explanation |
|---|---|
| `resource "aws_vpc" "this"` | Creates the VPC. The address is `aws_vpc.this`, and `this` is just a name (a common convention for the only resource of its kind) |
| `enable_dns_support`, `enable_dns_hostnames` | Lets the servers resolve names, which they need to find Atlas and the package servers |
| `tags = { Name = ... }` | The `Name` tag is what the AWS console shows |
| `aws_internet_gateway "this"` | The VPC's door to the internet. `vpc_id = aws_vpc.this.id` both **attaches it to the VPC** and tells Terraform to create the VPC first |
| `count = 2` | Creates **two copies** of the subnet. In each copy `count.index` is 0, then 1 |
| `availability_zone = local.azs[count.index]` | Copy 0 goes in the first zone, copy 1 in the second |
| `cidr_block = local.public_subnet_cidrs[count.index]` | Copy 0 gets `10.0.1.0/24`, copy 1 gets `10.0.2.0/24` |
| `map_public_ip_on_launch` | `true` on the public subnets: servers launched there get a public IP automatically. `false` on the private ones. It does **not** decide whether a subnet is public |
| `substr(local.azs[count.index], -1, -1)` | The last character of the zone name (`ap-south-1a` gives `a`), so the tags read `blog-public-a` |
| `Tier = "public"` | Just a label. What really makes a subnet public is the route table in section 5 |

The result is addressed as `aws_subnet.public[0]`, `aws_subnet.public[1]`, `aws_subnet.private[0]` and `aws_subnet.private[1]`.

### Section 5: Routing and the NAT gateway

```hcl

############################################################
# 5. Routing: what makes a subnet public or private
############################################################

# --- Public route table: everything not local goes to the internet gateway ---
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
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- NAT gateway: lives in a PUBLIC subnet and has a fixed public IP (an Elastic IP) ---
resource "aws_eip" "nat" {
  domain = "vpc"

  tags       = { Name = "${local.name}-nat-eip" }
  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags       = { Name = "${local.name}-nat" }
  depends_on = [aws_internet_gateway.this]
}

# --- Private route table: everything not local goes to the NAT gateway ---
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.name}-rtb-private" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}

# The same private route table is attached to BOTH private subnets
resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
```

This is the heart of the network. A subnet is **public or private only because of the route table attached to it**.

| Piece | Explanation |
|---|---|
| `aws_route_table.public` | A route table for the public subnets |
| `aws_route.public_internet` | One rule in it: `0.0.0.0/0` (every address not inside the VPC) goes to the **internet gateway** |
| `aws_route_table_association.public` | Attaches that route table to each public subnet. `count = 2` makes one association per subnet. Without this, the subnets would not use the table |
| `aws_eip.nat` | An **Elastic IP**: a public IP address that stays fixed. This is the address MongoDB Atlas will see, and the one you allow-list there. `domain = "vpc"` means it is for use inside a VPC |
| `aws_nat_gateway.this` | The NAT gateway. It lives in a **public** subnet (`aws_subnet.public[0]`) so it can reach the internet through the internet gateway, and it uses the Elastic IP |
| `aws_route_table.private` | A route table for the private subnets |
| `aws_route.private_nat` | Its one rule: `0.0.0.0/0` goes to the **NAT gateway** |
| `aws_route_table_association.private` | Attaches the **same** private route table to **both** private subnets |

**`depends_on = [aws_internet_gateway.this]`.** The Elastic IP and the NAT gateway do not reference the internet gateway anywhere, but the NAT gateway cannot work until the internet gateway is attached. `depends_on` is how you tell Terraform about a dependency it cannot see. It only controls the **order of creation**.

**Why the private subnet needs the NAT gateway.** A private subnet has no route to the internet gateway, so nothing from the internet can reach it, which is what you want. But the server still has to download packages and reach MongoDB Atlas. The NAT gateway lets it start those outbound connections: the packet goes to the NAT gateway, which swaps the server's private address for its own Elastic IP, then out through the internet gateway. Replies come back the same way. Connections started from the internet are not allowed in.

### Section 6: Security groups

```hcl

############################################################
# 6. Security groups: the firewalls
############################################################

# The load balancer accepts HTTP from anywhere
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "Load balancer: HTTP from the internet"
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

# The EC2 instance accepts the app port ONLY from the load balancer
resource "aws_security_group" "app" {
  name        = "${local.name}-app-sg"
  description = "EC2 instance: app port from the load balancer only"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "App port from the load balancer's security group"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound (package downloads and MongoDB Atlas go out through the NAT gateway)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-app-sg" }
}
```

A **security group** is a firewall attached to a resource.

| Piece | Explanation |
|---|---|
| `ingress { ... }` | A nested block describing **incoming** traffic that is allowed. You can repeat the block |
| `egress { ... }` | Allowed **outgoing** traffic |
| `from_port` / `to_port` / `protocol` | The port range and protocol. `protocol = "-1"` with ports 0 means "everything" |
| `cidr_blocks = ["0.0.0.0/0"]` | Allow from any IPv4 address (the load balancer must be reachable from the internet) |
| `security_groups = [aws_security_group.alb.id]` | Allow only traffic that comes **from resources wearing the load balancer's security group**. This is how the server accepts requests from the load balancer and from nothing else |
| `from_port = var.app_port` | The port comes from the variable, so everything stays consistent |

The server's group has no SSH rule and the server has no public IP. The only way in is through the load balancer, on one port.

### Section 7: The load balancer

```hcl

############################################################
# 7. Application Load Balancer in the public subnets
############################################################

resource "aws_lb" "app" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id # splat: the IDs of both public subnets

  tags = { Name = "${local.name}-alb" }
}

resource "aws_lb_target_group" "app" {
  name                 = "${local.name}-tg"
  port                 = var.app_port
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  target_type          = "instance"
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-tg" }
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

# Registers the EC2 instance in the target group
resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = var.app_port
}
```

| Piece | Explanation |
|---|---|
| `aws_lb "app"` | The Application Load Balancer. `internal = false` makes it internet-facing |
| `subnets = aws_subnet.public[*].id` | A **splat**: the IDs of **both** public subnets as a list. The load balancer lives in the public subnets even though the server is private |
| `aws_lb_target_group "app"` | The list of servers the load balancer sends traffic to, and how it checks them |
| `health_check { ... }` | Every 15 seconds the load balancer requests `/health`. Two successes in a row make the server healthy, three failures make it unhealthy. The nested block has no `=` |
| `deregistration_delay = 30` | Wait 30 seconds when removing a server, instead of the default 300 |
| `aws_lb_listener "http"` | Listens on port 80 and, with `default_action`, forwards every request to the target group |
| `aws_lb_target_group_attachment "app"` | Puts the EC2 instance in the target group. `target_id = aws_instance.app.id` refers to the instance **defined in section 8**, which is fine because the order of blocks never matters |

### Section 8: The EC2 instance

```hcl

############################################################
# 8. The EC2 instance, in a PRIVATE subnet
############################################################

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.private[0].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  user_data                   = local.user_data
  user_data_replace_on_change = true # a new user_data (or new server.js) replaces the instance

  # IMDSv2 only
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 12
    encrypted   = true
  }

  tags = { Name = "${local.name}-api" }

  # The boot script downloads packages, so the private route to the NAT gateway must exist BEFORE the instance starts.
  # Nothing in this resource references the route, so Terraform cannot work that out alone.
  depends_on = [aws_route.private_nat, aws_route_table_association.private]

  lifecycle {
    precondition {
      condition     = length(local.user_data) <= 16000
      error_message = "user_data is bigger than the 16 KB EC2 limit. Make server.js smaller, or download it from GitHub instead of embedding it."
    }
  }
}
```

| Piece | Explanation |
|---|---|
| `ami = data.aws_ami.ubuntu.id` | The image looked up in section 2 |
| `subnet_id = aws_subnet.private[0].id` | Puts the server in the **first private subnet**. This is what makes it private |
| `vpc_security_group_ids = [...]` | Attaches the server's security group |
| `user_data = local.user_data` | The boot script from section 3. AWS runs it on first start |
| `user_data_replace_on_change = true` | If the script changes (including a changed `server.js` or a changed secret), Terraform **replaces the instance** so the new script runs. Without it, the change would be saved but never run |
| `metadata_options { http_tokens = "required" }` | Requires the safer IMDSv2 for the instance metadata service |
| `root_block_device { ... }` | A 12 GB encrypted `gp3` disk |
| `depends_on = [aws_route.private_nat, aws_route_table_association.private]` | The most important line of the section. See below |
| `lifecycle { precondition { ... } }` | A check that runs **before** Terraform creates the instance. If `condition` is false, Terraform stops with `error_message`. Here it refuses a boot script bigger than EC2's 16 KB limit |

**Why `depends_on` is needed here.** The boot script downloads Node.js, so the server needs its route to the NAT gateway **before it starts**. The instance references the subnet, so Terraform creates the subnet first, but nothing in the instance references the **route** or the **route table association**. Without `depends_on`, Terraform could start the server while the route is still being created. The script runs only once, so a failed download would leave a server with no API and no obvious reason. This is exactly the kind of dependency Terraform cannot see from references.

---

## 8. `outputs.tf`, explained

Outputs print useful values at the end of `terraform apply`, and `terraform output` shows them again later. Save this as `outputs.tf`:

```hcl
output "alb_url" {
  description = "Public URL of the API (through the load balancer)."
  value       = "http://${aws_lb.app.dns_name}"
}

output "nat_gateway_public_ip" {
  description = "The fixed public IP the instance uses to reach the internet. Add it to the MongoDB Atlas Network Access list (as x.x.x.x/32)."
  value       = aws_eip.nat.public_ip
}

output "instance_id" {
  description = "ID of the EC2 instance in the private subnet."
  value       = aws_instance.app.id
}

output "instance_private_ip" {
  description = "Private IP of the EC2 instance (it has no public IP)."
  value       = aws_instance.app.private_ip
}

output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "IDs of the two public subnets (load balancer, NAT gateway)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the two private subnets (the EC2 instance is in the first one)."
  value       = aws_subnet.private[*].id
}

output "boot_log_command" {
  description = "Command that prints the instance's boot log (the output of the user data script)."
  value       = "aws ec2 get-console-output --instance-id ${aws_instance.app.id} --latest --output text --region ${var.aws_region}"
}

output "load_test_command" {
  description = "autocannon command that burns CPU on the instance through the /load endpoint."
  value       = "npx autocannon -c 10 -d 120 -t 30 \"http://${aws_lb.app.dns_name}/load?ms=100\""
}
```

| Output | Why you need it |
|---|---|
| `alb_url` | The address of your API. `"http://${aws_lb.app.dns_name}"` builds a string with interpolation |
| `nat_gateway_public_ip` | **The IP to allow-list in MongoDB Atlas.** It is the Elastic IP, because that is the address the server's outbound traffic appears to come from |
| `instance_id`, `instance_private_ip` | To identify the server (it has no public IP) |
| `vpc_id`, `public_subnet_ids`, `private_subnet_ids` | The network IDs. The `[*]` splat prints every subnet |
| `boot_log_command` | A ready-made AWS CLI command that prints the server's boot log, the only window into the user data script because the server has no SSH |
| `load_test_command` | A ready-made autocannon command for section 13 |

An output block has a `value` (the expression) and an optional `description`. You can add `sensitive = true` to hide a value, which is not needed here.

---

## 9. In what order does Terraform build things?

Terraform builds a **dependency graph** from your references, then creates independent items **in parallel** and dependent items in order. For this project the order is roughly:

```
 1. VPC
 2. ├── internet gateway          ├── 4 subnets          ├── 2 security groups
 3. │   (needs the VPC)           │   (need the VPC)     │   (alb first, then app)
 4. ├── public route table, private route table (need the VPC)
 5. ├── public route (needs the route table and the internet gateway)
 6. ├── 2 public route table associations (need public subnets + public route table)
 7. ├── Elastic IP (waits for the internet gateway, because of depends_on)
 8. ├── NAT gateway (needs the Elastic IP and public subnet 0)           ← slowest: about 2 minutes
 9. ├── private route (needs the NAT gateway)
10. ├── 2 private route table associations
11. ├── load balancer (needs the public subnets and the alb security group)   ← about 2 to 3 minutes
12. ├── target group (needs the VPC)
13. ├── EC2 instance (waits for the private route and associations, because of depends_on)
14. └── listener, then target group attachment (need the load balancer, target group and instance)
```

You can see the real graph with `terraform graph`. Two kinds of dependency are at work:

| Kind | Where it comes from | Example here |
|---|---|---|
| **Implicit** | One block **references** another | `vpc_id = aws_vpc.this.id` |
| **Explicit** | You wrote `depends_on` | the NAT gateway waiting for the internet gateway, and the instance waiting for the private route |

`terraform destroy` walks the same graph **backwards**: the instance goes first and the VPC last.

---

## 10. The complete files in one go

Sections 6 to 8 explain the Terraform files piece by piece. Here they are **complete and unbroken**, ready to copy. Together with `server.js` (section 3) they are everything the project needs.

```
blog-api-aws/
├── server.js        # section 3
├── variables.tf     # this section, file 1 (73 lines)
├── main.tf          # this section, file 2 (385 lines)
└── outputs.tf       # this section, file 3 (44 lines)
```

| File | What is in it | Explained in |
|---|---|---|
| `variables.tf` | The 9 inputs, with their validation rules | section 6 |
| `main.tf` | Terraform and provider settings, 2 data sources, the locals (including the boot script), and 19 resource blocks that expand to 23 resources | section 7 |
| `outputs.tf` | The 9 values printed after `apply` | section 8 |

### File 1: `variables.tf`

```hcl
variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Prefix for the names of all resources (blog-vpc, blog-alb, ...)."
  type        = string
  default     = "blog"
}

variable "vpc_cidr" {
  description = "IP range of the VPC. The subnets are /24 blocks carved out of it, so use a /16 (or larger)."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(regex("^[0-9]{1,3}([.][0-9]{1,3}){3}/(8|9|1[0-6])$", var.vpc_cidr))
    error_message = "vpc_cidr must look like 10.0.0.0/16 (a prefix length between /8 and /16)."
  }
}

variable "app_port" {
  description = "Port the Node.js API listens on. Used by the app, the target group and the security group."
  type        = number
  default     = 3000

  validation {
    condition     = var.app_port >= 1024 && var.app_port <= 65535
    error_message = "app_port must be between 1024 and 65535."
  }
}

variable "instance_type" {
  description = "EC2 instance type. t3 is recommended, t2 throttles the CPU during load tests."
  type        = string
  default     = "t3.micro"
}

variable "mongodb_uri" {
  description = "MongoDB Atlas connection string, including the database name. No default: you must supply it."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.mongodb_uri, "mongodb")
    error_message = "mongodb_uri must start with mongodb:// or mongodb+srv://."
  }
}

variable "jwt_secret" {
  description = "Secret used to sign JWTs. Use at least 32 random characters (openssl rand -base64 48)."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.jwt_secret) >= 32
    error_message = "jwt_secret must be at least 32 characters long."
  }
}

variable "jwt_expires_in" {
  description = "How long a login token stays valid (for example 15m, 1h, 7d)."
  type        = string
  default     = "1h"
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}
```

### File 2: `main.tf` (complete)

```hcl
############################################################
# 1. Terraform settings and the AWS provider
############################################################

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

  # Tags added automatically to every resource that supports tags
  default_tags {
    tags = merge({ Project = var.project_name, ManagedBy = "terraform" }, var.tags)
  }
}

############################################################
# 2. Data sources: read-only lookups of things that already exist
############################################################

# The Availability Zones of the region that are currently usable
data "aws_availability_zones" "available" {
  state = "available"
}

# The newest official Ubuntu 24.04 image published by Canonical
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical's AWS account ID

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

############################################################
# 3. Locals: named values calculated once and reused
############################################################

locals {
  name = var.project_name

  # The first two zones of the region, for example ["ap-south-1a", "ap-south-1b"]
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  # Carve /24 subnets out of the /16 VPC range
  public_subnet_cidrs  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 8, i + 1)]  # 10.0.1.0/24, 10.0.2.0/24
  private_subnet_cidrs = [for i in range(2) : cidrsubnet(var.vpc_cidr, 8, i + 11)] # 10.0.11.0/24, 10.0.12.0/24

  # server.js is read from disk and embedded as base64 text
  server_js_b64 = base64encode(file("${path.module}/server.js"))

  # The script the instance runs once, as root, on its first boot
  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    export HOME=/root

    APP_DIR=/opt/blog-api
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"

    # 1) Install Node.js 22. A private instance only reaches the internet through the NAT gateway.
    apt-get -o DPkg::Lock::Timeout=300 update -y
    apt-get -o DPkg::Lock::Timeout=300 install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get -o DPkg::Lock::Timeout=300 install -y nodejs

    # 2) The application: Terraform embedded server.js as base64, so quotes inside it cannot break this script
    echo '${local.server_js_b64}' | base64 -d > server.js

    cat > package.json <<'EOF'
    {
      "name": "blog-api",
      "private": true,
      "type": "module",
      "dependencies": {
        "bcryptjs": "^2.4.3",
        "express": "^5.1.0",
        "jsonwebtoken": "^9.0.2",
        "mongoose": "^8.8.0"
      }
    }
    EOF
    npm install --omit=dev

    # 3) Settings and secrets (the quoted 'EOF' stops bash from expanding a $ inside the values)
    cat > .env <<'EOF'
    PORT=${var.app_port}
    NODE_ENV=production
    MONGODB_URI=${var.mongodb_uri}
    JWT_SECRET=${var.jwt_secret}
    JWT_EXPIRES_IN=${var.jwt_expires_in}
    EOF
    chmod 600 .env

    # 4) Run the app as a systemd service: starts now, restarts after a crash, starts again after a reboot
    cat > /etc/systemd/system/blog-api.service <<'EOF'
    [Unit]
    Description=Blog API
    After=network-online.target
    Wants=network-online.target

    [Service]
    WorkingDirectory=/opt/blog-api
    EnvironmentFile=/opt/blog-api/.env
    ExecStart=/usr/bin/node server.js
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    EOF
    systemctl daemon-reload
    systemctl enable --now blog-api
  EOT
}

############################################################
# 4. The VPC, the internet gateway and the four subnets
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

# Two public subnets, one per Availability Zone
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.public_subnet_cidrs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name}-public-${substr(local.azs[count.index], -1, -1)}"
    Tier = "public"
  }
}

# Two private subnets, one per Availability Zone
resource "aws_subnet" "private" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.private_subnet_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-private-${substr(local.azs[count.index], -1, -1)}"
    Tier = "private"
  }
}

############################################################
# 5. Routing: what makes a subnet public or private
############################################################

# --- Public route table: everything not local goes to the internet gateway ---
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
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- NAT gateway: lives in a PUBLIC subnet and has a fixed public IP (an Elastic IP) ---
resource "aws_eip" "nat" {
  domain = "vpc"

  tags       = { Name = "${local.name}-nat-eip" }
  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags       = { Name = "${local.name}-nat" }
  depends_on = [aws_internet_gateway.this]
}

# --- Private route table: everything not local goes to the NAT gateway ---
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.name}-rtb-private" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}

# The same private route table is attached to BOTH private subnets
resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

############################################################
# 6. Security groups: the firewalls
############################################################

# The load balancer accepts HTTP from anywhere
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "Load balancer: HTTP from the internet"
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

# The EC2 instance accepts the app port ONLY from the load balancer
resource "aws_security_group" "app" {
  name        = "${local.name}-app-sg"
  description = "EC2 instance: app port from the load balancer only"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "App port from the load balancer's security group"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound (package downloads and MongoDB Atlas go out through the NAT gateway)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-app-sg" }
}

############################################################
# 7. Application Load Balancer in the public subnets
############################################################

resource "aws_lb" "app" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id # splat: the IDs of both public subnets

  tags = { Name = "${local.name}-alb" }
}

resource "aws_lb_target_group" "app" {
  name                 = "${local.name}-tg"
  port                 = var.app_port
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  target_type          = "instance"
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-tg" }
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

# Registers the EC2 instance in the target group
resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = var.app_port
}

############################################################
# 8. The EC2 instance, in a PRIVATE subnet
############################################################

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.private[0].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  user_data                   = local.user_data
  user_data_replace_on_change = true # a new user_data (or new server.js) replaces the instance

  # IMDSv2 only
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 12
    encrypted   = true
  }

  tags = { Name = "${local.name}-api" }

  # The boot script downloads packages, so the private route to the NAT gateway must exist BEFORE the instance starts.
  # Nothing in this resource references the route, so Terraform cannot work that out alone.
  depends_on = [aws_route.private_nat, aws_route_table_association.private]

  lifecycle {
    precondition {
      condition     = length(local.user_data) <= 16000
      error_message = "user_data is bigger than the 16 KB EC2 limit. Make server.js smaller, or download it from GitHub instead of embedding it."
    }
  }
}
```

### File 3: `outputs.tf`

```hcl
output "alb_url" {
  description = "Public URL of the API (through the load balancer)."
  value       = "http://${aws_lb.app.dns_name}"
}

output "nat_gateway_public_ip" {
  description = "The fixed public IP the instance uses to reach the internet. Add it to the MongoDB Atlas Network Access list (as x.x.x.x/32)."
  value       = aws_eip.nat.public_ip
}

output "instance_id" {
  description = "ID of the EC2 instance in the private subnet."
  value       = aws_instance.app.id
}

output "instance_private_ip" {
  description = "Private IP of the EC2 instance (it has no public IP)."
  value       = aws_instance.app.private_ip
}

output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "IDs of the two public subnets (load balancer, NAT gateway)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the two private subnets (the EC2 instance is in the first one)."
  value       = aws_subnet.private[*].id
}

output "boot_log_command" {
  description = "Command that prints the instance's boot log (the output of the user data script)."
  value       = "aws ec2 get-console-output --instance-id ${aws_instance.app.id} --latest --output text --region ${var.aws_region}"
}

output "load_test_command" {
  description = "autocannon command that burns CPU on the instance through the /load endpoint."
  value       = "npx autocannon -c 10 -d 120 -t 30 \"http://${aws_lb.app.dns_name}/load?ms=100\""
}
```

### Check that you pasted everything correctly

Run these in the project folder:

```bash
ls
# main.tf  outputs.tf  server.js  variables.tf

wc -l main.tf variables.tf outputs.tf
# 385 main.tf
#  73 variables.tf
#  44 outputs.tf
# 502 total

terraform fmt -check      # prints nothing when the formatting is already correct
terraform init
terraform validate        # Success! The configuration is valid.
```

If the line counts differ by a few lines, that is usually just trailing blank lines. If `terraform validate` reports an error, it names the file and line, so look there first. The most common slips are a missing closing `}`, a stray character at the end of a heredoc line, and a quote that turned into a curly quote when copied from a document. Terraform only accepts straight quotes (`"`).

Then continue with [section 11](#11-deploy-it).

---

## 11. Deploy it

### 11.1 Before you start

```bash
terraform version          # 1.5.0 or newer
aws --version
aws sts get-caller-identity
```

`get-caller-identity` must print your AWS account. If it fails, run `aws configure` (or `aws sso login`) first. Terraform uses the same credentials as the AWS CLI.

Check that the project folder has exactly these four files:

```bash
ls
# main.tf  outputs.tf  server.js  variables.tf
```

### 11.2 Set your two secrets

Terraform reads any environment variable called `TF_VAR_<variable name>` as the value of that variable. Run these in the terminal you will use for `terraform` (use your real Atlas string from section 4, and keep the single quotes):

```bash
export TF_VAR_mongodb_uri='mongodb+srv://blog_app:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/blogdb?retryWrites=true&w=majority'
export TF_VAR_jwt_secret="$(openssl rand -base64 48)"
```

Save the JWT secret so you can reuse the same one later, and keep it out of Git:

```bash
echo "$TF_VAR_jwt_secret" > jwt.secret && chmod 600 jwt.secret
echo "jwt.secret" >> .gitignore
```

In a new terminal later, restore it with `export TF_VAR_jwt_secret="$(cat jwt.secret)"`. Keep it stable: changing the secret changes the boot script, which **replaces the server** and logs every user out.

These variables exist only in the current terminal. If you open a new one, export them again.

### 11.3 Initialize, check and plan

```bash
terraform init
```

`init` downloads the AWS provider into a `.terraform/` folder. You should see `Terraform has been successfully initialized!`.

```bash
terraform fmt
terraform validate
```

`fmt` tidies the formatting (it prints the names of any files it changed). `validate` checks syntax and references and should print `Success! The configuration is valid.`

```bash
terraform plan
```

Read the plan before applying. You should see:

- many resources marked `+` ("will be created"),
- `user_data = (sensitive value)` on the instance, because it contains your secrets,
- a summary line like `Plan: 23 to add, 0 to change, 0 to destroy.`

Nothing has been created yet.

### 11.4 Apply

```bash
terraform apply
```

Type `yes` when asked. Creating everything takes about **4 to 6 minutes**, mostly waiting for the NAT gateway and the load balancer. At the end Terraform prints the outputs, including `alb_url` and `nat_gateway_public_ip`.

### 11.5 Allow the NAT gateway's IP in Atlas

The server reaches Atlas through the NAT gateway, so Atlas sees that gateway's Elastic IP.

```bash
terraform output -raw nat_gateway_public_ip
```

1. In Atlas open **Network Access, Add IP Address**.
2. Enter that IP followed by `/32` (for example `13.201.10.20/32`).
3. Add the comment `blog-nat` and confirm. Wait for the status **Active**.

You do not have to hurry. The server was written to keep retrying the connection every 5 seconds, so it connects by itself soon after the IP becomes active.

### 11.6 Wait for the server to come up

After `apply` finishes, the server still needs a few minutes to run its boot script (install Node.js, install the packages, start the service). That usually takes **3 to 5 minutes**.

Check the load balancer's view of the server (this uses the default project name `blog`):

```bash
TG=$(aws elbv2 describe-target-groups --names blog-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table
```

The state starts as `initial` and becomes `healthy` when `/health` answers. Repeat every 30 seconds.

The server has no SSH, so its boot log is your window into what happened. Terraform printed a ready-made command:

```bash
eval "$(terraform output -raw boot_log_command)"
```

This prints the instance's console output (the apt and npm output of the boot script). It can lag a few minutes behind real time.

---

## 12. Test the API

```bash
ALB=$(terraform output -raw alb_url)
echo $ALB
```

### Health and database status

```bash
curl $ALB/health
curl $ALB/ready
```

`/health` should answer `{"status":"ok", ...}`. `/ready` answers `{"db":"connected"}` once Atlas accepts the NAT IP, and `{"db":"disconnected"}` with status `503` until then. If it stays disconnected, see the troubleshooting table.

### Register, log in, and use the token

```bash
curl -s -X POST $ALB/api/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct-horse-battery"}'

TOKEN=$(curl -s -X POST $ALB/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}' | jq -r .token)

curl -s $ALB/api/auth/me -H "Authorization: Bearer $TOKEN"
```

### Blog posts

```bash
# create a post (needs the token)
curl -s -X POST $ALB/api/posts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"My first post on AWS","content":"Deployed with Terraform","tags":["aws","terraform"]}'

# list public posts, and filter by tag
curl -s "$ALB/api/posts?page=1&limit=5"
curl -s "$ALB/api/posts?tag=terraform"

# your own posts, drafts included
curl -s $ALB/api/posts/mine -H "Authorization: Bearer $TOKEN"
```

Copy a post's `_id` from the output and use it below:

```bash
ID=<paste a post id here>

curl -s -X PUT $ALB/api/posts/$ID -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Edited title"}'

curl -i -X DELETE $ALB/api/posts/$ID -H "Authorization: Bearer $TOKEN"     # 204 No Content
```

### Check that security works

```bash
curl -i $ALB/api/posts/mine                                  # 401: no token
curl -i $ALB/api/auth/me -H "Authorization: Bearer abc.def"  # 401: invalid token
```

### Prove the server is private

The instance has no public IP, and its security group only accepts the application port from the load balancer:

```bash
terraform output instance_private_ip
curl -m 5 http://$(terraform output -raw instance_private_ip):3000/health    # times out: not reachable from the internet
```

---

## 13. Load test it

The `/load` endpoint exists so you can raise the server's CPU on purpose. Terraform printed a ready-made command, so run it as it is:

```bash
$(terraform output -raw load_test_command)
```

That is `autocannon` with 10 connections for 120 seconds against `/load?ms=100`. Each request burns about 100 ms of one CPU core, so 10 connections keep the server busy for the whole test. `npx` downloads autocannon the first time.

What to expect:

- **Throughput of about 10 requests per second.** Node runs your code on one thread, so the server handles one `/load` request at a time (about 10 per second at 100 ms each). The other connections queue, so autocannon reports latency of roughly one second.
- **CPU rises.** In the EC2 console open the instance, **Monitoring**, **CPU utilization**. A `t3.micro` has two vCPUs and Node uses one, so expect the graph to climb toward about 50%. Basic monitoring updates every 5 minutes, so give it time.
- **`/health` still answers**, though more slowly during the test, because it waits in the same queue.

Try a heavier or lighter request:

```bash
npx autocannon -c 5  -d 60 "$ALB/load?ms=20"      # light
npx autocannon -c 30 -d 60 -t 30 "$ALB/load?ms=300"   # heavy: long queues, higher latency
```

You can also load the database path. Logging in runs a bcrypt comparison, which is CPU-heavy:

```bash
npx autocannon -c 5 -d 30 -m POST -H 'content-type: application/json' \
  -b '{"email":"ada@example.com","password":"correct-horse-battery"}' "$ALB/api/auth/login"
```

There is only one server here, so nothing scales. The natural next step is an Auto Scaling group, which launches more copies of this server when the CPU rises.

---

## 14. Experiments to learn the syntax

Terraform is learned fastest by changing things and reading the plan. None of these change anything until you type `yes` after `apply`, and `plan` never changes anything.

| Try this | What you will see | What it teaches |
|---|---|---|
| `terraform plan -var 'vpc_cidr=10.0.0.0/24'` | An error with your `error_message` | `validation` blocks run before anything is built |
| `terraform plan -var 'app_port=80'` | A validation error | the same, with a number range |
| `terraform plan -var 'instance_type=t3.small'` | `~ update in place` on the instance | Some changes do not need a new server |
| `terraform plan -var 'jwt_expires_in=2h'` | `-/+ replace` on the instance | `user_data_replace_on_change` |
| Edit `server.js` (change the default `ms`), then `terraform plan` | `-/+ replace` on the instance | `file()` makes the code part of the plan |
| `terraform plan -var 'tags={Owner="you"}'` | `~` on most resources | `default_tags` and `merge()` |
| `terraform plan -var 'project_name=shop'` | `-/+` on many resources | Names are part of identity |
| `terraform plan -destroy` | Everything marked `-` | What `destroy` would do, without doing it |

After a successful `apply`, explore Terraform's memory and graph:

```bash
terraform state list                         # every resource Terraform manages
terraform state show aws_nat_gateway.this    # all attributes of one resource
terraform output                             # the outputs again
terraform graph | head -30                   # the dependency graph in DOT format
```

Evaluate expressions interactively with `terraform console`. Type `exit` to leave:

```bash
terraform console
> cidrsubnet("10.0.0.0/16", 8, 1)
"10.0.1.0/24"
> [for i in range(2) : cidrsubnet("10.0.0.0/16", 8, i + 11)]
[
  "10.0.11.0/24",
  "10.0.12.0/24",
]
> slice(["a", "b", "c"], 0, 2)
> merge({ a = 1 }, { b = 2 })
> substr("ap-south-1a", -1, -1)
> length(local.user_data)
```

The last line shows how close the boot script is to the 16 KB limit that the `precondition` guards. (The value is sensitive, so Terraform may print `(sensitive value)`.)

---

## 15. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `No valid credential sources found` | AWS credentials are missing in this terminal. Run `aws configure` or `aws sso login` |
| Terraform asks you to type a value for `mongodb_uri` or `jwt_secret` | The `TF_VAR_...` variables are not set in this terminal. Export them again (section 11.2) |
| `Invalid value for variable ... jwt_secret must be at least 32 characters` | Your secret is too short. Use `openssl rand -base64 48` |
| `Invalid function argument ... no file exists at ./server.js` | `server.js` is missing or in another folder. It must sit next to `main.tf` |
| `Resource precondition failed: user_data is bigger than the 16 KB EC2 limit` | `server.js` grew too large to embed. Make it smaller, or have the boot script download it from GitHub with `curl` |
| `Error creating ELBv2 ... already exists` | A previous deployment left a load balancer or target group with that name. Delete it, or change `project_name` |
| `AddressLimitExceeded` or a VPC limit error | Your account has too many Elastic IPs or VPCs in this region. Release unused ones |
| Target stays `initial` or `unhealthy` for more than 8 minutes | The boot script probably failed. Read the boot log (`eval "$(terraform output -raw boot_log_command)"`) for `apt-get` or `curl` errors |
| The boot log shows `apt-get` or `curl` failing | The server could not reach the internet: the private route to the NAT gateway was not in place. In this project `depends_on` prevents that, so check that the route table and NAT gateway exist in the console |
| `/ready` stays `503` (`disconnected`) | Atlas is refusing the connection. Check that the NAT IP is in Network Access and **Active**, that the password in the URI is right and URL-encoded, and that the URI contains `/blogdb` |
| Register or login returns `500` | The database is not connected yet. Wait for `/ready` to say `connected` |
| The load balancer returns `502` or `503` | The server is not healthy yet (target state `initial`). Wait and check the target health |
| `Error acquiring the state lock` | Another Terraform command is running (or one was interrupted). Wait, or run `terraform force-unlock` with the ID it shows |
| `terraform destroy` seems stuck | The load balancer and NAT gateway take a few minutes to delete. Wait before assuming a problem |
| VS Code underlines a variable as undeclared | The editor's Terraform extension is out of date. Run `terraform validate` in the terminal, and if it passes, reload the VS Code window |

---

## 16. Destroy everything

```bash
terraform destroy
```

Type `yes`. Terraform deletes everything it created, in the right order (instance first, VPC last), and it takes a few minutes.

Then clean up the things Terraform does not manage:

- **Atlas:** remove the NAT IP from Network Access, and delete the `blog_app` user or the cluster if you no longer need them.
- **Local files:** delete `jwt.secret` if you will not use it again. Never commit it.
- **Check nothing is still billing:**

```bash
aws ec2 describe-nat-gateways --filter Name=state,Values=pending,available --query 'NatGateways[].NatGatewayId'
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName'
aws ec2 describe-addresses --query 'Addresses[].PublicIp'
aws ec2 describe-instances --filters Name=instance-state-name,Values=pending,running \
  --query 'Reservations[].Instances[].InstanceId'
```

Each should print an empty list (or only things that belong to other projects).

The state file `terraform.tfstate` stays on your disk after destroy. It no longer lists resources but may still hold your old secrets, so delete it or keep it private.

---

## 17. Terraform cheat sheet

| Syntax | Meaning | Example from this project |
|---|---|---|
| `resource "type" "name" { }` | Create and manage something | `resource "aws_vpc" "this" { ... }` |
| `data "type" "name" { }` | Read something that exists | `data "aws_ami" "ubuntu" { ... }` |
| `variable "x" { }` | An input | `variable "app_port" { ... }` |
| `locals { x = ... }` | A calculated, reusable value | `locals { name = var.project_name }` |
| `output "x" { value = ... }` | A value printed at the end | `output "alb_url" { ... }` |
| `var.x` | Read an input | `var.app_port` |
| `local.x` | Read a local | `local.azs` |
| `type.name.attr` | Read an attribute of a resource | `aws_vpc.this.id` |
| `data.type.name.attr` | Read an attribute of a data source | `data.aws_ami.ubuntu.id` |
| `"${ ... }"` | Interpolation inside a string | `"${local.name}-vpc"` |
| `$${` | A literal `${` | (avoided in the boot script) |
| `count = N` | N copies | `count = 2` on the subnets |
| `count.index` | Which copy | `local.azs[count.index]` |
| `resource[0]` | One copy | `aws_subnet.public[0].id` |
| `resource[*].attr` | All copies as a list (splat) | `aws_subnet.public[*].id` |
| `[for x in list : expr]` | Build a list | `[for i in range(2) : cidrsubnet(...)]` |
| `cond ? a : b` | If/else | (see section 5.6) |
| `depends_on = [...]` | Explicit ordering | the NAT gateway and the instance |
| `lifecycle { precondition { } }` | A check before creating | the user data size check |
| `validation { }` | A rule for an input | `vpc_cidr`, `jwt_secret` |
| `sensitive = true` | Hide a value in the output | `mongodb_uri`, `jwt_secret` |
| `<<-EOT ... EOT` | Multi-line string, indentation removed | the boot script |
| `file("path")` | Read a file's text | `file("${path.module}/server.js")` |
| `path.module` | The folder of this `.tf` file | `"${path.module}/server.js"` |
| `# comment` | A comment | everywhere |

| Command | Purpose |
|---|---|
| `terraform init` | Download providers |
| `terraform fmt` | Tidy formatting |
| `terraform validate` | Check syntax and references |
| `terraform plan` | Preview changes |
| `terraform apply` | Make the changes |
| `terraform output` | Show outputs |
| `terraform state list` | List what Terraform manages |
| `terraform console` | Try expressions |
| `terraform graph` | Show the dependency graph |
| `terraform destroy` | Delete everything |

### Where to go next

- **Auto Scaling:** replace the single `aws_instance` with a launch template and an Auto Scaling group, so more servers appear when the CPU rises. The load test in section 13 is built for that.
- **A prepared image:** build an AMI with Packer so servers start in a minute instead of installing Node.js at boot.
- **HTTPS:** add a certificate in AWS Certificate Manager and an HTTPS listener to the load balancer. Passwords and tokens should not travel over plain HTTP in real use.
- **Remote state:** keep `terraform.tfstate` in an encrypted S3 bucket instead of on your laptop.
- **Secrets:** move the MongoDB URI and JWT secret out of user data into a secrets service, so they are not stored in the launch details or the state.