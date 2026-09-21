#!/bin/sh
# Sizes the PHP-FPM worker pool to the container's actual memory limit before
# starting PHP-FPM.
#
# Hardcoding pm.max_children is a classic PHP-FPM failure mode: set it higher
# than memory allows and the pool happily forks past the cgroup limit under
# load, so the kernel OOM-kills the container mid-request instead of PHP-FPM
# gracefully queuing requests in its listen backlog. Deriving it from the limit
# means the pool degrades into a queue (recoverable, visible as rising latency)
# rather than a kill (not recoverable, visible as 502s).
#
# The same formula is mirrored in manifests/monitoring/php-fpm-metrics.yaml so
# the autoscaling metric's denominator always matches the real pool size.
set -e

# 128MB rather than 64: nginx now runs in this same container and shares its
# memory limit, so the non-worker overhead is FPM master + opcache + nginx
# master/workers. Undersizing this is what causes OOM kills under load.
RESERVED_MB="${PHP_FPM_RESERVED_MB:-128}"  # FPM master + opcache + nginx + headroom
PROCESS_MB="${PHP_FPM_PROCESS_MB:-48}"     # measured avg RSS of a WooCommerce worker
FALLBACK_MAX_CHILDREN=5
POOL_CONF=/usr/local/etc/php-fpm.d/www.conf

limit_bytes=""
if [ -r /sys/fs/cgroup/memory.max ]; then
  limit_bytes=$(cat /sys/fs/cgroup/memory.max)                      # cgroup v2
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  limit_bytes=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)    # cgroup v1
fi

# "max" (v2) or a huge sentinel (v1) both mean "no limit set" — there's nothing
# to derive from, so fall back rather than compute an absurd pool size.
case "$limit_bytes" in
  '' | max | *[!0-9]*) limit_mb=0 ;;
  *) limit_mb=$((limit_bytes / 1024 / 1024)) ;;
esac
[ "$limit_mb" -gt 131072 ] && limit_mb=0

if [ "$limit_mb" -gt 0 ]; then
  usable_mb=$((limit_mb - RESERVED_MB))
  [ "$usable_mb" -lt "$PROCESS_MB" ] && usable_mb="$PROCESS_MB"
  max_children=$((usable_mb / PROCESS_MB))
else
  max_children="$FALLBACK_MAX_CHILDREN"
fi
[ "$max_children" -lt 1 ] && max_children=1

# PHP-FPM refuses to start unless min_spare <= max_spare <= max_children, so
# derive the rest of the pool from max_children instead of leaving image
# defaults that may now exceed it.
start_servers=$((max_children / 4));     [ "$start_servers" -lt 1 ] && start_servers=1
min_spare=$start_servers
max_spare=$((max_children / 2));         [ "$max_spare" -lt "$min_spare" ] && max_spare=$min_spare

sed -i \
  -e "s/^pm.max_children = .*/pm.max_children = ${max_children}/" \
  -e "s/^pm.start_servers = .*/pm.start_servers = ${start_servers}/" \
  -e "s/^pm.min_spare_servers = .*/pm.min_spare_servers = ${min_spare}/" \
  -e "s/^pm.max_spare_servers = .*/pm.max_spare_servers = ${max_spare}/" \
  "$POOL_CONF"

echo "[fpm-autotune] memory_limit=${limit_mb}MB reserved=${RESERVED_MB}MB per_process=${PROCESS_MB}MB"
echo "[fpm-autotune] pm.max_children=${max_children} start_servers=${start_servers} min_spare=${min_spare} max_spare=${max_spare}"

exec docker-entrypoint.sh "$@"
