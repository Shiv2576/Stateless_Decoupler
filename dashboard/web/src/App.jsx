import { useEffect, useRef, useState } from 'react';
import TestSelector from './components/TestSelector.jsx';
import StatTile from './components/StatTile.jsx';
import MetricChart from './components/MetricChart.jsx';
import ClusterPanel from './components/ClusterPanel.jsx';
import StoreControls from './components/StoreControls.jsx';

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.ceil(p * sortedArr.length) - 1);
  return sortedArr[Math.max(0, idx)];
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('idle'); // idle | running | passed | failed
  const [chartData, setChartData] = useState([]);
  const [totals, setTotals] = useState({
    requests: 0, checksTotal: 0, checksSucceeded: 0, currentVus: 0, avgRequestTimeSeconds: 0,
  });
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [desiredReplicas, setDesiredReplicas] = useState(null);
  const [minReplicas, setMinReplicas] = useState(null);

  const bucketsRef = useRef(new Map());
  const totalsRef = useRef({ requests: 0, checksTotal: 0, checksSucceeded: 0, durationSumMs: 0, durationCount: 0 });
  const lastVusRef = useRef(0);
  const t0Ref = useRef(null);
  const wsRef = useRef(null);
  const flushTimerRef = useRef(null);

  useEffect(() => {
    fetch('/api/tests')
      .then((r) => r.json())
      .then((d) => {
        setFiles(d.files || []);
        if (d.files?.length) setSelected(d.files[0]);
      })
      .catch(() => setError('Could not reach the dashboard backend on :4000'));
  }, []);

  function bucketFor(second) {
    let bucket = bucketsRef.current.get(second);
    if (!bucket) {
      bucket = { t: second, vus: lastVusRef.current, reqCount: 0, durations: [], failedVals: [] };
      bucketsRef.current.set(second, bucket);
    }
    return bucket;
  }

  function handlePoint({ metric, time, value }) {
    const seconds = Math.floor(new Date(time).getTime() / 1000);
    if (t0Ref.current === null) t0Ref.current = seconds;
    const t = seconds - t0Ref.current;
    const bucket = bucketFor(t);

    switch (metric) {
      case 'vus':
        bucket.vus = value;
        lastVusRef.current = value;
        break;
      case 'http_reqs':
        bucket.reqCount += value;
        totalsRef.current.requests += value;
        break;
      case 'http_req_duration':
        bucket.durations.push(value);
        totalsRef.current.durationSumMs += value;
        totalsRef.current.durationCount += 1;
        break;
      case 'http_req_failed':
        bucket.failedVals.push(value);
        break;
      case 'checks':
        totalsRef.current.checksTotal += 1;
        if (value === 1) totalsRef.current.checksSucceeded += 1;
        break;
      default:
        break;
    }
  }

  function flush() {
    const rows = [...bucketsRef.current.values()]
      .sort((a, b) => a.t - b.t)
      .map((b) => {
        const sortedDur = [...b.durations].sort((x, y) => x - y);
        const failRate = b.failedVals.length
          ? (b.failedVals.reduce((s, v) => s + v, 0) / b.failedVals.length) * 100
          : 0;
        return {
          t: b.t,
          vus: b.vus,
          rps: b.reqCount,
          p50: percentile(sortedDur, 0.5),
          p90: percentile(sortedDur, 0.9),
          p95: percentile(sortedDur, 0.95),
          errorRate: failRate,
        };
      });
    setChartData(rows);
    setTotals({
      requests: totalsRef.current.requests,
      checksTotal: totalsRef.current.checksTotal,
      checksSucceeded: totalsRef.current.checksSucceeded,
      currentVus: lastVusRef.current,
      avgRequestTimeSeconds: totalsRef.current.durationCount
        ? totalsRef.current.durationSumMs / totalsRef.current.durationCount / 1000
        : 0,
    });
  }

  function resetState() {
    bucketsRef.current = new Map();
    totalsRef.current = { requests: 0, checksTotal: 0, checksSucceeded: 0, durationSumMs: 0, durationCount: 0 };
    lastVusRef.current = 0;
    t0Ref.current = null;
    setChartData([]);
    setTotals({ requests: 0, checksTotal: 0, checksSucceeded: 0, currentVus: 0, avgRequestTimeSeconds: 0 });
    setSummary('');
    setError('');
  }

  async function runTest() {
    resetState();
    setStatus('running');

    let runId;
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start run');
      runId = data.runId;
    } catch (e) {
      setStatus('failed');
      setError(e.message);
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?runId=${runId}`);
    wsRef.current = ws;

    flushTimerRef.current = setInterval(flush, 500);

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'point') {
        handlePoint(msg);
      } else if (msg.type === 'error') {
        setError(msg.message);
        setStatus('failed');
      } else if (msg.type === 'done') {
        clearInterval(flushTimerRef.current);
        flush();
        setSummary(msg.stdout || msg.stderr || '');
        setStatus(msg.exitCode === 0 ? 'passed' : 'failed');
      }
    };
    ws.onerror = () => setError('WebSocket connection to backend failed');
  }

  useEffect(() => () => {
    wsRef.current?.close();
    clearInterval(flushTimerRef.current);
  }, []);

  const checksFailed = totals.checksTotal - totals.checksSucceeded;

  return (
    <div className="app">
      <div className="app-header">
        <h1>k6 Load Test Dashboard</h1>
        <span className={`status-pill ${status}`}>{status}</span>
      </div>

      <TestSelector
        files={files}
        selected={selected}
        onSelect={setSelected}
        onRun={runTest}
        running={status === 'running'}
      />

      {error && <div className="empty-state" style={{ color: 'var(--status-critical)' }}>{error}</div>}

      <div className="stat-grid">
        <StatTile label="Active VUs" value={totals.currentVus} />
        <StatTile label="Total requests" value={totals.requests} />
        <StatTile label="Checks passed" value={totals.checksSucceeded} tone="good" />
        <StatTile
          label="Checks failed"
          value={checksFailed}
          tone={checksFailed > 0 ? 'critical' : undefined}
        />
        <StatTile label="Avg request time" value={`${totals.avgRequestTimeSeconds.toFixed(3)}s`} />
      </div>

      <StoreControls desiredReplicas={desiredReplicas} minReplicas={minReplicas} />

      <ClusterPanel
        onStats={(s) => {
          setDesiredReplicas(s.desiredReplicas ?? null);
          setMinReplicas(s.minReplicas ?? null);
        }}
      />

      <MetricChart
        title="Virtual users"
        data={chartData}
        series={[{ key: 'vus', label: 'VUs', color: 'var(--series-1)' }]}
      />

      <MetricChart
        title="Requests / sec"
        data={chartData}
        series={[{ key: 'rps', label: 'req/s', color: 'var(--series-3)' }]}
      />

      <MetricChart
        title="Response latency"
        data={chartData}
        yUnit="ms"
        series={[
          { key: 'p50', label: 'p50', color: 'var(--series-1)' },
          { key: 'p90', label: 'p90', color: 'var(--series-2)' },
          { key: 'p95', label: 'p95', color: 'var(--series-8)' },
        ]}
      />

      <MetricChart
        title="Error rate"
        data={chartData}
        yUnit="%"
        series={[{ key: 'errorRate', label: 'error rate', color: 'var(--series-8)' }]}
      />

      {summary && (
        <div className="chart-card">
          <h3>k6 summary</h3>
          <pre className="summary-pre">{summary}</pre>
        </div>
      )}
    </div>
  );
}
