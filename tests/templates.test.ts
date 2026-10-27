// Runs the exact code shown in the skill's reference docs.
// node --experimental-strip-types --test tests/   (Node 22.6+)
// The idempotency tests need a real Postgres; they use PGlite when it is installed
// (npm i --no-save @electric-sql/pglite) and are skipped otherwise.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extractTemplates } from "./extract.ts";

const dir = extractTemplates();
const load = (name: string) => import(pathToFileURL(join(dir, name)).href);
const { createCache } = await load("cache.ts");
const { withRetry } = await load("retry.ts");
const { allow } = await load("ratelimit.ts");
const { runOnce, InProgressError } = await load("idempotency.ts");

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("cache", () => {
  test("hit, expiry and least-recently-used eviction", async () => {
    const c = createCache({ ttlMs: 30, max: 2, jitter: 0 });
    c.set("a", 1); c.set("b", 2);
    assert.equal(c.get("a"), 1); // a is now most recent
    c.set("c", 3);
    assert.equal(c.get("b"), undefined);
    assert.equal(c.get("a"), 1);
    await tick(40);
    assert.equal(c.get("a"), undefined);
  });

  test("parallel loads of one key run the loader once", async () => {
    const c = createCache({ ttlMs: 1000, max: 10 });
    let loads = 0;
    const loader = async () => { loads++; await tick(10); return "v"; };
    assert.deepEqual(await Promise.all([c.getOrLoad("k", loader), c.getOrLoad("k", loader)]), ["v", "v"]);
    assert.equal(loads, 1);
  });

  test("a failed load is not cached", async () => {
    const c = createCache({ ttlMs: 1000, max: 10 });
    await assert.rejects(c.getOrLoad("k", async () => { throw new Error("db down"); }));
    assert.equal(await c.getOrLoad("k", async () => "ok"), "ok");
  });

  test("a delete during a load is not undone by that load's old value", async () => {
    const c = createCache({ ttlMs: 60_000, max: 10 });
    const oldRead = deferred<string>();
    const first = c.getOrLoad("k", () => oldRead.promise);
    c.delete("k"); // the write committed while the old read was in flight
    oldRead.resolve("old");
    assert.equal(await first, "old"); // the caller that asked before the write gets what it read
    assert.equal(c.get("k"), undefined); // but the cache doesn't keep it
    assert.equal(await c.getOrLoad("k", async () => "new"), "new");
  });

  test("after a delete, the next load runs fresh instead of joining the old one", async () => {
    const c = createCache({ ttlMs: 60_000, max: 10 });
    const oldRead = deferred<string>();
    c.getOrLoad("k", () => oldRead.promise);
    c.delete("k");
    const fresh = c.getOrLoad("k", async () => "new");
    oldRead.resolve("old");
    assert.equal(await fresh, "new");
    await tick(0);
    assert.equal(c.get("k"), "new");
  });

  test("a set during a load wins over that load", async () => {
    const c = createCache({ ttlMs: 60_000, max: 10 });
    const oldRead = deferred<string>();
    const first = c.getOrLoad("k", () => oldRead.promise);
    c.set("k", "written");
    oldRead.resolve("old");
    await first;
    assert.equal(c.get("k"), "written");
  });

  test("clear also drops loads in flight", async () => {
    const c = createCache({ ttlMs: 60_000, max: 10 });
    const oldRead = deferred<string>();
    const first = c.getOrLoad("k", () => oldRead.promise);
    c.clear();
    oldRead.resolve("old");
    await first;
    assert.equal(c.get("k"), undefined);
  });
});

