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
admin inspect can reconstruct turn-by-turn what the user asked. Read this
as "the log captures every server-observed moment of a run"; client-only
local edits stay implicit in the AppDoc.

## Storage + ordering

Two event families (mutation + conversation), one row per event in the
`events` table (`lib/db/pg.ts` owns the table type; DDL in
`lib/case-store/migrations/20260708000000_app_state.ts`). The `id`
identity column carries no ordering — reads order by `(ts, seq)` for a
`run_id`: `ts` is monotonic-ish across requests (the concurrency guard
serializes per user); `seq` tiebreaks events inside a single-millisecond
SSE burst. The full event rides the `event` jsonb column; the envelope
fields (`run_id`, `ts`, `seq`, `source`, `kind`) are projected into their
own columns so reads filter and order without parsing the payload.
`readEvents` re-validates each payload through `eventSchema.safeParse`
(`decodeEventsLenient`), dropping and counting any forward-version /
drifted row rather than failing the whole read.

## No-usage-in-events rule

Token usage and cost live on the per-run summary (`run_summaries`), not on
the event stream. The event log is supplemental; cost is a separate
concern owned by `UsageAccumulator` in `lib/db/usage.ts` and read back via
`readRunSummary` (which delegates to `lib/db/runSummary.ts::loadRunSummary`).

## Writer semantics

Fire-and-forget. `LogWriter.logEvent(event)` enqueues; a 100ms timer (or
a 450-event buffer threshold — a plain bound on how many rows one INSERT
carries) triggers one batched INSERT into `events`. `flush()` drains on
request end (finally block, onFinish, abort handler). Errors log but never
throw — observability failures must not block generation. Multiple
requests sharing a `runId` (the normal edit-thread case) cannot overwrite
each other's events because the `id` identity column is server-assigned
per row.
