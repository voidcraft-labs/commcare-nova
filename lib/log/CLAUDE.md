# lib/log — Event log

The single persistent stream of what happened during a generation run.

## Boundary

Writes come from the two tool surfaces (chat + MCP); each owns a
per-request `LogWriter` stamped with a `source` tag so one event
stream filters by origin.

No client-side code emits events. Users' doc edits via `applyMany` are
NOT mirrored to the event log — the AppDoc snapshot is authoritative for
user-side mutations. But the chat route DOES log the current request's
user message as a `ConversationEvent` (payload type `user-message`) so
replay and admin inspect can reconstruct turn-by-turn what the user
asked. Read this as "the log captures every server-observed moment of a
run"; client-only local edits stay implicit in the AppDoc.

## Ordering

Two event families (mutation + conversation), one stream at
`apps/{appId}/events/`. Doc IDs are Firestore auto-IDs and carry no
ordering — reads order by `(ts, seq)`: `ts` is monotonic-ish across
requests (the concurrency guard serializes per user); `seq` tiebreaks
events inside a single-millisecond SSE burst.

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

The async dispatcher (`replayEvents`) serves abortable live playback; the sync variant is the scrub/hydrate path, where the cursor commit runs immediately after dispatch — every mutation must have landed by then, so there is NO await between events. Chapter derivation is pure data shaping; subtitle resolution walks a running `BlueprintDoc` chapter-by-chapter so stage tags resolve to the display names the live SA observed at chapter start. No state reconstruction anywhere — mutations are the state delta.
