# Stateless Decoupler

Turning a stateful WordPress/WooCommerce store into a **stateless, horizontally
scalable** application tier on Kubernetes — and proving it with a live load-test
dashboard that shows pods autoscaling under traffic.

A stock WordPress deployment keeps sessions, uploaded media, and application data on
the same box that renders the page. That coupling makes it unsafe to run more than one
replica, and impossible to autoscale: add a pod and it can't see the media; remove a
pod and you drop whatever was on it.

This project moves each piece of state out into a dedicated service, so a WordPress pod
becomes pure compute — safe to kill, replace, or multiply on demand:

| State | Moved to | Mechanism |
|---|---|---|
| Object cache | **Redis** | `redis-cache` plugin + `object-cache.php` drop-in |
| Media uploads | **MinIO** (S3-compatible) | `humanmade/s3-uploads` pointed at MinIO via a mu-plugin |
| Posts / products / orders / users | **MySQL** | Shared DB, single source of truth |
| PHP sessions | **Redis** | `session.save_handler = redis` (see *Known limitations*) |

With state externalized, the **HorizontalPodAutoscaler** scales WordPress from 2 to 5
replicas on CPU (70%) and memory (80%), then back down when traffic subsides.

> For a full architectural breakdown — every manifest, the request path, the dashboard
> internals — see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Prerequisites

