# Stateless Decoupler — Repository Overview

> This document is a from-scratch analysis of the repository's structure, purpose, and
> architecture. It does not change or reflect intent to change any code — it's a map for
> understanding what's already here.

## 1. The Problem It Solves

A stock WordPress/WooCommerce deployment is **stateful**: PHP sessions, uploaded media,
and application data (products, orders, users) are typically all stored on the same
server/pod that renders the page. That coupling breaks the moment you try to run it on
Kubernetes with more than one replica:

- **Sessions** stored in local PHP files mean a logged-in user can get bounced to a
  different pod mid-session and appear logged out, or lose their cart.
- **Media uploads** written to local disk exist only on the pod that received the
  upload — other pods (and any pod created afterward by autoscaling) can't see them.
- Because pods can't be safely added/removed without losing state, you can't
  **horizontally autoscale** the application tier in response to traffic spikes — the
  common "reliable" fallback is to just run oversized, fixed-size servers year-round.

**Stateless Decoupler** is a hands-on testbed for solving this: it strips all
persistent/session state out of the WordPress pod and relocates it to dedicated
services, so that any WordPress pod becomes disposable — safe to kill, replace, or
multiply on demand. It then proves the result actually scales, using a real HPA
(Horizontal Pod Autoscaler) and a load-testing/observability harness built to watch it
happen.

In short: it's a practical study of **"can this specific stateful WordPress/WooCommerce
app be made stateless enough that Kubernetes' HPA can auto-scale it safely under a real
traffic spike, and what does that scaling actually look like in practice?"**

## 2. Core Architecture

### 2.1 The decoupling strategy

| Traditionally stored... | ...is moved to | Why |
|---|---|---|
| PHP sessions (`$_SESSION`, login state, carts) | **Redis** (`redis:6379`) | PHP's session handler is repointed to Redis via `session.save_handler = redis`, so any pod can serve any user's session. |
| WordPress object cache | **Redis** (same instance) | The `redis-cache` plugin drops in `object-cache.php`, offloading `wp_options`/transients lookups off of MySQL. |
| Media uploads (`wp-content/uploads`) | **MinIO** (S3-compatible object storage) | The `humanmade/s3-uploads` plugin (composer-installed) is redirected from real AWS S3 to MinIO's endpoint via a custom `S3_UPLOADS_ENDPOINT` filter (`manifests/mu-plugins/s3-uploads-minio.php`), so uploads land in shared object storage instead of local disk. |
| Application data (posts, products, orders, users) | **MySQL** (single `StatefulSet`, 1 replica) | Already naturally shared/relational; kept as the single source of truth all pods read/write through. |

With all three removed, a WordPress pod itself holds **no durable state** — it's pure
compute (PHP-FPM executing requests). That's what makes it safe for Kubernetes to spin
replicas up or down freely.

### 2.2 Kubernetes layout (`manifests/`)

Everything lives in a single `wordpress` namespace on a local **k3d/K3s** cluster:

```
                              Ingress (Traefik)
                    /wordpress → minio:9000   (media reads)
                    /          → wordpress:80 (app traffic)
                                     │
                        ┌────────────────────────┐
                        │   wordpress Deployment   │  2-5 replicas (HPA: CPU 70% / Mem 80%)
                        │  ┌────────┐ ┌─────────┐ │
                        │  │ nginx  │ │wordpress│ │  2 containers per pod, sharing an
                        │  │(proxy) │→│(php-fpm)│ │  emptyDir populated at pod start
                        │  └────────┘ └─────────┘ │  by an initContainer (from the
                        └────────────┬────────────┘  baked WordPress image)
                                     │
              ┌──────────────┬──────┴───────┬──────────────┐
              ▼              ▼              ▼
         ┌─────────┐   ┌──────────┐   ┌──────────────┐
         │  MySQL  │   │  Redis   │   │    MinIO     │
         │StatefulSet│  │Deployment│   │  Deployment   │
         │ 1 replica │  │1 replica │   │  (+ PVC 10Gi) │
         │ PVC 5Gi   │  │appendonly│   │  S3 API :9000 │
         └─────────┘   └──────────┘   │  console :9001│
                                       └──────────────┘
```

Key details:
- **`wordpress.yaml`** — the app `Deployment`/`Service`/`Ingress`/`HorizontalPodAutoscaler`.
  Each pod runs two containers: `nginx` (public-facing, serves static assets + proxies
  PHP requests) and `wordpress` (PHP-FPM on port 9000, internal-only). They share files
  via an `emptyDir` populated once per pod by an `init-html` initContainer, since the
  `nginx:alpine` image itself has no WordPress files.
- **`wordpress-config.yaml`** — two `ConfigMap`s: the actual `wp-config.php` (DB, Redis,
  S3/MinIO settings) mounted into the pod, and the nginx vhost config (PHP-FPM proxy,
  static asset caching, a `/fpm-status` endpoint used by the dashboard, and security
  rules like denying `wp-config.php`/`.ht*` access).
- **`mysql.yaml`** — a single-replica `StatefulSet` with a `PersistentVolumeClaim`; this
  is the one genuinely stateful piece left, intentionally — it's the system of record,
  not a scaling target.
