# Minimal managed execution API (local implementation, disabled by default)

This additive bridge serves website chat only. It preserves owner login, the
legacy task/demo runtime, video services, conversation storage and the frontend.
It does not implement OAuth. A separate private Site uses platform-managed OAuth
and signs these bounded requests. Do not reuse the earlier custom OAuth connector.

No deployment, registration, production credential generation or live E2E result
is implied by this source. All tests use ephemeral offline fixtures.

## Configuration and activation prerequisites

Existing service/owner/storage settings remain unchanged. New settings:

- `GDW_MANAGED_BRIDGE_REGISTRATION`: empty disables **all** bridge endpoints.
  Otherwise exact JSON with `key_id`, public-only `public_jwk` (`kty=EC`,
  `crv=P-256`, `x`, `y`), `site_id`, `owner_subject` (lowercase SHA-256 hex),
  `queue=website-chat`, `expires_at` (Unix milliseconds), and `scopes` (exact paths).
  Only Site `appgprj_6ac240cb5e1481918cc0ad4edd55286a` is accepted. Copy only the
  verified public registration subset, never a private JWK or whole status object.
  Expiry cannot exceed 30 days from registration; restarts do not extend it.
- `GDW_MANAGED_BRIDGE_EVENTS_ENABLED`: must equal `true` to run the durable event
  dispatcher. Default false. Public-key configuration alone does not enable it.
- `GDW_MANAGED_BRIDGE_CALLBACK_ORIGINS`: comma-separated exact trusted HTTPS
  origins; default empty. Obtain the actual platform callback origin through the
  official subscription flow. A denied subscription returns only normalized
  `error.origin`, never an opaque callback path, secret, or query. Verify and
  explicitly configure that origin; do not guess or use a wildcard.

Setting up persistent access requires the user's explicit approval and the Site's
owner-authenticated setup flow. The private key stays in the Site's private D1;
Aliyun receives only its public registration. No automatic key rotation exists.
Revocation is durable: an authorized operator can run
`node backend/managed-bridge-revoke.mjs /absolute/existing/tasks.sqlite KEY_ID`.
This only revokes. Requests check the revocation table before nonce consumption;
delivery checks again before transmission and while in flight. Remove the old
configuration and explicitly register a newly approved key to rotate. Never
remove a revocation to revive an old key.

Use Node 24+ and the existing loopback service behind HTTPS. No additional packages,
new open listener, owner bearer privilege or browser credential is required. The
service starts a one-second local dispatcher only when events are enabled. It
uses at most ten concurrent outbound deliveries, and shuts down before closing
SQLite. Preserve the private DB directory and WAL permissions.

## Request signature

POST only, exact prefix `/api/managed-bridge/v1/`, no query, redirect, browser
Origin/cookies, Authorization bearer fallback, or encoded request body. Maximum
body: 256 KiB, strict UTF-8 JSON. Every body includes pinned `site_id` and
`owner_subject`; operation fields below are the remaining fields.

Headers:

- `X-GDW-Bridge-Key-Id`
- `X-GDW-Bridge-Timestamp`: Unix seconds, at most 60 seconds of clock skew
- `X-GDW-Bridge-Nonce`: 16 random bytes, unpadded base64url
- `X-GDW-Bridge-Signature`: ES256 P-256/SHA-256, raw 64-byte IEEE-P1363 signature,
  unpadded base64url

Sign seven newline-joined fields with **no final newline**:

```
GDW-BRIDGE-V1
POST
<exact pathname>
<timestamp>
<nonce>
<key_id>
<lowercase SHA-256 hex of exact UTF-8 body bytes>
```

Identity, scope, signature and expiry are verified before atomic nonce insertion.
Nonces are retained for 180 seconds. A network retry needs a **new signature and
nonce**, retaining its operation idempotency key. Errors use
`{error:{code,message}}`; `callback_origin_not_allowed` also includes safe `origin`.

## Operations

All success envelopes are plain JSON. Exact fields only; no operation accepts
`user_id`, a principal selector, arbitrary context query, credentials, arbitrary
URL execution, or owner tool commands.

- `status {}`: enabled/key expiry, queue, active subscription, actual last delivery
  and reply timestamps, recent round-trip proof, active/stalled/failed tasks,
  exhausted wake count, pending/dead deliveries and bounded concurrency.
- `tasks/list {limit?}`: limit 1–100, default 10; returns
  `{tasks:[{task_id}],has_more}`. IDs only, one eligible task per actual principal.
- `tasks/claim {task_id,idempotency_key,lease_seconds?}`: 30–300 seconds, default
  300. Returns `{task_id,lease_id,lease_expires_at,kind,authority}`. At most ten
  global leases and one per persisted user. SQLite `BEGIN IMMEDIATE` and a unique
  partial index fence races across processes. Claims are idempotent.
