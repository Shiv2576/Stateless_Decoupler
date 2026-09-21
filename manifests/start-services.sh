#!/bin/bash
# Runs nginx and PHP-FPM together in one container.
#
# Why not supervisord: it is broken on this image (Alpine's python3/expat skew
# makes `supervisord` fail to import pyexpat), but more importantly a full
# process supervisor is the wrong shape for Kubernetes. If supervisord restarts
# a crashed PHP-FPM inside the container, the kubelet never learns anything went
# wrong — the pod reports zero restarts and looks perfectly healthy while
# silently flapping. Kubernetes is already the supervisor; what this script must
# guarantee is the opposite of supervision: if either process dies, exit, so the
# failure surfaces as a container restart.
set -uo pipefail

FPM_PID=""
NGINX_PID=""

# Kubernetes sends SIGTERM and then waits terminationGracePeriodSeconds before
# SIGKILL. Translate that into each process's own graceful-drain signal so
# in-flight requests finish instead of being severed mid-response.
graceful_stop() {
  trap - TERM INT
  [ -n "$NGINX_PID" ] && nginx -s quit 2>/dev/null
  # QUIT is PHP-FPM's graceful shutdown; TERM would kill workers immediately.
  [ -n "$FPM_PID" ] && kill -QUIT "$FPM_PID" 2>/dev/null
  wait
  exit 0
}
trap graceful_stop TERM INT

php-fpm -F &
FPM_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

# Return as soon as *either* process exits rather than waiting for both.
wait -n
status=$?

echo "[start-services] a process exited (status $status) — shutting down so Kubernetes restarts the pod" >&2
kill -TERM "$FPM_PID" "$NGINX_PID" 2>/dev/null
wait 2>/dev/null
exit "${status:-1}"