- **`redis.yaml`** — single-replica Redis with AOF persistence + LRU eviction, used for
  both sessions and object cache.
- **`minio.yaml`** — MinIO with a `PersistentVolumeClaim`, exposed both internally
  (`ClusterIP`, used by WordPress) and externally (`LoadBalancer`, for admin/testing
  access to the console).
- **`wordpress.Dockerfile`** — builds a custom WordPress image on top of
  `wordpress:6.6-php8.2-fpm-alpine`: compiles the `phpredis` PHP extension from source
  (needed for real session offloading — without it, PHP silently falls back to file
  sessions), installs `wp-cli`, and bakes in the `redis-cache`, `woocommerce` (pinned to
  9.5.0 for WP 6.6 compatibility), and `humanmade/s3-uploads` (via Composer, for its AWS
  SDK dependency) plugins.
- **`mu-plugins/`** — two must-use plugins baked into the image:
  - `s3-uploads-minio.php` repoints the s3-uploads plugin's AWS SDK client at MinIO's
    endpoint (MinIO has no native support in that plugin otherwise).
  - `disable-password-strength.php` disables WooCommerce's password-strength gate, for
    frictionless dev/test account creation.
- **`monitoring/setup-all.sh`** — installs the `kube-prometheus-stack` Helm chart
  (Prometheus + Grafana + kube-state-metrics + node-exporter) into a `monitoring`
  namespace, using `configs/grafana/prometheus-values.yaml` (7-day retention, a
  pre-provisioned Prometheus datasource, and Grafana dashboard `19665` — a standard k6
  load-test dashboard — auto-imported).

### 2.3 Load testing (`configs/k6/`, `scripts/`)

- **`configs/k6/tests/wordpress-load.js`** — a k6 script that ramps virtual users from
  0 → 5 → 10 → 20 → 0 over ~7 minutes, hitting the homepage, login page, and a product
  page, with thresholds (`p95 < 500ms`, error rate `< 1%`) that make a run pass/fail.
  This is the synthetic "viral traffic spike" the HPA is meant to absorb.
- **`scripts/install-plugins.sh`** — end-to-end environment bring-up: builds the custom
  WordPress image, imports it into the k3d cluster, applies `wordpress.yaml`, rolls out
  the deployment, runs `wp core install` once (via a throwaway `wp-cli` pod sharing the
  same `wp-config.php` ConfigMap — WordPress core setup is DB state, so it only needs to
  happen once across all replicas), activates the `redis-cache`/`s3-uploads`/
  `woocommerce` plugins (also DB state, also once), and ensures the MinIO bucket exists
  and is publicly readable (MinIO doesn't auto-create buckets, unlike some real-S3
  client assumptions).
- **`scripts/run-k6-test.sh`** — thin wrapper that runs the k6 test directly against
  `localhost:8080` and prints where to view results in Grafana.
- **`scripts/run-all.sh`** — orchestrates the whole demo: deploys monitoring, port-
  forwards Grafana to `localhost:3000`, then runs the k6 load test.

### 2.4 Live dashboard (`dashboard/`)

A small full-stack app for watching a load test and the cluster's real-time response to
it, instead of only reading a static k6/Grafana summary after the fact.

**Backend — `dashboard/server/` (Node.js + Express + `ws`, port 4000)**
- `server.js`:
  - `GET /api/tests` — lists available k6 test scripts from `configs/k6/tests/`.
  - `POST /api/run` — spawns `k6 run --out json=<tmpfile>` as a child process and
    returns a `runId`.
  - `WS /ws?runId=...` — tails the k6 JSON-lines output file (polling every 300ms,
    tracking a byte offset so it only reads new data), filters it down to five tracked
    metrics (`vus`, `http_reqs`, `http_req_duration`, `http_req_failed`, `checks`), and
    streams each data point to the browser; sends a final `done` message with exit code
    and stdout/stderr summary when the k6 process exits.
  - `WS /ws/cluster` — independent of any test run; polls `getClusterStats()` every 4s
    and streams cluster health regardless of whether a load test is active.
  - Both WebSocket servers run in `noServer` mode behind one manual `upgrade` handler,
    since attaching two path-scoped `WebSocketServer`s directly to the same HTTP server
    doesn't work (the first non-matching one aborts the handshake).
- `cluster.js` — shells out to `kubectl` (via `execFile`) to gather live cluster state:
  - `getPodStats()` — pod phase/readiness/restarts/CPU/memory via `kubectl get pods` +
    `kubectl top pods`.
  - `getPhpFpmStats()` — `pm.max_children` (read once from a pod's php-fpm config and
    cached) plus each pod's live active/idle PHP-FPM worker counts via the
    `/fpm-status` nginx location exposed on each pod.
  - `getRedisStats()` — connected client count (`redis-cli INFO clients`) and active
    session count (`redis-cli --scan` for `PHPREDIS_SESSION:*` keys), proving sessions
    are actually centralized in Redis rather than pod-local.
  - `getClusterStats()` — combines all of the above into one payload.

