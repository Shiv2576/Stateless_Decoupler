#!/bin/bash
set -euo pipefail

# Zero -> running stack. Creates the k3d cluster (if missing), deploys the
# backing services, then hands off to install-plugins.sh for the WordPress
# image build + one-time WP/plugin setup.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFESTS_DIR="$REPO_ROOT/manifests"
CLUSTER="${K3D_CLUSTER:-mycluster}"

for cmd in docker k3d kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required tool: $cmd"; exit 1; }
done

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "Cluster '$CLUSTER' already exists — starting it if stopped..."
  k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
else
  echo "Creating k3d cluster '$CLUSTER'..."
  # 8080->80 is required, not cosmetic: wp-config.php's S3_UPLOADS_BUCKET_URL
  # and every k6 test hardcode http://localhost:8080, and WordPress stores that
  # as its site URL in the DB. Changing it means reinstalling WordPress.
  # 9001 reaches the MinIO console via its LoadBalancer Service. Redis/MySQL are
  # ClusterIP only — use `kubectl port-forward` for those rather than a host
  # port mapping, which k3d's LB won't route to a ClusterIP Service.
  k3d cluster create "$CLUSTER" \
    --agents 2 \
    --port "8080:80@loadbalancer" \
    --port "9001:9001@loadbalancer"
fi

echo "Deploying backing services (MySQL, Redis, MinIO) and config..."
kubectl create namespace wordpress --dry-run=client -o yaml | kubectl apply -f -
# wordpress.yaml mounts both ConfigMaps defined here, so this must land before
# the Deployment is applied by install-plugins.sh.
kubectl apply -f "$MANIFESTS_DIR/wordpress-config.yaml"
kubectl apply -f "$MANIFESTS_DIR/minio.yaml"
kubectl apply -f "$MANIFESTS_DIR/mysql.yaml"
kubectl apply -f "$MANIFESTS_DIR/redis.yaml"

echo "Waiting for backing services to become ready..."
kubectl wait --for=condition=ready pod -l app=mysql -n wordpress --timeout=300s
kubectl wait --for=condition=ready pod -l app=redis -n wordpress --timeout=300s
kubectl wait --for=condition=ready pod -l app=minio -n wordpress --timeout=300s

echo "Building WordPress image and running one-time WordPress/plugin setup..."
"$SCRIPT_DIR/install-plugins.sh"

echo ""
echo "Stack is up. Site:    http://localhost:8080"
echo "            wp-admin: http://localhost:8080/wp-admin (admin / admin)"
echo "            MinIO:    http://localhost:9001 (admin / password123)"
echo ""
echo "Next: start the dashboard (see README.md 'Load-test dashboard')."
