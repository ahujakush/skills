# Database essentials

Written for Postgres (including Supabase, Neon, RDS); most of it holds for MySQL too. Measure first: `EXPLAIN (ANALYZE, BUFFERS) <query>` shows what the database actually does.

## Queries

- **Index what you filter and sort on.** A `where user_id = $1 order by created_at desc` wants `create index on items (user_id, created_at desc)`. Equality columns first, then the range or sort column.
- **Partial indexes** for hot subsets: `create index on jobs (run_after) where status = 'queued'`.
- **Foreign keys get an index** on the referencing column (Postgres doesn't add one for you).
- **No N+1**: never run one query per row in a loop. Fetch in one query with `where id = any($1)` or a join, then match in code.
- **Select only the columns you need.** `select *` drags large columns (JSON, text, blobs) across the wire.
- **Paginate every list.** Keyset pagination (`where created_at < $cursor order by created_at desc limit 50`) stays fast on big tables; `offset` gets slower the deeper you go.
- **Batch writes**: one multi-row `insert` or `upsert` instead of many single ones.
- **Counting**: `count(*)` on a big table is slow. Keep a counter, use an estimate, or show "50+".

## Connections and timeouts

- Use a **connection pooler** (PgBouncer, Supavisor, the provider's pooled URL) for serverless or many app copies. Keep pool size small; more connections is not more speed.
- Set `statement_timeout` (for example 5-15 s for web requests) and `idle_in_transaction_session_timeout` on the app's role.
- **Short transactions.** Never call an outside API while holding a transaction open.

## Correctness lives in the database

- **Constraints over app checks**: `not null`, `unique`, `check`, foreign keys. They hold even when two requests race.
- **Upserts** (`insert ... on conflict do update`) instead of read-then-write.
- **Row locks** when two workers could take the same row: `select ... for update skip locked`.
- Timestamps as `timestamptz`, money as integer cents or `numeric`, never floats.

## Multi-tenant data

- Every per-user or per-tenant table has the owner id column, indexed.
- **Row-level security** (or an equivalent enforced layer) on every table the client can reach. Test it: user A must get zero rows of user B.
- Server-only keys (service role, admin) never reach the browser or mobile app.

## Migrations

- One migration per change, checked into git, applied the same way in every environment.
- **Safe on a live table**: add nullable columns or columns with a constant default; create indexes `concurrently`; backfill in batches; add `not null` only after the backfill.
- Never rename or drop a column the running code still reads. Expand (add the new one), migrate the code, then contract (drop the old one) in a later release.
- Have a way back: a down migration, or a forward fix you've thought through.
