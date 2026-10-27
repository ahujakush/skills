# Done checklist

Go through this before saying a backend change is done. A box counts as ticked only if it was checked in this turn, with output to show for it. Anything skipped gets named in the reply, with the reason.

## Proof
- [ ] The test for the new behavior was seen failing before the fix and passing after.
- [ ] The full test command was run now, and the output read: N passed, 0 failed.
- [ ] Typecheck or build was run, if the project has one.
- [ ] For a speed change: before and after numbers.
- [ ] For a bug fix: the original symptom was reproduced, then shown gone.

## Failure paths
- [ ] Every outside call has a timeout.
- [ ] Retries only on retryable errors, with backoff, capped.
- [ ] Side effects are safe to run twice (idempotency key or a natural unique constraint).
- [ ] Background work survives a restart or is tracked for graceful shutdown.
- [ ] Errors are logged with context and shown to the user in plain words.

## Data
- [ ] The source of truth is the database or the user's storage, not RAM or a local file.
- [ ] Every cache has a TTL and a size cap, and is cleared on write.
- [ ] Cache keys include the user/tenant id where the data is per user.
- [ ] New queries have the indexes they need; new tables have row-level access control (see `database.md`).

## Safety
- [ ] Inputs are validated at the edge, with size limits.
- [ ] Rate limits on costly or public endpoints.
- [ ] No secrets in code, logs or responses.
- [ ] Auth, payments or personal data touched → security review done (see `security.md`).

## Wrap-up
- [ ] The whole diff re-read as a reviewer would (or a review skill run, such as gstack `/review`).
- [ ] Project docs updated if the project asks for it (for example CONTEXT.md / CHANGELOG.md).
- [ ] Nothing committed, pushed or deployed without the user's OK.
