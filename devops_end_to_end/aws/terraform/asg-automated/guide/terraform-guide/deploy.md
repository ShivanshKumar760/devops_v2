# Deploy both APIs on AWS, line by line

This run-book deploys two APIs, each as its own independent stack, with the same two tools in the same order:

1. **Packer** builds a golden AMI (in the default VPC, no network needed).
2. **Terraform** creates the VPC, load balancer and Auto Scaling group that launch from that AMI.

| | Simple API | Banking API |
|---|---|---|
| Repo | `load_test` (branch `main`) | `banking-cluster-api` (branch `master`) |
| Endpoints | `/`, `/health`, `/load` | signup, login, transfer (JWT, ACID) |
| Needs MongoDB Atlas | No | Yes |
| Needs secrets | No | Yes (`MONGO_URI`, `JWT_SECRET`) |
| Needs a NAT gateway | No | Yes (to reach Atlas from private subnets) |
| Terraform `project_name` | `simple` | `bank` |
| AMI name prefix | `simple-api-ami` | `bank-api-ami` |
| App folder on the instance | `/opt/simple-api` | `/opt/banking-api` |
| Terraform runs | 1 | 2 (network first, then the ASG) |

The stacks do not share anything. Each has its own VPC, load balancer, ASG and Terraform state, and their names differ (`simple-*` and `bank-*`), so they can run side by side. Deploy the simple API first: it is the easier of the two and proves your tools and credentials work.

All code (the APIs, `packer/` and `terraform/` files) is in the add-on guide, Parts 2 and 3. This run-book is the order of commands. Every command assumes region `ap-south-1` (Mumbai).

> I have not run these commands against your AWS account. Where output matters, the "You should see" lines show what to expect so you can spot a problem early.

## Time and cost at a glance

| Stage | Roughly how long |
|---|---|
| Packer build | 5 to 8 minutes |
| Terraform apply, simple API | 2 to 3 minutes, plus about 1 minute for instances to turn healthy |
| Terraform apply, banking API (NAT gateway) | 3 to 5 minutes for the network, 2 to 3 for the ASG |
| ASG scale-out during a load test | 3 to 5 minutes after the load starts |

Billing while it runs: the load balancers, EC2 instances, detailed monitoring and the banking stack's NAT gateway bill by the hour, and AMI snapshots bill for storage. Run the teardown (Part C) when you finish.

---

## Part 0: One-time setup

### 0.1 Install the tools

macOS:

```bash
brew install awscli jq node git
brew tap hashicorp/tap
brew install hashicorp/tap/terraform hashicorp/tap/packer
```

Linux or Windows: install the AWS CLI, Terraform and Packer from their official download pages, plus `jq`, Node.js 20 or newer and `git`.

Check that all six work:

```bash
aws --version
terraform version      # needs 1.5.0 or newer
packer version         # needs 1.10 or newer
jq --version
node --version         # 20 or newer
git --version
```

### 0.2 Log in to AWS

```bash
aws configure
```

It asks for four things: your access key ID, your secret access key, default region (`ap-south-1`) and output format (`json`). If your company uses SSO, run `aws configure sso` and then `aws sso login` instead.

Confirm it works:

```bash
aws sts get-caller-identity
```

You should see your account ID and user ARN. If you see an error, fix credentials before going on.

Make the region explicit for every tool in this terminal:

```bash
export AWS_REGION=ap-south-1
export AWS_DEFAULT_REGION=ap-south-1
```

Packer and Terraform both default to `ap-south-1`, so the AMI and the stack end up in the same region. Terraform finds the AMI by name in its own region, so a mismatch is the most common first error.

### 0.3 Make sure the default VPC exists

Packer builds in the default VPC.

```bash
aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[].VpcId' --output text
```

If it prints a VPC ID (for example `vpc-0abc123...`), continue. If it prints nothing, create one:

```bash
aws ec2 create-default-vpc
```

### 0.4 Prepare a working folder

```bash
mkdir -p ~/aws-asg && cd ~/aws-asg
```

You will end up with two sibling folders, one git repo each:

