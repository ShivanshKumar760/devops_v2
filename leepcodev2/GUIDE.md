# Mini LeetCode on DigitalOcean Kubernetes: 3 Regions, One Global Entry Point

India (Bangalore) · America (New York) · Singapore

> The diagrams in this guide are written in Mermaid. They render automatically on GitHub and in most Markdown viewers; in a plain text editor you will see the diagram source instead.

## Part 0: What you are building

```mermaid
flowchart TB
    users["Users worldwide"] --> dns["leetcode.example.com<br/>DNS: 2 IPv4 + 2 IPv6 records"]
    dns --> glb["DigitalOcean Global Load Balancer<br/>anycast IPs, routes to the nearest region<br/>(Step 6)"]
    reg[("DigitalOcean Container Registry<br/>one registry, images for all 3 clusters<br/>(Step 2 and Step 4c)")]

    subgraph india["India - blr1"]
        lb1["Regional load balancer"] --> c1["DOKS cluster<br/>judge + runner + mongo"]
    end
    subgraph america["America - nyc3"]
        lb2["Regional load balancer"] --> c2["DOKS cluster<br/>judge + runner + mongo"]
    end
    subgraph singapore["Singapore - sgp1"]
        lb3["Regional load balancer"] --> c3["DOKS cluster<br/>judge + runner + mongo"]
    end

    glb --> lb1
    glb --> lb2
    glb --> lb3
    reg -.->|image pulls| c1
    reg -.->|image pulls| c2
    reg -.->|image pulls| c3
```

A user in India lands on `blr1`, a user in the US on `nyc3`, a user in Singapore on `sgp1`. Each cluster is a full copy: a public **judge** and a private **runner**.

### Read this first (honest notes)

