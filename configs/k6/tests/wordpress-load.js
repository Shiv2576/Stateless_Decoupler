import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    stages: [
        { duration: '30s', target: 15 }, // Ramp up to 15 users
        { duration: '2m', target: 15 },  // Stay at 15 users
        { duration: '30s', target: 0 },  // Ramp down to 0
    ],
    thresholds: {
        http_req_duration: ['p(95)<500'],
        http_req_failed: ['rate<0.01'],
    },
};

const SITE_URL = 'http://localhost:8080';

export default function () {
    // Homepage
    const home = http.get(`${SITE_URL}/`);
    check(home, { 'Homepage loaded': (r) => r.status === 200 });
    
    // Login page
    const login = http.get(`${SITE_URL}/wp-login.php`);
    check(login, { 'Login page loaded': (r) => r.status === 200 });
    
    // Product page (if WooCommerce)
    const product = http.get(`${SITE_URL}/product/`);
    check(product, { 'Product page loaded': (r) => r.status === 200 || r.status === 404 });
    
    sleep(Math.random() * 2 + 1);
}
