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
  create_one "$region" &      # Spawns in background
  pids+=($!)
  sleep 15                    # 🚀 Staggers API requests to prevent "422 overlay create contention"
done

for pid in "${pids[@]}"; do wait "$pid"; done   # fails if any cluster failed

doctl kubernetes cluster list
