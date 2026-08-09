import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readdirSync, existsSync, openSync, readSync, closeSync, mkdtempSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { getClusterStats } from './cluster.js';

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
  const tick = async () => {
    if (cancelled) return;
    try {
      const stats = await getClusterStats();
      if (!cancelled && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'cluster-stats', ...stats }));
      }
    } catch (err) {
      if (!cancelled && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
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
