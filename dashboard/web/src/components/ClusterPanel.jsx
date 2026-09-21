import { useEffect, useRef, useState } from 'react';

function shortPodName(name) {
  // wordpress-cb9ddb44d-5ldbh -> 5ldbh
  const parts = name.split('-');
  return parts[parts.length - 1];
}

function WorkerBar({ active, max }) {
  if (active === null || max === null) return <div className="worker-bar empty" />;
  const pct = Math.min(100, (active / max) * 100);
  const tone = pct >= 100 ? 'critical' : pct >= 70 ? 'warning' : 'good';
  return (
    <div className="worker-bar">
      <div className={`worker-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function ClusterPanel({ onStats }) {
  const [stats, setStats] = useState(null);
  const [connError, setConnError] = useState('');
  const [deleting, setDeleting] = useState('');
  const wsRef = useRef(null);

  async function deletePod(name) {
    setDeleting(name);
    try {
      const res = await fetch('/api/cluster/pods/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pod: name }),
      });
      if (!res.ok) setConnError((await res.json()).error || 'Delete failed');
    } catch (e) {
      setConnError(e.message);
    } finally {
      // The pod grid refreshes on its own poll; clearing here just re-enables
      // the button if the same pod is somehow still listed.
      setTimeout(() => setDeleting(''), 2000);
    }
  }

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/cluster`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'cluster-stats') {
        setConnError('');
        setStats(msg);
        onStats?.(msg);
      } else if (msg.type === 'error') {
        setConnError(msg.message);
      }
    };
    ws.onerror = () => setConnError('Could not reach cluster stats (is kubectl configured?)');

    return () => ws.close();
  }, []);

  if (connError && !stats) {
    return <div className="chart-card"><div className="empty-state">{connError}</div></div>;
  }
  if (!stats) {
    return <div className="chart-card"><div className="empty-state">Loading cluster stats…</div></div>;
  }

  const fpmByPod = new Map(stats.phpFpm.pods.map((p) => [p.pod, p]));

  return (
    <div className="chart-card">
      <h3>Cluster — WordPress pods</h3>
      <div className="pod-grid">
        {stats.pods.map((pod) => {
          const fpm = fpmByPod.get(pod.name);
          return (
            <div className="pod-card" key={pod.name}>
              <div className="pod-card-header">
                <span className="pod-name">{shortPodName(pod.name)}</span>
                <span className={`status-pill ${pod.ready ? 'passed' : 'failed'}`}>
                  {pod.ready ? 'ready' : pod.phase}
                </span>
                <button
                  className="btn btn-danger btn-sm"
                  title="Delete this pod — the store keeps serving from the others"
                  onClick={() => deletePod(pod.name)}
                  disabled={deleting === pod.name}
                >
                  {deleting === pod.name ? '…' : 'kill'}
                </button>
              </div>
              <div className="pod-metric-row">
                <span>CPU</span><span>{pod.cpu ?? '—'}</span>
              </div>
              <div className="pod-metric-row">
                <span>Memory</span><span>{pod.memory ?? '—'}</span>
              </div>
              <div className="pod-metric-row">
                <span>Restarts</span><span>{pod.restarts}</span>
              </div>
              <div className="pod-metric-row">
                <span>PHP-FPM workers</span>
                <span>{fpm ? `${fpm.active} active / ${fpm.total} total (max ${fpm.maxChildren})` : '—'}</span>
              </div>
              <WorkerBar active={fpm?.active ?? null} max={fpm?.maxChildren ?? null} />
              {fpm?.maxChildrenReached && (
                <div className="pod-warning"></div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cluster-summary-row">
        <div className="cluster-summary-tile">
          <div className="label">Cluster max concurrent PHP requests</div>
          <div className="value">{stats.phpFpm.clusterMaxConcurrent ?? '—'}</div>
          <div className="sub">pm.max_children summed over {stats.pods.length} pods</div>
        </div>
        <div className="cluster-summary-tile">
          <div className="label">Redis connected clients</div>
          <div className="value">{stats.redis.connectedClients ?? '—'}</div>
        </div>
        <div className="cluster-summary-tile">
          <div className="label">Redis carts / sessions</div>
          <div className="value">{stats.redis.activeSessions ?? '—'}</div>
          <div className="sub">wc_session:* keys</div>
        </div>
      </div>
    </div>
  );
}
