# Agent skills by Kush Ahuja

[![skills.sh](https://skills.sh/b/ahujakush/skills)](https://skills.sh/ahujakush/skills)

Skills for Claude Code, Codex, Cursor and other coding agents that support the [Agent Skills](https://skills.sh) format.

## production-backend

Makes your coding agent write backend code that holds up in production, instead of code that only works on the happy path.

```bash
npx skills add ahujakush/skills --skill production-backend
```

What it makes the agent do:

- **Ask five questions before coding**: load, failure, "what if it runs twice", where the data really lives, and how we'll see it break.
- **Cache on a ladder, not by reflex**: fix the query first, then an in-process cache, then HTTP caching, and Redis only when 2+ server copies need to share state. Every cache gets a TTL, a size cap, delete-on-write and stampede protection.
- **Make every outside call safe**: timeouts, retries only on retryable errors with backoff and jitter, idempotency keys for anything that sends, charges or creates, background jobs that survive restarts, graceful shutdown.
- **Cover the basics**: database indexes and N+1 queries, LLM cost and caching, input validation, authorization, secrets, logs and health checks.
- **Test first, prove it's done**: watch the test fail before the fix, and never claim "done" without running the check in the same turn.

It's self-contained and works with any stack. The code templates are TypeScript with no dependencies, and they're tested. If you also have `supabase-postgres-best-practices`, gstack or the Anthropic engineering plugin installed, it points to them for depth.

```
skills/production-backend/
├── SKILL.md                    the rules, loaded when backend work starts
└── references/
    ├── caching.md              strategies, TTL guide, Redis rules, cache template
    ├── reliability.md          retry, idempotency, job table, shutdown, rate limit
    ├── database.md             indexes, pooling, constraints, safe migrations
    ├── llm-calls.md            timeouts, model routing, prompt caching, budgets
    ├── security.md             input, auth, secrets, webhooks
    └── done-checklist.md       what "done" means
```

### Install by hand

Copy `skills/production-backend` into `~/.claude/skills/` (Claude Code, every project) or `.claude/skills/` inside one project.

## Credits

The ideas behind "test first" and "verify before claiming done" come from [obra/superpowers](https://github.com/obra/superpowers). The cache strategies come from [donnemartin/system-design-primer](https://github.com/donnemartin/system-design-primer). Both are rewritten here in my own words.

## Author

Made by [Kush Ahuja](https://www.thekush.codes), AI engineer in Gurugram. MIT licensed.
