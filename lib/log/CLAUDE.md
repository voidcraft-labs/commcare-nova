# lib/log — Event log

The single persistent stream of what happened during a generation run.

## Boundary

Writes come from one place: `GenerationContext` (server-side). It owns a
`LogWriter` for the current request. Reads come from three places:

- `app/build/replay/[id]/page.tsx` — loads a run for replay
- `app/api/apps/[id]/logs/route.ts` — admin log inspection
- Diagnostic scripts (`scripts/inspect-logs.ts`, `scripts/inspect-compare.ts`)

No client-side code emits events. Users emit mutations via the doc store's
`applyMany`; the client does NOT mirror those to the event log — only the
agent writes. This is deliberate: the log captures agent work; the user's
local edits are implicit in the AppDoc snapshot.

## Shape

Two event families, one time-ordered stream at `apps/{appId}/events/`:

- `MutationEvent` — `{ kind: 'mutation', runId, ts, seq, actor, stage?, mutation }`
- `ConversationEvent` — `{ kind: 'conversation', runId, ts, seq, payload }`

See `types.ts` for the full Zod schemas.

## No-usage-in-events rule

Token usage and cost live on the per-run summary doc at
`apps/{appId}/runs/{runId}`, not on the event stream. Spec §5 keeps the
event log supplemental; cost is a separate concern owned by
`UsageAccumulator` in `lib/db/usage.ts`.

## Writer semantics

Fire-and-forget. `LogWriter.logEvent(event)` enqueues; a 100ms timer (or a
500-event buffer threshold) triggers a `WriteBatch` commit. `flush()`
drains on request end (finally block, onFinish, abort handler). Errors
log but never throw — observability failures must not block generation.

## Replay

`replayEvents(events, onMutation, onConversation, delayPerEvent?, signal?)`
walks the log in order. Mutations go to `docStore.applyMany`; conversation
events feed `useReplayMessages` (a pure derivation). No state
reconstruction — mutations are the state delta and conversation events are
stored directly. `deriveReplayChapters(events)` segments the stream into
UI chapters (Conversation, Data Model, Scaffold, Module, Form, Validation,
Done).

## Historical migration

Apps generated before this collection layout landed had events at
`apps/{appId}/logs/`. The one-time migration at
`scripts/migrate-logs-to-events.ts` back-fills them into the new
`apps/{appId}/events/` + `apps/{appId}/runs/{runId}` layout using
`scripts/migrate/legacy-event-translator.ts` to convert the historical
wire-event shape. Replay treats the old subcollection as empty for any
run that was not migrated.