- **Anycast comes from DigitalOcean's Global Load Balancer (GLB).** DigitalOcean has no separate "anycast product". Its docs say a GLB routes users to the nearest available backend, and DigitalOcean's own GLB Terraform module describes it as providing worldwide anycast IPs. The docs don't spell out the routing internals, so **Step 8 shows how to test it** instead of taking it on faith.
- **"Nearest" means nearest by network, not by country.** A user in Dubai could land in Bangalore or Singapore. If you need to force an order, the GLB supports `region_priorities` (see Step 6).
- **The GLB can only sit in front of *regional HTTP* load balancers.** Newer DOKS versions create *network* load balancers by default, so the manifest sets `do-loadbalancer-type: REGIONAL` explicitly. Don't remove that line.
- **Each region has its own MongoDB.** Problems and submissions are stored in MongoDB (pymongo), on a persistent disk, so they survive restarts. But the three databases are independent: every region seeds the same starter problems, while submissions stay in the region where they were made. Syncing them across continents needs a global database, which is a bigger design.
- **MongoDB here is a single pod.** No replica set, so no automatic failover inside a region (the Global Load Balancer still fails over *between* regions). Back it up before you delete anything (see Part 3).
- **Untested against a real DigitalOcean account.** I validated the Python tests, the YAML, the Terraform syntax and the shell syntax. I could not run `terraform apply` or create clusters. The GLB block in Step 6 is the part most worth checking with `terraform plan`, because the GLB settings come from DigitalOcean's docs, not from a run. The tests use `mongomock` (a fake MongoDB), so the first real-MongoDB run happens on your cluster: if the judge shows "not ready", read its logs (Part 2b has the commands).
- **Images live in DigitalOcean Container Registry (DOCR), one registry for all three clusters.** The free Starter plan allows only 1 repository and we have 2 images, so you need the Basic plan (5 repositories, 5 GiB; $5 per month on DigitalOcean's pricing page when I checked). The registry sits in one region, so clusters elsewhere pull images across regions. If the registry is down, running pods keep running, but new pods that need an image the node doesn't have will wait.
- **Security:** container limits stop accidents, not determined attackers. The runner is isolated (own node pool, no network access, non-root, read-only filesystem), but for public traffic add a stronger sandbox such as gVisor or a hosted judge like Judge0.

---

## Part 1: What you need installed

| Tool | Why | Check |
|---|---|---|
| DigitalOcean account + API token | Create clusters and load balancers | token from the control panel (API → Tokens) |
| `doctl` | DigitalOcean CLI: creates clusters (Option B) and downloads the kubeconfig | `doctl version` |
| `kubectl` | Talk to Kubernetes | `kubectl version --client` |
| `terraform` | Creates clusters and the GLB | `terraform version` |
| `docker` (with buildx) | Builds images | `docker buildx version` |
| `envsubst` | Fills `${REGION}` in the manifest (package `gettext`) | `envsubst --version` |
| `openssl` | Generates the MongoDB password | `openssl version` |
| Python 3.12 | Run the tests locally | `python3 --version` |
| DigitalOcean Container Registry (Basic plan) | Stores the Docker images for all three clusters, created in Step 2 | |
| A domain name | The public address | |

```bash
export DIGITALOCEAN_TOKEN="your-token-here"   # Terraform and doctl both read this
doctl auth init -t "$DIGITALOCEAN_TOKEN"
```

---

## Part 2: What to create, and in what order

```
leetcode/
├── runner/runner.py              ← 1a
├── judge/judge.py                ← 1b
├── judge/index.html              ← 1c
├── tests/test_judge.py           ← 1d
├── docker/Dockerfile.runner      ← Step 2
├── docker/Dockerfile.judge       ← Step 2
├── scripts/build-push.sh         ← Step 2
├── k8s/leetcode.yaml             ← Step 3
├── terraform/clusters/main.tf    ← Step 4  (Option A: Terraform)
├── scripts/create-clusters-doctl.sh ← Step 4 (Option B: command line)
├── scripts/get-kubeconfig.sh     ← Step 4b (creates do_kube_config)
├── scripts/connect-registry.sh   ← Step 4c (registry → all 3 clusters)
├── scripts/deploy.sh             ← Step 5
├── terraform/glb/main.tf         ← Step 6  (anycast configuration)
├── scripts/verify.sh             ← Step 8
├── .gitignore                    ← Step 4b
└── do_kube_config                ← generated in Step 4b, never commit it
```

| Step | What | Why this comes here |
|---|---|---|
| 1 | Python files | Everything else packages or deploys them |
| 2 | Docker images, pushed to DigitalOcean Container Registry | Kubernetes needs images to pull, and the registry must exist before the clusters connect to it |
| 3 | Kubernetes manifest (architecture: Part 2c) | Describes how the images, MongoDB and its disk run |
| 4 | Clusters (Terraform *or* `doctl`) with **edge node configuration**, then the `do_kube_config` file and the registry connection (Step 4c) | The manifest needs clusters to run on, `kubectl` needs the file to reach them, and the clusters need the registry secret to pull images |
| 5 | Deploy | Creates the pods and the three regional load balancers |
| 6 | **Anycast configuration** (GLB) | Needs the three regional load balancers from Step 5 |
| 7 | **DNS configuration** | Needs the GLB's addresses from Step 6 |
| 8 | Verify | Everything must exist first |

Create the folders:

```bash
mkdir -p leetcode/runner leetcode/judge leetcode/tests leetcode/docker \
         leetcode/k8s leetcode/scripts leetcode/terraform/clusters leetcode/terraform/glb
cd leetcode
```

---

## Part 2b: Kubernetes explained (read this if Kubernetes is new to you)

### The one-sentence idea

You don't tell Kubernetes *what to do*. You write down *what you want to exist* ("2 copies of the judge, 1 database with a disk, a public address"), and Kubernetes keeps making reality match. If a copy crashes, it starts another one.

### The building blocks

| Word | Plain meaning | In this project |
|---|---|---|
| **Cluster** | A group of machines managed together | 3 clusters: `blr1`, `nyc3`, `sgp1` |
| **Node** | One machine (a DigitalOcean Droplet) in the cluster | `edge` pool and `sandbox` pool |
| **Pod** | The smallest unit: one running container (sometimes a few). Disposable: when it dies, its files die with it | `judge-xxxx`, `runner-xxxx`, `mongo-0` |
| **Deployment** | "Keep N identical pods running." Replaces dead ones, does rolling updates | judge, runner |
| **StatefulSet** | Like a Deployment, but each pod keeps a fixed name (`mongo-0`) and its own disk | mongo |
| **Service** | A stable address in front of pods. Pods come and go, the Service name doesn't | `runner`, `mongo`, `judge` |
| **Namespace** | A folder that groups objects | `leetcode` |
| **Secret** | Small sensitive values (passwords). Base64 is *encoding*, not encryption: anyone allowed to read the Secret can decode it | `mongo-auth` |
| **PVC / PV / StorageClass** | A disk that outlives pods (explained below) | `data-mongo-0` |
| **HPA** | Adds or removes pods automatically based on load | runner: 2 to 6 pods |
| **NetworkPolicy** | A firewall between pods | runner and mongo lockdown |
| **CRD** | A way to teach Kubernetes new object types (explained below) | none used, but important to know |

Three more words you'll see in the manifest:

- **Labels and selectors** are the glue. A pod carries `labels: {app: judge}`. A Service or Deployment finds its pods with `selector: {app: judge}`. If the labels don't match, nothing connects.
- **Probes** are health checks. A *readiness* probe decides "should this pod receive traffic yet?". Ours check `/ready` (judge), `/` (runner) and a MongoDB ping.
- **requests / limits** are CPU and memory. A *request* is what the scheduler reserves for the pod; a *limit* is the maximum before it's throttled or killed.

### How the pieces sit in ONE cluster

```mermaid
flowchart TB
    net["Internet / Global Load Balancer"] --> svcj["Service: judge<br/>type LoadBalancer"]

    subgraph ns["namespace: leetcode"]
        subgraph edgepool["edge node pool"]
            judge["judge pods x2"]
            mongo["pod mongo-0"]
        end
        subgraph sandboxpool["sandbox node pool (tainted)"]
            runner["runner pods x2 to x6<br/>run untrusted code"]
        end
        svcr["Service: runner :5001"]
        svcm["Service: mongo :27017"]
        pvc[("PVC data-mongo-0<br/>5Gi block storage")]
    end

    svcj --> judge
    judge --> svcr --> runner
    judge --> svcm --> mongo
    mongo --- pvc
```

### Anatomy of a manifest (YAML) file

Every Kubernetes object has the same four top-level fields:

```yaml
apiVersion: apps/v1          # 1. which version of the Kubernetes API defines this kind
kind: Deployment             # 2. WHAT you are creating
metadata:                    # 3. its identity
  name: judge
  namespace: leetcode
spec:                        # 4. WHAT YOU WANT (the rest depends on the kind)
  replicas: 2                #    "keep 2 pods running"
  selector:                  #    "the pods that belong to me are the ones labelled app=judge"
    matchLabels: {app: judge}
  template:                  #    "when you create a pod, use this blueprint"
    metadata:
      labels: {app: judge}   #    must match the selector above
    spec:
      containers:
        - name: judge
          image: registry.digitalocean.com/my-registry/leetcode-judge:v1
          ports: [{containerPort: 8080}]
```

- One file can hold many objects, separated by a line containing only `---`. Our `k8s/leetcode.yaml` holds 10.
- YAML uses **indentation** (spaces, never tabs) for nesting. `- ` starts a list item. `{a: b}` is a compact one-line version of a nested block.
- `kubectl apply -f file.yaml` is **declarative and repeatable**: run it again and Kubernetes only changes what differs.
- `${REGION}` and friends are *not* Kubernetes syntax. They are placeholders our `deploy.sh` fills in with `envsubst` before sending the file.

### What each object in `k8s/leetcode.yaml` does

| Order | Object | Job |
|---|---|---|
| 1 | Namespace `leetcode` | Folder for everything |
| 2 | Deployment `runner` | 2 runner pods, only on `sandbox` nodes |
| 3 | Service `runner` | Internal address `runner:5001` |
| 4 | NetworkPolicy `runner-lockdown` | Only the judge may call the runner; the runner can call nothing |
| 5 | HPA `runner` | Scale runner pods 2 to 6 on CPU |
| 6 | StatefulSet `mongo` | 1 MongoDB pod + a 5Gi disk |
| 7 | Service `mongo` | Internal address `mongo:27017` |
| 8 | NetworkPolicy `mongo-lockdown` | Only the judge may reach the database |
| 9 | Deployment `judge` | 2 judge pods, only on `edge` nodes |
| 10 | Service `judge` (LoadBalancer) | Public regional load balancer |

Order inside the file doesn't matter much to Kubernetes, it retries until dependencies exist (a pod waits for the Secret and the disk). We keep a readable order anyway.

### Storage: PVC, PV and StorageClass

**The problem.** A pod's filesystem is thrown away when the pod dies. A database can't live like that.

**The solution** is three objects that work together:

| Object | Plain meaning | Who creates it |
|---|---|---|
| **StorageClass** | A *type* of disk ("DigitalOcean block storage"). Named `do-block-storage` | DigitalOcean (already in every DOKS cluster) |
| **PVC** (PersistentVolumeClaim) | A *request*: "I need 5Gi of that type" | Us, through `volumeClaimTemplates` |
| **PV** (PersistentVolume) | The *actual disk* that satisfies the claim | Kubernetes, automatically |

What happens when you deploy:

```mermaid
flowchart LR
    sts["StatefulSet: mongo<br/>volumeClaimTemplates"] -->|creates| pvc["PVC: data-mongo-0<br/>asks for 5Gi of do-block-storage"]
    pvc -->|DigitalOcean provisions| pv[("PV = a real<br/>block-storage volume")]
    pv -->|attached to the node| pod["Pod mongo-0<br/>mounted at /data/db"]
```

How long does the data live?

| Event | Data |
|---|---|
| Pod `mongo-0` crashes or is restarted | **Kept.** The new pod reattaches the same disk |
| You update the StatefulSet or the image | **Kept** |
| You delete the StatefulSet | **Kept.** The PVC stays |
| You delete the **namespace** (or the PVC) | **Usually deleted**, and the DigitalOcean volume with it, depending on the StorageClass's reclaim policy (`kubectl get storageclass`) |

`ReadWriteOnce` means one node at a time may mount the disk. `fsGroup: 999` in the manifest makes the mounted disk writable by the `mongo` user, and without it MongoDB fails with "permission denied" on `/data/db`.

```bash
kubectl --context CTX -n leetcode get pvc          # STATUS must be Bound
kubectl --context CTX get pv                       # the disks behind the claims
kubectl get storageclass                           # what disk types exist
doctl compute volume list                          # the real DigitalOcean volumes (and their cost)
```

### MongoDB on Kubernetes: how our setup works

- **StatefulSet, not Deployment**, because a database needs a stable name (`mongo-0`) and its own disk.
- **Headless Service** (`clusterIP: None`): the name `mongo` resolves straight to the pod. The judge connects to `mongo:27017`.
- **Password in a Secret.** `deploy.sh` generates a random password once per cluster and stores it as Secret `mongo-auth`. The MongoDB image uses it to create the admin user on first start, and the judge reads the same Secret. The password is never in git or in the YAML.
- **pymongo in the judge.** The judge builds `mongodb://user:password@mongo:27017/?authSource=admin` from environment variables, and uses database `leetcode` with two collections: `problems` and `submissions`.
- **Seeding.** On start, the judge inserts the two starter problems *only if they don't exist yet*. After that MongoDB is the source of truth, so you can add or edit problems in the database and they survive restarts.
- **Readiness.** The judge reports "not ready" if MongoDB is unreachable. With no ready pods, that region's load balancer health check fails, and the Global Load Balancer sends users to another region.
- **Each region has its own separate MongoDB.** Problems are identical (same seed), but submissions are per region and not synchronized.
- **Single node = no high availability.** If the node holding the disk fails, the database is down until it recovers. Real production setups use a replica set (3 members) or a managed database.

### CRD: Custom Resource Definitions (and operators)

Kubernetes ships with built-in kinds: Pod, Deployment, Service, PVC, and so on. A **CRD** is a way to add *new* kinds. Once a CRD is installed you can write, for example:

```yaml
kind: SomeDatabase          # not built in! it exists because a CRD defined it
spec:
  members: 3
  version: "7.0"
```

By itself that's just stored data. It becomes useful when paired with an **operator**: a program running in the cluster that watches those custom objects and does the real work (creating StatefulSets, disks, users, backups, failover). So:

```mermaid
flowchart LR
    crd["CRD<br/>teaches Kubernetes a new kind,<br/>e.g. SomeDatabase"] --> res["Your resource<br/>kind: SomeDatabase<br/>members: 3"]
    res -->|watched by| op["Operator<br/>a program running in the cluster"]
    op -->|creates and heals| objs["StatefulSets, disks,<br/>users, backups, pods"]
```

**Why we did *not* use one here.** Our MongoDB is one pod, so a plain StatefulSet is easier to read and learn from. Everything in `k8s/leetcode.yaml` uses built-in kinds only. (The HPA looks fancy but is built in.)

**When you would.** If you want a 3-member MongoDB replica set with automated failover and backups, install a MongoDB operator and declare it through its CRD instead of hand-writing StatefulSets. Operators exist from MongoDB itself and from other vendors. Check each project's current docs before choosing, since I haven't verified their current status or manifests. Another route is DigitalOcean's managed database service, if it offers MongoDB in your three regions at a price that suits you.

See CRDs on any cluster:

```bash
kubectl get crd                        # every custom type installed (probably empty on a fresh DOKS cluster)
kubectl api-resources                  # EVERY kind the cluster knows, built-in and custom
kubectl explain statefulset.spec       # built-in documentation for any field
```

### `kubectl` cheat sheet

`kubectl` is the command that talks to a cluster. We have three clusters, so you must say *which*. Each cluster is a **context** inside your kubeconfig file (`do_kube_config`, created in Step 4b), named like `do-blr1-leetcode-blr1`.

```bash
export KUBECONFIG="$PWD/do_kube_config"          # tell kubectl which file to read (Step 4b)
kubectl config get-contexts                       # list the 3 clusters
CTX=do-blr1-leetcode-blr1                         # pick one
alias k="kubectl --context $CTX -n leetcode"      # shortcut: context + namespace
```

| I want to... | Command |
|---|---|
| See everything running | `k get pods` · `k get all` · `k get pods -o wide` (shows nodes) |
| See disks, secrets, policies | `k get pvc` · `k get secret` · `k get networkpolicy` |
| Why is a pod stuck? | `k describe pod <name>` (read the **Events** at the bottom) |
| Recent problems in the namespace | `k get events --sort-by=.lastTimestamp` |
| Read logs | `k logs deploy/judge` · `k logs -f deploy/judge` · `k logs <pod> --previous` (after a crash) |
| Open a shell in a pod | `k exec -it mongo-0 -- bash` |
| Reach a service from your laptop | `k port-forward svc/judge 8080:80` then open http://localhost:8080 |
| Apply or update YAML | `kubectl --context $CTX apply -f k8s/leetcode.yaml` |
| Scale | `k scale deploy/judge --replicas=3` |
| Restart a Deployment | `k rollout restart deploy/judge` |
| Roll back a bad release | `k rollout undo deploy/judge` |
| Watch a rollout | `k rollout status deploy/judge` |
| CPU and memory use | `k top pods` · `kubectl --context $CTX top nodes` |
| Delete something | `k delete pod <name>` (a new one appears) · `k delete namespace leetcode` (**everything**, including disks) |

Pod status words: `Pending` (waiting for a node or a disk), `ContainerCreating` (pulling the image), `Running`, `CrashLoopBackOff` (keeps crashing: read `logs --previous`), `ImagePullBackOff` (can't download the image), `Completed`.

### Deploying by hand to ONE cluster (to see what `deploy.sh` automates)

```bash
export IMAGE_PREFIX=registry.digitalocean.com/YOUR_REGISTRY TAG=v1 REGION=blr1
doctl kubernetes cluster kubeconfig show leetcode-blr1 > do_kube_config   # 1. get access (Step 4b)
export KUBECONFIG="$PWD/do_kube_config"
CTX=do-blr1-leetcode-blr1

kubectl --context $CTX create namespace leetcode                # 2. folder
kubectl --context $CTX -n leetcode create secret generic mongo-auth \
  --from-literal=username=leetcode_admin \
  --from-literal=password="$(openssl rand -hex 16)"             # 3. database password

envsubst '${REGION} ${IMAGE_PREFIX} ${TAG}' < k8s/leetcode.yaml \
  | kubectl --context $CTX apply -f -                            # 4. create everything

kubectl --context $CTX -n leetcode get pods -w                  # 5. watch pods start (Ctrl+C to stop)
kubectl --context $CTX -n leetcode get svc judge                # 6. EXTERNAL-IP appears after ~1-2 min
```

What you should see: `mongo-0` goes `Pending → Running` (waiting for the disk first), then `judge` pods become `1/1 Ready` once MongoDB answers.

---

## Part 2c: Kubernetes architecture (what is really running inside a cluster)

Part 2b described the *objects* you write. This part describes the *machinery* that makes them real. A DigitalOcean Kubernetes (DOKS) cluster has three layers: a **control plane** (the brain), **worker nodes** (the muscle), and **add-ons** (plumbing). Each of our three regions has its own complete copy.

```mermaid
flowchart TB
    you["You: kubectl + do_kube_config"] -->|HTTPS| api

    subgraph cp["Control plane - managed by DigitalOcean, you cannot log in to it"]
        api["API server<br/>the only front door"]
        etcd[("etcd<br/>stores every Kubernetes object")]
        sched["Scheduler<br/>picks a node for each pod"]
        cm["Controller manager<br/>Deployment, StatefulSet and HPA loops"]
        ccm["Cloud controller manager<br/>talks to the DigitalOcean API"]
        api <--> etcd
        sched --> api
        cm --> api
        ccm --> api
    end

    ccm -->|creates| lb["Regional load balancer"]

    subgraph workers["Worker nodes - your Droplets, billed"]
        subgraph n1["edge node"]
            kubelet1["kubelet + container runtime"]
            p1["judge and mongo pods"]
        end
        subgraph n2["sandbox node"]
            kubelet2["kubelet + container runtime"]
            p2["runner pods"]
        end
        net["Network plugin + CoreDNS<br/>pod networking, Service names, NetworkPolicy"]
        csi["DigitalOcean CSI driver<br/>attaches block-storage volumes"]
    end

    kubelet1 --> api
    kubelet2 --> api
    lb --> p1
    csi -->|creates and attaches| vol[("Block storage volume")]
```

### The components, and what each does in OUR project

| Component | Lives in | Job | In this project |
|---|---|---|---|
| **API server** | control plane | The only front door. `kubectl`, kubelets and controllers all talk to it, and it checks your credentials | Every command you run with `do_kube_config` goes here |
| **etcd** | control plane | The database of every Kubernetes *object* | Stores the Deployments, the Secret `mongo-auth`, and so on. **Not** MongoDB's data, which sits on the block volume |
| **Scheduler** | control plane | Decides which node each new pod runs on (filters by `nodeSelector`, taints and free CPU/memory) | Puts the runner on `sandbox` nodes, and the judge and mongo on `edge` nodes |
| **Controller manager** | control plane | Many small loops that compare "what you asked for" with "what exists" and fix the difference | Keeps 2 judge pods alive, recreates `mongo-0`, makes the HPA add runner pods |
| **Cloud controller manager** | control plane | Connects Kubernetes to the DigitalOcean API | Reads the `do-loadbalancer-*` annotations and creates the regional load balancer `leetcode-<region>` |
| **kubelet** | every node | The agent: starts containers, runs probes, mounts volumes and Secrets, reports status | Runs the readiness checks, mounts `/data/db`, injects the `mongo-auth` password |
| **Container runtime** | every node | Actually runs the containers (for example containerd) | Runs your three images and `mongo:7.0` |
| **Network plugin (CNI)** | every node | Gives pods IP addresses, routes pod traffic, and **enforces NetworkPolicy** | `runner-lockdown` and `mongo-lockdown` |
| **Service routing** | every node | Makes a Service name reach a healthy pod behind it | `judge` calling `runner:5001` and `mongo:27017` |
| **CoreDNS** | add-on (2 replicas by default) | Turns names like `runner` into addresses | Why the judge can say `http://runner:5001` |
| **CSI driver** | add-on | Creates and attaches DigitalOcean block-storage volumes for PVCs | Makes the 5Gi disk behind `data-mongo-0` |
| **metrics-server** | add-on | Reports pod CPU and memory | The HPA scales the runner from these numbers |
| **Cluster autoscaler** | managed | Adds or removes Droplets in an auto-scaling node pool | `edge` 2 to 4 nodes, `sandbox` 1 to 3 nodes |

DigitalOcean runs the control plane for you, so you can't log in to those machines. DigitalOcean's documentation also says not to modify the managed components that come pre-installed (for example CoreDNS and Cilium). Names and details of the add-ons vary by DOKS version. See what runs in your cluster with:

```bash
kubectl --context do-blr1-leetcode-blr1 -n kube-system get pods
```

### What happens when you run `kubectl apply` (or `deploy.sh`)

Nobody tells the pods to start. You write the *desired state* into the API server, then independent components each notice their part and act on it:

```mermaid
sequenceDiagram
    actor You
    participant API as API server
    participant Etcd as etcd
    participant Ctl as Controller manager
    participant Sch as Scheduler
    participant Kub as kubelet on a node
    participant CCM as Cloud controller manager
    participant DO as DigitalOcean API

    You->>API: kubectl apply - Deployment judge x2 and Service type LoadBalancer
    API->>Etcd: store the desired state
    Ctl->>API: sees a Deployment with no pods, creates 2 pods
    Sch->>API: sees pods with no node, picks nodes using nodeSelector and taints
    Kub->>API: sees pods assigned to my node
    Kub->>Kub: pulls the image, starts the container, runs the readiness probe
    CCM->>API: sees a Service of type LoadBalancer
    CCM->>DO: create regional load balancer leetcode-blr1
    DO-->>CCM: public IP address
    CCM->>API: writes the IP into the Service status
    You->>API: kubectl get svc judge now shows the EXTERNAL-IP
```

This "write the goal, let components react" design is why everything is repeatable and self-healing.

### The life of one submission through the architecture

```mermaid
sequenceDiagram
    actor User
    participant GLB as Global load balancer
    participant RLB as Regional LB blr1
    participant Judge as judge pod
    participant Mongo as mongo-0 pod
    participant Run as runner pod

    User->>GLB: POST /api/submit
    GLB->>RLB: forwards to the nearest healthy region
    RLB->>Judge: reaches a judge pod through the Service named judge
    Judge->>Mongo: find the problem by _id, including hidden tests
    Mongo-->>Judge: problem document
    loop for each test case until one fails
        Judge->>Run: POST /execute with user code plus test driver, via Service runner
        Run-->>Judge: stdout, stderr, exit_code
    end
    Judge->>Mongo: insert the submission
    Judge-->>User: verdict JSON with header X-Served-By blr1
```

Three details worth noticing: the user never talks to MongoDB or the runner (only the judge does), the hidden test cases travel only between MongoDB and the judge, and the response carries `X-Served-By` so you can see which region answered.

### Self-healing: who notices a failure?

| What breaks | Who notices | What happens |
|---|---|---|
| A judge or runner pod crashes | kubelet, then the Deployment controller | The container restarts, or a replacement pod is created |
| A pod fails its readiness probe (for example MongoDB is down) | kubelet | The pod is taken out of the Service, so no traffic reaches it |
| A whole node dies | Controller manager | Stateless pods (judge, runner) are recreated on other nodes. `mongo-0` waits until its disk can be attached to a healthy node |
| Runner pods get busy | HPA (needs metrics-server) | More runner pods are added, from 2 up to 6 |
| No room for new pods | Cluster autoscaler | A new Droplet joins the pool, up to the maximum |
| Every judge pod in one region is unhealthy | The regional load balancer's health check, then the Global Load Balancer | Users are sent to another region |
| The registry (or its region) is unavailable | kubelet | Running pods are unaffected. A new pod needing an image the node doesn't already have waits in `ImagePullBackOff` until the registry is back |
| The control plane has a problem | DigitalOcean | Already-running pods keep running, but you can't change anything until it is back |

The three regions are **separate clusters that don't know about each other**. The only link between them is the Global Load Balancer in front, and there is no shared data.

### Check that the architecture works on YOUR cluster

Run these once after deploying (use `export KUBECONFIG="$PWD/do_kube_config"` and the `k` alias from Step 5):

```bash
# 1. Does the HPA have CPU numbers? (needs metrics-server)
k top pods                      # shows CPU and memory. An error means metrics-server is missing
k get hpa                       # TARGETS should show a percentage, not <unknown>

# 2. Which pods are behind a Service?
k describe svc runner           # look at the "Endpoints:" line: the runner pod IPs
k get pods -o wide              # NODE column: runner pods on sandbox nodes, judge and mongo on edge nodes

# 3. Is the NetworkPolicy really enforced? (this protects you from submitted code)
k exec deploy/judge -- python -c "import urllib.request; print(urllib.request.urlopen('http://runner:5001/', timeout=3).read())"
#    expected: prints {"status":"ok"}   (the judge is allowed in)

k run np-test --rm -it --restart=Never --image=busybox:1.36 -- wget -qO- -T 3 http://runner:5001/
#    expected: times out or fails     (any other pod is blocked)

k exec deploy/runner -- python -c "import urllib.request; urllib.request.urlopen('http://example.com', timeout=3)"
#    expected: an error                (the runner can call nothing, not even the internet)
```

**If the second test prints `{"status":"ok"}`, or the third succeeds, your cluster is not enforcing NetworkPolicy**, and the runner is not isolated. DigitalOcean's documentation refers to Cilium as the DOKS network plugin, but it also describes installing Cilium yourself, and I couldn't confirm what your cluster version enforces. Do not put this in front of untrusted users until all three behave as expected.

---

## Step 1: The Python files

### 1a. `runner/runner.py`: runs submitted code

The worker. It takes Python code, runs it with limits (5 s, 128 MB, 64 processes), and returns what it printed. It knows nothing about problems.

```python
# ============================================================
# RUNNER SERVICE  (the "worker")
# Job: take Python code, run it safely-ish, return what it printed.
# It knows NOTHING about problems or test cases.
# ============================================================
import os, resource, subprocess, sys, tempfile
from flask import Flask, request, jsonify

app = Flask(__name__)


def set_limits():
    """Runs inside the child process just before the user's code starts."""
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))                    # max 5 sec of CPU
    resource.setrlimit(resource.RLIMIT_AS, (128 * 2**20,) * 2)         # max 128 MB memory
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))                # max 64 processes (fork bombs)
    resource.setrlimit(resource.RLIMIT_FSIZE, (2**20, 2**20))          # max 1 MB file writes


@app.route("/")
def health():
    return jsonify(status="ok")


@app.route("/execute", methods=["POST"])
def execute():
    code = (request.get_json(silent=True) or {}).get("code")
    if not isinstance(code, str) or not code:
        return jsonify(error="send JSON like {'code': '...'}"), 400

    with tempfile.TemporaryDirectory() as folder:          # folder is deleted afterwards
        path = os.path.join(folder, "script.py")
        with open(path, "w") as f:
            f.write(code)
        try:
            result = subprocess.run(
                [sys.executable, "-I", path],              # run the code as a separate process
                capture_output=True, text=True,
                timeout=5,                                  # kill after 5 seconds
                preexec_fn=set_limits,
                cwd=folder, env={},                         # empty env: no secrets leak in
            )
        except subprocess.TimeoutExpired:
            return jsonify(error="timeout"), 408

    return jsonify(stdout=result.stdout, stderr=result.stderr, exit_code=result.returncode)


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5001)))
```

### 1b. `judge/judge.py`: problems, test cases, verdicts

The boss. It keeps the problems, hidden test cases and submissions in **MongoDB** (through `pymongo`), asks the runner to execute your code on each test case, and compares the answers. Starter problems are inserted the first time it starts; the hidden tests are never sent to the browser. The `REGION` setting and the `X-Served-By` response header are what let you see which cluster answered.

```python
# ============================================================
# JUDGE SERVICE  (the "boss")
# Job: show problems, receive submissions, ask the runner to run
# the code on each test case, compare answers, return a verdict.
# Problems and submissions are stored in MongoDB (via pymongo).
# ============================================================
import json, os, time
from urllib.parse import quote_plus

import requests
from flask import Flask, request, jsonify, send_from_directory
from pymongo import MongoClient
from pymongo.errors import PyMongoError

app = Flask(__name__)

# Which cluster am I in? Set by Kubernetes. Sent back in every response so
# you can SEE which region served you (header: X-Served-By).
REGION = os.environ.get("REGION", "local")


@app.after_request
def add_region_header(resp):
    resp.headers["X-Served-By"] = REGION
    return resp


# Where the runner lives. In Kubernetes this is the Service named "runner".
RUNNER_URL = "http://" + os.environ.get("RUNNER_HOSTPORT", "localhost:5001")


# ---------- 1) DATABASE: MongoDB ----------
def build_mongo_uri():
    """Kubernetes passes MONGO_HOST/USER/PASSWORD. For local dev you can set MONGO_URI instead."""
    if os.environ.get("MONGO_URI"):
        return os.environ["MONGO_URI"]
    host = os.environ.get("MONGO_HOST")
    if not host:
        return None
    user = quote_plus(os.environ["MONGO_USER"])          # quote_plus: safe if the password has symbols
    password = quote_plus(os.environ["MONGO_PASSWORD"])
    return f"mongodb://{user}:{password}@{host}:27017/?authSource=admin"


MONGO_URI = build_mongo_uri()
# MongoClient connects lazily, so importing this file never crashes if MongoDB is still starting.
client = MongoClient(MONGO_URI or "mongodb://localhost:27017", serverSelectionTimeoutMS=3000)
db = client["leetcode"]          # database "leetcode" has 2 collections: problems, submissions

# The starting problems. They are copied into MongoDB the first time the judge starts.
SEED_PROBLEMS = [
    {
        "_id": "two-sum",        # in MongoDB, _id is the primary key
        "title": "Two Sum (Easy)",
        "description": "Return the indices of the two numbers in `nums` that add up to `target`.\n"
                       "Example: nums=[2,7,11,15], target=9 -> [0,1]",
        "function": "twoSum",
        "starter": "class Solution:\n    def twoSum(self, nums, target):\n        pass\n",
        "tests": [
            {"args": [[2, 7, 11, 15], 9], "expected": [0, 1]},
            {"args": [[3, 2, 4], 6], "expected": [1, 2]},
            {"args": [[3, 3], 6], "expected": [0, 1]},
            {"args": [[-1, -2, -3, -4, -5], -8], "expected": [2, 4]},
            {"args": [[0, 4, 3, 0], 0], "expected": [0, 3]},
        ],
    },
    {
        "_id": "valid-parentheses",
        "title": "Valid Parentheses (Easy)",
        "description": "Return True if the brackets in string `s` are closed in the correct order.\n"
                       'Example: "()[]{}" -> True,  "(]" -> False',
        "function": "isValid",
        "starter": "class Solution:\n    def isValid(self, s):\n        pass\n",
        "tests": [
            {"args": ["()"], "expected": True},
            {"args": ["()[]{}"], "expected": True},
            {"args": ["(]"], "expected": False},
            {"args": ["([)]"], "expected": False},
            {"args": ["{[]}"], "expected": True},
            {"args": ["("], "expected": False},
        ],
    },
]


def seed_problems(database):
    """Insert each problem ONLY if it doesn't exist yet ($setOnInsert).
    After that MongoDB is the source of truth: edits made in the database are never overwritten."""
    for p in SEED_PROBLEMS:
        fields = {k: v for k, v in p.items() if k != "_id"}
        database.problems.update_one({"_id": p["_id"]}, {"$setOnInsert": fields}, upsert=True)


def wait_and_seed():
    """MongoDB may start after the judge does, so retry for a while."""
    for _ in range(20):
        try:
            seed_problems(db)
            print("MongoDB ready, problems seeded", flush=True)
            return
        except PyMongoError as e:
            print("waiting for MongoDB...", e, flush=True)
            time.sleep(2)
    print("WARNING: could not reach MongoDB", flush=True)


if MONGO_URI:        # only in Kubernetes / local runs; the tests use a fake database instead
    wait_and_seed()


@app.errorhandler(PyMongoError)
def database_down(err):
    return jsonify(error="database unavailable"), 503


# ---------- 2) TALK TO THE RUNNER ----------
def call_runner(code):
    """Send code to the runner service. Returns (http_status, json_body)."""
    r = requests.post(RUNNER_URL + "/execute", json={"code": code}, timeout=15)
    return r.status_code, r.json()


def same(got, expected):
    # Two Sum may answer [1,0] or [0,1], so compare lists in sorted order.
    if isinstance(got, list) and isinstance(expected, list):
        return sorted(got) == sorted(expected)
    return got == expected


# ---------- 3) THE JUDGING LOGIC ----------
def judge(problem, user_code):
    tests = problem["tests"]
    for number, test in enumerate(tests, start=1):
        args, expected = test["args"], test["expected"]
        # Glue a tiny "test driver" under the user's code. It calls their function
        # with this test's arguments and prints the answer after a marker.
        script = (user_code + "\n\nimport json\n"
                  f"print('RESULT:' + json.dumps(Solution().{problem['function']}(*{args!r})))\n")
        try:
            status, out = call_runner(script)
        except requests.RequestException:
            return {"verdict": "Judge Error", "passed": number - 1, "total": len(tests)}

        if status == 408:
            return {"verdict": "Time Limit Exceeded", "passed": number - 1, "total": len(tests)}
        if out["exit_code"] != 0:
            return {"verdict": "Runtime Error", "passed": number - 1, "total": len(tests),
                    "error": out["stderr"][-500:]}

        # Take the last line that starts with RESULT: (user may print other stuff too)
        lines = [l for l in out["stdout"].splitlines() if l.startswith("RESULT:")]
        got = json.loads(lines[-1][len("RESULT:"):]) if lines else None
        if not same(got, expected):
            return {"verdict": "Wrong Answer", "passed": number - 1, "total": len(tests)}

    return {"verdict": "Accepted", "passed": len(tests), "total": len(tests)}


# ---------- 4) WEB ROUTES ----------
@app.route("/")
def home():
    return send_from_directory(os.path.dirname(os.path.abspath(__file__)), "index.html")


@app.route("/health")
def health():
    return jsonify(status="ok")                       # process is alive


@app.route("/ready")
def ready():
    client.admin.command("ping")                      # raises if MongoDB is down -> 503
    return jsonify(status="ready")


@app.route("/api/problems")
def list_problems():
    cursor = db.problems.find({}, {"title": 1}).sort("_id", 1)
    return jsonify([{"id": p["_id"], "title": p["title"]} for p in cursor])


@app.route("/api/problems/<pid>")
def get_problem(pid):
    # The projection hides the "tests" field, so hidden test cases never leave the server.
    p = db.problems.find_one({"_id": pid}, {"description": 1, "starter": 1})
    if not p:
        return jsonify(error="not found"), 404
    return jsonify(description=p["description"], starter=p["starter"])


@app.route("/api/submit", methods=["POST"])
def submit():
    data = request.get_json(silent=True) or {}
    pid, code = data.get("problem_id"), data.get("code")
    # isinstance(str) matters: a dict like {"$ne": null} here would be a MongoDB injection.
    if not isinstance(pid, str) or not isinstance(code, str) or not code.strip():
        return jsonify(error="need problem_id and code"), 400
    problem = db.problems.find_one({"_id": pid})
    if not problem:
        return jsonify(error="unknown problem"), 400

    result = judge(problem, code)
    db.submissions.insert_one({"problem_id": pid, "at": time.time(), **result})
    return jsonify(result)


@app.route("/api/submissions")
def submissions():
    cursor = db.submissions.find({}, {"_id": 0, "at": 0}).sort("at", -1).limit(10)
    return jsonify(list(cursor))


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5000)))
```

### 1b+. Deep dive: `same()` and `judge()`, block by block

These two functions are the heart of the project. `judge(problem, user_code)` receives a **problem document** from MongoDB (title, function name, `tests`, and so on) and the text the user submitted. It returns a small dictionary: the **verdict**, how many tests **passed**, and the **total**.

#### The whole decision in one picture

```mermaid
flowchart TD
    start(["judge(problem, user_code)"]) --> next{"another test case?"}
    next -->|"no, every test passed"| acc["Accepted"]
    next -->|yes| build["glue the test driver under the user's code"]
    build --> runit["call_runner(script)"]
    runit --> net{"runner reachable?"}
    net -->|no| je["Judge Error"]
    net -->|yes| st{"HTTP status 408?"}
    st -->|yes| tle["Time Limit Exceeded"]
    st -->|no| ex{"exit_code is not 0?"}
    ex -->|yes| rte["Runtime Error"]
    ex -->|no| parse["find the last RESULT: line and json.loads it"]
    parse --> cmp{"same(got, expected)?"}
    cmp -->|no| wa["Wrong Answer"]
    cmp -->|yes| next
```

Read it as a loop: for every test case the judge asks the runner to execute the code, then checks four things in a fixed order (network, time, crash, answer). The first problem found ends the whole judging. Only a test case that passes everything lets the loop continue.

#### `same()`: is the answer correct?

```python
def same(got, expected):
    # Two Sum may answer [1,0] or [0,1], so compare lists in sorted order.
    if isinstance(got, list) and isinstance(expected, list):
        return sorted(got) == sorted(expected)
    return got == expected
```

| Line | What it does |
|---|---|
| `def same(got, expected):` | `got` is what the user's code returned. `expected` is the answer stored in MongoDB. Returns `True` or `False`. |
| the comment | Two Sum says "return the two indices", and `[1, 0]` is as right as `[0, 1]`. A plain `==` would wrongly reject the first. |
| `if isinstance(got, list) and isinstance(expected, list):` | Only when **both** are lists do we ignore order. Booleans, numbers and strings skip this branch. |
| `return sorted(got) == sorted(expected)` | `sorted()` makes sorted *copies* (the originals are untouched) and compares them. `[1, 0]` becomes `[0, 1]`, so it equals `[0, 1]`. |
| `return got == expected` | The normal comparison for everything else (for example Valid Parentheses returns `True` or `False`). |

What it returns, checked on the real code:

| Call | Result | Why |
|---|---|---|
| `same([1, 0], [0, 1])` | `True` | Sorted lists match |
| `same([], [0, 1])` | `False` | Different lengths |
| `same(True, False)` | `False` | Plain comparison |
| `same(True, 1)` | `True` | In Python `True == 1`. Harmless for our two problems, but worth knowing |

#### `judge()`: block by block

**Block A: start.** Pull the list of test cases out of the problem document.

```python
def judge(problem, user_code):
    tests = problem["tests"]
```

`problem["tests"]` looks like `[{"args": [[2, 7, 11, 15], 9], "expected": [0, 1]}, ...]`. The tests live only on the server; the web API never sends them to the browser.

**Block B: the loop.** One pass per test case.

```python
    for number, test in enumerate(tests, start=1):
        args, expected = test["args"], test["expected"]
```

- `enumerate(tests, start=1)` hands out `(1, first_test)`, `(2, second_test)`, and so on. We start at 1 so `number` is the human test number.
- `args, expected = ...` unpacks the test: `args` is the list of arguments for the function, `expected` is the right answer.

**Block C: build the program to run.**

```python
        script = (user_code + "\n\nimport json\n"
                  f"print('RESULT:' + json.dumps(Solution().{problem['function']}(*{args!r})))\n")
```

The user only wrote a class. Nothing *calls* it, so the judge glues a tiny **test driver** underneath. For Two Sum test 1 the finished script ends like this (real output):

```python
    ...the user's code above...

import json
print('RESULT:' + json.dumps(Solution().twoSum(*[[2, 7, 11, 15], 9])))
```

| Piece | Why it is there |
|---|---|
| `user_code + "\n\nimport json\n"` | The blank lines separate our code from theirs, even if their last line has no newline. `import json` is for the next line. |
| `{problem['function']}` | The method name from MongoDB, for example `twoSum` or `isValid`. (Single quotes inside the f-string are on purpose, because the f-string itself uses double quotes.) |
| `Solution()` | The user must name their class `Solution`. |
| `{args!r}` | `!r` inserts the arguments as Python source text, `[[2, 7, 11, 15], 9]`, which is what you would type in code. |
| the `*` before it | Unpacks the list into separate arguments: `twoSum([2, 7, 11, 15], 9)` instead of one list argument. |
| `json.dumps(...)` | Turns the answer into text, since the only way back to the judge is **printed text**. |
| `'RESULT:' + ...` | A marker, so the judge can find the answer among anything else the code prints. |

**Block D: call the runner, survive network problems.**

```python
        try:
            status, out = call_runner(script)
        except requests.RequestException:
            return {"verdict": "Judge Error", "passed": number - 1, "total": len(tests)}
```

- `call_runner` returns a pair, the HTTP status number and the decoded JSON body. `status, out = ...` splits the pair.
- If the runner is down, too slow (the call has a 15 second timeout), or replies with something that isn't JSON, `requests` raises `RequestException`. That is the **judge's** problem, not the user's, so the verdict is `Judge Error`.
- `"passed": number - 1` means "tests passed before this one". Failing on test 3 means 2 passed.
- Returning ends the function immediately. Every later `if` is a stop sign like this.

A real reply from the runner for the script above:

```json
200  {"exit_code": 0, "stderr": "", "stdout": "RESULT:[0, 1]\n"}
```

**Block E: too slow.**

```python
        if status == 408:
            return {"verdict": "Time Limit Exceeded", "passed": number - 1, "total": len(tests)}
```

The runner answers HTTP **408** when the code was still running after 5 seconds, for example `while True: pass`. This check comes first because a killed program has no output to look at.

**Block F: crashed.**

```python
        if out["exit_code"] != 0:
            return {"verdict": "Runtime Error", "passed": number - 1, "total": len(tests),
                    "error": out["stderr"][-500:]}
```

Exit code `0` means the program finished normally; anything else means it crashed: an exception, a syntax error, a missing `Solution` class, or running out of memory. `out["stderr"][-500:]` keeps the **last 500 characters** of the error text, because the useful line (like `ZeroDivisionError: division by zero`) is at the end of a traceback. A real example:

```text
Traceback (most recent call last):
  File ".../script.py", line 3, in twoSum
    return 1/0
ZeroDivisionError: division by zero
```

**Block G: read the answer from the output.**

```python
        lines = [l for l in out["stdout"].splitlines() if l.startswith("RESULT:")]
        got = json.loads(lines[-1][len("RESULT:"):]) if lines else None
```

- `out["stdout"].splitlines()` cuts the printed text into lines.
- The list comprehension keeps only lines that start with `RESULT:`. If the user printed debug text, it is ignored.
- `lines[-1]` takes the **last** such line. The driver's own line is printed last, so it wins over any earlier `RESULT:` lines the user printed. Real example: stdout `'debug line\nRESULT:fake\nRESULT:[0, 1]\n'` gives `lines[-1] == 'RESULT:[0, 1]'`.
- `[len("RESULT:"):]` slices off the 7-character marker, leaving `[0, 1]`.
- `json.loads(...)` turns that text back into a Python list.
- `... if lines else None`: if no marker line exists, `got` becomes `None`, which fails the comparison in the next block.

**Block H: compare.**

```python
        if not same(got, expected):
            return {"verdict": "Wrong Answer", "passed": number - 1, "total": len(tests)}
```

The verdict deliberately does **not** include the expected answer, so users can't read the hidden tests off their failures.

**Block I: all tests passed.**

```python
    return {"verdict": "Accepted", "passed": len(tests), "total": len(tests)}
```

This line is only reached after the loop ends, which happens only when no test returned early.

#### Why one runner call per test case?

Each test is a **fresh Python process**. A test that loops forever gets its own 5 seconds, earlier results stay intact, and no state leaks from one test to the next. The price is Python's start-up time for every test, which is small for 5 to 6 tests. And because judging stops at the first failure, a wrong solution is rejected quickly.

#### Every verdict, with real output

| Situation | Caught by | Verdict returned |
|---|---|---|
| All tests pass | end of the loop | `{'verdict': 'Accepted', 'passed': 5, 'total': 5}` |
| Returns `[0, 0]` always | `same()` is `False` | `{'verdict': 'Wrong Answer', 'passed': 0, 'total': 5}` |
| `return 1/0` | exit code not 0 | `Runtime Error`, with `ZeroDivisionError` in `error` |
| No `Solution` class | exit code not 0 | `Runtime Error`, with `NameError: name 'Solution' is not defined` |
| Returns a `set` | `json.dumps` fails in the driver | `Runtime Error`, with `Object of type set is not JSON serializable` |
| `while True: pass` | HTTP 408 | `Time Limit Exceeded` |
| Runner unreachable | `RequestException` | `Judge Error` |

#### Known limitations (read before trusting it)

I ran these cases against the real code. The judge protects **your server** from submitted code. It is not cheat-proof:

1. **A mixed-type list crashes the request.** If the user returns something like `[1, "a"]`, `sorted()` raises `TypeError`, which nothing catches, so `/api/submit` answers HTTP 500 and the submission isn't saved.
2. **A forged `RESULT:` line can crash it too.** Code that prints `RESULT:oops` and then calls `sys.exit(0)` before the driver runs leaves a last `RESULT:` line that isn't valid JSON, so `json.loads` raises and the request returns 500.
3. **Scoring can be gamed.** Code can print a `RESULT:` line and exit, or read its own source file (which contains the test arguments). Containers keep this from harming the server, but a determined user can fake a pass.
4. **Memory and CPU kills look like crashes.** Running out of memory is a `Runtime Error`. A program that burns its 5 seconds of CPU may be reported as either Time Limit Exceeded or Runtime Error, depending on which limit fires first.
5. **Numbers must match exactly**, so floating point answers would need a tolerance. Not needed for these two problems.

**Optional hardening for 1 and 2** (not applied in the project files; the code above is exactly what the tests cover). Both snippets were tested and turn the crashes into a normal `Wrong Answer`:

```python
def same(got, expected):
    try:
        if isinstance(got, list) and isinstance(expected, list):
            return sorted(got) == sorted(expected)
    except TypeError:            # e.g. [1, "a"] cannot be sorted
        return False
    return got == expected
```

```python
        try:
            got = json.loads(lines[-1][len("RESULT:"):]) if lines else None
        except ValueError:       # a corrupted RESULT line
            got = None
```

### 1c. `judge/index.html`: the web page (plain HTML and JS, no CSS)

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Mini LeetCode</title></head>
<body>
  <h1>Mini LeetCode</h1>

  <select id="problem"></select>
  <pre id="description"></pre>

  <textarea id="code" rows="14" cols="80"></textarea><br>
  <button id="submit">Submit</button>

  <h3>Result</h3>
  <pre id="result">-</pre>

  <h3>Recent submissions</h3>
  <pre id="history">-</pre>

<script>
const $ = id => document.getElementById(id);

// Load the chosen problem's description + starter code
async function showProblem() {
  const res = await fetch("/api/problems/" + $("problem").value);
  const p = await res.json();
  $("description").textContent = p.description;
  $("code").value = p.starter;
}

// Show the last submissions
async function showHistory() {
  const res = await fetch("/api/submissions");
  const list = await res.json();
  $("history").textContent = list
    .map(s => s.problem_id + "  " + s.verdict + "  " + s.passed + "/" + s.total)
    .join("\n") || "-";
}

// Send code to the judge
$("submit").onclick = async () => {
  $("result").textContent = "Running...";
  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ problem_id: $("problem").value, code: $("code").value })
  });
  $("result").textContent = JSON.stringify(await res.json(), null, 2);
  showHistory();
};