```
~/aws-asg/
├── load_test/               # Part A (branch main)
│   ├── src/server.js
│   ├── ecosystem.config.cjs
│   ├── package.json  package-lock.json  .gitignore
│   ├── packer/    (simple-api.pkr.hcl, provision.sh)
│   └── terraform/ (main.tf, variables.tf, outputs.tf)
└── banking-cluster-api/     # Part B (branch master)
    ├── server.js
    ├── ecosystem.config.cjs
    ├── package.json  package-lock.json  .gitignore
    ├── packer/    (the same two files)
    └── terraform/ (the same three files)
```

### 0.5 The two GitHub repositories

| Repo | URL | Branch |
|---|---|---|
| Simple API | `https://github.com/ShivanshKumar760/load_test.git` | `main` |
| Banking API | `https://github.com/ShivanshKumar760/banking-cluster-api.git` | `master` |

The simple API repo (`load_test`) already exists. Create `banking-cluster-api` on github.com as an empty repository. Make **both public** (Packer clones them without credentials). If you want a private repo, set a read-only token before each `packer build`: `export PKR_VAR_github_token='github_pat_...'`.

The two repos use **different branch names**, and Packer's default branch is `master`. So the simple API's Packer commands below pass `-var 'repo_branch=main'`, while the banking API's commands need no branch variable. If you push to the wrong branch, or forget the variable, Packer fails at the `git clone` step with a "Remote branch ... not found" message.

---

## Part A: Deploy the simple API

### A1. Clone your repo and add the infrastructure files

```bash
cd ~/aws-asg
git clone https://github.com/ShivanshKumar760/load_test.git
cd load_test
git checkout main
git branch --show-current
```

The last command should print `main`. The repo already holds the API. Check that these are at the **root** of the repo:

```bash
ls package.json package-lock.json ecosystem.config.cjs
```

All three must exist. `ecosystem.config.cjs` must have `cwd: '/opt/simple-api'` (that is where Packer clones the repo on the instance), and its `script` must point at your server file. If `package-lock.json` is missing, run `npm install` and commit it.

Now add the infrastructure files, copying the code from the add-on guide:

```bash
mkdir -p packer terraform
```

| File | Where the code is |
|---|---|
| `.gitignore` (add these lines) | `*.tfstate*`, `.terraform/`, `terraform.tfvars`, `jwt.secret` |
| `packer/simple-api.pkr.hcl` | Add-on guide, Part 2, Packer section |
| `packer/provision.sh` | Add-on guide, Part 2, Packer section |
| `terraform/main.tf` | Add-on guide, Part 2, Terraform section |
| `terraform/variables.tf` | Add-on guide, Part 2, Terraform section |
| `terraform/outputs.tf` | Add-on guide, Part 2, Terraform section |

Run it locally once to prove the code works:

```bash
npm install
npm run dev
```

In a second terminal:

```bash
curl localhost:3000/
curl localhost:3000/health
curl "localhost:3000/load?ms=200"
```

You should see JSON for each. Stop the server with Ctrl+C. (If your server file lives somewhere other than `src/server.js`, use the start command from your own `package.json`.)

### A2. Push the code to GitHub

```bash
cd ~/aws-asg/load_test
git add .
git commit -m "Add Packer and Terraform"
git push origin main
```

Check on github.com, on the `main` branch, that `packer/`, `terraform/`, `ecosystem.config.cjs` and `package-lock.json` are there. Packer clones whatever is on `main` at build time, so push before every build.

### A3. Build the AMI with Packer

```bash
cd packer
packer init .
```

You should see Packer install the Amazon plugin.

```bash
packer validate -var 'repo_url=https://github.com/ShivanshKumar760/load_test.git' -var 'repo_branch=main' .
```

You should see `The configuration is valid.`

```bash
packer build -var 'repo_url=https://github.com/ShivanshKumar760/load_test.git' -var 'repo_branch=main' .
```

This takes 5 to 8 minutes. Packer prints each step as it goes: it finds the newest Ubuntu 24.04 image, creates a temporary key pair and security group, launches a `t3.micro`, runs `provision.sh` (you will see the apt, Node and npm output, and the `/health` and `/load` responses from the smoke test), creates the AMI, then terminates the instance and deletes its key pair and security group. The last lines look like:

```
==> simple-api.amazon-ebs.simple_api: AMI: ami-0123456789abcdef0
Build 'simple-api.amazon-ebs.simple_api' finished after 6 minutes 12 seconds.
```

