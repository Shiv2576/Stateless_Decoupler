import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const NAMESPACE = process.env.WP_NAMESPACE || 'wordpress';
const WP_LABEL = process.env.WP_LABEL || 'app=wordpress';
const REDIS_LABEL = process.env.REDIS_LABEL || 'app=redis';
const SESSION_KEY_PATTERN = 'PHPREDIS_SESSION:*';

let cachedMaxChildren = null;

function kubectl(args) {
  return execFileP('kubectl', args, { timeout: 5000 });
}

async function getPmMaxChildren(podName) {
  if (cachedMaxChildren !== null) return cachedMaxChildren;
  try {
    const { stdout } = await kubectl([
      'exec', '-n', NAMESPACE, podName, '-c', 'wordpress', '--',
      'sh', '-c', "grep -m1 '^pm.max_children' /usr/local/etc/php-fpm.d/www.conf",
    ]);
    const match = stdout.match(/=\s*(\d+)/);
    cachedMaxChildren = match ? Number(match[1]) : null;
  } catch {
    cachedMaxChildren = null;
  }
  return cachedMaxChildren;
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
  const maxChildren = podNames[0] ? await getPmMaxChildren(podNames[0]) : null;

  const results = await Promise.all(podNames.map(async (name) => {
    try {
      const { stdout } = await kubectl([
        'exec', '-n', NAMESPACE, name, '-c', 'nginx', '--',
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

  const clusterMaxConcurrent = maxChildren !== null ? maxChildren * podNames.length : null;
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

export async function getClusterStats() {
  const pods = await getPodStats();
  const podNames = pods.map((p) => p.name);
  const [phpFpm, redis] = await Promise.all([
    getPhpFpmStats(podNames),
    getRedisStats(),
  ]);
  return { pods, phpFpm, redis };
}
