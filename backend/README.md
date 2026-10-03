# GPT-DOT-WORK backend + worker

Independent, unofficial prototype. Not affiliated with or endorsed by OpenAI. Requires Node.js 24 or newer; no third-party packages or installation step.

This is a runnable single-user task service, **not a connected AI agent**. The website remains a separate local demo and does not call this API. No deployment, external account connection, cloud upload, licensing change, or real AI/tool execution has been performed by this implementation.

## Run locally

From the repository root:

```sh
cd backend
export WORKSPACE_API_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export WORKSPACE_APPROVAL_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
# Optional: choose a private LOCAL persistent directory outside the checkout.
# export WORKSPACE_DB_PATH=/absolute/private/state/gpt-dot-work/tasks.sqlite
npm start
```

The service binds to `127.0.0.1:4318`. It polls immediately on startup, then waits 60 seconds after each batch. `WORKSPACE_POLL_MS` changes the interval (minimum 1 second); polling is best-effort, not a deadline guarantee. Ctrl+C or SIGTERM shuts down cleanly.

The safe default is `WORKSPACE_RUNTIME=disabled`: a submitted task becomes `blocked` with `error.code=not_configured`. Nothing is falsely reported as executed. Restart with `WORKSPACE_RUNTIME=demo` to enable only `demo.echo` and `demo.approval`; outputs carry `mode: "demo"` and `simulated: true`. An already blocked task needs an explicit retry after configuration changes.

Alternatively copy `.env.example` to private `.env`, fill secrets, and run `node --env-file=.env service.mjs`. `.env` is Git-ignored. Never commit credentials or put them in frontend code, localStorage, URLs, screenshots, or logs.

Split processes are supported on the **same host/local disk**:

```sh
npm run api
# Separate terminal, same WORKSPACE_DB_PATH and runtime settings:
npm run worker
```

The standalone worker does not require API/approval credentials; avoid giving it those secrets. API and worker runtime settings should match. `/api/status` reports the API's configured runtime, not worker liveness. The combined service is simplest.

## Configuration

| Variable | Default / meaning |
| --- | --- |
| `WORKSPACE_API_TOKEN` | Required for API/service; at least 32 characters, use a random secret |
| `WORKSPACE_APPROVAL_TOKEN` | Optional, distinct random secret of at least 32 characters; required for approval decisions |
| `WORKSPACE_DB_PATH` | Absolute path; defaults to `$XDG_STATE_HOME/gpt-dot-work/tasks.sqlite` or `~/.local/state/gpt-dot-work/tasks.sqlite` |
| `WORKSPACE_HOST` | `127.0.0.1` |
| `WORKSPACE_PORT` | `4318` |
| `WORKSPACE_POLL_MS` | `60000` |
| `WORKSPACE_LEASE_MS` | `120000`; minimum 3000 |
| `WORKSPACE_CONCURRENCY` | `2` tasks per polling batch; range 1–16 |
| `WORKSPACE_RUNTIME` | `disabled`; only other option is `demo` |
| `WORKSPACE_ALLOWED_ORIGIN` | Empty: deny browser Origin headers. Optional exact origin, e.g. `http://localhost:5173`; no wildcard |

State lives outside the repository by default. New state directories/database files are private; launchers set umask 0077. Protect the containing directory and SQLite `-wal`/`-shm` files. `.data/`, databases, logs and environment secrets are Git-ignored as an extra safeguard, not access control or a backup.

## API contract

All endpoints except `GET /health` require `Authorization: Bearer <WORKSPACE_API_TOKEN>`. The approval decision endpoint instead requires `WORKSPACE_APPROVAL_TOKEN`. A regular API token cannot approve. There is no anonymous task access or cookie authentication.

