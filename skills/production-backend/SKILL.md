---
name: production-backend
description: "Production engineering rules for backend code: caching (in-memory, Redis, cache-aside, TTL, invalidation, stampede), timeouts, retries with backoff, idempotency, background jobs and queues, rate limits, graceful shutdown, database indexes and N+1 queries, LLM call cost and caching, input validation and secrets, logging and health checks, and proving work is done. Load it BEFORE writing or changing server code, API endpoints, workers, cron jobs, webhooks, or anything that calls a database, an LLM or another outside API. Also load it when someone asks to 'make it production ready', 'add caching', 'add Redis', 'make it faster', 'make it scale', or when something is slow, flaky, runs twice or falls over under load. Self-contained; works with any stack."
license: MIT
metadata:
  author: Kush Ahuja (https://www.thekush.codes)
  version: "1.1.1"
  date: 2026-10-28
  sources: "Own rules. Ideas adapted (rewritten, not copied) from obra/superpowers (test first, verify before claiming done) and donnemartin/system-design-primer (cache strategies)."
---

# Production backend

Production code is code that keeps working when things go wrong: the database is slow, an API times out, the server restarts mid-job, a webhook arrives twice, a hot key expires under load. This skill is the checklist for that.

It is NOT "add Redis, queues and microservices to everything". Every piece of infrastructure is one more thing that can break, costs money and needs watching. Add it when the numbers say so.

**The project's own instructions win** over this file (`CLAUDE.md`, `AGENTS.md` or similar): rules about new dependencies, committing, which database to touch, how to deploy.

## 1. Before writing code: five questions

Answer these in a few lines (in the plan or in chat) before building anything that touches a server:

1. **Load**: how many requests or jobs per minute, how much data, how many users? Today and in 6 months. Guess with a number, not "a lot".
2. **Failure**: what happens if each outside call (DB, LLM, third-party API, worker) is slow, down, or returns garbage?
3. **Twice**: what happens if this runs twice? (retries, restarts, double clicks, webhook redelivery, two server copies)
4. **State**: where does the real data live? Anything only in RAM or a local file dies on restart or redeploy.
5. **Seeing it**: when this breaks at 2 am, which log line or health check tells us?

For a big or new piece of work, write a short plan first (components, data flow, the answers above, what you will NOT build) and get the user's OK before coding.

## 2. Reuse first

Before writing a helper (cache, retry, rate limiter, queue), search the repo for one that already exists. Then the standard library, then a platform feature (a database constraint beats app code, CSS beats JS), then an installed package. A new dependency needs the user's OK. Most of what is below fits in 20-60 lines of plain code.

## 3. Caching: climb the ladder, stop at the first rung that works

| Rung | Use when | Notes |
|---|---|---|
| 0. Fix the query | Always first | Missing index, N+1 queries, `select *`, no limit. Measure with `EXPLAIN ANALYZE`. See [references/database.md](references/database.md). |
| 1. Don't call at all | The data is already in hand | Pass it down, batch the calls, compute once per request. |
| 2. In-process cache | One server copy, data can be a bit old | Map with TTL + size cap + single-flight. Template in [references/caching.md](references/caching.md). |
| 3. HTTP / CDN cache | Public or per-user GET responses, static files | `Cache-Control`, `ETag`, immutable hashed assets. |
| 4. Redis (or similar) | 2+ server copies must share it, rate limits across copies, queues, locks, sessions | Needs the user's OK (new service + dependency). Still cache-aside, still TTL. |

Rules for every cache, every rung:
- **The cache is a copy.** The database is the source of truth. Losing the whole cache must only make things slower, never lose data.
- **Every entry expires** (TTL). Pick it from "how old can this be before a user notices?".
- **Size cap** on in-memory caches, least-used out first. An unbounded map is a memory leak.
- **On write, delete the cached copy** (or update it) in the same code path that writes the data.
- **Stop the stampede**: when a hot key expires, one caller reloads it and the rest wait for that result (single-flight). Add a little random jitter to TTLs so keys don't all expire together.
- **Key includes everything that changes the answer**: user/tenant id, params, version. Never serve user A's data to user B.
- **Don't cache errors** (or cache them for seconds only).
- Cache **objects** (a user, a settings record) rather than raw query results; objects are easy to invalidate.

Patterns (cache-aside, write-through, write-behind, refresh-ahead), Redis rules and a tested TypeScript template: [references/caching.md](references/caching.md).

## 4. Reliability rules (non-negotiable)

- **Every outside call has a timeout.** No `fetch` without `AbortSignal.timeout(ms)` (or the language's equivalent). No DB query without a statement timeout.
- **Retry only what is safe to retry**: network errors, 429, 502/503/504, timeouts. Never 400/401/403/404/422. Exponential backoff with jitter, capped attempts, respect `Retry-After`.
- **Idempotency**: anything that sends, charges, creates or notifies must be safe to run twice. Use an idempotency key stored with a UNIQUE constraint and claim it before the side effect.
- **Background jobs** record their state in the database (queued, running, done, failed + attempts), so a restart can resume or retry them. A job held only in memory is lost on redeploy.
- **Graceful shutdown**: on SIGTERM stop taking new work, finish or checkpoint in-flight work and pending background writes, then exit.
- **Fail loud, degrade soft**: log the real error with context, show the user a clear message, keep the rest of the app working.

Code templates (retry, idempotency, job table, shutdown, rate limit, logging): [references/reliability.md](references/reliability.md).

## 5. Database

Indexes for every filter and sort you run often, no N+1 queries, pagination on every list, short transactions, connection pooling, row-level access control for multi-tenant data, safe migrations. Details and SQL: [references/database.md](references/database.md).

## 6. LLM and other paid API calls

Timeouts and streaming, cache identical requests, route easy tasks to cheaper models, use provider prompt caching, cap tokens and spend per user, log cost per call. Details: [references/llm-calls.md](references/llm-calls.md).

## 7. Security

Validate every input at the edge, rate-limit login and anything that costs money, keep secrets in env vars and out of logs, check authorization on every request (not just authentication), parameterize every query. Details: [references/security.md](references/security.md). For auth, payments or personal data, do a dedicated security review before shipping.

## 8. Seeing it in production

- **Structured logs** at the boundaries: request in/out, outside call, job start/end/fail. Include ids (request, user, job), duration and outcome. No secrets, no full personal data.
- **A health endpoint** that checks real dependencies (DB reachable) and returns fast.
- **Measure before optimizing.** Every "made it faster" claim comes with a before and after number (timing logs, `EXPLAIN ANALYZE`, a load test).

## 9. Test first, then prove it is done

Two rules, adapted from obra/superpowers:

**Test first.** For a new behavior or a bug fix, write the test that shows the problem, run it and watch it fail for the right reason, then write the code that makes it pass. A test you never saw fail may not test anything. Every failure path from section 4 gets a test too: the timeout, the retry, the duplicate run, the cache miss and expiry. Use the project's existing test style and runner.

**No "done" without fresh proof.** Before saying fixed, working, passing or done, run the command that proves it in this turn and read its output. "Should work", "looks right" and "the tests passed earlier" are not proof. If a check couldn't be run, say so plainly.

Final checklist before calling it done: [references/done-checklist.md](references/done-checklist.md).

## Works well with (optional)

Everything above stands on its own. If these skills happen to be installed, use them for depth instead of repeating their work:

| Need | Skill, if installed |
|---|---|
| Postgres schema, indexes, RLS, slow queries | `supabase-postgres-best-practices` |
| Full system design or a tech choice with trade-offs | `system-design`, `architecture` (Anthropic engineering plugin) |
| Plan review, code review, security audit, benchmarks | gstack: `/plan-eng-review`, `/review`, `/cso`, `/benchmark` |
| LLM cost and model routing | `cost-aware-llm-pipeline` |
