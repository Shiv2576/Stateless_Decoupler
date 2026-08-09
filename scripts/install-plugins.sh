#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS_DIR="$SCRIPT_DIR/../manifests"
IMAGE="wordpress-custom:6.6-php8.2-fpm-alpine"
K3D_CLUSTER="mycluster"

WP_URL="http://localhost:8080"
WP_TITLE="Stateless Decoupler"
WP_ADMIN_USER="admin"
WP_ADMIN_PASSWORD="admin"
WP_ADMIN_EMAIL="admin@example.com"

wp_cli_run() {
  # Runs a one-off wp-cli pod with wp-config.php mounted from the same
  # ConfigMap the real deployment uses, so it talks to the same MySQL/Redis.
  local name="$1"
  shift
  local cmd_json
  cmd_json=$(printf '"%s",' "$@")
  cmd_json="[${cmd_json%,}]"

  kubectl run "$name" --rm -i --restart=Never \
    -n wordpress \
    --image="$IMAGE" \
    --overrides='
    {
      "spec": {
        "containers": [{
          "name": "'"$name"'",
          "image": "'"$IMAGE"'",
          "command": '"$cmd_json"',
          "volumeMounts": [{
            "name": "wp-config",
            "mountPath": "/var/www/html/wp-config.php",
            "subPath": "wp-config.php"
          }]
        }],
        "volumes": [{
          "name": "wp-config",
          "configMap": { "name": "wordpress-config" }
        }],
        "restartPolicy": "Never"
      }
    }'
}

# Build the custom WordPress image (wp-cli + plugin files + redis object-cache drop-in baked in)
echo "Building $IMAGE..."
docker build -t "$IMAGE" -f "$MANIFESTS_DIR/wordpress.Dockerfile" "$MANIFESTS_DIR"

echo "Importing image into k3d cluster $K3D_CLUSTER..."
k3d image import "$IMAGE" -c "$K3D_CLUSTER"

echo "Applying WordPress deployment..."
kubectl apply -f "$MANIFESTS_DIR/wordpress.yaml"

echo "Rolling out new image..."
kubectl rollout restart deployment/wordpress -n wordpress
kubectl rollout status deployment/wordpress -n wordpress --timeout=180s

# WordPress core (site tables in wp_options etc.) only needs to exist once in
# the shared MySQL DB, not per replica.
if ! wp_cli_run wp-cli-check wp core is-installed --allow-root; then
  echo "WordPress not installed yet, installing with dev defaults ($WP_URL, $WP_ADMIN_USER/$WP_ADMIN_PASSWORD)..."
  wp_cli_run wp-cli-install wp core install \
    "--url=$WP_URL" \
    "--title=$WP_TITLE" \
    "--admin_user=$WP_ADMIN_USER" \
    "--admin_password=$WP_ADMIN_PASSWORD" \
    "--admin_email=$WP_ADMIN_EMAIL" \
    --skip-email --allow-root
fi

# amazon-s3-and-cloudfront (WP Offload Media) was replaced by s3-uploads,
# which is what wp-config.php's S3_UPLOADS_* constants actually target.
# Its files are gone from this image; drop the stale DB reference too.
wp_cli_run wp-cli-deactivate-old wp plugin deactivate amazon-s3-and-cloudfront --allow-root || true

# Plugin activation is DB state (wp_options), shared by all replicas via MySQL,
# so it only needs to happen once, from a throwaway pod.
echo "Activating plugins..."
wp_cli_run wp-cli-activate wp plugin activate redis-cache s3-uploads woocommerce --allow-root

# MinIO doesn't auto-create buckets on first upload (unlike real S3 in some
# SDKs' assumptions) — s3-uploads will fail every upload with NoSuchBucket
# until this exists.
echo "Ensuring MinIO bucket exists and is publicly readable..."
MINIO_POD=$(kubectl get pods -n wordpress -l app=minio -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n wordpress "$MINIO_POD" -- sh -c \
  "mc alias set local http://localhost:9000 admin password123 >/dev/null \
   && mc mb --ignore-existing local/wordpress \
   && mc anonymous set download local/wordpress"

echo "Setup complete!"