describe("retry", () => {
  test("retries a 503 and returns the later success", async () => {
    let n = 0;
    const out = await withRetry(async () => { if (++n < 3) throw httpError(503); return "ok"; }, { baseMs: 1 });
    assert.equal(out, "ok");
    assert.equal(n, 3);
  });

  test("does not retry a 400", async () => {
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; throw httpError(400); }, { baseMs: 1 }));
    assert.equal(n, 1);
  });

  test("stops after the attempt cap", async () => {
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; throw httpError(503); }, { baseMs: 1, attempts: 4 }));
    assert.equal(n, 4);
  });

  test("retries a timeout and a fetch network error (code on .cause)", async () => {
    let n = 0;
    await withRetry(async () => {
      n++;
      if (n === 1) throw new DOMException("timed out", "TimeoutError");
      if (n === 2) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return "ok";
    }, { baseMs: 1 });
    assert.equal(n, 3);
  });

  test("does not retry an AbortError (someone cancelled)", async () => {
    let n = 0;
    await assert.rejects(
      withRetry(async () => { n++; throw new DOMException("aborted", "AbortError"); }, { baseMs: 1 }),
      { name: "AbortError" },
    );
    assert.equal(n, 1);
  });

  test("the caller's signal stops it mid-operation, and the operation runs once", async () => {
    const ac = new AbortController();
    let n = 0;
    const p = withRetry((_attempt: number, signal?: AbortSignal) => {
      n++;
      return new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason)));
    }, { baseMs: 1, signal: ac.signal });
    ac.abort();
    await assert.rejects(p, { name: "AbortError" });
    assert.equal(n, 1);
  });

  test("the caller's signal cuts the wait between attempts short", async () => {
    const ac = new AbortController();
    let n = 0;
    const started = Date.now();
    const p = withRetry(async () => { n++; throw httpError(503); }, { baseMs: 10_000, maxMs: 10_000, signal: ac.signal });
    await tick(20);
    ac.abort();
    await assert.rejects(p, { name: "AbortError" });
    assert.ok(Date.now() - started < 1000, "did not wait out the backoff");
    assert.equal(n, 1);
  });

  test("an already-cancelled signal never calls the operation", async () => {
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; return 1; }, { signal: AbortSignal.abort() }));
    assert.equal(n, 0);
  });
});

test("rate limit allows up to the limit per window", () => {
  assert.ok(allow("u1", 2, 1000));
  assert.ok(allow("u1", 2, 1000));
  assert.ok(!allow("u1", 2, 1000));
  assert.ok(allow("u2", 2, 1000));
});

const pglite = await import("@electric-sql/pglite").catch(() => null);

describe("idempotency (Postgres)", { skip: pglite ? false : "PGlite not installed" }, () => {
  const setup = async () => {
    const db = new pglite!.PGlite();
    const md = (await import("node:fs")).readFileSync(
      join(import.meta.dirname, "..", "skills", "production-backend", "references", "reliability.md"), "utf8");
    await db.exec(md.match(/```sql\n(create table if not exists idempotency_keys[\s\S]*?)```/)![1]);
    const query = (text: string, params: unknown[]) => db.query(text, params);
    const row = async (key: string) => (await db.query<any>(`select * from idempotency_keys where key = $1`, [key])).rows[0];
    return { db, query, row };
  };

  test("runs once, then returns the saved result", async () => {
    const { query, row } = await setup();
    let runs = 0;
    const work = async () => { runs++; return { id: 7 }; };
    assert.deepEqual(await runOnce(query, "k", work), { id: 7 });
    assert.deepEqual(await runOnce(query, "k", work), { id: 7 });
    assert.equal(runs, 1);
    assert.equal((await row("k")).status, "done");
  });

  test("a failed side effect is marked failed and the next attempt runs it again", async () => {
    const { query, row } = await setup();
    await assert.rejects(runOnce(query, "k", async () => { throw new Error("smtp down"); }), /smtp down/);
    const failed = await row("k");
    assert.equal(failed.status, "failed");
    assert.match(failed.last_error, /smtp down/);
    let runs = 0;
    assert.equal(await runOnce(query, "k", async () => { runs++; return "sent"; }), "sent");
    assert.equal(runs, 1);
    const done = await row("k");
    assert.equal(done.status, "done");
    assert.equal(done.attempts, 2);
    assert.equal(done.last_error, null);
  });

  test("a second call while the first is running gets InProgressError and does no work", async () => {
    const { query } = await setup();
    const gate = deferred<string>();
    const first = runOnce(query, "k", () => gate.promise);
    await tick(20);
    let runs = 0;
    await assert.rejects(runOnce(query, "k", async () => { runs++; return "x"; }), InProgressError);
    assert.equal(runs, 0);
    gate.resolve("ok");
    assert.equal(await first, "ok");
  });

  test("a key stuck in started past its lease is taken over", async () => {
    const { db, query } = await setup();
    await db.query(`insert into idempotency_keys (key, status, locked_at) values ('k', 'started', now() - interval '10 minutes')`);
    assert.equal(await runOnce(query, "k", async () => "recovered", 300), "recovered");
  });

  test("a key started within its lease is left alone", async () => {
    const { db, query } = await setup();
    await db.query(`insert into idempotency_keys (key, status) values ('k', 'started')`);
    await assert.rejects(runOnce(query, "k", async () => "x", 300), InProgressError);
  });
});