If it fails, read the error. The smoke test failing means the app did not start (check that `package-lock.json` and `ecosystem.config.cjs` are in the repo). A failed build creates no AMI.

Confirm the AMI exists:

```bash
aws ec2 describe-images --owners self --filters "Name=name,Values=simple-api-ami*" \
  --query 'Images[].[ImageId,Name,State]' --output table
```

You should see one row with state `available`.

### A4. Create the infrastructure with Terraform

```bash
cd ../terraform
terraform init
terraform validate
terraform plan
```

`plan` lists about 25 resources to create: a VPC, 4 subnets, route tables, an internet gateway, 2 security groups, a target group, a load balancer and listener, a launch template, an ASG and a scaling policy. Nothing is created yet.

```bash
terraform apply
```

Type `yes` when asked. This takes about 2 to 3 minutes (no NAT gateway for this API, so it is quick). At the end Terraform prints the outputs, including `alb_url` and `load_test_command`.

### A5. Wait until the instances are healthy

```bash
aws elbv2 describe-target-health \
  --target-group-arn "$(terraform output -raw target_group_arn)" \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table
```

Run it every 30 seconds. At first the targets show `initial`. Within about 1 to 2 minutes both should show `healthy`. If they stay `unhealthy` after 4 minutes, see the troubleshooting table in Part D.

### A6. Test the API

```bash
ALB=$(terraform output -raw alb_url)
echo $ALB

curl $ALB/
curl $ALB/health
curl "$ALB/load?ms=100"
```

Show the load balancing across the two instances:

```bash
for i in $(seq 1 20); do curl -s $ALB/ | jq -r .host; done | sort | uniq -c
```

You should see two different hostnames (like `ip-10-0-11-x` and `ip-10-0-12-x`), one per private subnet.

### A7. Load test and watch it scale

Run the load test in one terminal (about 10 minutes):

```bash
npx autocannon -c 40 -d 600 -t 60 "$ALB/load?ms=100"
```

In a second terminal, from the same `terraform/` folder, watch the group:

```bash
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names simple-asg \
  --query 'AutoScalingGroups[0].[DesiredCapacity,length(Instances)]' --output text

aws autoscaling describe-scaling-activities --auto-scaling-group-name simple-asg --max-items 5 \
  --query 'Activities[].[StatusCode,Description]' --output table
```

Run these every minute. After 3 to 5 minutes of load, `DesiredCapacity` rises from 2 toward 4 and the activity list shows launches. About 15 minutes after the load stops, the group scales back to 2.

The simple API is now fully deployed. You can leave it running while you do Part B, or tear it down first with Part C.

---

## Part B: Deploy the banking API

### B1. Prepare MongoDB Atlas

1. In Atlas, open **Database Access** and choose **Add New Database User**. Use the username `bank_app`, a long random password (letters and numbers only avoids escaping problems) and the privilege **Read and write to any database**.
2. Open your cluster, choose **Connect**, then **Drivers**, and copy the connection string.
3. Build the final URI by replacing `<password>` with the real password and adding the database name `bankDB` before the `?`:

   ```
   mongodb+srv://<db-user>:<db-password>@<cluster-host>/bankDB?retryWrites=true&w=majority
   ```

   If the password has special characters, URL-encode them (`@` is `%40`, `/` is `%2F`, `#` is `%23`).
4. Leave **Network Access** alone for now. You add the NAT gateway's IP in step B6.

### B2. Create the project files

```bash
cd ~/aws-asg
mkdir -p banking-cluster-api/packer banking-cluster-api/terraform
cd banking-cluster-api
```

Create the application files by copying from the guide (Part 3, section 3.14):

| File | Where the code is |
|---|---|
| `package.json` | 3.14, "package.json" |
| `server.js` | 3.14, "server.js (ASG-ready)" |
| `ecosystem.config.cjs` | 3.14, "ecosystem.config.cjs" (fork mode, `cwd` is `/opt/banking-api`) |
| `test.js` | 3.12 "Concurrency test", with the two changes from 3.14 |
| `.gitignore` | `node_modules/`, `.env`, `jwt.secret`, `*.tfstate*`, `.terraform/` |

Copy only the infrastructure code files from the simple API. Do not copy `.terraform/` or any `.tfstate` file, or Terraform would think the simple stack's resources belong to this one:

