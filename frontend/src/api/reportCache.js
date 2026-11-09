import { api } from './client';
import { cacheGet, cacheSet, reportCacheKey } from '../utils/cache';

const inflight = new Map();

// Warm the report cache ahead of time (e.g. while hovering the "View Report"
// link) so opening a report renders instantly.
export function prefetchReport(submissionId) {
  const key = reportCacheKey(submissionId);
  if (cacheGet(key) || inflight.has(key)) return;
  const promise = api
    .get(`/get-report/${submissionId}`)
    .then((response) => {
      cacheSet(key, response.data);
    })
    .catch(() => {
      // Prefetching is best-effort; the real navigation will surface errors.
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
}
