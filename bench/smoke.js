import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    read_feed: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const target = __ENV.TARGET_URL || 'http://web:8080';

export default function () {
  const response = http.get(`${target}/api/posts?limit=20`);
  check(response, { 'status is 200': (result) => result.status === 200 });
  sleep(0.1);
}
