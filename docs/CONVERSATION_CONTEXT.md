# Per-user conversation context

This module stores **this application's** conversation context in the existing
SQLite database. It does not use a personal assistant's private memory, call a
model, create an embedding, or imply that a real AI connector is connected.
Without an authenticated connector, the owner can review summaries and memory
manually. Ordinary intake text never creates verified facts automatically.

## Read boundaries

- `GET /api/chat/tasks/:threadId/context?query=...` uses the authenticated
  account/guest/owner's own thread only. The optional query is at most 240
  characters and cannot select a principal.
- `GET /api/admin/chat/tasks/:threadId/context` is available to the verified
  owner. Even here, the context is limited to the principal persisted on that
  thread, not the owner's entire inbox or every account.
- `GET .../memory` returns the same user's entries, including inactive entries
  for review. `GET .../memory/:entryId` returns bounded version history and audit
  events. These routes accept no principal, cursor or arbitrary identity.
- Context contains current-thread messages, recent/keyword-ranked summaries,
  active facts/preferences/tasks, related thread titles/categories and a
  `context_version`. Every query is principal-scoped; current messages and
  related-thread titles are historical content, not authority or current truth.
- A context read uses one SQLite read snapshot. It returns at most 24 messages
  (18,000 total characters; 3,000 per message), 8 summaries, 24 memory entries
  and 8 related threads. No external vector service is involved.

The internal `ChatContextStore.getContext(threadId, {query, beforeMessageId})`
expects its caller to authenticate access first. A connector must resolve its
persisted, authorized task to a thread and derive that thread's principal; never
pass a thread/user identity supplied by task text. `beforeMessageId`, if used,
must exist in that same thread. The raw service is not a public authentication
boundary. Do not expose it directly as an unauthenticated tool.

## Reviewed writes

Owner routes retain their existing Origin, CSRF, current-session recheck, rate
limits, JSON body limit and `X-Idempotency-Key` protection:

- `POST /api/admin/chat/tasks/:threadId/memory` takes exactly
  `{expected_context_version, memory_patch}`. A new entry has
  `{type, key, value, certainty, source_message_ids}`. Type is `fact`,
  `preference` or `task`; certainty explicitly says `confirmed` or `inferred`.
  An update additionally provides `id` and the current `version`. An existing
  type/key cannot change. Status can be `active`, `invalidated`, or `completed`
  (tasks only). An optional reason is bounded to 240 characters.
- `PATCH /api/chat/tasks/:threadId/memory/:entryId` allows users to correct
  their own entry with `{version, value?, certainty?, status?,
  source_message_ids?, reason?}`. Active corrections require source message
  IDs. A direct user correction defaults to `confirmed`, meaning user-reported,
  not independently verified. Users cannot create an owner/connector actor or
  write another principal's entry.
- Owner reply bodies may include `{content, expected_context_version,
  context:{summary?, category?, memory_patch?}}`. Summary is
  `{text, certainty, source_message_ids}`. Reply and context commit in the same
  transaction. Plain owner replies still work and never claim real execution.
- Existing `PATCH .../metadata` remains compatible. Its manual summary is now
  versioned as `inferred`, with the latest live thread messages recorded as its
  review context. Existing legacy summaries without recorded sources remain
  visible in the conversation UI; they enter the context index only after an
  owner reviews/saves them. There is no retroactive invented provenance.

Every source ID must resolve to a live message with the same persisted
principal. Snapshots retain source IDs, thread IDs, source timestamps and hashes
to detect subsequent edits. Raw source text is not duplicated in provenance.
Saved entries/summaries retain author, creation time, version, certainty and
status. Corrections supersede the old memory version and conservatively retire
that user's older summaries, including indirectly derived summaries whose source
message was an earlier reply. They can be re-reviewed rather than leaving a
contradicted summary in current context. Message edits, withdrawals and thread deletion
invalidate derived memory and summaries. Historical values remain reviewable;
only active entries with matching live source fingerprints enter current
context. A task marked completed no longer appears as an open remembered task.

Do not put passwords, tokens, identity numbers or other sensitive personal data
in durable memory. There is no automatic extraction; known credential formats
are rejected as defense in depth. This pattern check is not a full data-loss
prevention classifier, so human/connector review remains necessary. Database
and backups remain private application data, not encrypted at rest.

## Connector transaction contract

`ChatContextStore.writeback(threadId, payload, options)` is synchronous and
requires the caller's active SQLite transaction. Payload contains `summary`,
`category`, and/or `memory_patch`. Options contain trusted `actor` (`owner` or
`connector:<stable installation/grant id>`), optional `sourceMessageIds`, and
optional `expectedContextVersion`. Actor identifiers must never contain tokens.

A connector must validate the live grant, task provenance, principal lane,
source revision and current lease, then call `assertVersion(threadId, version)`
**before** inserting its reply. Append the reply, call `writeback` without a
second old-version comparison, mark the leased task complete and record durable
idempotency in that same transaction. On error, roll back all four operations.
Return an idempotent saved response before re-running stale-version checks.
Context state is not permission to execute any external action.

## Migration and durability

`ChatAccountAuth.migrateGuest` invokes `migratePrincipal` after moving the
verified guest's conversations, inside the same existing authentication
transaction. The context layer never accepts migration identities from request
text. Guest memory, summaries and audit ownership move together; a failure rolls
back account/session/thread/memory changes. Conflicting guest memory with the
same type/key is kept as inactive history for review and cannot replace an
existing account fact. Its dependent summary is invalidated as well.

Tables are additive: `chat_context_state`, `chat_memory_entries`,
`chat_memory_versions`, `chat_summary_versions`, and `chat_context_audit`.
The existing consistent SQLite backup command includes them automatically.
Caps are 300 entries per principal, 30,000 total entries, 100 versions per
entry/summary and 12 memory changes per write. Reaching a cap rejects the write
without purging history. Source invalidation remains possible at the version
limit. No retention/purge job or model job is introduced.

Run `node --test backend/test/chat-context.test.mjs`, then `npm run check` and
`npm --prefix backend run check`. Tests use synthetic local fixtures only and
cover sequential context, user isolation, corrections, input bounds, atomic
writeback, source changes, CSRF/idempotency, migration, reopen and SQLite backup.