// On page load: fill the dropdown, then show the first problem
(async () => {
  const res = await fetch("/api/problems");
  const problems = await res.json();
  $("problem").innerHTML = problems
    .map(p => '<option value="' + p.id + '">' + p.title + "</option>").join("");
  $("problem").onchange = showProblem;
  showProblem();
  showHistory();
})();
</script>
</body>
</html>
```

### 1d. `tests/test_judge.py`: proves the whole thing works

The tests swap the real MongoDB for `mongomock`, a fake that lives in memory, so they need no database. They also check that hidden tests stay hidden, that seeding never overwrites edits, and that a malicious `problem_id` is rejected.

```python
# Tests the judge using the real runner code and a FAKE in-memory MongoDB (mongomock).
# No network, no real database needed.
import os, sys
root = os.path.dirname(os.path.dirname(__file__))
sys.path += [os.path.join(root, "runner"), os.path.join(root, "judge")]

import mongomock
import runner, judge

# 1) Swap the real MongoDB for a fake one, then load the starting problems into it
judge.db = mongomock.MongoClient()["leetcode"]
judge.seed_problems(judge.db)

# 2) Instead of HTTP, call the runner directly
runner_client = runner.app.test_client()

def fake_call_runner(code):
    r = runner_client.post("/execute", json={"code": code})
    return r.status_code, r.get_json()