**Frontend — `dashboard/web/` (React 18 + Vite + Recharts)**
- `App.jsx` — the main page: lets the user pick and run a k6 test, opens the `/ws`
  socket, buckets incoming metric points into per-second aggregates client-side
  (computing p50/p90/p95 latency and error rate per bucket), and renders stat tiles plus
  time-series charts for VUs, requests/sec, latency percentiles, and error rate.
- `components/ClusterPanel.jsx` — subscribes to `/ws/cluster` and renders a live grid of
  WordPress pod cards (readiness, CPU/memory, restarts, PHP-FPM worker utilization bar)
  plus cluster-wide summary tiles (max concurrent PHP capacity = `pm.max_children ×
  pod count`, Redis connected clients, Redis active sessions) — this is the panel that
  visually demonstrates the HPA adding pods (and capacity) as the k6 test ramps load up.
- `components/MetricChart.jsx`, `StatTile.jsx`, `TestSelector.jsx` — presentational
  building blocks (charts, single-stat cards, the test-file picker/run button).

### 2.5 Data flow, end to end

```
k6 load test ──HTTP──> Ingress ──> nginx ──fastcgi──> PHP-FPM (WordPress)
                                                              │
                                           ┌──────────────────┼──────────────────┐
                                           ▼                  ▼                  ▼
                                        MySQL              Redis              MinIO
                                    (posts/orders/     (sessions +      (uploaded media,
                                     users, source        object          proxied back
                                     of truth)            cache)          through Ingress)

Meanwhile:
k6 (JSON metrics) ──file──> dashboard/server ──WebSocket──> dashboard/web (charts)
kubectl (pods/top/exec) ──> dashboard/server ──WebSocket──> dashboard/web (ClusterPanel)
HPA watches pod CPU/mem ──> scales `wordpress` Deployment 2↔5 replicas
```

## 3. Why This Matters (the demonstrated payoff)

Because no user- or app-specific state lives inside a WordPress pod:
1. The **HPA** can scale the `wordpress` Deployment from 2 to 5 replicas purely off CPU
   (70%) and memory (80%) thresholds, with zero risk of losing sessions, carts, or
   uploads when a pod is added or removed.
2. A viral-traffic scenario (sudden spike → HPA scales out → traffic spreads across more
   pods → spike subsides → HPA scales back in) can be safely rehearsed and observed live,
   rather than only reasoned about theoretically.
3. The dashboard turns that abstract claim ("stateless pods scale safely") into a
   directly observable signal: pod count climbing under `k6`-generated load, PHP-FPM
   worker saturation per pod, and Redis session/connection counts staying centralized
   and continuous throughout — i.e., proof, not just architecture diagrams.

## 4. Repository Map

```
.
├── README.md                          Quick-start commands + project description
├── ARCHITECTURE.md                    This document
├── manifests/                         Kubernetes resources + WordPress image build
│   ├── wordpress.yaml                 App Deployment, Service, Ingress, HPA
│   ├── wordpress-config.yaml          wp-config.php + nginx vhost ConfigMaps
│   ├── wordpress.Dockerfile           Custom WP image (phpredis, wp-cli, plugins)
│   ├── mysql.yaml                     MySQL StatefulSet (system of record)
│   ├── redis.yaml                     Redis Deployment (sessions + object cache)
│   ├── minio.yaml                     MinIO Deployment (S3-compatible media storage)
│   ├── mu-plugins/                    Must-use PHP plugins baked into the image
│   └── monitoring/setup-all.sh        Installs kube-prometheus-stack
├── configs/
│   ├── grafana/prometheus-values.yaml Helm values for the monitoring stack
│   └── k6/tests/wordpress-load.js     Synthetic "viral traffic" load test
├── scripts/
│   ├── install-plugins.sh             Build image, deploy, install WP, activate plugins
│   ├── run-k6-test.sh                 Run the k6 test directly
│   └── run-all.sh                     Full demo: monitoring + Grafana + load test
└── dashboard/                         Live k6 + cluster observability UI
    ├── server/                        Express + ws backend (port 4000)
    │   ├── server.js                  HTTP API + WebSocket streaming of k6 output
    │   └── cluster.js                 kubectl-based live cluster stats
    └── web/                           React + Vite + Recharts frontend
        └── src/
            ├── App.jsx                Test runner + metric charts
            └── components/            ClusterPanel, MetricChart, StatTile, TestSelector
```

## 5. Notes for Anyone Picking This Up

- This is a **local/dev-oriented demo stack**, not production-hardened: secrets (DB
  passwords, MinIO credentials, WordPress auth salts) are plaintext in the manifests,
  `WP_DEBUG`/environment settings are dev defaults, and MySQL/Redis/MinIO each run as a
  single replica (deliberately — they're the fixed "backing services," not the thing
  being scaled).
  - There is also a `secrets.txt` file at the repo root, outside any manifest — worth
    checking whether it should exist in version control at all before this repo is
    shared or made public.
- The `wordpress` pods are the *only* thing the HPA targets; MySQL/Redis/MinIO are
  intentionally left as single points of state precisely because collapsing statelessness
  down to "just the app tier" is the whole point of the experiment — a natural next step
  (not implemented here) would be clustering/replicating those backing services too.
