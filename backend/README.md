> 当前默认界面已调整：公开 `/` 接收文字问题与需求，注册/登录可选；`/admin/` 是有权限的记录、摘要、分类与回复页面，不再提供新任务发布。普通账号只能访问自己的记录，所有者独立认证。新问答 API 使用 `/api/chat/*`，与本文保留的历史私有任务 API 分开。真实 dot 连接仍未完成接入验证；详见 [问答记录模块](../docs/CHAT_INTAKE.md)。本文旧工作空间/单用户段落仅描述历史模块，不能作为新公开界面的完整权限说明。

# GPT-DOT-WORK backend + worker

Independent, unofficial prototype. Not affiliated with or endorsed by OpenAI. Requires Node.js 24 or newer; no third-party packages or installation step.

This is a runnable single-owner web workspace and task service, **not a connected AI agent**. The backend serves an authenticated frontend with persistent SQLite data. A separate static demo remains available. No deployment, external account connection, cloud upload, licensing change, or real AI/tool execution has been performed by this implementation. For browser setup, start with [Single-owner web application](#single-owner-web-application) below.

## Run locally (legacy bearer-only development)

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

For browser owner mode, copy `.env.example` to a private file outside the checkout, fill configuration, and run `node --env-file=/absolute/private/workspace.env service.mjs`. Never commit credentials or put them in frontend code, localStorage, URLs, screenshots, or logs.

Split processes are supported on the **same host/local disk**:

```sh
npm run api
# Separate terminal, same WORKSPACE_DB_PATH and runtime settings:
npm run worker
```

The standalone worker does not require API/approval bearer credentials; avoid giving it those tokens. Shared production config validation still requires owner configuration and a built static directory. API and worker runtime settings should match. `/api/status` reports the API's configured runtime, not worker liveness. The combined service is simplest.

## Configuration

| Variable | Default / meaning |
| --- | --- |
| `WORKSPACE_API_TOKEN` | Optional in owner mode; otherwise required for API/service. At least 32 random characters |
| `WORKSPACE_APPROVAL_TOKEN` | Optional distinct random secret of at least 32 characters; machine-client approval only; owner sessions use explicit approval routes |
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

Task and workspace endpoints require a valid owner cookie session or `Authorization: Bearer <WORKSPACE_API_TOKEN>`. Machine-client approval instead requires `WORKSPACE_APPROVAL_TOKEN`; a regular API token cannot approve. Owner browser sessions use same-origin and CSRF protection. Static assets, `GET /health`, `GET /api/session`, and login are public; private data is never anonymous.

Every task POST/PATCH requires `Content-Type: application/json` and an `Idempotency-Key` of 8–128 ASCII letters/numbers or `._:-`. Use a fresh key for a new operation and reuse **the same key for network retries**. Each operation/target/key has a durable response; changed input with the same key returns HTTP 409. Replays return the original response snapshot, so GET the task for its current state. This prevents duplicate submissions, not arbitrary external side effects.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/health` | Minimal public `{ "ok": true }` |
| GET | `/api/status` | Configuration, `realExecutionConfigured: false`, states, approval availability |
| GET | `/api/tasks?limit=100&cursor=...` | `{ tasks, nextCursor }`; limit 1–500, pass returned cursor unchanged |
| POST | `/api/tasks` | `{ title, instructions, kind? }` → `{ task }` saved as **draft** |
| PATCH | `/api/tasks/:id` | Any of `title`, `instructions`, `kind`; **drafts only** |
| GET | `/api/tasks/:id` | `{ task }` with status, attempts, error, result, approval |
| POST | `/api/tasks/:id/submit` | Owner browser: `{revision}` matching reviewed draft; legacy bearer may use `{}`. Explicit draft → pending |
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
- The server-side `demo.approval` handler always gates execution. Its request contains an ID, an action description, and a fingerprint bound to immutable instructions/revision. Only an authenticated owner session with valid CSRF or the separate approval bearer credential can decide that exact current request. Rejection cancels; retry creates a new approval. Text such as “skip approval” has no authority.
- Demo approval simulates **no external effects**. It is an application boundary, not identity verification or a substitute for legal, financial, security or provider-specific consent.

## Hosting and extension limits

Runnable behind your HTTPS reverse proxy/process supervisor with persistent local storage; **not publicly deployed**. Keep loopback binding until transport security and network controls exist. SQLite/WAL supports one host: do not use NFS/network shares or assume multi-region worker support.

This is a single-owner trusted-host workspace. Owner sessions and login rate limits are implemented; there is no multi-user tenancy, provider OAuth, metrics, distributed queue, encryption at rest, retention job or automatic backup scheduling. Database/file administrators can change state; the approval credential does not defend against a compromised host or worker. Use SQLite's consistent backup mechanism: copying only the main file while WAL is active may omit data. Treat task text, results, approvals and events as private application data.

Browser authentication keeps API and approval secrets out of the frontend; CORS alone is not authentication. Before connecting a real runtime, add an allow-listed adapter, bounded execution, cancellation checks, provider idempotency, constrained tools, exact action-specific approvals, audit redaction and sandbox/isolation. Never execute task text as shell/code or allow AI output to authorize its own actions.

## Verify

```sh
cd backend
npm run check
# Or: node --test test/*.test.mjs
```

Tests use isolated temporary databases and loopback HTTP, with no external services/credentials. Coverage includes eight independent claim processes, draft exclusion, idempotency conflicts/replay, restart persistence, cancellation fencing, failed-task retry, expired leases, not-configured behavior, allow-listed demos, approval/stale-request/retry boundaries, auth, origin restrictions and request validation. Run the current suite for the latest totals. Owner tests also cover session persistence/rotation/expiry/logout, production configuration, CSRF, workspace validation/concurrency, public static boundaries, durable throttles, password hashing and session revocation.

## Single-owner web application

The backend now serves the built frontend and supports one private owner account.
This does not create an AI account, connect an external service, generate a deployed
credential, or enable real execution. The deterministic demo is still an explicit
`WORKSPACE_RUNTIME=demo` opt-in. Normal production uses `disabled`.

### Configure the owner safely

Use Node 24+, build the frontend (`npm run build` from the repository root), and
keep the runtime environment file outside the repository with mode `0600`.
`backend/.env.example` contains names only, no real credential. The owner password
must be set by the operator. Generate its salted scrypt hash with a no-echo prompt
in a trusted shell, not a command-line password argument:

```bash
read -r -s -p 'Owner password: ' OWNER_PASSWORD; printf '\n'
printf '%s' "$OWNER_PASSWORD" | node backend/password-hash.mjs
unset OWNER_PASSWORD
```

The helper prints only `scrypt$32768$8$1$<base64url salt>$<base64url hash>` and
requires at least 8 characters (Unicode code points), at most 1024 UTF-8 bytes,
and no line breaks. Copy that hash into the private environment file as
`WORKSPACE_OWNER_PASSWORD_HASH`. Treat the hash as sensitive configuration. Use a
unique, high-entropy password from a password manager. Do not commit the password,
hash, bearer tokens, environment file, SQLite file, or backups. Shell variables are
not exported by this prompt; avoid shells with tracing enabled (`set -x`).

Set `NODE_ENV=production`, an exact HTTPS `WORKSPACE_PUBLIC_ORIGIN`, and an absolute
`WORKSPACE_DB_PATH` on a private persistent local disk outside both the checkout and
public static root. Production fails at startup unless the hash, HTTPS origin,
loopback host, and built `index.html` are valid. The app listens on loopback; the
operator's existing reverse proxy must terminate TLS, preserve `Host`, and forward
to that listener. The app never trusts `X-Forwarded-For`, TLS forwarding headers,
or client-supplied identity headers. A dedicated client-IP header can be explicitly
trusted for login throttling only, as described below. Do not expose the HTTP
listener directly.

`WORKSPACE_STATIC_DIR` defaults to the repository's built `dist`. Only the root
page and allow-listed `/src/` assets are public; source config, arbitrary files,
symlinks escaping the static root, and self-contained demo preview are not served.
The server injects the `workspace-mode=server` meta marker, so the frontend must not
silently fall back to local demo data if the API fails. Static demo hosting alone
is not an authenticated production deployment.

Optional `WORKSPACE_RELEASE` accepts 1–64 alphanumeric, dot, underscore, or hyphen
characters and appears as `releaseId` on the public `/health` response. No secret
or detailed runtime configuration is returned by health checks.

### Browser API contract

- `GET /api/session`: public login state; includes `csrfToken`, `owner.name`, and
  `expiresAt` only when authenticated. Also reports `loginConfigured`, `runtime`,
  `demo`, and `realExecutionConfigured:false`.
- `POST /api/login` with `{ "password": "…" }`: requires exact public `Origin`,
  accepts no other field, rotates a new server-side session, and returns session
  state. The frontend never receives bearer tokens or the password hash.
- `POST /api/logout` with `{}`: requires the owner session, matching `Origin`, and
  `X-CSRF-Token`; revokes that session in SQLite and clears the cookie.
- `GET /api/workspace`: authenticated `{revision, updatedAt, workspace}`. An empty
  account starts at revision 0 with `version:1` and empty `projects`, `notes`,
  `tasks`, `decisions` arrays.
- `PUT /api/workspace` with exactly `{revision, workspace}`: authenticated,
  same-origin, CSRF-protected. Atomic compare-and-swap increments the revision;
  stale writes get `409 revision_conflict` without overwriting newer data. The
  client must let the user preserve unsaved changes and explicitly reload/resolve
  conflicts, rather than retrying stale data blindly.
- Execution requests use the existing `/api/tasks` API, never workspace fields.
  Create/edit remains a draft until explicit `POST /api/tasks/:id/submit` with
  `{revision}` matching the exact draft the owner reviewed. The check is atomic;
  a stale revision gets `409 revision_conflict` and never queues changed text.
  Review refreshed content before resubmitting. Legacy bearer-only callers may
  continue sending `{}`, but should send `revision` for the same protection.
  Owner sessions may use the task routes, with CSRF on every mutation and a fresh
  `Idempotency-Key` per logical operation. Retry the same logical write with the
  same key. Approval requires the exact pending `requestId` and `decision` at
  `POST /api/tasks/:id/approval`; saved text never grants permission.
- Error responses are `{error:{code,message}}`. `401` means sign-in is needed;
  `403` means origin/CSRF denied; `429` login throttling includes `Retry-After`.

Workspace schema is fixed to the UI's version 1 fields. Unknown fields (including
execution requests and authority flags), duplicate IDs, dangling project
references, invalid enum values, and oversized data are rejected. At most 1000
records per collection and 1 MiB total workspace JSON are supported. Notes may
contain up to 64000 characters and 30 tags. This is a small personal workspace,
not unbounded document or file storage.

### Sessions, brute-force protection, and recovery

Production cookies are host-only `__Host-workspace_session`, `Secure`, `HttpOnly`,
`SameSite=Strict`, and `Path=/`. Session identifiers and CSRF values are independent
256-bit random values; only a SHA-256 session identifier is stored in SQLite.
Sessions survive restarts, expire absolutely after 12 hours and after one idle
hour by default, and are capped at ten active devices. Changing the configured
password hash invalidates existing sessions. Optional session timeout variables
are listed in `.env.example` and validated at startup.

Only failed password checks consume the durable login quota: five per verified
client IP per 15 minutes. A successful password login clears that client's failure
history. Invalid JSON/form bodies, malformed proxy headers, successful logins, and
requests rejected before password work do not add failures. SQLite retains at most
4096 recent client counters; old counters expire or are evicted oldest-first. No
persistent global failure counter can lock out all clients. Upgrading removes the
old shared global counter.

Separately, at most two scrypt password checks run concurrently per API process,
with at most one per client. Excess work is rejected immediately as
`429 login_busy` with `Retry-After: 1`, without queueing passwords or consuming the
failed-auth quota. A client whose five password failures exhausted its own window
receives `429 login_rate_limited` with `Retry-After: 900`. Run a single API process
as configured by the service template; this resource gate is process-wide, not a
distributed limiter across multiple API replicas. A separate task worker does not
perform password checks.

The safe default is `WORKSPACE_TRUST_PROXY=` (empty): client-IP forwarding headers
are ignored and the actual socket peer identifies the client. With a loopback
reverse proxy this shares one bucket, so public failed attempts could temporarily
lock out the owner behind that proxy. To separate clients, explicitly configure
only the loopback peer actually used, for example `WORKSPACE_TRUST_PROXY=127.0.0.1`
(or the exact comma-separated peers `127.0.0.1,::1`). CIDRs, public proxy peers,
`true`, `*`, and hostnames are rejected. IPv4-mapped loopback sockets match the
corresponding IPv4 peer.

Enable trust only after checking the local reverse proxy **overwrites** the fixed
`X-Workspace-Client-IP` header using its directly connected, verified client IP.
Examples inside the existing proxy's upstream configuration:

```nginx
proxy_set_header X-Workspace-Client-IP $remote_addr;
```

```caddyfile
header_up X-Workspace-Client-IP {http.request.remote.host}
```

Do not use an inherited `X-Forwarded-For` value, blindly trust a chain supplied by
the browser, or enable IP rewriting from arbitrary upstream peers in the proxy.
The backend honors this dedicated header only when the connection socket exactly
matches a configured trusted loopback peer. It requires one plain IPv4/IPv6
address; missing, duplicate/comma-separated, port-qualified, scoped, or malformed
values from a trusted peer return `400 invalid_client_ip` before password work.
Headers from untrusted peers are ignored. Equivalent IPv6 forms are canonicalized
for one rate bucket. This header supplies rate-limit attribution, never login or
permissions. TLS, origin, session, password and CSRF checks remain unchanged.

This is resource protection, not a guarantee of availability under attack. Clients
sharing a NAT still share a failure bucket. Sustained traffic can briefly occupy
the two verification slots, and callers can retry after those slots free. The
operator should apply suitable edge request limits/network access controls. Keep
the loopback backend inaccessible externally and review the proxy's own trusted-IP
settings. No plaintext passwords or request content is logged by the backend.

The existing database now includes `owner_workspace`, `owner_sessions`, and
`owner_login_attempts`, alongside task/request/audit tables. After restoring a
backup, while the service is stopped, revoke every restored session before
serving traffic:

```bash
WORKSPACE_DB_PATH=/absolute/private/restored.sqlite node backend/revoke-sessions.mjs
```

The command removes only `owner_sessions`; workspace and execution records are
preserved. Run the same command for an explicit sign-out-all-devices incident
response. Back up consistently with SQLite-aware tooling, protect backups as
private user data, and verify restore procedures before relying on them.

Legacy machine callers can still use distinct `WORKSPACE_API_TOKEN` and
`WORKSPACE_APPROVAL_TOKEN` bearer credentials. These are optional in owner mode.
A normal API bearer token alone never approves tasks. Never paste either bearer
credential into the browser, localStorage, source code, or client configuration.

## Optional managed-Site chat execution bridge

The additive [managed task API](../docs/MANAGED_TASK_API.md) is disabled until an
explicitly approved public-key registration and callback configuration exist.
It serves only task-derived chat context and atomic reply/summary/memory writes;
it does not grant owner tools or implement custom OAuth. Local tests do not imply
a live connection. The existing runtime and other services remain independent.