```bash
cp ../load_test/packer/simple-api.pkr.hcl ../load_test/packer/provision.sh packer/
cp ../load_test/terraform/main.tf ../load_test/terraform/variables.tf ../load_test/terraform/outputs.tf terraform/
ls packer terraform
```

You should see the two Packer files and the three Terraform files, and nothing else.

Install dependencies so the lock file exists:

```bash
npm install
```

### B3. Push the code to GitHub

```bash
git init -b master
git add .
git commit -m "Banking cluster API"
git remote add origin https://github.com/ShivanshKumar760/banking-cluster-api.git
git push -u origin master
```

Check on github.com that `server.js`, `ecosystem.config.cjs` and `package-lock.json` are there.

### B4. Build the banking AMI with Packer

```bash
cd packer
packer init .
packer build \
  -var 'repo_url=https://github.com/ShivanshKumar760/banking-cluster-api.git' \
  -var 'app_dir=/opt/banking-api' \
  -var 'smoke_test=false' \
  -var 'ami_name_prefix=bank-api-ami' .
```

No `repo_branch` is needed here: this repo is on `master`, which is Packer's default.

Three of those variables matter:

- `app_dir` must be `/opt/banking-api`, the same folder as `cwd` in the banking `ecosystem.config.cjs`.
- `smoke_test=false` is required because the banking app cannot start without a database and secrets. Packer checks that the dependencies installed instead (`npm ls`).
- `ami_name_prefix=bank-api-ami` keeps it apart from the simple API's AMI.

Confirm it:

```bash
aws ec2 describe-images --owners self --filters "Name=name,Values=bank-api-ami*" \
  --query 'Images[].[ImageId,Name,State]' --output table
```

### B5. Create the network first (VPC, NAT gateway, load balancer)

The instances can only reach Atlas through the NAT gateway, and you need its IP before they start. So create the network without instances first.

Create `terraform/terraform.tfvars`. It holds only non-secret values:

```hcl
project_name       = "bank"
app_name           = "banking-api"
app_dir            = "/opt/banking-api"
ami_name_prefix    = "bank-api-ami"
enable_nat_gateway = true
```

Then:

```bash
cd ../terraform
terraform init
terraform plan -var create_asg=false
terraform apply -var create_asg=false
```

`create_asg=false` builds the VPC, subnets, route tables, NAT gateway with its Elastic IP, security groups and load balancer, but no launch template, ASG or instances. It takes 3 to 5 minutes, mostly waiting for the NAT gateway.

Get the NAT gateway's IP:

```bash
terraform output nat_gateway_public_ips
```

You should see one address, for example `["13.201.10.20"]`. Copy it.

### B6. Allow that IP in Atlas

1. In Atlas open **Network Access** and choose **Add IP Address**.
2. Enter the IP followed by `/32` (for example `13.201.10.20/32`).
3. Add the comment `bank-nat` and confirm.
4. Wait until the status shows **Active**.

Do not skip this. Without it the workers cannot connect, they exit, the load balancer health check fails, and the ASG keeps replacing instances.

### B7. Create the secrets (once)

From the `terraform/` folder:

```bash
openssl rand -base64 48 > ../jwt.secret
chmod 600 ../jwt.secret
```

Keep a copy of this value somewhere safe, like a password manager. Reuse it on every later deploy: changing it logs every user out and replaces all instances.

Put the Atlas URI in a shell variable (use your real value, keep the single quotes):

```bash
export MONGO_URI='mongodb+srv://<db-user>:<db-password>@<cluster-host>/bankDB?retryWrites=true&w=majority'
```

Build the Terraform variable. `jq` escapes special characters correctly:

```bash
export TF_VAR_app_env="$(jq -nc \
  --arg uri "$MONGO_URI" \
  --arg jwt "$(cat ../jwt.secret)" \
  '{MONGO_URI: $uri, JWT_SECRET: $jwt, DB_POOL_SIZE: "5"}')"
```

Check the shape without printing the secrets:

```bash
echo "$TF_VAR_app_env" | jq 'keys'
```

You should see `["DB_POOL_SIZE", "JWT_SECRET", "MONGO_URI"]`.

These variables only exist in this terminal. If you open a new terminal later, run the two `export` lines again.

### B8. Create the Auto Scaling group

```bash
terraform plan
terraform apply
```