judge.call_runner = fake_call_runner
client = judge.app.test_client()

def submit(problem_id, code):
    return client.post("/api/submit", json={"problem_id": problem_id, "code": code}).get_json()


def test_two_sum_correct():
    code = """class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i
"""
    assert submit("two-sum", code)["verdict"] == "Accepted"


def test_parentheses_correct():
    code = """class Solution:
    def isValid(self, s):
        stack, pair = [], {')': '(', ']': '[', '}': '{'}
        for c in s:
            if c in pair:
                if not stack or stack.pop() != pair[c]:
                    return False
            else:
                stack.append(c)
        return not stack
"""
    assert submit("valid-parentheses", code)["verdict"] == "Accepted"


def test_wrong_answer():
    code = "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 0]\n"
    assert submit("two-sum", code)["verdict"] == "Wrong Answer"


def test_crash():
    assert submit("two-sum", "this is not python")["verdict"] == "Runtime Error"


def test_infinite_loop():
    code = "class Solution:\n    def isValid(self, s):\n        while True: pass\n"
    assert submit("valid-parentheses", code)["verdict"] == "Time Limit Exceeded"


def test_problems_come_from_mongodb_and_hide_tests():
    listing = client.get("/api/problems").get_json()
    assert {p["id"] for p in listing} == {"two-sum", "valid-parentheses"}
    one = client.get("/api/problems/two-sum").get_json()
    assert "tests" not in one and "starter" in one          # hidden tests never leave the server


