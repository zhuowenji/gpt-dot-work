# Managed bridge event outbox

## State of this implementation

This is local implementation and offline test coverage only. The module is disabled by default. Importing it does not start a worker, resolve DNS, contact a callback, create a subscription, or generate credentials. No deployed connection or end-to-end ChatGPT receipt is established by these tests.

Protocol reference: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), checked 2026-10-04. Signing reference: [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md). The implementation uses Node's built-in HMAC-SHA256 to keep the backend dependency-free.

The official callback examples do not establish a production callback hostname. There is no guessed or wildcard platform allowlist. Production enablement requires a separately verified exact HTTPS origin, a valid Site/owner/public-key registration, an authorized subscription, its platform-supplied callback secret, and the normal deployment/activation approvals.

## Backend integration

`ManagedBridgeEvents` shares the existing `TaskStore.db`; its tables are not a second database. Construct it after the store and verified registration authorizer exist:

```js
const events = new ManagedBridgeEvents(store, {
  enabled: false,
  allowedCallbackOrigins: [],
  registrationActive: registration => auth.active()
    && registration.key_id === auth.registration.key_id
    && registration.site_id === auth.registration.site_id
    && registration.owner_subject === auth.registration.owner_subject,
});
```

The callback's authorizer must synchronously consult the current registration and durable revocation state, not just the originally authenticated HTTP request. The verified registration has `site_id`, `owner_subject`, `key_id`, `queue: "website-chat"`, and `expires_at` in Unix milliseconds. The events module does not authenticate HTTP requests or accept identity from subscription arguments.

Authenticated routes are:

- `POST /api/managed-bridge/v1/subscriptions/upsert`: authenticate and strip `site_id`/`owner_subject`, then await `events.upsert(registration, operation)`.
- `POST /api/managed-bridge/v1/subscriptions/delete`: authenticate the same binding, then call `events.delete(registration, operation)`.

Upsert takes the official `name`, `arguments`, `delivery`, optional `ttlMs`, and optional `cursor` fields. Only `task.created`, `{queue: "website-chat"}`, webhook delivery, and a null/absent cursor are supported. `delivery` contains the callback `url` and platform-provided `secret`. Delete uses the same identity with no secret. No caller-supplied owner, key, arbitrary event, or extra filter is accepted.

Successful upsert returns `{id, refreshBefore, cursor: null, truncated: false}`. The expiration is ISO 8601. Delete returns `{}` and is idempotent. Never log either route's body or callback headers: the callback URL can itself contain an opaque token.

### Transactional task wakeups

Inside the same synchronous transaction that records a ready task and its notification generation:

```js
events.enqueueTaskReady(registration, {
  task_id: task.id,
  queue: "website-chat",
  created_at: store.now(),
  generation: task.notificationGeneration,
});
```

`enqueueTaskCreated` is the same operation; omitted `generation` means zero. `created_at` is the wake event's occurrence time in Unix milliseconds. Generation must be a nonnegative safe integer persisted by the task queue. The event ID is deterministic per Site, owner, key, task, and generation. Repeating one generation never creates another delivery.

The queue decides readiness. A same-principal follower should emit only when it becomes eligible to claim; a recovered/released task needs a new durable readiness generation. This avoids consuming the sole wake while the task is still blocked by another lease. A reply does not itself become a task or event; queue reconciliation may wake a different pending user task after its predecessor finishes.

The module requires an existing task transaction for enqueueing. Any failure rolls back task and outbox together. It rejects asynchronous callback verification or dispatch inside an open transaction. Subscription mutations and delivery state changes use synchronous SQLite savepoints.

Only subscriptions active at event creation receive that event. The protocol does not offer replay. A later subscription does not stream historical chat or resurrect cancelled deliveries. Explicit queue bootstrap must list pending tasks and, where appropriate, record a fresh readiness generation.

### Dispatcher and status

An explicitly enabled service may call `await events.dispatchOne()` outside a transaction on its existing scheduler. No timer starts automatically in this module. An idle or disabled call returns null. A delivery attempt returns its event ID, safe status, and attempt count; it never returns a URL, secret, event content, callback body, or raw transport error.

`events.status(registration)` returns:

```js
{
  subscription_active: false,
  last_delivery_at: null, // actual acknowledgement Unix milliseconds, not event time
  delivery_pending: 0,
  delivery_dead: 0,
}
```

