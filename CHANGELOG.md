# Changelog

## production-backend 1.1.1 (2026-10-28)

Fixes three bugs in the reference templates, found in an outside review:

- **Cache**: a load that started before a write could store the old value after the write deleted the key, leaving stale data until the TTL ran out. `delete`, `set` and `clear` now cancel the store of any load in flight, and the next read loads fresh.
- **Retry**: a caller's cancellation (`AbortError`) was retried like a timeout, so a cancelled operation ran up to 3 times. It's no longer retried; there's an optional `signal` that stops retries and cuts the backoff wait short. Network errors from `fetch` (code on `error.cause`) are now retried; before they weren't.
- **Idempotency**: if the side effect threw, the key stayed `started` forever and every later attempt got no result and did no work. The template is now a full `runOnce()`: a failure marks the key `failed` so the next attempt runs again, a concurrent attempt gets `InProgressError`, and a key stuck past its lease is taken over.

Also added `tests/`: they run the exact code from the docs (21 tests; the Postgres ones use PGlite). Against 1.1.0's templates, 13 of them fail.

## production-backend 1.1.0 (2026-10-27)

First public version.