def test_submissions_saved_in_mongodb():
    before = judge.db.submissions.count_documents({})
    submit("two-sum", "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 0]\n")
    assert judge.db.submissions.count_documents({}) == before + 1
    history = client.get("/api/submissions").get_json()
    assert history[0]["problem_id"] == "two-sum" and "_id" not in history[0]


def test_seeding_never_overwrites_edits():
    judge.db.problems.update_one({"_id": "two-sum"}, {"$set": {"title": "Edited in MongoDB"}})
    judge.seed_problems(judge.db)                           # simulates a restart
    assert judge.db.problems.find_one({"_id": "two-sum"})["title"] == "Edited in MongoDB"
    assert judge.db.problems.count_documents({}) == 2       # no duplicates


def test_injection_is_rejected():
    r = client.post("/api/submit", json={"problem_id": {"$ne": None}, "code": "print(1)"})
    assert r.status_code == 400
```

### 1e. Run and test locally

```bash
pip install flask gunicorn requests pymongo mongomock pytest
pytest -v                      # expect: 9 passed (one test waits ~5s on purpose)
```

Optional, run it for real in three terminals:

```bash
docker run --rm -p 27017:27017 mongo:7.0                                  # terminal 1: a throwaway MongoDB
(cd runner && python runner.py)                                           # terminal 2, port 5001
(cd judge && MONGO_URI=mongodb://localhost:27017 python judge.py)         # terminal 3 → http://localhost:5000
```

---

## Step 2: Docker images

Kubernetes runs containers, so each service needs an image, and the images need a home that all three clusters can reach. We use DigitalOcean Container Registry.

### `docker/Dockerfile.runner`

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir flask==3.0.3 gunicorn==22.0.0
WORKDIR /app
COPY runner/runner.py .
USER 10001
CMD ["gunicorn", "runner:app", "--bind", "0.0.0.0:5001", "--workers", "2"]
```

### `docker/Dockerfile.judge`

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir flask==3.0.3 gunicorn==22.0.0 requests==2.32.3 pymongo==4.10.1
WORKDIR /app
COPY judge/judge.py judge/index.html ./
USER 10001
# State now lives in MongoDB (not in this process), so more workers would also be safe.
# 1 worker + 4 threads keeps memory small.
CMD ["gunicorn", "judge:app", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120"]
```

### `scripts/build-push.sh`

```bash
#!/usr/bin/env bash
# Builds both images and pushes them to your DigitalOcean Container Registry.
# Run `doctl registries login` once first (it logs docker in to the registry).
#
# Example:
#   export REGISTRY=leetcode-yourname
#   export IMAGE_PREFIX=registry.digitalocean.com/$REGISTRY
#   TAG=v1 ./scripts/build-push.sh
set -euo pipefail
: "${IMAGE_PREFIX:?set IMAGE_PREFIX, e.g. registry.digitalocean.com/leetcode-yourname}"
TAG=${TAG:-latest}
for svc in runner judge; do
  docker buildx build --platform linux/amd64 -f docker/Dockerfile.$svc \
    -t "$IMAGE_PREFIX/leetcode-$svc:$TAG" --push .
done
```

### Create the container registry (once)

Instead of a public registry, we use **DigitalOcean Container Registry (DOCR)**: one private registry that all three clusters pull from.

```mermaid
flowchart LR
    dev["Your computer<br/>docker build and push"] -->|"push, after doctl registries login"| reg[("DigitalOcean Container Registry<br/>registry.digitalocean.com/YOUR_REGISTRY<br/>leetcode-judge and leetcode-runner")]
    reg -->|"pull, using the registry secret"| k1["cluster blr1"]
    reg -->|"pull, using the registry secret"| k2["cluster nyc3"]
    reg -->|"pull, using the registry secret"| k3["cluster sgp1"]
```

**Choose a plan.** We push two images (`leetcode-judge` and `leetcode-runner`), and each image is its own *repository*:

| Plan | Repositories | Storage | Price (DigitalOcean's pricing page when I checked) |
|---|---|---|---|
| Starter | 1 | 500 MiB | $0 |
| **Basic** | **5** | **5 GiB** | **$5 per month** |
| Professional | Unlimited | 100 GiB | $20 per month |

**Starter is not enough**, because it allows only one repository and we have two. Use **Basic**. (You can switch plans later: control panel → Container Registry → Plan details → Edit plan.) Check DigitalOcean's pricing page for current numbers.

**Choose a name.** It must be unique across DigitalOcean, 3 to 63 characters, only letters, numbers and dashes, and it **cannot be renamed later**.

**Choose a region.** DigitalOcean recommends a region close to your other resources. One registry serves all three clusters, so a cluster in another region pulls its images across regions. That only happens when a pod starts on a node that doesn't already have the image.

```bash
export REGISTRY=leetcode-yourname                 # pick your own unique name
doctl registries create "$REGISTRY" --subscription-tier basic --region nyc3
```

If your `doctl` version rejects a flag, `doctl registries create --help` lists the exact ones. You can also create the registry in the control panel (Container Registry → Create a Container Registry).

### Log docker in to the registry

```bash
doctl registries login
```

This generates a personal access token that lets `docker` push and pull for your team. You can revoke it at any time. (Without `doctl`, you can run `docker login registry.digitalocean.com` using your account email as the username and an API token as the password.)

### Build and push

```bash
export REGISTRY=leetcode-yourname
export IMAGE_PREFIX=registry.digitalocean.com/$REGISTRY
export TAG=v1
./scripts/build-push.sh
```

Image names follow this pattern:

| Part | Our value |
|---|---|
| `registry.digitalocean.com` | DigitalOcean's registry server |
| `<registry name>` | `$REGISTRY` |
| `<repository>` | `leetcode-runner` and `leetcode-judge` |
| `:<tag>` | `v1` |

So the judge is `registry.digitalocean.com/leetcode-yourname/leetcode-judge:v1`. Confirm both appear in the control panel under Container Registry → Repositories.

**Use version tags like `v1`, not `latest`.** Kubernetes pulls a `:latest` image again every time a pod starts, but reuses a versioned image already on the node. Versioned tags mean fewer cross-region downloads, a smaller dependence on the registry, and you always know which version is running. When you ship `v2`, push `v2` and deploy with `TAG=v2`.

**Housekeeping.** Old image versions use up your 5 GiB. DigitalOcean's docs describe cleaning them up under "Clean Up Container Registry".

**Optional: keep MongoDB's image in your registry too.** The manifest pulls `mongo:7.0` from Docker Hub, which can rate-limit pulls. To mirror it (this uses a third repository, still within Basic's five):

```bash
docker pull --platform linux/amd64 mongo:7.0
docker tag mongo:7.0 registry.digitalocean.com/$REGISTRY/mongo:7.0
docker push registry.digitalocean.com/$REGISTRY/mongo:7.0
# then in k8s/leetcode.yaml change  image: mongo:7.0  to  image: ${IMAGE_PREFIX}/mongo:7.0
```


---

## Step 3: The Kubernetes manifest

New to Kubernetes? Read **Part 2b** first; it explains every object below. This is one file, applied unchanged to all three clusters. Only `${REGION}` differs. Things to notice:

- **runner**: only on the `sandbox` node pool, `ClusterIP` Service (internal only), and a `NetworkPolicy` that lets only the judge in and nothing out.
- **judge**: only on the `edge` node pool, with a `type: LoadBalancer` Service that makes DigitalOcean create a **regional** load balancer named `leetcode-<region>`.
- **mongo**: a `StatefulSet` with a 5Gi persistent disk (`volumeClaimTemplates`), a headless Service, and a NetworkPolicy that lets only the judge connect. Its password comes from a Secret that `deploy.sh` creates.
- **judge**: now has `MONGO_*` settings and is "Ready" only when MongoDB answers.
- **HPA**: adds runner pods (2 to 6) when CPU passes 70%.

```yaml
# ${REGION}, ${IMAGE_PREFIX}, ${TAG} are filled in by scripts/deploy.sh (envsubst).
apiVersion: v1
kind: Namespace
metadata: {name: leetcode}
---
# ================= RUNNER: private, runs untrusted code =================
apiVersion: apps/v1
kind: Deployment
metadata: {name: runner, namespace: leetcode}
spec:
  replicas: 2
  selector: {matchLabels: {app: runner}}
  template:
    metadata: {labels: {app: runner}}
    spec:
      # Edge-node config: run ONLY on the tainted "sandbox" node pool, away from the judge
      nodeSelector: {pool: sandbox}
      tolerations:
        - {key: dedicated, operator: Equal, value: sandbox, effect: NoSchedule}
      topologySpreadConstraints:          # spread replicas over different nodes
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: {matchLabels: {app: runner}}
      automountServiceAccountToken: false # submitted code can't talk to the Kubernetes API
      securityContext: {runAsNonRoot: true, runAsUser: 10001}
      containers:
        - name: runner
          image: ${IMAGE_PREFIX}/leetcode-runner:${TAG}
          ports: [{containerPort: 5001}]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true  # only /tmp is writable
            capabilities: {drop: ["ALL"]}
          resources:
            requests: {cpu: 250m, memory: 256Mi}
            limits: {cpu: "1", memory: 512Mi}
          readinessProbe: {httpGet: {path: /, port: 5001}}
          volumeMounts: [{name: tmp, mountPath: /tmp}]
      volumes: [{name: tmp, emptyDir: {sizeLimit: 128Mi}}]
---
apiVersion: v1
kind: Service
metadata: {name: runner, namespace: leetcode}
spec:                                     # ClusterIP (default) = only reachable inside the cluster
  selector: {app: runner}
  ports: [{port: 5001, targetPort: 5001}]
---
# Runner accepts traffic ONLY from the judge, and can call out to NOTHING (no internet).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: runner-lockdown, namespace: leetcode}
spec:
  podSelector: {matchLabels: {app: runner}}
  policyTypes: [Ingress, Egress]
  ingress:
    - from: [{podSelector: {matchLabels: {app: judge}}}]
      ports: [{port: 5001}]
  egress: []
---
# Add more runner pods automatically when submissions pile up.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: runner, namespace: leetcode}
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: runner}
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource: {name: cpu, target: {type: Utilization, averageUtilization: 70}}
---
# ================= MONGODB: stores problems + submissions =================
# The password lives in a Secret called "mongo-auth". It is NOT in this file (so it never
# lands in git); scripts/deploy.sh creates it once per cluster.
#
# StatefulSet (not Deployment) because a database needs a stable identity and its own disk.
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: mongo, namespace: leetcode}
spec:
  serviceName: mongo                  # the headless Service below
  replicas: 1                         # single node: simple, but NOT highly available
  selector: {matchLabels: {app: mongo}}
  template:
    metadata: {labels: {app: mongo}}
    spec:
      nodeSelector: {pool: edge}
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, fsGroup: 999}  # fsGroup: makes the disk writable by mongo
      containers:
        - name: mongo
          image: mongo:7.0
          ports: [{containerPort: 27017}]
          env:                        # the official image creates this admin user on first start
            - name: MONGO_INITDB_ROOT_USERNAME
              valueFrom: {secretKeyRef: {name: mongo-auth, key: username}}
            - name: MONGO_INITDB_ROOT_PASSWORD
              valueFrom: {secretKeyRef: {name: mongo-auth, key: password}}
          resources:
            requests: {cpu: 250m, memory: 512Mi}
            limits: {cpu: "1", memory: 1Gi}
          readinessProbe:
            exec: {command: ["mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]}
            initialDelaySeconds: 15
            periodSeconds: 10
          volumeMounts: [{name: data, mountPath: /data/db}]   # MongoDB writes its files here
  # Kubernetes creates one PersistentVolumeClaim ("data-mongo-0") from this template.
  # DigitalOcean answers it by creating a block-storage volume and attaching it to the node.
  volumeClaimTemplates:
    - metadata: {name: data}
      spec:
        accessModes: ["ReadWriteOnce"]          # one node at a time can mount it
        storageClassName: do-block-storage      # DigitalOcean's disk type
        resources: {requests: {storage: 5Gi}}
---
apiVersion: v1
kind: Service
metadata: {name: mongo, namespace: leetcode}
spec:
  clusterIP: None                     # "headless": the name "mongo" points straight at the pod
  selector: {app: mongo}
  ports: [{port: 27017}]
---
# Only the judge may talk to MongoDB. The runner (untrusted code) cannot reach it.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: mongo-lockdown, namespace: leetcode}
spec:
  podSelector: {matchLabels: {app: mongo}}
  policyTypes: [Ingress]
  ingress:
    - from: [{podSelector: {matchLabels: {app: judge}}}]
      ports: [{port: 27017}]
---
# ================= JUDGE: public website + API =================
apiVersion: apps/v1
kind: Deployment
metadata: {name: judge, namespace: leetcode}
spec:
  replicas: 2
  selector: {matchLabels: {app: judge}}
  template:
    metadata: {labels: {app: judge}}
    spec:
      nodeSelector: {pool: edge}          # edge-node config: the normal pool
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: {matchLabels: {app: judge}}
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 10001}
      containers:
        - name: judge
          image: ${IMAGE_PREFIX}/leetcode-judge:${TAG}
          ports: [{containerPort: 8080}]
          env:
            - {name: REGION, value: "${REGION}"}              # shows up in X-Served-By header
            - {name: RUNNER_HOSTPORT, value: "runner:5001"}   # the runner Service above
            - {name: MONGO_HOST, value: "mongo"}              # the mongo Service below
            - name: MONGO_USER
              valueFrom: {secretKeyRef: {name: mongo-auth, key: username}}
            - name: MONGO_PASSWORD
              valueFrom: {secretKeyRef: {name: mongo-auth, key: password}}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: ["ALL"]}
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {cpu: 500m, memory: 256Mi}
          readinessProbe: {httpGet: {path: /ready, port: 8080}}   # Ready only if MongoDB answers
          volumeMounts: [{name: tmp, mountPath: /tmp}]
      volumes: [{name: tmp, emptyDir: {sizeLimit: 64Mi}}]
