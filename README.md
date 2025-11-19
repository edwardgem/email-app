# email-app (compose + author-agent + email-agent)

A three-service rewrite of the email workflow:
- **author-agent**: generates HTML email drafts (initial + regen).
- **email-agent**: sends approved HTML emails.
- **compose**: orchestrates author → email (HITL can be slotted later).

## Structure
- `author-agent/` – generation service (uses `prompt.txt`, supports `base_html` regen path).
- `email-agent/` – send service (mailer stub).
- `compose/` – AMP-facing orchestrator; merges config defaults, calls author/email.
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
- email-agent: `PORT=4102`
- Log service: `LOG_API_URL=http://localhost:4000/api/log`
- LLM config (env): supports ollama or OpenAI via `LLM_PROVIDER`, `LLM_MODEL`, `LLM_ENDPOINT`, `LLM_OPTIONS`, `OPENAI_API_KEY`.
- Mail config (env): `MAIL_PROVIDER` (resend/gmail) plus provider-specific keys.
- Env sourcing: set shared env in `ecosystem.config.js` (pm2) or service-level env; per-instance `.env` files are optional and only for instance-specific overrides.

## Running with pm2
```
INSTANCE_ROOT=/Users/edwardc/Projects/agents LOG_API_URL=http://localhost:4000/api/log pm2 start ecosystem.config.js
```

## API contracts (summary)
- `author-agent POST /generate`
  - body: `{ instance_id, username, instructions?, base_html?, subject?, trace_id? }`
  - behavior: instructions empty → use prompt.txt (resolved via PROMPT_FILE, first from instance `config.json`, then instance env, then service env); with base_html, apply prompt (and optional instructions) to provided HTML; appends `llm_traces.json`; writes `artifacts/email.html` (rotates existing email.html → email-1.html, etc.).
- `email-agent POST /send`
  - body: `{ instance_id, username, html, subject, to[], cc?, bcc?, sender_email?, sender_name?, trace_id? }`
  - behavior: validates recipients/subject/html, reads per-instance mail env overrides, sends via provider (resend/gmail), writes `artifacts/email.html`.
- `compose POST /compose/send`
  - body: `{ instance_id?, username, instructions, subject?, to?, cc?, bcc?, sender_email?, sender_name?, regen_base_html?, trace_id? }`
  - behavior: generate instance_id if missing; merge subject/recipients from request over `config.json`; require subject and at least one recipient after merge; call author then email; return combined result.

## Notes
- All services have `/health`.
- LLM/mailer are stubbed; replace with real adapters as needed.
- Compose must be called with `username`; it propagates to downstream logs.
