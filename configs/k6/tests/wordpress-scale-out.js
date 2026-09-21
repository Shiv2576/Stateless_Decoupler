import http from 'k6/http';
import { check, sleep } from 'k6';

// Designed to force the HPA from 2 -> 5 replicas mid-run and show p95 latency
// recovering as the extra pods come online, instead of just holding a flat VU
// count. Each pod's PHP-FPM pool caps out at pm.max_children=5, so at the
// HPA's floor of 2 replicas there are only 10 concurrent PHP "slots" cluster-
// wide — 40 VUs is deliberately well past that, to saturate CPU/memory past
// the HPA's 70%/80% thresholds fast and keep it there long enough (4m) for
// scale-up to land and for the extra capacity to actually drain the queue.
//
// HPA scale-up has no custom `behavior` block in wordpress.yaml, so Kubernetes
// defaults apply: 0s stabilization window, re-evaluated every ~15s — it reacts
// quickly. Scale-down defaults to a 5m stabilization window, so this test
// doesn't try to also show scale-down; ramp down is just to end the run cleanly.
export const options = {
    stages: [
        { duration: '30s', target: 40 }, // Spike: overload the 2-pod floor
        { duration: '4m', target: 40 },  // Hold: HPA scales 2 -> 5, latency should fall as it does
        { duration: '1m', target: 0 },   // Ramp down
    ],
    thresholds: {
        // Loose on purpose — the point of this test is to *observe* the
        // latency spike-then-recover shape, not to pass/fail on it.
        http_req_duration: ['p(95)<30000'],
        http_req_failed: ['rate<0.5'],
    },
};

const SITE_URL = 'http://localhost:8080';

export default function () {
    const home = http.get(`${SITE_URL}/`);
    check(home, { 'Homepage loaded': (r) => r.status === 200 });

    const login = http.get(`${SITE_URL}/wp-login.php`);
    check(login, { 'Login page loaded': (r) => r.status === 200 });

    const product = http.get(`${SITE_URL}/product/`);
    check(product, { 'Product page loaded': (r) => r.status === 200 || r.status === 404 });

    sleep(Math.random() * 2 + 1);
}
