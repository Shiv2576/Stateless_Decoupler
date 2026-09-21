#!/bin/bash
# Seeds demo products into the running store.
#
# Piped into wp-cli inside a live pod rather than run from a throwaway pod:
# a `kubectl run` pod takes ~30s to schedule and pull before it does any work,
# which is far too slow to sit behind a dashboard button. The products land in
# MySQL and the images in MinIO, so any pod serves them regardless of which one
# executed this.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${WP_NAMESPACE:-wordpress}"

POD=$(kubectl get pods -n "$NAMESPACE" -l app=wordpress \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

if [ -z "$POD" ]; then
  echo "No running WordPress pod found in namespace $NAMESPACE" >&2
  exit 1
fi

kubectl exec -i -n "$NAMESPACE" "$POD" -c wordpress -- \
  sh -c 'cat > /tmp/seed-store.php && cd /var/www/html && wp eval-file /tmp/seed-store.php --allow-root; rc=$?; rm -f /tmp/seed-store.php; exit $rc' \
  < "$SCRIPT_DIR/seed-store.php"
