# lib/log — Event log

The single persistent stream of what happened during a generation run.

## Boundary

Writes come from one place: `GenerationContext` (server-side). It owns a
`LogWriter` for the current request. Reads come from three places:

- `app/build/replay/[id]/page.tsx` — loads a run for replay
- `app/api/apps/[id]/logs/route.ts` — admin log inspection
- Diagnostic scripts (`scripts/inspect-logs.ts`, `scripts/inspect-compare.ts`)

No client-side code emits events. Users' doc edits via `applyMany` are
NOT mirrored to the event log — the AppDoc snapshot is authoritative for
user-side mutations. But the chat route DOES log the current request's
user message as a `ConversationEvent` (payload type `user-message`) so
replay and admin inspect can reconstruct turn-by-turn what the user
asked. Read this as "the log captures every server-observed moment of a
run"; client-only local edits stay implicit in the AppDoc.

## Shape

Two event families, one time-ordered stream at `apps/{appId}/events/`:

- `MutationEvent` — `{ kind: 'mutation', runId, ts, seq, actor, stage?, mutation }`
- `ConversationEvent` — `{ kind: 'conversation', runId, ts, seq, payload }`

Doc IDs are Firestore auto-IDs — the event stream carries no ordering
semantics on its `_id`. Reads order by `(ts, seq)`. `ts` is the primary
sort (monotonic-ish across requests because the concurrency guard
serializes them per user); `seq` is a per-request counter that
tiebreaks events emitted inside a single millisecond SSE burst.

See `types.ts` for the full Zod schemas.

## No-usage-in-events rule

Token usage and cost live on the per-run summary doc at
`apps/{appId}/runs/{runId}`, not on the event stream. Spec §5 keeps the
event log supplemental; cost is a separate concern owned by
`UsageAccumulator` in `lib/db/usage.ts`.

## Writer semantics

Fire-and-forget. `LogWriter.logEvent(event)` enqueues; a 100ms timer (or
a 450-event buffer threshold — 50 under Firestore's `WriteBatch` hard
limit of 500) triggers a `WriteBatch` commit of `.create()` calls
(auto-IDs). `flush()` drains on request end (finally block, onFinish,
abort handler). Errors log but never throw — observability failures
must not block generation. Multiple requests sharing a `runId` (the
normal edit-thread case) cannot overwrite each other's events because
doc IDs are minted by Firestore per write.

## Replay

`replayEvents(events, onMutation, onConversation, delayPerEvent?, signal?)`
walks the log in order. Mutations go to `docStore.applyMany`; conversation
events feed `useReplayMessages` (a pure derivation). No state
reconstruction — mutations are the state delta and conversation events are
stored directly. `deriveReplayChapters(events)` segments the stream into
UI chapters (Conversation, Data Model, Scaffold, Module, Form, Validation,
Done).
