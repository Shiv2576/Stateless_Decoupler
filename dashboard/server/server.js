import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readdirSync, existsSync, openSync, readSync, closeSync, mkdtempSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { getClusterStats, scaleDeployment, deletePod, deleteAllPods, getStoreInfo } from './cluster.js';

const TESTS_DIR = join(import.meta.dirname, '..', '..', 'configs', 'k6', 'tests');
const PORT = process.env.PORT || 4000;

// Metrics the dashboard charts — everything else in k6's JSON output is dropped
// at the source instead of shipped to the browser and filtered there.
const TRACKED_METRICS = new Set([
  'vus',
  'http_reqs',
  'http_req_duration',
  'http_req_failed',
  'checks',
]);

const runs = new Map(); // runId -> { outFile, proc, done, exitCode, stdout, stderr }

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/tests', (_req, res) => {
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.js'));
  res.json({ files });
});

app.post('/api/run', (req, res) => {
  const file = basename(req.body?.file || '');
  const scriptPath = join(TESTS_DIR, file);
  if (!file || !existsSync(scriptPath)) {
    return res.status(400).json({ error: `Unknown test file: ${file}` });
  }

  const runId = randomUUID();
  const outFile = join(mkdtempSync(join(tmpdir(), 'k6-run-')), 'output.ndjson');

  const proc = spawn('k6', ['run', '--out', `json=${outFile}`, scriptPath]);
  const run = { outFile, proc, done: false, exitCode: null, stdout: '', stderr: '' };
  runs.set(runId, run);

  proc.stdout.on('data', (chunk) => { run.stdout += chunk; });
  proc.stderr.on('data', (chunk) => { run.stderr += chunk; });
  proc.on('error', (err) => {
    run.done = true;
    run.exitCode = -1;
    run.stderr += `\nFailed to start k6: ${err.message}`;
  });
  proc.on('close', (code) => {
    run.done = true;
    run.exitCode = code;
  });

  res.json({ runId });
});

app.get('/api/cluster/stats', async (_req, res) => {
  try {
    res.json(await getClusterStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cluster/scale', async (req, res) => {
  try {
    res.json(await scaleDeployment(req.body?.replicas));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/cluster/pods/delete', async (req, res) => {
  try {
    res.json(await deletePod(String(req.body?.pod || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/cluster/pods/delete-all', async (_req, res) => {
  try {
    res.json(await deleteAllPods());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/store', async (_req, res) => {
  try {
    res.json(await getStoreInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/store/seed', (_req, res) => {
  const script = join(import.meta.dirname, '..', '..', 'scripts', 'seed-store.sh');
  if (!existsSync(script)) {
    return res.status(500).json({ error: 'seed-store.sh not found' });
  }

  // Seeding generates images and pushes them to MinIO, so it can take longer
  // than a browser is willing to wait on a hung request — bound it explicitly.
  const proc = spawn('bash', [script], { timeout: 180000 });
  let out = '';
  let err = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { err += c; });
  proc.on('error', (e) => res.status(500).json({ error: e.message }));
  proc.on('close', (code) => {
    if (res.headersSent) return;
    if (code === 0) {
      res.json({ ok: true, output: out.trim().split('\n').slice(-8).join('\n') });
    } else {
      res.status(500).json({ error: (err || out).trim().split('\n').slice(-5).join('\n') });
    }
  });
});

const server = createServer(app);

// Both WebSocketServers use noServer mode and share one manual 'upgrade'
// dispatcher below — attaching two `{ server, path }` instances directly
// doesn't work: ws's first non-matching server aborts the handshake with a
// 400 before the second ever gets a chance to check its own path.
const wss = new WebSocketServer({ noServer: true });

// Separate channel from the per-run /ws socket above — cluster stats are
// relevant whether or not a k6 run is active, so it polls independently on
// its own interval rather than piggybacking on a run's lifecycle.
const clusterWss = new WebSocketServer({ noServer: true });
const CLUSTER_POLL_MS = 4000;

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws/cluster') {
    clusterWss.handleUpgrade(req, socket, head, (ws) => clusterWss.emit('connection', ws, req));
  } else if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

clusterWss.on('connection', (ws) => {
  let cancelled = false;
  let inFlight = false;
  const tick = async () => {
    // Under load a poll can take longer than the interval. Without this guard
    // ticks overlap and queue up kubectl processes, which makes the very
    // contention that slowed things down worse.
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      const stats = await getClusterStats();
      if (!cancelled && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'cluster-stats', ...stats }));
      }
    } catch (err) {
      if (!cancelled && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    } finally {
      inFlight = false;
    }
  };
  tick();
  const interval = setInterval(tick, CLUSTER_POLL_MS);
  ws.on('close', () => { cancelled = true; clearInterval(interval); });
});

wss.on('connection', (ws, req) => {
  const runId = new URL(req.url, 'http://localhost').searchParams.get('runId');
  const run = runs.get(runId);
  if (!run) {
    ws.send(JSON.stringify({ type: 'error', message: `Unknown runId: ${runId}` }));
    ws.close();
    return;
  }

  let offset = 0;
  let pendingLine = '';

  const poll = setInterval(() => {
    if (!existsSync(run.outFile)) return;

    let fd;
    try {
      fd = openSync(run.outFile, 'r');
      const buf = Buffer.alloc(64 * 1024);
      let bytesRead;
      while ((bytesRead = readSync(fd, buf, 0, buf.length, offset)) > 0) {
        offset += bytesRead;
        pendingLine += buf.toString('utf8', 0, bytesRead);
        const lines = pendingLine.split('\n');
        pendingLine = lines.pop(); // last chunk may be a partial line
        for (const line of lines) {
          if (!line.trim()) continue;
          let point;
          try {
            point = JSON.parse(line);
          } catch {
            continue;
          }
          if (point.type !== 'Point' || !TRACKED_METRICS.has(point.metric)) continue;
          ws.send(JSON.stringify({
            type: 'point',
            metric: point.metric,
            time: point.data.time,
            value: point.data.value,
          }));
        }
      }
    } catch {
      // file may be mid-write; just retry next tick
    } finally {
      if (fd !== undefined) closeSync(fd);
    }

    if (run.done) {
      clearInterval(poll);
      ws.send(JSON.stringify({
        type: 'done',
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
      }));
      ws.close();
    }
  }, 300);

  ws.on('close', () => clearInterval(poll));
});

server.listen(PORT, () => {
  console.log(`k6 dashboard server listening on http://localhost:${PORT}`);
});