The result is scoped to the currently active registration. A 2xx callback acknowledgment proves receipt by the callback endpoint; it does not prove that ChatGPT completed a task. A connected-status gate should separately establish the matching claim/reply result.

Wire `auth.onRevoke` to `events.haltRevoked()` to abort this process's current requests immediately. Call `events.close()` during shutdown before closing SQLite. Other processes must read the same durable revocation table. Checks occur at claim, before and after DNS, before transmission, and after the callback; active requests also recheck access every 50 ms. Bytes already accepted remotely cannot be withdrawn.

## Verification and transport protections

- New callbacks receive a signed, fresh, short-lived challenge first. Application data is withheld until a 2xx response echoes it in constant time. A pending verification cannot reactivate a concurrently deleted subscription.
- Successful verification is cached for at most five minutes, under the authenticated binding and exact callback identity. A replacement secret requires verification. A failed replacement leaves the previously verified subscription unchanged.
- Callback origins must match an explicit configuration entry. URL credentials, fragments, non-default ports, backslashes, literal IP hosts, and non-HTTPS URLs are rejected. An unknown origin returns `callback_origin_not_allowed` with only the origin, never the callback path/query or secret.
- Every connection resolves the hostname afresh, validates every returned address, rejects mixed public/private answers, and pins a vetted address into HTTPS. TLS still verifies the original hostname. There is no redirect-following or proxy path.
- IPv4 private, loopback, link-local, CGNAT, special-use, documentation, benchmark, multicast, and reserved ranges are blocked. IPv6 is limited to global unicast, additionally excluding special-purpose, documentation, transition, and translation ranges. This is deliberately conservative.
- Both verification and events use a 10-second total request ceiling; DNS has a three-second ceiling. Only eight requests may be in flight. Verification responses are limited to 4 KiB; event response bodies are not retained.
- Callback secrets must be canonical `whsec_` Base64, decoding to 24–64 bytes. The module never generates or invents a callback secret. Replacements overlap old/new signatures for at most five minutes, bounded by subscription expiry.

## Durability and retry bounds

`managed_bridge_subscriptions` stores callback identity, finite expiry, verification state, current/temporary previous signing secrets, and a concurrency version. Treat this SQLite file and its WAL/backup copies as confidential runtime data. Use the existing TaskStore's restricted directory/file permissions and service-account access; never include them in source archives. Expiry/revocation cleanup clears stored callback secrets. Deletion also clears them immediately. Disk snapshots and prior SQLite pages need their own retention policy.

`managed_bridge_event_outbox` stores one immutable, thin event body containing only task ID and queue. `managed_bridge_event_deliveries` stores subscription-specific attempts, leases, status, and actual acknowledgement time. Exact body bytes and event IDs are reused across retries; each attempt receives a fresh signing timestamp.

Limits are exported as `EVENT_LIMITS`:

- Subscription lifetime: default/maximum 24 hours; finite even for `ttlMs: null`; bounded by registration expiry. Minimum requested lifetime is one second.
- Delivery: at most eight attempts over at most 24 hours, exponential delays starting at one second. Retry only network failures, 408, 425, 429, and 5xx. Redirects and other 4xx, including 410 and 413, terminate delivery.
- Lease: 30 seconds, further bounded by subscription/key expiry. A crashed worker's expired lease can be reclaimed. Callback receipt is at-least-once; receiver deduplication uses the stable event ID.
- Capacity: 32 subscription identities, 100,000 outbox records, and 200,000 delivery records. Capacity failures are explicit. Tombstoned subscription identities count toward the bound; operators should review them rather than silently discarding revocation evidence.
- Expired events become dead and are removed after two days when no delivery is pending. Task and chat history are separate and unchanged.

## Offline verification

Run `node --test backend/test/managed-bridge-events.test.mjs` from the repository root. All callback transport and DNS in these tests are mocks; the tests make no outbound requests. Fixtures use fixed non-production secrets. A temporary SQLite restart test removes its fixture database afterward.

Coverage includes default-off behavior, strict scope/filter validation, callback challenges, signature bytes, origin/address defenses, DNS rebinding, transaction rollback, restart persistence, generation deduplication, retries, stale leases, scoped unsubscribe, expiry/revocation races, secret rotation, and actual acknowledgement timestamps.

Hosted subscription discovery, actual platform-origin verification, real callback receipt, and ChatGPT claim/reply execution remain separate activation checks.
