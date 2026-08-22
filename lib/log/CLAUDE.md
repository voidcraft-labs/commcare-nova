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
`readEvents` strictly validates the complete ordered page through
`eventSchema.array().parse`. One malformed row fails the whole read; returning
the valid rows around it would invent a partial history that never existed.
Pre-cutover mutation payloads use the explicit opaque `archived-mutation` arm.

Conversation-event attachment UUIDs are immutable audit receipts, not live
media references. Readers display the snapshotted metadata only; event ids are
never dereferenced, remapped during Project moves, copied, reverse-indexed, or
used to block deletion. The live carrier set is authored Blueprint slots plus
strict `threads.messages[*].metadata.attachments[*]`.

## Usage in events — per-step decomposition only

Aggregate token usage and COST live on the per-run summary
(`run_summaries`), owned by `UsageAccumulator` in `lib/db/usage.ts` and
read back via `readRunSummary` (which delegates to
`lib/db/runSummary.ts::loadRunSummary`) — never on the event stream. The
one usage shape events DO carry is the `step-usage` conversation
annotation (`GenerationContext.handleAgentStep`, one per agent step):
per-step input / cached-input / output tokens, because "which step
re-billed uncached input" is a per-step question the run summary's
aggregates cannot answer. Steps with tools also carry their opaque tool-call
ids, which correlate private payload-free outcome annotations without exposing
the tool input or result. No money values on events; sub-generation usage
(document extraction etc.) stays summary-only.

The private design loop emits `design-tool-outcome` annotations with opaque
call identity, tool name, input character count, duration, a closed outcome
category, a stable code, and optional validation stage plus issue count. The
private build executor emits `executor-tool-outcome` annotations with only
model step, tool name, operation index, workspace revision, a closed outcome
category, and a stable code. Raw inputs, outputs, rejection prose, and
customer-authored names never enter either event.

Terminal reviewed-build failures also emit one structured
`design_build_failed` operational line outside this event stream. Product
resumability does not choose its severity. Only an expected external
prerequisite stays at warning; a provider, protocol, validation, compiler, or
budget defect logs at error and mirrors to Sentry even when the preserved
design can resume after a deploy. `designSessionId`, `runId`, `errorType`, and
`failureClass` are bounded searchable tags. No authored payload joins them.

## Writer semantics

Fire-and-forget. `LogWriter.logEvent(event)` enqueues; a 100ms timer (or
a 450-event buffer threshold — a plain bound on how many rows one INSERT
carries) triggers one batched INSERT into `events`. `flush()` drains on
request end (finally block, onFinish, abort handler). Errors log but never
throw — observability failures must not block generation. Multiple
requests sharing a `runId` (the normal edit-thread case) cannot overwrite
each other's events because the `id` identity column is server-assigned
per row.
