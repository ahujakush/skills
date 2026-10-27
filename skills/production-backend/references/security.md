# Security essentials

The baseline for any backend change. Anything touching auth, payments or personal data deserves a dedicated security review on top.

## Input

- **Validate at the edge**: type, required fields, length, size, format, allowed values. Reject with 400 and a clear message before doing any work.
- **Cap sizes**: request body, uploads, list lengths, string lengths.
- **Parameterized queries only.** Never build SQL, shell commands or file paths by joining user text.
- **Files**: check type by content, not just extension; store outside the web root or in object storage; generate your own file names.
- **Outgoing requests to user-given URLs** (webhooks, link previews): allow-list schemes and block private and metadata IP ranges (SSRF).

## Auth

- **Authorization on every request**, not just "is signed in": does this user own this record? Check it in the query (`where id = $1 and owner_id = $2`) or with row-level security.
- Hash passwords with a slow hash (argon2, bcrypt, scrypt). Hash API tokens and one-time codes before storing them.
- Sessions and tokens expire; sign-out and password change revoke them.
- **Rate limit** login, signup, password reset, one-time codes, and anything that costs money (LLM, SMS, email).
- Compare secrets with a constant-time comparison.

## Secrets

- Only in environment variables or a secret manager. Never in git, logs, error messages, URLs or client code.
- Separate keys per environment. Rotate a key that leaked; deleting the commit is not enough.
- Encrypt stored third-party tokens (OAuth refresh tokens and similar) with a key kept outside the database.

## Responses and headers

- Return only the fields the client needs. Never return password hashes, tokens or other users' data.
- Error messages for users are plain and general; details go to logs.
- CORS: allow only your own origins. Cookies: `HttpOnly`, `Secure`, `SameSite`.
- Webhooks: verify the provider's signature and timestamp, and make the handler idempotent.

## Dependencies

- Keep them few. Each one is code you didn't review.
- Pin versions with a lockfile and check advisories (`npm audit`, `pip-audit` or the platform's equivalent) before releases.
