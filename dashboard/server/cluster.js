import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const NAMESPACE = process.env.WP_NAMESPACE || 'wordpress';
const WP_LABEL = process.env.WP_LABEL || 'app=wordpress';
const REDIS_LABEL = process.env.REDIS_LABEL || 'app=redis';
// WooCommerce shopping sessions, written by WC_Session_Handler_Redis (see
// manifests/mu-plugins/wc-redis-sessions.php). This previously scanned for
// PHPREDIS_SESSION:* — PHP's native session keys — which always read zero
// because nothing in this stack calls session_start().
const SESSION_KEY_PATTERN = 'wc_session:*';

// Keyed by pod name, not global: each pod derives its own pm.max_children from
// its memory limit at startup (see manifests/fpm-autotune.sh), so pods with
// different limits legitimately have different pool sizes. Caching one value
// for the whole cluster also meant a value read before a rollout survived it,
// making the dashboard report a stale capacity forever.
const maxChildrenByPod = new Map();

// 15s rather than a few seconds: this dashboard is watched *during* load tests,
// which is precisely when the single-machine cluster is saturated and the API
// server responds slowly. A tight timeout makes the cluster panel go blank at
// the exact moment it is most interesting.
function kubectl(args) {
  return execFileP('kubectl', args, { timeout: 15000 });
}

async function getPmMaxChildren(podName) {
  if (maxChildrenByPod.has(podName)) return maxChildrenByPod.get(podName);

  let value = null;
  try {
    const { stdout } = await kubectl([
      'exec', '-n', NAMESPACE, podName, '-c', 'wordpress', '--',
      'sh', '-c', "grep -m1 '^pm.max_children' /usr/local/etc/php-fpm.d/www.conf",
    ]);
    const match = stdout.match(/=\s*(\d+)/);
    value = match ? Number(match[1]) : null;
  } catch {
    value = null;
  }

  // Only cache successful reads — a pod whose container isn't up yet should be
  // retried on the next poll rather than pinned to null for its whole lifetime.
  if (value !== null) maxChildrenByPod.set(podName, value);
  return value;
}

export async function getPodStats() {
  const [{ stdout: podsJson }, topResult] = await Promise.all([
    kubectl(['get', 'pods', '-n', NAMESPACE, '-l', WP_LABEL, '-o', 'json']),
    kubectl(['top', 'pods', '-n', NAMESPACE, '-l', WP_LABEL, '--no-headers']).catch(() => null),
  ]);

  const pods = JSON.parse(podsJson).items;
  const usageByName = new Map();
  if (topResult) {
    for (const line of topResult.stdout.trim().split('\n').filter(Boolean)) {
      const [name, cpu, mem] = line.trim().split(/\s+/);
      usageByName.set(name, { cpu, memory: mem });
    }
  }

  return pods.map((pod) => {
    const name = pod.metadata.name;
    const containerStatuses = pod.status.containerStatuses || [];
    return {
      name,
      phase: pod.status.phase,
      ready: containerStatuses.every((c) => c.ready),
      restarts: containerStatuses.reduce((sum, c) => sum + c.restartCount, 0),
      cpu: usageByName.get(name)?.cpu ?? null,
      memory: usageByName.get(name)?.memory ?? null,
    };
  });
}

export async function getPhpFpmStats(podNames) {
  // Drop cache entries for pods that no longer exist, so the map doesn't grow
  // without bound across repeated scale-up/scale-down cycles.
  for (const cached of maxChildrenByPod.keys()) {
    if (!podNames.includes(cached)) maxChildrenByPod.delete(cached);
  }

  const results = await Promise.all(podNames.map(async (name) => {
    const maxChildren = await getPmMaxChildren(name);
    try {
      // nginx and PHP-FPM now share the "wordpress" container, so /fpm-status
      // is reachable on localhost from inside it.
      const { stdout } = await kubectl([
        'exec', '-n', NAMESPACE, name, '-c', 'wordpress', '--',
        'wget', '-qO-', 'http://127.0.0.1/fpm-status?json',
      ]);
      const status = JSON.parse(stdout);
      return {
        pod: name,
        active: status['active processes'],
        idle: status['idle processes'],
        total: status['total processes'],
        maxChildrenReached: status['max children reached'] > 0,
        maxChildren,
      };
    } catch {
      return { pod: name, active: null, idle: null, total: null, maxChildrenReached: null, maxChildren };
    }
  }));

  // Summed rather than maxChildren × podCount: pool sizes are per-pod, so a
  // cluster mid-rollout can legitimately hold pods with different capacities.
  const known = results.filter((p) => p.maxChildren !== null);
  const clusterMaxConcurrent = known.length
    ? known.reduce((sum, p) => sum + p.maxChildren, 0)
    : null;
  return { pods: results, clusterMaxConcurrent };
}

