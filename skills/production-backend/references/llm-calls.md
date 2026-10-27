# LLM and paid API calls

LLM calls are the slowest and most expensive outside calls most apps make. Treat them like any other outside call (timeout, retry, logging) plus cost control.

## Speed and failure

- **Timeout** sized for the model and output length (often 30-120 s), and **stream** whenever a user is waiting so the first words show early.
- **Retry** on 429, 5xx, overloaded and timeout errors with backoff and jitter; respect `Retry-After`. Don't retry on invalid-request errors.
- **Fallback**: a second model or provider for when the first is down or slow, behind one small wrapper so callers don't care which one answered.
- **Run independent calls in parallel**, not one after another.
- **Validate structured output** (JSON schema or tool-call arguments) and retry once with the error message if it's malformed.

## Cost

- **Route by difficulty**: classification, extraction, short rewrites and routing go to the small, cheap model; long reasoning and writing go to the big one. Decide per task, in config, not hard-coded at every call site.
- **Prompt caching** from the provider: put the long, stable part (system prompt, tool definitions, documents) first and the changing part last, so the stable prefix is cached.
- **Response cache** for identical requests (same model + prompt + params): hash them into the key and give it a TTL. Don't cache personal or time-sensitive answers across users.
- **Trim context**: send only the history and documents the task needs. Summarize or drop old turns.
- **Cap output** with `max_tokens` set for the task.
- **Budgets**: a per-user and per-day spend cap, checked before the call; a clear message when it's hit.
- **Log every call**: model, input/output tokens, cached tokens, duration, cost, and which feature made it. You can't cut cost you can't see.

## Safety

- Text from users, web pages, emails and files is data, not instructions. Keep it clearly separated in the prompt, and never let model output run commands, queries or tool calls with more permission than the user has.
- Keep API keys on the server only. Never ship them in a web or mobile client.