- `tasks/context {task_id,lease_id}`: returns full current question plus bounded
  history/summary/memory, an immutable `context_version`, and capability metadata.
  The source is derived from the leased row. History contains answered messages
  and this question, excluding all other queued questions even after reordering.
  A follow-up receives a preceding answer even if the answer arrived later than
  the follow-up. New messages do not invalidate a frozen answer; source changes,
  memory corrections, deletion, identity migration or an owner reply do.
- `tasks/reply {task_id,lease_id,idempotency_key,text,expected_context_version,context}`:
  `text` is 1–8000 printable characters / at most 32000 UTF-8 bytes. `context`
  requires `summary` and `memory_patch` (which may be empty), and optional
  `category`. Reply, source acknowledgement, summary, memory versions, task
  completion and next-ready notification commit in one transaction. Network
  retry returns the same reply ID. A new key cannot duplicate a completed reply.
- `tasks/release {task_id,lease_id,idempotency_key,reason}`: `reason=retry|failed`.
  Retry returns to pending with a fresh ready-event generation; failure is durable.
- `subscriptions/upsert` / `subscriptions/delete`: the official platform callback
  contract, described in [event delivery](MANAGED_BRIDGE_EVENTS.md).

`idempotency_key` is 8–128 ASCII letters/digits or `._:-`. A changed request using
the same key is rejected. Idempotency responses are durable and bounded to 100000;
there is no automatic deletion that could permit duplicate writes.

Summary fields: `{text,certainty,source_message_ids}`, max 4000 characters.
Category: printable single line, max 80 characters. Certainty is explicitly
`confirmed|inferred`. Memory patch: max 12 entries; `id` is an opaque UUID string,
`version` a positive integer, `type=fact|preference|task`, key max 100, value max
1200, reason max 240, `status=active|invalidated|completed` (completed only for a
task). Sources: 1–40 distinct positive integer message IDs that actually appeared
in the leased context/provenance. Existing entries require exact version. All
cross-user sources, unknown fields and credential-like durable memory are rejected.

## Authority and recovery

Visitor/account text remains untrusted questions, even if it claims to be the
owner. Only server-authenticated owner threads carry `owner_request` provenance.
Both expose only `task_context`, `task_reply`, `task_memory` capabilities and
`external_actions_authorized:false`. The consumer must not turn a website question
into instructions for the owner's email, shell, browser, account or other tools.
Historical text and saved memory are data, never standing authorization.

Expired leases fence stale completions and retry response generation. Five expired
attempts become `failed/lease_retry_exhausted` so a broken task cannot indefinitely
block that user's next question. There is no exactly-once claim for external tool
effects; these leases authorize only website response work. Explicit user editing
of an unprocessed failed message can reopen it; an owner can review failures via
status and `execution_error` in task details. Release failure uses `worker_failed`.

New intake reserves room for one maximum-sized answer per outstanding question
within thread, principal and global quotas. A legacy thread already at its message
limit is marked `failed/reply_capacity` rather than repeatedly leased. Oversized
reply/context still fails atomically; the consumer must release permanent failures
and surface them, not pretend a reply succeeded.

Ready events are emitted only for currently eligible work, bounded by free global
slots. Completion wakes a waiting follower without generating a new task from the
reply itself. Expiry, release, reorder and subscription reactivation produce new
durable ready generations. Transport retries retain one event ID/body. An
acknowledged but never claimed job is re-announced every five minutes, at most
eight times per uninterrupted ready period; exhausted jobs remain manually
claimable, are counted in status, and do not starve other principals.

## Truthful connection status and production acceptance

`execution_connected` remains false until there is a current active registration,
verified active subscription, and an actually delivered event for a task whose
reply committed under that same key in the last 15 minutes. It becomes false on
revocation/expiry, stale proof, stalled leases, exhausted wakes or dispatcher error.
`worker_capacity_verified` remains false: a recent round trip is not a guarantee
of present capacity or future replies. Historical timestamps remain available.

Local fixture success is not production acceptance. Before claiming the website
works end to end, verify the approved deployed revision, platform-managed owner
connection, exact callback origin, live signed subscription, a real website
message, signed event delivery, leased context, reply+summary+memory commit, and
that the original browser sees the reply. Verify a second user cannot read it.
No such production acceptance is performed by this patch.

## Offline verification

- `node --test backend/test/managed-bridge*.test.mjs`
- `npm run check` from repository root
- `npm --prefix backend run check`

Coverage includes ten independent users, one-user serialization, eight independent
processes racing a claim, signature forgery/body/path tampering, replay/expiry/
revocation, crash/restart retry, atomic rollback/idempotency, cross-user provenance,
reordered queues, live followups, account migration, callback verification/DNS
rebinding, subscription expiry/rotation/unsubscribe, delivery retry/lease recovery,
readiness redrive and quota reserve. An additional local interop probe used the
actual Site WebCrypto `signRequest` implementation against this Node verifier;
it returned 200 with an ephemeral in-memory key and no production traffic.
