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
