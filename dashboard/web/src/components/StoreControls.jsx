import { useEffect, useState } from 'react';

const STORE_URL = 'http://localhost:8080';

export default function StoreControls({ desiredReplicas, minReplicas, onChanged }) {
  const [store, setStore] = useState({ url: STORE_URL, products: null });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);

  async function loadStore() {
    try {
      const res = await fetch('/api/store');
      setStore(await res.json());
    } catch {
      /* panel still works without the product count */
    }
  }

  useEffect(() => { loadStore(); }, []);

  function report(text, tone = 'info') {
    setMessage({ text, tone });
    setTimeout(() => setMessage(null), 6000);
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function scale(replicas) {
    setBusy('scale');
    try {
      await post('/api/cluster/scale', { replicas });
      report(
        replicas > 2
          ? `Pinned to ${replicas} pods (HPA floor raised — it will not scale below this).`
          : 'Floor back to 2 — the HPA is in control again.'
      );
      onChanged?.();
    } catch (e) {
      report(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function killAll() {
    // Briefly takes the whole application tier down. Worth a confirm so it
    // cannot happen on a stray click mid-presentation.
    if (!window.confirm('Delete every WordPress pod?\n\nThe store goes down for a few seconds while the Deployment recreates them. An open cart survives, because no pod holds it.')) {
      return;
    }
    setBusy('killall');
    try {
      const data = await post('/api/cluster/pods/delete-all');
      report(`Deleted ${data.deleted.length} pods — the Deployment is recreating them.`);
      onChanged?.();
    } catch (e) {
      report(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function seed() {
    setBusy('seed');
    report('Seeding products and uploading images to MinIO…');
    try {
      const data = await post('/api/store/seed');
      const summary = (data.output || '').split('\n').filter((l) => l.includes('seeded:')).pop();
      report(summary || 'Store seeded.');
      loadStore();
    } catch (e) {
      report(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  const current = desiredReplicas ?? '—';

  return (
    <div className="chart-card">
      <h3>Store &amp; cluster controls</h3>

      <div className="control-row">
        <div className="control-group">
          <span className="control-label">Storefront</span>
          <a className="btn btn-primary" href={store.url} target="_blank" rel="noreferrer">
            Visit store ↗
          </a>
          <a className="btn" href={`${store.url}/wp-admin/`} target="_blank" rel="noreferrer">
            wp-admin ↗
          </a>
          <span className="control-hint">
            {store.products === null ? 'product count unavailable' : `${store.products} products published`}
          </span>
        </div>

        <div className="control-group">
          <span className="control-label">Demo data</span>
          <button className="btn" onClick={seed} disabled={busy === 'seed'}>
            {busy === 'seed' ? 'Seeding…' : 'Seed demo products'}
          </button>
          <span className="control-hint">images upload to MinIO</span>
        </div>

        <div className="control-group">
          <span className="control-label">Pin pods (now {current})</span>
          {[2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`btn ${minReplicas === n ? 'btn-active' : ''}`}
              onClick={() => scale(n)}
              disabled={busy === 'scale'}
              title={
                n === 2
                  ? 'Return the floor to 2 and let the HPA decide'
                  : `Hold at least ${n} pods by raising the HPA's minReplicas`
              }
            >
              {n}
            </button>
          ))}
          <span
            className="control-hint"
            title={
              "These set the HPA's minReplicas (a floor it never goes below), not " +
              'spec.replicas.\n\n' +
              '`kubectl scale` does not stick here: the HPA recomputes a target every ' +
              '~15s and overwrites it. Raising the stabilization window does not help ' +
              'either — that window keeps the highest HPA-generated recommendation, and ' +
              'with no load every recommendation in its history is minReplicas.'
            }
          >
            {minReplicas > 2 ? `pinned — floor is ${minReplicas}` : 'HPA in control (floor 2)'}
          </span>
        </div>

        <div className="control-group">
          <span className="control-label">Chaos</span>
          <button
            className="btn btn-danger"
            onClick={killAll}
            disabled={busy === 'killall'}
            title="Delete every WordPress pod at once. An open cart survives, because it lives in Redis rather than on any pod."
          >
            {busy === 'killall' ? 'Killing…' : 'Kill all pods'}
          </button>
          <span className="control-hint">carts survive — they are not on the pods</span>
        </div>
      </div>

      {message && (
        <div className={`control-message ${message.tone}`}>{message.text}</div>
      )}
    </div>
  );
}