export async function getRedisStats() {
  try {
    const { stdout: podsJson } = await kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', REDIS_LABEL, '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    const redisPod = podsJson.trim();
    if (!redisPod) return { connectedClients: null, activeSessions: null };

    const [infoResult, scanResult] = await Promise.all([
      kubectl(['exec', '-n', NAMESPACE, redisPod, '--', 'redis-cli', 'INFO', 'clients']),
      kubectl(['exec', '-n', NAMESPACE, redisPod, '--', 'redis-cli', '--scan', '--pattern', SESSION_KEY_PATTERN]),
    ]);

    const clientsMatch = infoResult.stdout.match(/connected_clients:(\d+)/);
    const sessionLines = scanResult.stdout.split('\n').filter((l) => l.trim().length > 0);

    return {
      connectedClients: clientsMatch ? Number(clientsMatch[1]) : null,
      activeSessions: sessionLines.length,
    };
  } catch {
    return { connectedClients: null, activeSessions: null };
  }
}

const DEPLOYMENT = process.env.WP_DEPLOYMENT || 'wordpress';
const MAX_REPLICAS = 10;

const HPA = process.env.WP_HPA || 'wordpress-hpa';
const HPA_FLOOR = 2;

/**
 * Pin the replica count by raising the HPA's floor.
 *
 * `kubectl scale` does NOT work here: the HPA recomputes a target every ~15s
 * and overwrites spec.replicas, so a manual scale visibly snaps back within
 * seconds. Raising the stabilization window does not help either — that window
 * keeps the highest *HPA-generated* recommendation, and with no load every
 * recommendation in its history is minReplicas.
 *
 * minReplicas is a hard floor the HPA will never go below, so this actually
 * holds. Pass the floor value to hand control back to the autoscaler.
 */
export async function scaleDeployment(replicas) {
  const count = Number(replicas);
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPLICAS) {
    throw new Error(`replicas must be an integer between 1 and ${MAX_REPLICAS}`);
  }

  await kubectl([
    'patch', 'hpa', HPA, '-n', NAMESPACE,
    '--type', 'merge',
    '-p', JSON.stringify({ spec: { minReplicas: count } }),
  ]);

  return { minReplicas: count, pinned: count > HPA_FLOOR };
}

/**
 * Delete a single WordPress pod. The name is checked against the live pod list
 * rather than trusted, so a caller cannot reach pods outside this deployment
 * even though the namespace is already fixed.
 */
export async function deletePod(podName) {
  const pods = await getPodStats();
  if (!pods.some((p) => p.name === podName)) {
    throw new Error(`Unknown pod: ${podName}`);
  }
  // --wait=false returns as soon as deletion is accepted; the caller is a UI
  // button and the pod grid will show the change on its next poll anyway.
  await kubectl(['delete', 'pod', '-n', NAMESPACE, podName, '--wait=false']);
  return { deleted: podName };
}

/**
 * Delete every WordPress pod at once — the "the store survives losing its
 * entire application tier" demo. The Deployment recreates them, and because no
 * pod holds session, cart or media state, an open cart survives it.
 */
export async function deleteAllPods() {
  const pods = await getPodStats();
  await kubectl([
    'delete', 'pod', '-n', NAMESPACE, '-l', WP_LABEL, '--wait=false',
  ]);
  return { deleted: pods.map((p) => p.name) };
}

export async function getClusterStats() {
  const pods = await getPodStats();
  const podNames = pods.map((p) => p.name);
  const [phpFpm, redis, desiredReplicas, minReplicas] = await Promise.all([
    getPhpFpmStats(podNames),
    getRedisStats(),
    getDesiredReplicas(),
    getMinReplicas(),
  ]);
  return { pods, phpFpm, redis, desiredReplicas, minReplicas };
}

/** The HPA's floor — what the replica buttons actually control. */
async function getMinReplicas() {
  try {
    const { stdout } = await kubectl([
      'get', 'hpa', HPA, '-n', NAMESPACE, '-o', 'jsonpath={.spec.minReplicas}',
    ]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function getDesiredReplicas() {
  try {
    const { stdout } = await kubectl([
      'get', 'deployment', DEPLOYMENT, '-n', NAMESPACE, '-o', 'jsonpath={.spec.replicas}',
    ]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Product count, read through wp-cli inside a live pod. */
export async function getStoreInfo() {
  const url = process.env.WP_SITE_URL || 'http://localhost:8080';
  try {
    const pods = await getPodStats();
    const ready = pods.find((p) => p.ready);
    if (!ready) return { url, products: null };

    const { stdout } = await execFileP('kubectl', [
      'exec', '-n', NAMESPACE, ready.name, '-c', 'wordpress', '--',
      'sh', '-c', 'cd /var/www/html && wp post list --post_type=product --post_status=publish --format=count --allow-root',
    ], { timeout: 25000 });

    const count = Number(stdout.trim().split('\n').pop());
    return { url, products: Number.isFinite(count) ? count : null };
  } catch {
    return { url, products: null };
  }
}
