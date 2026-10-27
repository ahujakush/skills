# Reliability templates

Plain TypeScript, no dependencies (Node 18+). Adapt to the project's style and existing helpers; search the repo first in case one already exists.

## Timeout on every outside call

```ts
const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
```

Pick the timeout from the slowest normal response, plus margin. LLM calls need longer (30-120 s) and should stream when a user is waiting. For Postgres, set `statement_timeout` on the role or connection.

## Retry with backoff and jitter

A timeout (`TimeoutError`) is retried; a cancellation by the caller (`AbortError`, or the caller's `signal` firing) is not, and it also cuts the wait between attempts short.

```ts
// file: retry.ts
import { setTimeout as sleep } from "node:timers/promises";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"]);

export async function withRetry<T>(
  fn: (attempt: number, signal?: AbortSignal) => Promise<T>,
  opts: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    signal?: AbortSignal; // the caller's cancel signal: stops retrying at once
    isRetryable?: (e: unknown) => boolean;
  } = {},
): Promise<T> {
  const { attempts = 3, baseMs = 300, maxMs = 5_000, signal } = opts;
  const isRetryable = opts.isRetryable ?? ((e: any) =>
    e?.name === "TimeoutError" || // our own per-attempt timeout; AbortError means someone cancelled
    RETRYABLE_CODES.has(e?.code) || RETRYABLE_CODES.has(e?.cause?.code) || // fetch puts it on .cause
    RETRYABLE_STATUS.has(e?.status));
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt, signal);
    } catch (e: any) {
      if (signal?.aborted || attempt >= attempts || !isRetryable(e)) throw e;
      const retryAfter = Number(e?.retryAfterSeconds) * 1000;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const wait = retryAfter > 0 ? Math.min(retryAfter, maxMs * 4) : backoff / 2 + Math.random() * (backoff / 2);
      await sleep(wait, undefined, { signal }); // rejects with AbortError if the caller cancels mid-wait
    }
  }
}
```

Usage with a timeout per attempt and the caller's cancel signal (Node 20.3+ for `AbortSignal.any`):

```ts
const data = await withRetry(
  (_attempt, signal) =>
    fetch(url, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]) })
      .then((r) => { if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }); return r.json(); }),
  { signal: req.signal },
);
```

Never retry a non-idempotent call (send email, charge, create event) unless it carries an idempotency key the other side honors.

## Idempotency key

For anything with a side effect (send, charge, create, notify), store the key with a UNIQUE constraint and claim it before acting. Every key ends in one of three states, and each one has a clear next step:

| State | Meaning | Another attempt with the same key |
|---|---|---|
| `done` | The side effect happened | Gets the stored result; the work does not run again |
| `failed` | The side effect threw | Claims the key and runs the work again |
| `started` | Running now, or the worker died | Gets `InProgressError` (answer 409 or retry the job later), unless the lease ran out, in which case it takes over |

```sql
create table if not exists idempotency_keys (
  key text primary key,
  status text not null check (status in ('started', 'done', 'failed')),
  result jsonb,
  last_error text,
  attempts int not null default 1,
  locked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
```

```ts
// file: idempotency.ts
// `query` matches node-postgres: (text, params) => Promise<{ rows }>.
type Query = (text: string, params: unknown[]) => Promise<{ rows: any[] }>;

export class InProgressError extends Error {}

export async function runOnce<T>(
  query: Query,
  key: string,
  sideEffect: () => Promise<T>,
  leaseSeconds = 300, // longer than the side effect can ever take
): Promise<T> {
  // Claim a new key, a key whose last attempt failed, or one stuck in 'started' past its lease.
  const claim = await query(
    `insert into idempotency_keys (key, status) values ($1, 'started')
     on conflict (key) do update
       set status = 'started', locked_at = now(), last_error = null,
           attempts = idempotency_keys.attempts + 1
       where idempotency_keys.status = 'failed'
          or (idempotency_keys.status = 'started'
              and idempotency_keys.locked_at < now() - make_interval(secs => $2::int))
     returning key`,
    [key, leaseSeconds],
  );

  if (claim.rows.length === 0) {
    const { rows } = await query(`select status, result from idempotency_keys where key = $1`, [key]);
    if (rows[0]?.status === "done") return rows[0].result as T;
    throw new InProgressError(`"${key}" is already running`);
  }

  let result: T;
  try {
    result = await sideEffect();
  } catch (e) {
    // Release the key so a later attempt runs the work again instead of finding nothing.
    await query(
      `update idempotency_keys set status = 'failed', last_error = $2 where key = $1`,
      [key, String(e).slice(0, 1000)],
    );
    throw e;
  }
  await query(
    `update idempotency_keys set status = 'done', result = $2::jsonb where key = $1`,
    [key, JSON.stringify(result ?? null)],
  );
  return result;
}
```

- Build the key from what makes the action unique: `email:{userId}:{messageHash}`, `webhook:{provider}:{eventId}`. Clean up old `done` keys on a schedule.
- The result must be JSON-serializable: a repeat call gets it back from the database, not from memory.
- This table alone can't make a side effect exactly-once. If the work succeeds but the process dies before `done` is saved, or the side effect throws after the other side already acted (a timeout after the email was accepted), the next attempt runs it again. Close that gap by also passing the key to the provider when it supports one (Stripe `Idempotency-Key`, a message id, a unique external id).

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
// file: ratelimit.ts
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
