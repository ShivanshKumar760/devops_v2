#!/usr/bin/env bash
# Deploys the app + ingress-nginx to nyc3 and sgp1. Run from the project root.
# Needs: KUBECONFIG pointing at do_kube_config, IMAGE_PREFIX set, helm installed.
set -eo pipefail
: "${IMAGE_PREFIX:?set IMAGE_PREFIX, e.g. registry.digitalocean.com/leetcode-shivansh}"
TAG=v4
export KUBECONFIG="${KUBECONFIG:-$PWD/do_kube_config}"

for REGION in nyc3 sgp1; do
  CTX="do-$REGION-leetcode-$REGION"
  k="kubectl --context $CTX"
  echo ""; echo "=============== $REGION (tag $TAG) ==============="

  # metrics-server (needed by the runner HPA). Safe to re-apply.
  $k apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

  # Namespace
  $k create namespace leetcode --dry-run=client -o yaml | $k apply -f -

  # Wait for the registry pull secret to reach the namespace
  pull=""
  for _ in $(seq 1 12); do
    pull=$($k -n leetcode get serviceaccount default -o jsonpath='{.imagePullSecrets[*].name}' 2>/dev/null || true)
    [ -n "$pull" ] && break
    sleep 5
  done
  [ -n "$pull" ] || { echo "No registry pull secret in $REGION. Run: doctl kubernetes cluster registry add leetcode-$REGION"; exit 1; }

  # MongoDB password: created ONCE, never changed afterwards
  $k -n leetcode get secret mongo-auth >/dev/null 2>&1 || \
    $k -n leetcode create secret generic mongo-auth \
      --from-literal=username=leetcode_admin \
      --from-literal=password="$(openssl rand -hex 16)"

  # App manifest (sed fills the placeholders)
  sed -e "s|\${REGION}|$REGION|g" -e "s|\${IMAGE_PREFIX}|$IMAGE_PREFIX|g" -e "s|\${TAG}|$TAG|g" \
      k8s/leetcode.yaml | $k apply -f -

  # ingress-nginx
  sed "s|\${REGION}|$REGION|g" k8s/ingress-nginx-values.yaml | \
    helm upgrade --install ingress-nginx ingress-nginx \
      --repo https://kubernetes.github.io/ingress-nginx \
      --kube-context "$CTX" --namespace ingress-nginx --create-namespace -f -

  $k -n leetcode rollout status statefulset/mongo --timeout=300s
  $k -n leetcode rollout status deploy/runner --timeout=300s
  $k -n leetcode rollout status deploy/judge --timeout=300s
  $k -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s

  echo "Waiting for the $REGION load balancer address..."
  ip=""
  for _ in $(seq 1 30); do
    ip=$($k -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[*].ip}' 2>/dev/null || true)
    [ -n "$ip" ] && break
    sleep 10
  done
  echo "==> $REGION load balancer addresses: ${ip:-NOT READY YET}"
  echo "    test with the IPv4 one:  curl -i http://<ipv4>/health"
done