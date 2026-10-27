# Reliability templates

Plain TypeScript, no dependencies (Node 18+). Adapt to the project's style and existing helpers; search the repo first in case one already exists.

## Timeout on every outside call

```ts
const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
```

Pick the timeout from the slowest normal response, plus margin. LLM calls need longer (30-120 s) and should stream when a user is waiting. For Postgres, set `statement_timeout` on the role or connection.

## Retry with backoff and jitter

```ts
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; maxMs?: number; isRetryable?: (e: unknown) => boolean } = {},
): Promise<T> {
  const { attempts = 3, baseMs = 300, maxMs = 5_000 } = opts;
  const isRetryable = opts.isRetryable ?? ((e: any) =>
    e?.name === "TimeoutError" || e?.name === "AbortError" ||
    e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT" ||
    RETRYABLE.has(e?.status));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e: any) {
      if (attempt >= attempts || !isRetryable(e)) throw e;
      const retryAfter = Number(e?.retryAfterSeconds) * 1000;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const wait = retryAfter > 0 ? retryAfter : backoff / 2 + Math.random() * (backoff / 2);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
```

Never retry a non-idempotent call (send email, charge, create event) unless it carries an idempotency key the other side honors.

## Idempotency key

For anything with a side effect (send, charge, create, notify), store the key with a UNIQUE constraint and claim it before acting:

```sql
create table if not exists idempotency_keys (
  key text primary key,
  status text not null default 'started',  -- started | done | failed
  result jsonb,
  created_at timestamptz not null default now()
);
```

```ts
// Claim: the insert succeeds for exactly one caller.
const claimed = await db.insertIgnoreConflict("idempotency_keys", { key });
if (!claimed) return await db.getResult(key); // already done or running: don't repeat the side effect
const result = await doSideEffect();
await db.update("idempotency_keys", key, { status: "done", result });
```

Build the key from what makes the action unique: `email:{userId}:{messageHash}`, `webhook:{provider}:{eventId}`. Clean up old keys on a schedule.

## Background jobs that survive restarts

- Store jobs in a table: `status` (queued / running / done / failed), `attempts`, `run_after`, `last_error`, `locked_at`.
- Take work with `update ... set status='running', locked_at=now() where id = (select id from jobs where status='queued' and run_after <= now() order by run_after limit 1 for update skip locked) returning *`.
- On failure: `attempts + 1`, set `run_after` with backoff, mark `failed` after N attempts, and log it.
- On startup: put `running` jobs whose `locked_at` is too old back to `queued`.
- Postgres extensions such as `pgmq` (queues) and `pg_cron` (schedules) can replace a separate queue service.

## Graceful shutdown

```ts
let shuttingDown = false;
const inFlight = new Set<Promise<unknown>>();

export function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  p.finally(() => inFlight.delete(p)).catch(() => {});
  return p;
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;               // stop accepting new work (check this flag in handlers/pollers)
    server?.close();
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((r) => setTimeout(r, 20_000)), // don't hang forever
    ]);
    process.exit(0);
  });
}
```

Wrap fire-and-forget background writes in `track(...)` so a redeploy doesn't drop them.

## Rate limit (single copy, in memory)

```ts
const hits = new Map<string, { count: number; resetAt: number }>();

export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.resetAt <= now) { hits.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (h.count >= limit) return false;
  h.count++;
  return true;
}
// Sweep expired keys every minute so the map doesn't grow forever.
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, 60_000).unref();
```

Return 429 with `Retry-After`. Key by user id when signed in, by IP otherwise. With 2+ server copies this must move to Redis or Postgres.

## Input validation

Check type, required fields, length and size limits, and allowed values at the edge, before any work. Reject with 400 and a clear message. Cap request body size and upload size. Use the project's existing validator if it has one; otherwise a small hand-written check beats a new dependency.

## Logging

One line per event, as JSON or `key=value`: `event`, `requestId` / `jobId`, `userId` (an id, not an email), `durationMs`, `outcome`, `error`. Log the error message and stack on failure. Never log tokens, passwords, API keys, full message bodies or files.