This time `create_asg` is back to its default (`true`). The plan shows the launch template, ASG and scaling policy being added. The `user_data` line shows `(sensitive value)`, which is correct. Type `yes`.

### B9. Wait until the instances are healthy

```bash
aws elbv2 describe-target-health \
  --target-group-arn "$(terraform output -raw target_group_arn)" \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table
```

Repeat every 30 seconds. Both targets should become `healthy` within about 1 to 3 minutes. If they do not, check the Atlas Network Access list first (step B6), then see Part D.

### B10. Test the API

```bash
ALB=$(terraform output -raw alb_url)

curl $ALB/health        # which instance answered
curl $ALB/ready         # {"status":"ready"...} means the instance reached Atlas
```

Create two users (each gets the $200 credit):

```bash
curl -X POST $ALB/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@test.com","password":"password123"}'

curl -X POST $ALB/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"Bob","email":"bob@test.com","password":"password123"}'
```

Copy Alice's `token` from the first response and make a transfer. The `Idempotency-Key` header is required:

```bash
TOKEN=<paste Alice's token here>

curl -X POST $ALB/api/transfer \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"toEmail":"bob@test.com","amount":25.50}'

curl $ALB/api/account/me -H "Authorization: Bearer $TOKEN"
```

Alice's balance should now be `174.50`.

### B11. Run the concurrency test across instances

From the banking repo root (one folder above `terraform/`):

```bash
cd ..
API_BASE="$ALB/api" node test.js
```

You should see `Succeeded: 20 | Rejected: 30`, Alice at `$0.00`, Bob at `$400.00`, the total at `$400.00` and `PASS`. The requests are spread across different instances and workers. On the Atlas free tier (100 operations per second) it runs slower than on a laptop, but the result must be identical.

### B12. Load test the banking API

Create a user for the test, then hit `login`, which is CPU-heavy because of bcrypt:

```bash
curl -X POST $ALB/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"Load","email":"load@test.com","password":"password123"}'

npx autocannon -c 30 -d 300 -t 30 -m POST \
  -H 'content-type: application/json' \
  -b '{"email":"load@test.com","password":"password123"}' \
  "$ALB/api/auth/login"
```

Watch the scaling the same way as step A7, using the group name `bank-asg`:

```bash
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names bank-asg \
  --query 'AutoScalingGroups[0].[DesiredCapacity,length(Instances)]' --output text
```

If latency climbs while CPU stays low, the Atlas free tier is the bottleneck, not your instances.

### B13. Update the banking API later

**New code:**

```bash
git add . && git commit -m "change" && git push

cd packer
packer build \
  -var 'repo_url=https://github.com/ShivanshKumar760/banking-cluster-api.git' \
  -var 'app_dir=/opt/banking-api' \
  -var 'smoke_test=false' \
  -var 'ami_name_prefix=bank-api-ami' .

cd ../terraform
terraform apply
```

Terraform picks up the newest `bank-api-ami*`, updates the launch template, and the ASG replaces the instances in rolling batches (at least half stay healthy).

**New secret or pool size:** set `TF_VAR_app_env` again (step B7, with the new value) and run `terraform apply`. The instances are refreshed with the new `.env`.

---

## Part C: Tear everything down

Run these from the right folder, one stack at a time.

```bash
cd ~/aws-asg/banking-cluster-api/terraform
terraform destroy
```

```bash
cd ~/aws-asg/load_test/terraform
terraform destroy
```

Type `yes` each time. Destroy removes the ASG and its instances, launch template, load balancer, target group, NAT gateway and its Elastic IP, subnets, route tables, internet gateway, security groups and VPC, in the right order. The load balancer and NAT gateway can take a few minutes.

Then remove what Terraform does not manage, the AMIs and their snapshots. Run once for each prefix:

```bash
for prefix in simple-api-ami bank-api-ami; do
  for ami in $(aws ec2 describe-images --owners self \
      --filters "Name=name,Values=${prefix}*" --query 'Images[].ImageId' --output text); do
    snaps=$(aws ec2 describe-images --image-ids "$ami" \
      --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text)
    echo "removing $ami"
    aws ec2 deregister-image --image-id "$ami"
    for s in $snaps; do aws ec2 delete-snapshot --snapshot-id "$s"; done
  done
done
```

Last clean-up items:

