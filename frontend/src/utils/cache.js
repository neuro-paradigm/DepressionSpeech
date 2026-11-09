// Tiny in-memory cache so returning to a page paints instantly from the last
// known data while a fresh request revalidates in the background.
const store = new Map();

export const CACHE_KEYS = {
  submissions: 'admin:submissions',
};

export function reportCacheKey(submissionId) {
  return `report:${submissionId}`;
}

export function cacheGet(key) {
  return store.get(key)?.data ?? null;
}

export function cacheSet(key, data) {
  store.set(key, { data, timestamp: Date.now() });
}

export function cacheDelete(key) {
  store.delete(key);
}
