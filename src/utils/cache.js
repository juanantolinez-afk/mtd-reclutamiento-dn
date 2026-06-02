const TTL_MS = 60 * 60 * 1000; // 1 hora

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs = TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function del(key) {
  store.delete(key);
}

module.exports = { get, set, del };
