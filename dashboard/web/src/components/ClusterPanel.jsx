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

export default function ClusterPanel() {
  const [stats, setStats] = useState(null);
  const [connError, setConnError] = useState('');
  const wsRef = useRef(null);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/cluster`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'cluster-stats') {
        setConnError('');
        setStats(msg);
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
                <div className="pod-warning">max children reached — requests are queuing</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cluster-summary-row">
        <div className="cluster-summary-tile">
          <div className="label">Cluster max concurrent PHP requests</div>
          <div className="value">{stats.phpFpm.clusterMaxConcurrent ?? '—'}</div>
          <div className="sub">pm.max_children × {stats.pods.length} pods</div>
        </div>
        <div className="cluster-summary-tile">
          <div className="label">Redis connected clients</div>
          <div className="value">{stats.redis.connectedClients ?? '—'}</div>
        </div>
        <div className="cluster-summary-tile">
          <div className="label">Redis active sessions</div>
          <div className="value">{stats.redis.activeSessions ?? '—'}</div>
          <div className="sub">PHPREDIS_SESSION:* keys</div>
        </div>
      </div>
    </div>
  );
}