| Tool | Purpose |
|---|---|
| Docker | Runs the k3d cluster and builds the WordPress image |
| [k3d](https://k3d.io) | Local K3s cluster |
| kubectl | Cluster access |
| [k6](https://k6.io) | Load generation (`brew install k6`) |
| Node.js 18+ | Load-test dashboard |

Give Docker a healthy resource allocation — Docker Desktop → Settings → Resources.
The stack plus a load test is genuinely CPU-hungry, and starving it causes slow pod
startup and flaky readiness (see *Troubleshooting*).

## Quick start

From a clean machine to a running store:

```bash
./scripts/bootstrap.sh
```

That script is idempotent and will:

1. Create the k3d cluster `mycluster` (1 server, 2 agents) with `localhost:8080`
   mapped to the in-cluster Traefik ingress.
2. Deploy MySQL, Redis, MinIO and the WordPress/nginx ConfigMaps.
3. Build the custom WordPress image and import it into the cluster.
4. Install WordPress once, activate `redis-cache` / `s3-uploads` / `woocommerce`,
   and create the public MinIO bucket.

When it finishes:

| What | Where | Credentials |
|---|---|---|
| Store | http://localhost:8080 | — |
| wp-admin | http://localhost:8080/wp-admin | `admin` / `admin` |
| MinIO console | http://localhost:9001 | `admin` / `password123` |

> **The `8080` port mapping is load-bearing.** WordPress stores `http://localhost:8080`
> as its site URL in the database, and `wp-config.php` uses it for
> `S3_UPLOADS_BUCKET_URL`. Changing the host port means reinstalling WordPress.

To stop and resume later without losing data (PVCs survive):

```bash
k3d cluster stop mycluster
k3d cluster start mycluster
```

## Load-test dashboard

A purpose-built dashboard that streams k6 metrics *and* live cluster state side by
side — so you can watch latency, pod count, and PHP-FPM worker saturation move
together in one view.

```bash
# Terminal 1 — backend (port 4000)
cd dashboard/server && npm install && node server.js

# Terminal 2 — frontend (port 5173)
cd dashboard/web && npm install && npm run dev
```

Open **http://localhost:5173**.

The backend shells out to `kubectl`, so it uses whatever context your terminal has —
make sure it's `k3d-mycluster`.

**Important:** the charts only plot runs the dashboard itself starts. Launching `k6`
from a terminal writes to its own output file that the dashboard never sees, and the
graphs will sit at *"Waiting for data…"*. Use the **Run test** button.

The cluster panel below the charts polls independently every 4s, so it shows pod
health, CPU/memory, PHP-FPM workers, and Redis stats whether or not a test is running.

## How to showcase this

Two demos. The first shows autoscaling; the second shows *why* autoscaling is safe.

### Demo 1 — Autoscaling under a traffic spike

**Setup.** Confirm you're at the HPA floor, and leave this running in a side terminal:

```bash
kubectl get hpa,pods -n wordpress -l app=wordpress -w
```

You should see 2 WordPress pods. In the dashboard's cluster panel, note
**Cluster max concurrent PHP requests: 10** — that's `pm.max_children` (5) × 2 pods.
It's the honest ceiling of the app tier, and it's about to become the story.

**Run it.** Select `wordpress-scale-out.js` and hit **Run test**. It ramps to 40 virtual
users — deliberately ~4× the 2-pod capacity — and holds for 4 minutes.

**What to narrate, in order:**

| ~Time | What happens | The point |
|---|---|---|
| 0–30s | VUs ramp to 40, latency climbs | 40 concurrent users against 10 PHP slots — requests queue |
| ~40s | HPA CPU crosses 70% | The autoscaler notices |
| ~60s | New pods appear as `Init:0/1` | Scale-out begins, unprompted |
| ~100s | Pods reach `2/2 Running`, capacity tile → 20 | Real capacity arrives |
| ~140s | 5th pod added, tile → 25 | HPA ceiling reached |
| 140s+ | **Latency falls, RPS rises, errors stay flat** | The payoff shot |

Those timings are from an actual run on this stack — pods went 2 → 4 → 5 within
~140 seconds.

**The closer.** Stop generating load and wait. Nothing happens for five minutes, then
the deployment collapses back to 2. That delay is Kubernetes' default scale-down
stabilization window — it exists so a brief traffic lull doesn't cause thrashing.
Point at it deliberately; "it didn't scale down instantly" is a feature, and knowing
why is the difference between running a demo and understanding it.

### Demo 2 — Pods are disposable

This is the one that actually demonstrates decoupling. **Start a load test first**, then
while it's running, kill a pod:

```bash
kubectl delete pod -n wordpress "$(kubectl get pods -n wordpress -l app=wordpress -o jsonpath='{.items[0].metadata.name}')"
```

Then show, while the site is still being hammered:

- The **error rate chart stays flat** — surviving pods absorb the traffic, because the
  Service only routes to `Ready` endpoints.
- A **replacement pod appears** and rejoins automatically.
- **Media still loads** — images live in MinIO, not on the pod you just destroyed.
- **Products and orders are intact** — they were never on the pod to begin with.

Deleting a pod from a conventional WordPress host loses the uploads on its disk. Here it
costs nothing. That's the entire thesis in one command.

### Optional — CLI and Grafana

```bash
k6 run configs/k6/tests/wordpress-load.js       # 3 min, 15 VUs, steady state
k6 run configs/k6/tests/wordpress-scale-out.js  # 40 VUs, forces 2 -> 5 scale-out

./manifests/monitoring/setup-all.sh             # Prometheus + Grafana
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
```

## Test scripts

| File | Shape | Use it for |
|---|---|---|
| `wordpress-load.js` | 30s ramp → 2m at 15 VUs → 30s down | Steady-state baseline |
| `wordpress-scale-out.js` | 30s ramp → 4m at 40 VUs → 1m down | Triggering and observing HPA scale-out |

`wordpress-scale-out.js` runs deliberately loose thresholds — the goal is to *observe*
the spike-then-recover curve, not to pass/fail on it.

## Troubleshooting

**Homepage takes ~30 seconds; latency is terrible regardless of pod count.**
Check MinIO: `kubectl get pods -n wordpress -l app=minio`. If it isn't `Running`,
WordPress blocks on a dead S3 endpoint on every request that touches media, and no
amount of scaling helps. This is not a capacity problem and the HPA can't fix it —
CPU stays near idle while latency is enormous.

**MinIO stuck in `ImagePullBackOff`.**
`minio/minio:latest` on Docker Hub is no longer publicly pullable. The manifest uses
`quay.io/minio/minio:latest` instead. Note that `k3d image import` fails on this image
with a `content digest ... not found` error — let the cluster nodes pull it directly
from quay.io rather than importing it locally.

**Dashboard charts stuck on "Waiting for data…".**
You started k6 from a terminal instead of the dashboard's **Run test** button. Only
dashboard-initiated runs are streamed to the charts.

**Cluster panel shows `null active / null total` workers for some pods.**
The backend reads PHP-FPM status via `kubectl exec` into each pod. Newly-created pods
report `null` until their nginx container is ready, and execs can fail under heavy node
load. It's a reporting gap, not a pod fault.

**Pods take minutes to become `Ready`; nodes flap to `NotReady`; `kubectl` times out.**
The host is out of CPU. k3d runs every "node" as a container on one machine, so a heavy
load test starves the control plane that's trying to schedule your new pods. Raise
Docker's CPU/memory allocation, or don't run a 40-VU test while watching cold starts.
Check with `docker stats`.

**WordPress installed but the site URL is wrong.**
The `8080` host port is baked into the database. Recreate the cluster with the correct
mapping and re-run `./scripts/bootstrap.sh`.

## Known limitations

This is a **local development and demonstration stack**, not a production reference.

- **Secrets are plaintext** in the manifests, and the WordPress auth salts in
  `wordpress-config.yaml` are literal `put-your-unique-key-here-N` placeholders, which
  makes auth cookies cryptographically worthless. Real deployments need generated salts
  delivered via Kubernetes `Secret`s. There is also a `secrets.txt` tracked in git that
  should be removed and its credentials rotated.
- **PHP session offloading is configured but largely unexercised.** WordPress core
  authenticates with signed cookies rather than server-side sessions, and WooCommerce
  uses its own handler backed by the `wp_woocommerce_sessions` MySQL table — neither
  calls `session_start()` in normal operation. That's why the dashboard's *Redis active
  sessions* tile reads `0`. The decoupling that is actually load-bearing here is object
  cache → Redis and media → MinIO.
- **MySQL, Redis, and MinIO are each a single replica** with no backups or failover.
  They're deliberately the fixed backing services rather than the scaling target, but
  MySQL is the real ceiling of this architecture — every WordPress replica opens its own
  connection pool against one server.
- **Scaling on CPU is a poor fit for PHP-FPM.** A pod with all 5 workers blocked on I/O
  is fully saturated at near-zero CPU, and the HPA won't react. Worker saturation —
  which the dashboard already collects — is the more honest signal, via Prometheus and a
  custom-metrics HPA.
- **Cold start is slow.** Every new pod copies WordPress core, WooCommerce, and the AWS
  SDK into an `emptyDir` before serving traffic, which is most of the ~40s scale-out
  latency.