---
# type: LoadBalancer makes DigitalOcean create a REGIONAL load balancer for this cluster.
# The Global Load Balancer (Step 6) will later sit in front of the three regional ones.
apiVersion: v1
kind: Service
metadata:
  name: judge
  namespace: leetcode
  annotations:
    # Must be REGIONAL (HTTP). Newer DOKS versions default to a *network* LB,
    # which cannot be placed behind a Global Load Balancer.
    service.beta.kubernetes.io/do-loadbalancer-type: "REGIONAL"
    service.beta.kubernetes.io/do-loadbalancer-name: "leetcode-${REGION}"   # Terraform finds it by this name
    service.beta.kubernetes.io/do-loadbalancer-protocol: "http"
    service.beta.kubernetes.io/do-loadbalancer-healthcheck-protocol: "http"
    service.beta.kubernetes.io/do-loadbalancer-healthcheck-path: "/health"
spec:
  type: LoadBalancer
  selector: {app: judge}
  ports:
    - {name: http, port: 80, targetPort: 8080}
```

---

## Step 4: Edge node configuration (the three clusters)

Each region is an "edge" location. Its nodes are split into **two pools** so untrusted code never shares a machine with the public website:

| Pool | Runs | Size | Autoscaling | Label | Taint |
|---|---|---|---|---|---|
| `edge` | judge | `s-2vcpu-4gb` | 2 to 4 nodes | `pool=edge` | none |
| `sandbox` | runner | `s-2vcpu-4gb` | 1 to 3 nodes | `pool=sandbox` | `dedicated=sandbox:NoSchedule` |

How it fits together: the **taint** repels every pod from the sandbox nodes, the runner's **toleration** lets it in, and its **nodeSelector** forces it there. The judge's nodeSelector keeps it on the edge pool. Autoscaling adds nodes when pods can't fit.

### Choose ONE way to create the clusters

| | Option A: Terraform | Option B: `doctl` command line |
|---|---|---|
| Good for | Repeatable infrastructure as code; clean teardown with `terraform destroy` | Seeing exactly what is created; no extra tool |
| Files | `terraform/clusters/main.tf` | `scripts/create-clusters-doctl.sh` |
| Result | 3 clusters, 2 node pools each | The same 3 clusters, the same 2 node pools |

Use **one** of them, never both: the cluster names (`leetcode-blr1` and so on) would clash. After either one, continue with **Step 4b** to download the kubeconfig.

### Option A: Terraform

#### `terraform/clusters/main.tf`

```hcl
# Creates the 3 DOKS clusters: India (Bangalore), America (New York), Singapore.
terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {} # reads your token from the DIGITALOCEAN_TOKEN environment variable

locals {
  regions = ["blr1", "nyc3", "sgp1"] # India, America, Singapore
}

data "digitalocean_kubernetes_versions" "current" {}

resource "digitalocean_kubernetes_cluster" "leetcode" {
  for_each      = toset(local.regions)
  name          = "leetcode-${each.key}"
  region        = each.key
  version       = data.digitalocean_kubernetes_versions.current.latest_version
  surge_upgrade = true

  # Connect the DigitalOcean Container Registry (created in Step 2) to this cluster.
  # DigitalOcean then copies a pull secret into the cluster's namespaces, so pods can pull
  # your images. The registry must already exist, or this apply fails.
  registry_integration = true

  # EDGE node pool: runs the judge. Grows from 2 to 4 nodes under load.
  node_pool {
    name       = "edge"
    size       = "s-2vcpu-4gb"
    auto_scale = true
    min_nodes  = 2
    max_nodes  = 4
    labels     = { pool = "edge" }
  }
}

# SANDBOX node pool: runs ONLY the runner (untrusted code). The taint keeps every
# other pod off these nodes, so a bad submission can't sit next to the judge.
resource "digitalocean_kubernetes_node_pool" "sandbox" {
  for_each   = digitalocean_kubernetes_cluster.leetcode
  cluster_id = each.value.id
  name       = "sandbox"
  size       = "s-2vcpu-4gb"
  auto_scale = true
  min_nodes  = 1
  max_nodes  = 3
  labels     = { pool = "sandbox" }

  taint {
    key    = "dedicated"
    value  = "sandbox"
    effect = "NoSchedule"
  }
}

output "clusters" {
  value = [for c in digitalocean_kubernetes_cluster.leetcode : c.name]
}
```

#### Create the clusters with Terraform

```bash
cd terraform/clusters
terraform init
terraform plan          # read it: 3 clusters + 3 sandbox node pools
terraform apply         # about 5–10 minutes
cd ../..
```

Check the available regions and sizes if Terraform complains:

```bash
doctl kubernetes options regions
doctl kubernetes options sizes
```

### Option B: the `doctl` command line

You already ran `doctl auth init` in Part 1. First look up the valid values:

```bash
doctl kubernetes options regions      # confirm blr1, nyc3 and sgp1 are listed
doctl kubernetes options sizes        # confirm s-2vcpu-4gb
doctl kubernetes options versions     # available Kubernetes versions
```

**1. Create one cluster by hand first (India):**

```bash
doctl kubernetes cluster create leetcode-blr1 \
  --region blr1 \
  --version latest \
  --node-pool "name=edge;size=s-2vcpu-4gb;count=2;auto-scale=true;min-nodes=2;max-nodes=4;label=pool=edge" \
  --node-pool "name=sandbox;size=s-2vcpu-4gb;count=1;auto-scale=true;min-nodes=1;max-nodes=3;label=pool=sandbox;taint=dedicated=sandbox:NoSchedule"
```

It normally waits until the cluster is ready (several minutes), and doctl may also add the cluster to your default `~/.kube/config`. That is harmless; we will use our own `do_kube_config` file instead.

How to read each `--node-pool` string. It is a list of settings separated by `;`:

| Setting | Meaning | Where it matters |
|---|---|---|
| `name=edge` | The pool's name | |
| `size=s-2vcpu-4gb` | Machine type of each node | |
| `count=2` | Nodes to start with | |
| `auto-scale=true;min-nodes=2;max-nodes=4` | Add or remove nodes automatically between 2 and 4 | |
| `label=pool=edge` | Puts the label `pool=edge` on every node | The judge's `nodeSelector: {pool: edge}` |
| `taint=dedicated=sandbox:NoSchedule` | Repels all pods that don't explicitly tolerate it (`key=value:effect`) | The runner's `tolerations` |

`--version latest` picks the newest Kubernetes version available.

**2. Create all three with the script** (it skips clusters that already exist and builds the three in parallel):

```bash
#!/usr/bin/env bash
# OPTION B: create the 3 clusters with the doctl command line (instead of Terraform).
# Each cluster gets 2 node pools: "edge" (judge + mongo) and "sandbox" (runner, tainted).
# Use EITHER this script OR terraform/clusters, never both (the names would clash).
set -euo pipefail

create_one() {
  region=$1
  if doctl kubernetes cluster get "leetcode-$region" >/dev/null 2>&1; then
    echo "leetcode-$region already exists, skipping"
    return 0
  fi
  echo "Creating leetcode-$region (takes several minutes)..."
  doctl kubernetes cluster create "leetcode-$region" \
    --region "$region" \
    --version latest \
    --node-pool "name=edge;size=s-2vcpu-4gb;count=2;auto-scale=true;min-nodes=2;max-nodes=4;label=pool=edge" \
    --node-pool "name=sandbox;size=s-2vcpu-4gb;count=1;auto-scale=true;min-nodes=1;max-nodes=3;label=pool=sandbox;taint=dedicated=sandbox:NoSchedule"
}

pids=()
for region in blr1 nyc3 sgp1; do
  create_one "$region" &      # all three at the same time
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done   # fails if any cluster failed