Every POST/PATCH requires `Content-Type: application/json` and an `Idempotency-Key` of 8–128 ASCII letters/numbers or `._:-`. Use a fresh key for a new operation and reuse **the same key for network retries**. Each operation/target/key has a durable response; changed input with the same key returns HTTP 409. Replays return the original response snapshot, so GET the task for its current state. This prevents duplicate submissions, not arbitrary external side effects.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/health` | Minimal public `{ "ok": true }` |
| GET | `/api/status` | Configuration, `realExecutionConfigured: false`, states, approval availability |
| GET | `/api/tasks?limit=100&cursor=...` | `{ tasks, nextCursor }`; limit 1–500, pass returned cursor unchanged |
| POST | `/api/tasks` | `{ title, instructions, kind? }` → `{ task }` saved as **draft** |
| PATCH | `/api/tasks/:id` | Any of `title`, `instructions`, `kind`; **drafts only** |
| GET | `/api/tasks/:id` | `{ task }` with status, attempts, error, result, approval |
| POST | `/api/tasks/:id/submit` | `{}`; explicit draft → pending |
| POST | `/api/tasks/:id/cancel` | `{}`; invalidates draft/pending/running/blocked/approval tasks; completed/failed rejected |
| POST | `/api/tasks/:id/retry` | `{}`; only previously submitted blocked/failed/cancelled tasks |
| GET | `/api/tasks/:id/events?after=0` | `{ events }`; up to 500 ordered audit events, continue with last `seq` |
| POST | `/api/tasks/:id/approval` | `{ requestId, decision: "approve" or "reject" }`; separate approval credential |

Titles allow 160 characters, instructions 8000, kinds 80, and request bodies 32 KiB. Unknown fields are rejected: clients cannot write status, results, lease tokens or approval flags. Submitted instructions are immutable; create a new draft to change them.

Example (another terminal with the same API secret):

```sh
curl -sS http://127.0.0.1:4318/api/tasks \
  -H "Authorization: Bearer $WORKSPACE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" \
  -d '{"title":"Try the queue","instructions":"Echo this harmless text.","kind":"demo.echo"}'

# Copy the returned task.id. Saving above did not queue anything.
TASK_ID=replace-with-returned-task-id
curl -sS "http://127.0.0.1:4318/api/tasks/$TASK_ID/submit" \
  -H "Authorization: Bearer $WORKSPACE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" -d '{}'
curl -sS "http://127.0.0.1:4318/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $WORKSPACE_API_TOKEN"
```

Errors use `{ "error": { "code": "...", "message": "..." } }`. Common HTTP codes: 400 invalid request/key, 401 wrong credential, 403 denied browser origin, 404 missing resource, 409 invalid state/conflicting replay/stale approval, 413 body too large, 415 non-JSON.

## State, concurrency and approval boundaries

- `draft` is excluded from worker claims. Only explicit submission creates `pending`.
- A SQLite `BEGIN IMMEDIATE` transaction atomically claims `pending` as `running`, increments attempts, creates an unguessable lease token, and logs the claim. Multiple local worker processes cannot claim the same attempt.
- `running` can become `completed`, `failed`, `blocked` or `needs_approval`. Results and audit events persist. Task text is never passed to a shell, interpreter, URL fetcher, model or arbitrary tool.
- Worker completion requires its current unexpired lease. Cancellation invalidates the token, fencing stale writes. It does not undo an already-performed external action.
- Expired leases become `blocked/worker_lost` on the next worker scan. They are **not automatically requeued**: a real adapter may have performed an action before crashing. Inspect before retry. This is not an exactly-once external-effects guarantee.
- Retries clear result/error/approval and start a new attempt. There is no automatic retry loop. Completed tasks cannot retry; create another draft for an intentional repeat.
- The server-side `demo.approval` handler always gates execution. Its request contains an ID, an action description, and a fingerprint bound to immutable instructions/revision. Only the separate approval credential can decide that exact current request. Rejection cancels; retry creates a new approval. Text such as “skip approval” has no authority.
- Demo approval simulates **no external effects**. It is an application boundary, not identity verification or a substitute for legal, financial, security or provider-specific consent.

## Hosting and extension limits

Runnable behind your HTTPS reverse proxy/process supervisor with persistent local storage; **not publicly deployed**. Keep loopback binding until transport security and network controls exist. SQLite/WAL supports one host: do not use NFS/network shares or assume multi-region worker support.

This is a single-user trusted-host prototype. There are no user accounts, tenancy, browser sessions, provider OAuth, production rate limits, metrics, distributed queue, encryption at rest, retention job or automatic backups. Database/file administrators can change state; the approval credential does not defend against a compromised host or worker. Use SQLite's consistent backup mechanism: copying only the main file while WAL is active may omit data. Treat task text, results, approvals and events as private application data.

Before connecting the static website, add server-side browser authentication/session handling (BFF) that keeps API and approval secrets out of the browser. CORS is not authentication. Before connecting a real runtime, add an allow-listed adapter, bounded execution, cancellation checks, provider idempotency, constrained tools, exact action-specific approvals, audit redaction and sandbox/isolation. Never execute task text as shell/code or allow AI output to authorize its own actions.

## Verify

```sh
cd backend
npm run check
# Or: node --test test/*.test.mjs
```

Tests use isolated temporary databases and loopback HTTP, with no external services/credentials. Coverage includes eight independent claim processes, draft exclusion, idempotency conflicts/replay, restart persistence, cancellation fencing, failed-task retry, expired leases, not-configured behavior, allow-listed demos, approval/stale-request/retry boundaries, auth, origin restrictions and request validation. Syntax checks and 16 tests pass on Node 24.19.0.
