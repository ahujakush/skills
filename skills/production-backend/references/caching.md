# Caching in depth

Strategy ideas adapted from donnemartin/system-design-primer, rewritten for small Node/TypeScript services.

## Which strategy

| Strategy | How it works | Good for | Watch out |
|---|---|---|---|
| **Cache-aside** (lazy loading) | Read cache → miss → read DB → store in cache → return. Writes go to the DB and delete the cached key. | Default choice. Only data someone asked for gets cached. | First read after a miss is slow. Data can be stale until TTL or invalidation. |
| **Write-through** | Every write updates the DB and the cache together. | Data read right after it's written (profile, settings). | Writes get slower. Caches data nobody reads, so still use a TTL. |
| **Write-behind** | Write to the cache, flush to the DB later in the background. | Very high write rates (counters, analytics). | Data loss if the process dies before the flush. Only with a durable queue, and only with the user's OK. |
| **Refresh-ahead** | Reload hot keys shortly before they expire. | A few very hot keys where a miss is expensive. | Wasted reloads if you guess wrong about what's hot. |

Start with cache-aside plus delete-on-write. Use the others only when a measured problem asks for them.

## What to cache, at what level

- **Objects** (a user record, an account's settings, a parsed config) are easy to invalidate: when the row changes, delete that one key.
- **Query results** are hard to invalidate: one changed row can sit inside many cached queries. Cache them only with a short TTL.
- **Whole responses** (HTTP cache, CDN) for public or slowly changing pages and static files.
- **Don't cache in local files** on servers that can be redeployed or scaled: the next copy starts empty and copies disagree.

## TTL guide

| Data | TTL |
|---|---|
| Static files with a hash in the name | 1 year, `immutable` |
| Public pages, lists that change rarely | minutes |
| Per-user settings or profile (deleted on write) | 5-60 min |
| Third-party API answers (places, weather, exchange rates) | whatever the provider allows, often minutes to hours |
| Anything about money, permissions or auth | don't cache, or seconds with delete-on-write |

Add ±10% random jitter so keys made together don't expire together.

## In-process cache template (TypeScript, no dependencies)

TTL, size cap (oldest out first), single-flight loading, no caching of errors, and no stale write-back: if a key is deleted or set while a load is running, that load's result is returned to its callers but not stored. `Map` keeps insertion order, so re-inserting on read makes this an LRU.

```ts
// file: cache.ts
type Entry<V> = { value: V; expiresAt: number };

export function createCache<V>(opts: { ttlMs: number; max: number; jitter?: number }) {
  const entries = new Map<string, Entry<V>>();
  const loading = new Map<string, Promise<V>>();
  const jitter = opts.jitter ?? 0.1;

  function store(key: string, value: V) {
    const ttl = opts.ttlMs * (1 + (Math.random() * 2 - 1) * jitter);
    entries.delete(key);
    entries.set(key, { value, expiresAt: Date.now() + ttl });
    while (entries.size > opts.max) entries.delete(entries.keys().next().value!);
  }

  // A write wins over any load already running for the key: that load read the old data.
  function set(key: string, value: V) {
    loading.delete(key);
    store(key, value);
  }

  function invalidate(key: string) {
    loading.delete(key);
    entries.delete(key);
  }

  function get(key: string): V | undefined {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) { entries.delete(key); return undefined; }
    entries.delete(key); entries.set(key, hit); // mark as recently used
    return hit.value;
  }

  // Cache-aside with single-flight: one load per key at a time, others await it.
  async function getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = get(key);
    if (hit !== undefined) return hit;
    const inFlight = loading.get(key);
    if (inFlight) return inFlight;
    const p: Promise<V> = load()
      .then((v) => {
        // Store only if no write or delete happened while loading; otherwise v may be stale.
        if (loading.get(key) === p) store(key, v);
        return v;
      })
      .finally(() => {
        if (loading.get(key) === p) loading.delete(key);
      });
    loading.set(key, p);
    return p;
  }

  return {
    get,
    set,
    getOrLoad,
    delete: invalidate,
    clear: () => { loading.clear(); entries.clear(); },
  };
}
```

Usage: `const settings = createCache<Settings>({ ttlMs: 10 * 60_000, max: 5_000 });` then `settings.getOrLoad(\`settings:${userId}\`, () => db.loadSettings(userId))`, and `settings.delete(\`settings:${userId}\`)` right **after** every write to that user's settings commits.

Callers that were already waiting on a load when the write happened still get the value that load read. That's fine: they asked before the write. Only the cache must not keep it.

Tests to write for it: hit, miss, expiry, size cap evicts the oldest, two parallel `getOrLoad` calls run the loader once, a failed load is not cached, and a delete or set during a load is not overwritten by that load's old result.

## When Redis is actually needed

Move from the in-process cache to Redis (or Valkey, Upstash and similar) only when one of these is true:
- **2+ server copies** must see the same cached data, or a delete on one must reach the others.
- **Rate limits or locks** must hold across copies.
- **A queue** of jobs must survive restarts and be shared by workers (a Postgres table with `FOR UPDATE SKIP LOCKED`, or pgmq, often does this without Redis).
- **The cache is too big** for process memory, or a cold start after every deploy is too slow.

Ask the user first: it's a new service, a new dependency and a new bill.

## Redis rules (once you have it)

- Still cache-aside, still a TTL on every key (`SET key value EX seconds`). Set `maxmemory` and an eviction policy (`allkeys-lru` for a pure cache).
- The stale write-back race exists across copies too: copy A reads old data from the DB, copy B writes and deletes the key, then A stores what it read. Keep TTLs short for data that changes, delete after the write commits, and for data that must never be stale put a version in the key (bumped on write) or skip the cache.
- Namespaced, versioned keys: `app:v1:user:{id}:settings`. Bump the version to drop a whole shape after a schema change.
- **Redis down = slower, not broken**: wrap calls with a short timeout and fall back to the database.
- Stampede: single-flight per process, plus `SET lock:key 1 NX EX 10` if loads are expensive across copies.
- Rate limiting: a fixed window with `INCR` + `EXPIRE`, or a sliding window with a sorted set.
- Never store secrets or tokens without encryption. Never use `KEYS *` in production (use `SCAN`).
- Pick a region close to the app server; a cross-region cache can be slower than the database.