doctl kubernetes cluster list
```

```bash
chmod +x scripts/*.sh
./scripts/create-clusters-doctl.sh
```

**3. Check the result:**

```bash
doctl kubernetes cluster list
doctl kubernetes cluster node-pool list leetcode-blr1      # expect two pools: edge and sandbox
```

**4. Change things later (examples):**

```bash
# Let the edge pool grow to 6 nodes. Repeat --label, because an update REMOVES any label you don't repeat.
doctl kubernetes cluster node-pool update leetcode-blr1 edge \
  --auto-scale --min-nodes 2 --max-nodes 6 --label pool=edge

# Add another pool
doctl kubernetes cluster node-pool create leetcode-blr1 \
  --name extra --size s-2vcpu-4gb --count 1 --label pool=extra
```

For the sandbox pool, an update must repeat both `--label pool=sandbox` and `--taint "dedicated=sandbox:NoSchedule"`, or the runner stops being isolated.

---

## Step 4b: Download the kubeconfig as `do_kube_config` (for both options)

A **kubeconfig** is a file that tells `kubectl` where each cluster is and how to log in to it. We store ours in a file named `do_kube_config`.

```mermaid
flowchart LR
    kubectl["kubectl"] -->|reads KUBECONFIG| file["do_kube_config<br/>one file, three contexts"]
    file --> x1["context do-blr1-leetcode-blr1"] --> k1["cluster blr1"]
    file --> x2["context do-nyc3-leetcode-nyc3"] --> k2["cluster nyc3"]
    file --> x3["context do-sgp1-leetcode-sgp1"] --> k3["cluster sgp1"]
```

### Quick way: one cluster

```bash
doctl kubernetes cluster kubeconfig show leetcode-blr1 > do_kube_config
export KUBECONFIG="$PWD/do_kube_config"
kubectl get nodes                       # you should see the edge and sandbox nodes
```

`show` prints the cluster's kubeconfig as YAML; the `>` saves it into the file named `do_kube_config`.

### Real way: all three clusters in ONE file

Our scripts talk to three clusters, so this script downloads the three configs and merges them:

```bash
#!/usr/bin/env bash
# Downloads the credentials of all 3 clusters and merges them into ONE file: do_kube_config
# Run it from the project root. Re-run it whenever kubectl says "Unauthorized".
set -euo pipefail
OUT="${KUBECONFIG_OUT:-do_kube_config}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

files=()
for region in blr1 nyc3 sgp1; do
  # "show" prints the cluster's kubeconfig YAML to the screen; we redirect it into a file
  doctl kubernetes cluster kubeconfig show "leetcode-$region" > "$tmp/$region.yaml"
  files+=("$tmp/$region.yaml")
done

# Merge the 3 files into one (--flatten embeds the certificates, so the file stands alone)
KUBECONFIG="$(IFS=:; echo "${files[*]}")" kubectl config view --flatten > "$OUT"
chmod 600 "$OUT"      # it contains credentials: only you may read it

echo "Saved $OUT with these contexts:"
kubectl --kubeconfig "$OUT" config get-contexts -o name
```

```bash
./scripts/get-kubeconfig.sh
export KUBECONFIG="$PWD/do_kube_config"        # use this file in THIS terminal

kubectl config get-contexts                    # three contexts: do-blr1-..., do-nyc3-..., do-sgp1-...
kubectl --context do-blr1-leetcode-blr1 get nodes
kubectl --context do-nyc3-leetcode-nyc3 get nodes
kubectl --context do-sgp1-leetcode-sgp1 get nodes
```

### Good to know

- **`export KUBECONFIG=...` only lasts for the terminal window you typed it in.** Run it again in every new terminal, or put it in your shell profile. Without it, `kubectl` reads the default `~/.kube/config`, which isn't the file we made.
- **The file contains credentials.** Anyone holding it can control your clusters. The script restricts it to your user (`chmod 600`), and this `.gitignore` keeps it (and Terraform's state, which can hold secrets) out of git:

```gitignore
# Credentials: NEVER commit these
do_kube_config
*.tfstate
*.tfstate.*
.terraform/
terraform.tfvars
```

- **The credentials expire.** DigitalOcean's docs say the credentials from `kubeconfig show` last seven days by default. When `kubectl` says `Unauthorized`, re-run `./scripts/get-kubeconfig.sh`. `deploy.sh` does this for you every time it runs.
- **The alternative:** `doctl kubernetes cluster kubeconfig save leetcode-blr1` adds the cluster to your default `~/.kube/config` instead and, per the docs, renews credentials automatically. This guide uses the separate `do_kube_config` file so everything stays in the project folder.

---

## Step 4c: Connect the registry to all three clusters

A private registry needs credentials, and Kubernetes needs to know where to find them. Connecting the registry to a cluster does that automatically:

| What DigitalOcean does | Why |
|---|---|
| Creates a pull secret in the cluster's `kube-system` namespace, named after your registry | The secret holds the credentials to pull from your registry |
| Copies that secret into every other namespace | So any namespace can pull |
| Adds the secret to each namespace's `default` service account as an `imagePullSecret` | So pods pick it up automatically. Our manifest needs no extra settings |

```mermaid
sequenceDiagram
    participant Dep as Deployment judge
    participant Kub as kubelet on a node
    participant SA as default service account
    participant Reg as DigitalOcean Container Registry

    Dep->>Kub: start a pod with image registry.digitalocean.com/YOUR_REGISTRY/leetcode-judge:v1
    Kub->>SA: which imagePullSecrets does this pod get
    SA-->>Kub: the registry secret, added by the registry connection
    Kub->>Reg: pull the image, authenticating with that secret
    Reg-->>Kub: image layers
    Kub->>Kub: start the container
```

**Before you start:**

- The registry must exist (Step 2) and the three clusters must exist (Step 4).
- DigitalOcean's docs say you can only connect **the latest Kubernetes patch version**. Both of our creation options use `latest`, so that is already satisfied.
- **Warning from DigitalOcean's docs:** with this integration, each cluster can pull from **every registry your account owns**, not just this one. Keep other registries in mind before sharing cluster access.

### Option A: you created the clusters with Terraform

Nothing more to do. The cluster resource in `terraform/clusters/main.tf` already contains `registry_integration = true`, so the connection was made when you applied it. Verify it:

```bash
export REGISTRY=leetcode-yourname
./scripts/connect-registry.sh check
```

### Option B: you created the clusters with `doctl`

Connect one cluster by hand first:

```bash
doctl kubernetes cluster registry add leetcode-blr1
```

Then connect all three and check them with the script:

```bash
#!/usr/bin/env bash
# Connects your DigitalOcean Container Registry to all 3 clusters, then checks the result.
#   ./scripts/connect-registry.sh          add the registry to each cluster, then check
#   ./scripts/connect-registry.sh check    only check (use after Terraform did the integration)
# Needs: export REGISTRY=<your registry name>   and the 3 clusters to exist (Step 4).
set -euo pipefail
: "${REGISTRY:?set REGISTRY to your registry name, e.g. leetcode-yourname}"
MODE=${1:-add}

if [ "$MODE" = "add" ]; then
  for region in blr1 nyc3 sgp1; do
    echo "== adding the registry to leetcode-$region"
    # If the cluster is already connected this may complain; the check below is what decides.
    doctl kubernetes cluster registry add "leetcode-$region" \
      || echo "   (add did not succeed here: it may already be connected, see the check below)"
  done
fi

# Check: DigitalOcean stores the pull secret in kube-system, named after the registry
./scripts/get-kubeconfig.sh >/dev/null
export KUBECONFIG="$PWD/do_kube_config"
failed=0
for region in blr1 nyc3 sgp1; do
  ctx=$(kubectl config get-contexts -o name | grep -- "-leetcode-$region$" | head -n 1 || true)
  if [ -n "$ctx" ] && kubectl --context "$ctx" -n kube-system get secret "$REGISTRY" >/dev/null 2>&1; then
    echo "OK    $region: registry secret '$REGISTRY' exists in kube-system"
  else
    echo "FAIL  $region: no registry secret '$REGISTRY' in kube-system"
    failed=1
  fi
done
exit $failed
```

```bash
export REGISTRY=leetcode-yourname
./scripts/connect-registry.sh
```

You should see one `OK` line per region:

```text
OK    blr1: registry secret 'leetcode-yourname' exists in kube-system
OK    nyc3: registry secret 'leetcode-yourname' exists in kube-system
OK    sgp1: registry secret 'leetcode-yourname' exists in kube-system
```

### What about our `leetcode` namespace?

It doesn't exist yet. `deploy.sh` creates it in Step 5, and DigitalOcean copies the pull secret into it. `deploy.sh` then waits up to a minute for the secret to appear on the `default` service account. If it never does, the script stops with a clear message instead of leaving pods in `ImagePullBackOff`. The fix is in the troubleshooting table: run `./scripts/connect-registry.sh` again, and re-run `deploy.sh`.

### Manual fallback (DigitalOcean's "Option 2")

If you prefer not to use the integration, upload the credentials yourself. This creates a secret named `registry-<your registry>` and you then point the default service account at it:

```bash
doctl registries kubernetes-manifest | kubectl --context do-blr1-leetcode-blr1 apply -f -
```

Our namespace is `leetcode`, so you would also create the secret there and patch that namespace's `default` service account with it. DigitalOcean's page "How to Use Your Private DigitalOcean Container Registry with Docker and Kubernetes" has the exact commands.

---

## Step 5: Deploy to all three clusters

### `scripts/deploy.sh`

First it refreshes `do_kube_config` (Step 4b). Then, for each region, it picks that cluster's context, creates the namespace, generates the MongoDB password Secret (once, and keeps it on re-runs), waits until the registry's pull secret has reached that namespace (Step 4c), fills in `${REGION}`, applies the manifest, waits for MongoDB and the pods, and waits for the regional load balancer to get its IP.

```bash
#!/usr/bin/env bash
# Applies the SAME manifest to all 3 clusters (only ${REGION} differs).
# Run from the project root.
set -euo pipefail
: "${IMAGE_PREFIX:?set IMAGE_PREFIX, e.g. registry.digitalocean.com/YOUR_REGISTRY}"
export IMAGE_PREFIX
export TAG=${TAG:-latest}

# Refresh do_kube_config first (its credentials expire), then make kubectl use it
./scripts/get-kubeconfig.sh
export KUBECONFIG="$PWD/do_kube_config"

for region in blr1 nyc3 sgp1; do
  # find this region's context inside do_kube_config, e.g. do-blr1-leetcode-blr1
  ctx=$(kubectl config get-contexts -o name | grep -- "-leetcode-$region$" | head -n 1 || true)
  [ -n "$ctx" ] || { echo "No context for leetcode-$region in do_kube_config"; exit 1; }
  k="kubectl --context $ctx"

  # Namespace first, because the Secret has to live inside it
  $k create namespace leetcode --dry-run=client -o yaml | $k apply -f -

  # The registry connection (Step 4c) copies a pull secret into each namespace and adds it to the
  # "default" service account. Our namespace is brand new, so wait for that to happen.
  echo "Checking registry pull access in $region..."
  pull=""
  for _ in $(seq 1 12); do
    pull=$($k -n leetcode get serviceaccount default -o jsonpath='{.imagePullSecrets[*].name}' 2>/dev/null || true)
    [ -n "$pull" ] && break
    sleep 5
  done
  [ -n "$pull" ] || {
    echo "No registry pull secret reached namespace 'leetcode' in $region."
    echo "Run ./scripts/connect-registry.sh (see Step 4c and the troubleshooting table), then re-run this script."
    exit 1
  }

  # MongoDB password: generated ONCE per cluster, never written to a file or git.
  # (If the secret already exists we keep it: changing it later would not change
  #  the password MongoDB already stored on its disk.)
  if ! $k -n leetcode get secret mongo-auth >/dev/null 2>&1; then
    $k -n leetcode create secret generic mongo-auth \
      --from-literal=username=leetcode_admin \
      --from-literal=password="$(openssl rand -hex 16)"
  fi

  REGION=$region envsubst '${REGION} ${IMAGE_PREFIX} ${TAG}' < k8s/leetcode.yaml | $k apply -f -

  $k -n leetcode rollout status statefulset/mongo --timeout=300s
  $k -n leetcode rollout status deploy/runner deploy/judge --timeout=300s

  echo "Waiting for the $region load balancer IP..."
  until ip=$($k -n leetcode get svc judge -o jsonpath='{.status.loadBalancer.ingress[0].ip}') \
        && [ -n "$ip" ]; do sleep 10; done
  echo "==> $region ready, regional LB IP: $ip"
done
```

### Run it

```bash
export IMAGE_PREFIX=registry.digitalocean.com/YOUR_REGISTRY
export TAG=v1                  # must match the tag you pushed in Step 2
./scripts/deploy.sh
```

At the end you'll see three regional IPs. Test one directly:

```bash
curl -i http://<blr1-ip>/health      # should show  X-Served-By: blr1
```

If a pod is stuck: `kubectl --context do-blr1-leetcode-blr1 -n leetcode describe pod <name>`.

### Check that MongoDB and its disk are working

```bash
export KUBECONFIG="$PWD/do_kube_config"        # the file from Step 4b (once per terminal)
CTX=do-blr1-leetcode-blr1
alias k="kubectl --context $CTX -n leetcode"

k get pvc                      # data-mongo-0  should say Bound
k get pods                     # mongo-0 1/1, judge x2 1/1, runner x2 1/1
PW=$(k get secret mongo-auth -o jsonpath='{.data.password}' | base64 -d)

# Look inside the database
k exec -it mongo-0 -- mongosh -u leetcode_admin -p "$PW" --authenticationDatabase admin leetcode \
  --eval 'db.problems.find({}, {title: 1}); db.submissions.countDocuments()'
```

Add your own problem straight into MongoDB (no redeploy needed), then refresh the page in that region:

```bash
k exec -it mongo-0 -- mongosh -u leetcode_admin -p "$PW" --authenticationDatabase admin leetcode --eval '
db.problems.insertOne({
  _id: "add-two", title: "Add Two Numbers (Easy)",
  description: "Return a + b.", function: "add",
  starter: "class Solution:\n    def add(self, a, b):\n        pass\n",
  tests: [{args: [1, 2], expected: 3}, {args: [-5, 5], expected: 0}]
})'
```

Prove the disk works: `k delete pod mongo-0`, wait until it is `Running` again, and the problems and submissions are still there.

---

## Step 6: Anycast configuration (Global Load Balancer)

The GLB is the single global front door. You attach the three regional load balancers behind it and DigitalOcean routes each user to the nearest healthy one. If a region's backends go unhealthy, traffic fails over to another region.

### `terraform/glb/main.tf`

```hcl
# The anycast layer: ONE Global Load Balancer in front of the 3 regional load balancers.
# Run this AFTER scripts/deploy.sh (the regional LBs must already exist).
terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {}

variable "domain" {
  description = "Public hostname users will visit, e.g. leetcode.example.com"
  type        = string
}

variable "dns_on_digitalocean" {
  description = "true if the domain's DNS zone is in DigitalOcean (DNS records are then created for you)"
  type        = bool
  default     = false
}

# Find the 3 regional LBs that Kubernetes created (named in k8s/leetcode.yaml)
data "digitalocean_loadbalancer" "regional" {
  for_each = toset(["blr1", "nyc3", "sgp1"])
  name     = "leetcode-${each.key}"
}

resource "digitalocean_loadbalancer" "global" {
  name   = "leetcode-global"
  type   = "GLOBAL"
  region = "nyc3" # the provider asks for one; a global LB serves every region

  forwarding_rule {
    entry_port      = 80
    entry_protocol  = "http"
    target_port     = 80
    target_protocol = "http"
  }

  healthcheck {
    port     = 80
    protocol = "http"
    path     = "/health"
  }

  glb_settings {
    target_protocol = "http"
    target_port     = 80
    cdn {
      is_enabled = false # judge responses are dynamic: nothing to cache
    }
    # Optional: prefer regions in a fixed order instead of "nearest":
    # region_priorities  = { blr1 = 1, sgp1 = 2, nyc3 = 3 }
    # failover_threshold = 50
  }

  domains {
    name       = var.domain
    is_managed = var.dns_on_digitalocean
  }

  target_load_balancer_ids = [for lb in data.digitalocean_loadbalancer.regional : lb.id]
}

output "global_lb_id" {
  value = digitalocean_loadbalancer.global.id
}
output "global_lb_ip" {
  value = digitalocean_loadbalancer.global.ip
}
```

### Create it

```bash
cd terraform/glb
terraform init
terraform plan -var="domain=leetcode.example.com"     # check this carefully, see note below
terraform apply -var="domain=leetcode.example.com"
cd ../..
```

If your domain's DNS is hosted on DigitalOcean, add `-var="dns_on_digitalocean=true"`.

**Note:** this GLB block follows DigitalOcean's Terraform and API documentation but I could not run it. If `terraform plan` rejects an argument, compare with the `digitalocean_loadbalancer` page in DigitalOcean's Terraform reference. The no-code fallback, which is documented by DigitalOcean: **Control Panel → Create → Load Balancer → Global**, then add the three regional load balancers (`leetcode-blr1`, `leetcode-nyc3`, `leetcode-sgp1`) as backends. All backends in a GLB pool must be the same type.

**Optional tuning:** to prefer regions in a fixed order instead of nearest, uncomment `region_priorities` and `failover_threshold` in the file.

---

## Step 7: DNS configuration

Users type a name, DNS turns it into the GLB's addresses. The GLB has **two IPv4 and two IPv6 addresses**, and you add all four as records.

### Option A: your domain's DNS is on DigitalOcean (easiest)

```bash
doctl compute domain create example.com          # only if the domain isn't added yet
```

Apply the GLB with `-var="dns_on_digitalocean=true"` (Step 6). DigitalOcean then creates the required A and AAAA records for you.

### Option B: DNS is at another provider (Namecheap, GoDaddy, Cloudflare, ...)

1. Open **Networking → Load Balancers → `leetcode-global`** in the DigitalOcean control panel. The four addresses are listed there.
2. At your DNS provider, create four records for `leetcode.example.com`:

| Type | Name | Value |
|---|---|---|
| A | `leetcode` | first IPv4 address |
| A | `leetcode` | second IPv4 address |
| AAAA | `leetcode` | first IPv6 address |
| AAAA | `leetcode` | second IPv6 address |

3. **If you use Cloudflare, set these records to "DNS only" (grey cloud).** With the orange-cloud proxy on, Cloudflare answers users instead and DigitalOcean's global routing is bypassed.
4. When migrating an existing site, lower the old records' TTL first (DigitalOcean's advice), add the new records, wait for the old TTL to expire, then remove the old ones.

### Check DNS

```bash
dig +short A    leetcode.example.com      # two IPv4 addresses
dig +short AAAA leetcode.example.com      # two IPv6 addresses
```

### HTTPS (after HTTP works)

This guide ships HTTP only. To add HTTPS:

- **DNS on DigitalOcean:** GLB → **Settings → Connect a Domain → Generate a new SSL certificate** (free, Let's Encrypt). If your domain has CAA records, authorize `letsencrypt.org` or `pki.goog`.
- **DNS elsewhere:** upload your own certificate and key and attach it to the GLB.

After changing the GLB in the control panel, run `terraform plan` in `terraform/glb`. Terraform will want to undo the panel changes, so update `main.tf` to match them afterwards.

---

## Step 8: Verify the routing

### `scripts/verify.sh`

```bash
#!/usr/bin/env bash
# Usage: ./scripts/verify.sh leetcode.example.com
# X-Served-By tells you which cluster answered (blr1, nyc3 or sgp1).
set -euo pipefail
curl -s -D - -o /dev/null "http://$1/health" | grep -i -E "^HTTP|x-served-by"
```

```bash
./scripts/verify.sh leetcode.example.com
# HTTP/1.1 200 OK
# X-Served-By: blr1        ← the cluster that answered you
```

### Prove it for each region

The header names the serving cluster, so test from each place:

1. Create the smallest Droplet in **blr1**, **nyc3** and **sgp1** (control panel → Create → Droplets).
2. SSH into each and run `curl -s -D - -o /dev/null http://leetcode.example.com/health`.
3. Expect `X-Served-By` to match the Droplet's own region (`blr1`, `nyc3`, `sgp1`).
4. Delete the Droplets when done.

Droplets sit inside DigitalOcean's network, so this shows the routing logic but not the exact path a home user's ISP would take. For real-user checks, repeat the `curl` from machines in different countries (a friend, or a "check from many locations" web tool).

### Test failover

```bash
kubectl --context do-blr1-leetcode-blr1 -n leetcode scale deploy/judge --replicas=0
./scripts/verify.sh leetcode.example.com        # from India: should now be nyc3 or sgp1
kubectl --context do-blr1-leetcode-blr1 -n leetcode scale deploy/judge --replicas=2
```

Failover is not instant. The health checks need a few failed probes first.

### Submit real code

Open `http://leetcode.example.com`, pick a problem, submit a solution. The verdict comes from your nearest cluster.

---

## Part 3: Updating, cleaning up, troubleshooting

Every `kubectl` command below assumes you have run `export KUBECONFIG="$PWD/do_kube_config"` in this terminal (Step 4b).

### Ship a new version

```bash
export IMAGE_PREFIX=registry.digitalocean.com/YOUR_REGISTRY
TAG=v2 ./scripts/build-push.sh     # push the new version to the registry
TAG=v2 ./scripts/deploy.sh         # roll it out to all three clusters
```

### Back up MongoDB (before deleting anything)

```bash
PW=$(kubectl --context do-blr1-leetcode-blr1 -n leetcode get secret mongo-auth -o jsonpath='{.data.password}' | base64 -d)
kubectl --context do-blr1-leetcode-blr1 -n leetcode exec mongo-0 -- \
  mongodump -u leetcode_admin -p "$PW" --authenticationDatabase admin --db leetcode --archive --gzip > leetcode-blr1.gz
```

If `mongodump` isn't found in your image version, take a snapshot of the volume in the DigitalOcean control panel instead.

### Tear everything down (order matters)

```bash
(cd terraform/glb && terraform destroy -var="domain=leetcode.example.com")   # 1. GLB first
for r in blr1 nyc3 sgp1; do                                                  # 2. regional LBs
  kubectl --context do-$r-leetcode-$r delete namespace leetcode
done
(cd terraform/clusters && terraform destroy)                                  # 3. clusters
```

**Created the clusters with `doctl` (Option B)?** Replace step 3 with:

```bash
for r in blr1 nyc3 sgp1; do doctl kubernetes cluster delete leetcode-$r; done   # asks you to confirm each one
```

Deleting the namespace removes the regional load balancers **and the MongoDB disk with its data** (back up first). If you skip it, load balancers and volumes can be left behind and keep billing. Check **Networking → Load Balancers** and `doctl compute volume list` afterwards.

**The registry is separate from the clusters**, so it keeps billing after they are gone. Delete it in the control panel (Container Registry → Settings), or with `doctl registries delete YOUR_REGISTRY`, once you no longer need the images.

### What costs money

Per region: the node pools (edge 2 to 4 nodes, sandbox 1 to 3 nodes), one regional load balancer, and one 5Gi block-storage volume for MongoDB. Globally: the Global Load Balancer and the container registry (Basic plan: 5 repositories and 5 GiB, $5 per month on DigitalOcean's pricing page when I checked). Check DigitalOcean's pricing pages for current numbers before you apply.

### Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `kubectl` says `Unauthorized` or `You must be logged in to the server` | The credentials in `do_kube_config` expired (7 days by default). Run `./scripts/get-kubeconfig.sh` again. |
| `kubectl` shows a different cluster than expected, or `connection refused` | `KUBECONFIG` isn't set in this terminal. Run `export KUBECONFIG="$PWD/do_kube_config"` and check `kubectl config get-contexts`. |
| `doctl kubernetes cluster create` says the name already exists | You already created it (maybe with Terraform). Use only one option. `doctl kubernetes cluster list` shows what exists. |
| `get-kubeconfig.sh` fails with `cluster not found` | One of `leetcode-blr1`, `leetcode-nyc3`, `leetcode-sgp1` doesn't exist yet. Check `doctl kubernetes cluster list`. |
| `terraform plan` in `glb/` says it can't find `leetcode-blr1` | Step 5 isn't finished, or the Service lacks `do-loadbalancer-name`. Run `doctl compute load-balancer list`. |
| GLB rejects the regional load balancers | They are *network* load balancers. Keep `do-loadbalancer-type: "REGIONAL"` in the Service and re-apply. |
| Runner pods stay `Pending` | The sandbox pool isn't ready, or no toleration. `kubectl describe pod`, and check `kubectl get nodes --show-labels`. |
| `ImagePullBackOff` on judge or runner | The cluster can't pull from the registry. Run `./scripts/connect-registry.sh check`. Then `k describe pod <name>` and read the Events: `not found` means the image name or tag doesn't exist in the registry (compare `IMAGE_PREFIX` and `TAG` with what you pushed); `unauthorized` means the pull secret is missing. |
| `deploy.sh` stops with "No registry pull secret reached namespace 'leetcode'" | The registry isn't connected to that cluster, or the secret hasn't been copied into the new namespace. Run `./scripts/connect-registry.sh`, then `deploy.sh` again. You can also open the registry's Settings in the control panel and edit the cluster's namespaces. |
| `docker push` says `unauthorized` or `denied` | Your docker login expired or was revoked. Run `doctl registries login` again. |
| `docker push` fails because of a repository or storage limit | You are on the Starter plan (1 repository, 500 MiB). Upgrade to Basic: Container Registry → Plan details → Edit plan. |
| `connect-registry.sh` says `add did not succeed` | The cluster may already be connected (for example by Terraform). Look at the `OK` or `FAIL` line for that region. A cluster that is not on the latest Kubernetes patch version cannot be connected until you upgrade it. |
| Verdict is `Judge Error` | The judge can't reach the runner. Check the runner pods are Ready and the NetworkPolicy is applied. |
| Always the same region for everyone | Your DNS is behind a proxy (e.g. Cloudflare orange cloud), or you are testing from one location only. |
| `mongo-0` stays `Pending` | The disk isn't ready. `k get pvc` (should be `Bound`) and `k describe pvc data-mongo-0`. Check the StorageClass: `kubectl get storageclass`. |
| `mongo-0` in `CrashLoopBackOff`, logs say permission denied on `/data/db` | The disk isn't writable by user 999. Keep `fsGroup: 999` in the StatefulSet. |
| Judge pods `0/1` (not Ready), logs say "waiting for MongoDB" | MongoDB isn't up yet, or the Secret is wrong. `k logs mongo-0`, and check `k get secret mongo-auth`. |
| Authentication failed after you deleted and re-created the Secret | MongoDB stored the *old* password on its disk when it first started. Restore the old Secret, or wipe the disk (data loss): delete the StatefulSet and PVC. |
| Problems or submissions differ between regions | Expected: each region has its own MongoDB. |
| Terraform wants to change the GLB after you edited it in the panel | Update `terraform/glb/main.tf` to match, or re-apply to overwrite. |