- **Atlas:** remove the NAT IP from Network Access, and delete the `bank_app` database user (or the cluster) if you no longer need them.
- **Local files:** delete `jwt.secret` if you will not use it again. Never commit it.
- **Check nothing is still billing:**

  ```bash
  aws ec2 describe-nat-gateways --filter Name=state,Values=pending,available --query 'NatGateways[].NatGatewayId'
  aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName'
  aws ec2 describe-addresses --query 'Addresses[].PublicIp'
  aws ec2 describe-instances --filters Name=instance-state-name,Values=pending,running \
    --query 'Reservations[].Instances[].InstanceId'
  ```

  Each should print an empty list (or only resources you created for other projects).

---

## Part D: When something goes wrong

| Symptom | Likely cause and fix |
|---|---|
| `aws sts get-caller-identity` fails | Credentials not set. Run `aws configure` or `aws sso login`. |
| Packer: no default VPC or subnet | Run `aws ec2 create-default-vpc`, then build again. |
| Packer: timeout waiting for SSH | Your network blocks outbound SSH, or the build instance got no public IP. Try another network, or use the default VPC. |
| Packer: `UnauthorizedOperation` | Your AWS user lacks EC2 permissions (run instances, create images, key pairs, security groups). |
| Packer fails at the smoke test (simple API) | The app did not start. Check that `package-lock.json` and `ecosystem.config.cjs` are committed and that the branch name is right. |
| Terraform: `Your query returned no results` for the AMI | No AMI with that name prefix in this region. Run the Packer build, and check that `ami_name_prefix` and the region match on both sides. |
| Terraform: load balancer or target group name already exists | Another stack or leftover resource uses the name. Use a different `project_name`, or delete the leftover. |
| Targets stay `unhealthy` (simple API) | Check that `package-lock.json` was committed and that PM2 started the app. Connect with an EC2 Instance Connect Endpoint and read `/var/log/cloud-init-output.log`. |
| Targets stay `unhealthy` (banking API) | Almost always Atlas: the NAT IP is not in Network Access, or not yet Active, or `MONGO_URI` has a wrong password or unescaped special characters. Check `pm2 logs banking-api` on an instance. |
| Instances keep being replaced (banking API) | Same cause as above, plus check that the health grace period (120 s) is enough. Fix Atlas, then wait. |
| `MONGO_URI is missing` in the logs | `app_dir` in Terraform does not match the folder PM2 runs in, or `TF_VAR_app_env` was empty when you applied. Re-export it and apply again. |
| Terraform asks you for a value for `app_env` or says it is not valid JSON | The `export TF_VAR_app_env=...` was not run in this terminal. Run step B7 again. |
| `terraform destroy` hangs on a subnet or security group | A stray instance or network interface still uses it. Terminate leftover instances and retry. |
| Transfers return `400` about the Idempotency-Key | The key is required. Send `-H "Idempotency-Key: $(uuidgen)"` with every transfer. |
| Scaling never happens | CPU did not reach 60%. Use the heavier load test, and remember scale-in takes about 15 minutes. Without detailed monitoring (on by default here) reaction is much slower. |

---

## Quick reference: the whole thing in order

Simple API:

```bash
cd ~/aws-asg/load_test/packer
packer init . && packer build -var 'repo_url=https://github.com/ShivanshKumar760/load_test.git' -var 'repo_branch=main' .
cd ../terraform
terraform init && terraform apply
terraform output alb_url
```

Banking API:

```bash
cd ~/aws-asg/banking-cluster-api/packer
packer init . && packer build -var 'repo_url=https://github.com/ShivanshKumar760/banking-cluster-api.git' \
  -var 'app_dir=/opt/banking-api' -var 'smoke_test=false' -var 'ami_name_prefix=bank-api-ami' .
cd ../terraform
terraform init && terraform apply -var create_asg=false
terraform output nat_gateway_public_ips          # allow this IP in Atlas, wait for Active
export MONGO_URI='<your-atlas-connection-string>'
export TF_VAR_app_env="$(jq -nc --arg uri "$MONGO_URI" --arg jwt "$(cat ../jwt.secret)" \
  '{MONGO_URI: $uri, JWT_SECRET: $jwt, DB_POOL_SIZE: "5"}')"
terraform apply
terraform output alb_url
```s