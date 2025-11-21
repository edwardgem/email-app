# email-app (compose + author-agent + send-agent)

A three-service app of the email workflow:
- **author-agent**: generates HTML email drafts (initial + regen).
- **send-agent**: sends approved HTML emails.
- **compose**: orchestrates author → send (HITL can be slotted later).

**LangChain** now orchestrates the compose workflow (author-agent tool → HITL tool → send-agent tool). The author-agent continues to run its existing prompt/LLM logic, but compose exposes each service as a LangChain tool so we can trace/run the entire pipeline (with a transparent fallback to the legacy imperative flow) while keeping the **HITL agent** integration untouched.

## Structure
- `author-agent/` – generation service (uses `prompt.txt`, supports `base_html` regen path).
- `send-agent/` – send service (mailer stub).
- `compose/` – AMP-facing orchestrator; merges config defaults, calls author/send, and loads LangChain chains that wrap both calls plus the HITL workflow. Run `npm install` inside `compose/` to pull the LangChain dependency.
- `shared/` – common utilities (paths, logging, traces).
- `infrastructure/` – deployment assets (pm2 config lives at repo root).
- `tests/` – integration/unit tests (to be added).

## Runtime expectations
- `INSTANCE_ROOT` points to your runtime instances, e.g. `/Users/edwardc/Projects/agents`.
- Instance layout: `INSTANCE_ROOT/email-app/<instance_id>/` with `config.json` (can set PROMPT_FILE), optional per-instance `.env` overrides, `meta.json`, `artifacts/`, `logs/`, `llm_traces.json`.
- Logging: services POST to `LOG_API_URL` (e.g. `http://localhost:4000/api/log`) with required fields `instance_id`, `service`, `event_type`, `message`, `username`, `ts`, `trace_id`.

## Services (defaults)
- compose: `PORT=4100`
- author-agent: `PORT=4101`
- send-agent: `PORT=4102`
- Log service: `LOG_API_URL=http://localhost:4000/api/log`
- LLM config (env): supports ollama or OpenAI via `LLM_PROVIDER`, `LLM_MODEL`, `LLM_ENDPOINT`, `LLM_OPTIONS`, `OPENAI_API_KEY`.
- Mail config (env): `MAIL_PROVIDER` (resend/gmail) plus provider-specific keys.
- Env sourcing: set shared env in `ecosystem.config.js` (pm2) or service-level env; per-instance `.env` files are optional and only for instance-specific overrides.
- Compose lazily imports `@langchain/core` to build tools for author-agent, the HITL agent, and send-agent. If the package is missing, it logs a warning and falls back to the legacy imperative flow so AMP / HITL / log-agent integrations continue to work.

## Running with pm2
```
INSTANCE_ROOT=/Users/edwardc/Projects/agents LOG_API_URL=http://localhost:4000/api/log pm2 start ecosystem.config.js
```

## API contracts (summary)
- `author-agent POST /generate`
  - body: `{ instance_id, username, instructions?, base_html?, subject?, trace_id? }`
  - behavior: instructions empty → use prompt.txt (resolved via PROMPT_FILE, first from instance `config.json`, then instance env, then service env); with base_html, apply prompt (and optional instructions) to provided HTML; appends `llm_traces.json`; writes `artifacts/email.html` (rotates existing email.html → email-1.html, etc.).
- `send-agent POST /send`
  - body: `{ instance_id, username, html, subject, to[], cc?, bcc?, sender_email?, sender_name?, trace_id? }`
  - behavior: validates recipients/subject/html, reads per-instance mail env overrides, sends via provider (resend/gmail), writes `artifacts/email.html`.
- `compose POST /compose/send`
  - body: `{ instance_id?, username, instructions, subject?, to?, cc?, bcc?, sender_email?, sender_name?, regen_base_html?, trace_id? }`
  - behavior: generate instance_id if missing; merge subject/recipients from request over `config.json`; require subject and at least one recipient after merge; LangChain chain calls author tool then HITL tool (with fallback when LangChain is unavailable); return combined result.

## Notes
- All services have `/health`.
- LLM/mailer are stubbed; replace with real adapters as needed.
- Compose must be called with `username`; it propagates to downstream logs.
