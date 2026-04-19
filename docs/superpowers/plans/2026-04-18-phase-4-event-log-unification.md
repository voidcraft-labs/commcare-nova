# Phase 4: Event Log Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution uses two-stage review at each task (spec-compliance sonnet + code-quality opus).

**Goal:** Unify the generation event log into a single time-ordered stream of typed `Event`s (mutation + conversation) under `lib/log/`. Delete `lib/services/eventLogger.ts`, `lib/services/logReplay.ts`, `lib/generation/mutationMapper.ts`, and `lib/db/logs.ts`. The stream dispatcher keeps only the live `data-mutations` + lifecycle branches (legacy wire-event replay goes away). Replay consumes `Event[]` directly — no `StoredEvent → ReplayStage` reconstruction. Phase 4 of 7 from `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`.

**Architecture:** `lib/log/` owns every persistence-layer artifact for the event stream: Zod types + TS inference (`types.ts`), a Firestore writer with ~100ms batching (`writer.ts`), a sequential reader (`reader.ts`), and a ~30-line replay dispatcher (`replay.ts`). The live SSE stream is decoupled from persistence — the SA's `ctx.emitMutations(muts, stage)` writes to the SSE and to the log independently. Writing is fire-and-forget; the blueprint snapshot on `AppDoc` remains authoritative for state. Usage tracking for the spend cap is a separate concern: a `UsageAccumulator` owned by `GenerationContext` tracks cumulative token cost and flushes to `usage/{userId}/months/{period}` on request end (spec §5 "authority" + the Phase 1 fail-closed contract). Per-run cost observability (for `scripts/inspect-logs.ts` / admin tooling) moves to a new `apps/{appId}/runs/{runId}` summary doc written once on finalize — the event log intentionally does NOT carry token usage per spec §5.

**Tech Stack:** TypeScript 5.x strict, Zod 4.x, Zustand, Immer, Google Cloud Firestore (node SDK), Vitest, Biome.

**Worktree:** `.worktrees/phase-4-event-log-unification` on branch `refactor/phase-4-event-log-unification`. Create at commit `28f9746` (current `main` HEAD — Phase 3 merged). Use `superpowers:using-git-worktrees` to create the worktree before any code changes.

**Baseline before starting:** From `main` at `28f9746`:
- `npm test -- --run` — 1191 tests across 66 files, all passing
- `npx tsc --noEmit` — clean
- `npm run lint` — clean
- `npm run build` — clean

Re-verify in the final verification task.

---

## Architectural north star (carried from Phase 3)

1. **Internal code runs on domain types only.** Log entries carry `Mutation` (from `@/lib/doc/types`) for mutation events and a small typed `ConversationPayload` discriminated union for conversation events — never wire-format snapshots. The legacy `StoredEvent`/`LogEvent` discriminated union in `lib/db/types.ts` is replaced wholesale by the new `Event` type in `lib/log/types.ts`.
2. **`data-mutations` is the only mutation-bearing stream event.** The server-side SA already writes `data-mutations` for every doc edit (Phase 3 shipped this). Phase 4 replicates the same mutations onto the persistent event log at emission time — no dual wire formats, no replay-time reconstruction, no `mutationMapper.ts`.
3. **Logging moves out of the agent layer.** `lib/agent/*` stops importing `EventLogger`. The agent imports `logEvent` from `@/lib/log/writer` (a plain client), and `GenerationContext` owns an instance plus a sibling `UsageAccumulator` for spend tracking. `EventLogger` disappears as a concept — its responsibilities split into `logEvent` (events) + `UsageAccumulator` (cost) + per-run summary writer (admin observability).
4. **Replay loads `Event[]` directly.** `extractReplayStages` disappears. The replay UI consumes raw `Event[]` from Firestore via `readEvents(appId, runId)`, and the replay controller steps through stages derived from `stage`-tagged runs of mutation events plus conversation event boundaries. Progressive chat history is implicit — it's just "the conversation events up to the current cursor."
5. **No runtime migration layer.** Per spec non-goals: "No adapter layers, no runnable intermediate states. Big-bang in a worktree." The old `apps/{appId}/logs/` subcollection is not migrated; historical apps built before Phase 4 lose replay fidelity. Current main is early-stage with only test/dev data in Firestore logs — this is acceptable.

---

## Bridge-smell guardrails (read before every task)

Subagents trained on "what to do" invent bridges. Subagents trained on "why bridges betray the architecture" don't. None of the following patterns may appear in a Phase 4 commit:

- **Dual-writing `StoredEvent` and `Event` "for read compat."** The new writer lands on `apps/{appId}/events/`; the old `apps/{appId}/logs/` subcollection is deprecated, not read, not referenced, not indexed. Don't re-introduce it as a shim.
- **Keeping `EventLogger` as a deprecated class.** Delete `lib/services/eventLogger.ts`. If cost tracking or sub-generation bookkeeping needs a home, extract it to `UsageAccumulator` or delete it — don't preserve the old API surface.
- **Dual-format emission on the SSE wire.** The SSE still emits `data-mutations { mutations, stage? }` for the live client (Phase 3 contract — unchanged). It does NOT also emit per-mutation `MutationEvent` envelopes — those are a persistence concept and live in Firestore only.
- **Keeping `lib/generation/mutationMapper.ts` "for the legacy replay case."** The mapper exists ONLY to translate historical wire-events. After Phase 4 removes the legacy replay branch from `streamDispatcher.ts`, no call site remains — delete the file (and its tests).
- **`lib/services/logReplay.ts` as a re-export shim from `lib/log/replay.ts`.** The move is a move. Delete the source. Update every import.
- **Writing `ts`-scope doc IDs that collide across millisecond-adjacent events.** The spec keys Firestore docs by `{runId}:{ts}:{seq}`. Include `seq` even when events land milliseconds apart — under SSE burst conditions (scaffold → many addField mutations emitted synchronously), multiple events share `ts`.
- **`lib/log.ts` (the GCP structured logger) coexisting with `lib/log/` (the directory).** One of them renames. Per this plan: `lib/log.ts` → `lib/logger.ts`; update all 14 imports.
- **Persisting token usage on the event log.** Spec §5 is explicit: log is supplemental, mutation + conversation only. Token usage lives on the per-run summary doc (`apps/{appId}/runs/{runId}`) and on monthly `usage/{userId}/months/{period}`. Don't smuggle token fields onto `Event`.
- **`// TODO: Phase 5 will remove this` comments.** Phase 4 is a complete end state for logging. Every file this plan touches must land in its final shape.
- **`as any` / `@ts-expect-error` to paper over the rename.** Fix the import, fix the type. If a consumer drifted, the consumer is part of Phase 4's scope.

---

## Scope boundaries

IN SCOPE (this plan):

- Rename `lib/log.ts` → `lib/logger.ts`; update all 14 imports.
- Create `lib/log/` with: `types.ts`, `writer.ts`, `reader.ts`, `replay.ts`, `CLAUDE.md`.
- Add Zod schema + Firestore converter for the new `Event` type at `apps/{appId}/events/{runId}_{seq}`.
- Add a `UsageAccumulator` in `lib/db/usage.ts` for request-level cost tracking (replaces the `EventLogger.logStep` + `logSubResult` + `finalize` cost path).
- Add a per-run summary writer at `apps/{appId}/runs/{runId}` with cost/token breakdown. New collection + Zod schema.
- Rewrite `GenerationContext` to own `LogWriter` + `UsageAccumulator` instead of `EventLogger`. `emit` becomes lifecycle-only; `emitMutations` writes one `MutationEvent` per mutation; new `emitConversation(payload)` writes conversation events; `runAgent`'s `onStepFinish` emits assistant-reasoning / assistant-text / tool-call / tool-result conversation events.
- Rewrite the chat route so `user-message` conversation events are written via the log writer (replaces `logger.logConversation`).
- Simplify `lib/generation/streamDispatcher.ts` — delete the `LEGACY_REPLAY_DOC_MUTATION_EVENTS` branch; keep `data-mutations` + lifecycle + session-only. Delete its test file for the legacy branch.
- Delete `lib/generation/mutationMapper.ts` and `lib/generation/__tests__/mutationMapper.test.ts`.
- Rewrite `ReplayBuilder`, `ReplayHydrator`, `ReplayController`, and the `/build/replay/[id]/page.tsx` to read `Event[]` from the new collection and dispatch via `replayEvents` + `applyStreamEvent` (lifecycle-only events now).
- Rewrite `extractReplayStages` → a new `deriveReplayChapters(events)` in `lib/log/replay.ts` that derives chapter metadata (header/subtitle/bounds) from `stage`-tagged mutation runs + conversation-event boundaries. The ReplayController keeps its chapter-navigation UI.
- Update `app/api/apps/[id]/logs/route.ts` and `app/api/admin/users/[id]/apps/[appId]/logs/route.ts` to query the new collection and return `Event[]` (not `StoredEvent[]`).
- Rewrite `scripts/inspect-logs.ts`, `scripts/inspect-compare.ts`, `scripts/lib/log-stats.ts`, `scripts/lib/types.ts`: new Event-based analysis; cost summaries sourced from the per-run summary doc.
- Delete `lib/services/eventLogger.ts`, `lib/services/logReplay.ts`, `lib/db/logs.ts`, and their tests/fixtures.
- Move `lib/generation/mutationMapper.ts` + its test → `scripts/migrate/legacy-event-translator.ts` + `scripts/migrate/__tests__/legacy-event-translator.test.ts`. The translator keeps running in the main test suite; it's only used by the one-time migration script.
- Write a one-time migration script at `scripts/migrate-logs-to-events.ts` that reads every document under `apps/{appId}/logs/` for each app, converts to the new `Event[]` shape via the moved translator, and writes to `apps/{appId}/events/` + seeds `apps/{appId}/runs/{runId}` summaries from aggregated `StepEvent` / `ConfigEvent` data. Runs with `--dry-run` and `--app=<id>` flags. Idempotent via deterministic doc IDs.
- Update `CLAUDE.md` files: root (builder state section), `lib/services/CLAUDE.md` (remove eventLogger/logReplay callouts), `lib/agent/CLAUDE.md` (logging moved), `lib/session/CLAUDE.md` (unchanged). Add `lib/log/CLAUDE.md` (new).

OUT OF SCOPE (future phases or deferred):

- **Phase 5: Declarative field editor UI + god-component splits.** Phase 4 touches zero component files beyond ReplayController / ReplayBuilder / ReplayHydrator.
- **Phase 6: Hook + lint hygiene, top-level `/hooks/` deletion.** Phase 4 leaves hooks alone.
- **Phase 7: Delete `lib/schemas/blueprint.ts`, `lib/services/`, etc.** `lib/services/` shrinks (eventLogger + logReplay removed) but is not deleted.
- **Per-run summary UI.** Phase 4 writes the summary doc and updates inspect scripts; no builder UI consumes it.
- **Splitting per-type SA tools.** `toolSchemaGenerator` still ships on `flat-sentinels` only.

---

## File structure

### Files to create

| File | Responsibility |
|------|---------------|
| `lib/logger.ts` | Renamed from `lib/log.ts`. The GCP structured console logger — no behavior change. |
| `lib/log/CLAUDE.md` | Describes the event log boundary: Event type, writer/reader/replay surface, actor discipline (agent calls `logEvent` as a plain client), no-usage-in-events rule. |
| `lib/log/types.ts` | `Event`, `MutationEvent`, `ConversationEvent`, `ConversationPayload`, `ConversationAttachment`, `ClassifiedErrorPayload`, plus the Zod schemas that back each. |
| `lib/log/writer.ts` | `LogWriter` class: accepts events, batches ~100ms, fire-and-forget Firestore set. `flush()` drains on request end. `logEvent(event)` is the only public method. |
| `lib/log/reader.ts` | `readEvents(appId, runId?)`, `readLatestRunId(appId)`, `readRunSummary(appId, runId)`. |
| `lib/log/replay.ts` | `replayEvents(events, onMutation, onConversation, delayPerEvent?, signal?)` — the ~30-line dispatch loop. `deriveReplayChapters(events)` — the ReplayController's chapter metadata (header/subtitle/start index/end index). |
| `lib/log/__tests__/writer.test.ts` | Tests the batcher: single event flushes on timer, batch reaches size cap, `flush()` drains immediately, errors log but don't throw. |
| `lib/log/__tests__/reader.test.ts` | Tests ordering-by-`ts`, fallback to `seq` tiebreaker, empty result, latest-run resolution. |
| `lib/log/__tests__/replay.test.ts` | Tests the dispatch loop: applies mutations and forwards conversation payloads in order; `signal.aborted` short-circuits; `delayPerEvent=0` runs synchronously fast; `deriveReplayChapters` groups `stage`-tagged mutation runs. |
| `lib/db/runSummary.ts` | Writer for `apps/{appId}/runs/{runId}`: `writeRunSummary(appId, runId, summary)`. |
| `lib/db/__tests__/runSummary.test.ts` | Round-trips a summary doc through the Zod converter. |
| `scripts/migrate/legacy-event-translator.ts` | Moved verbatim from `lib/generation/mutationMapper.ts`. The wire-event → `Mutation[]` translator used only by the migration script. Test moves alongside to keep coverage. |
| `scripts/migrate/__tests__/legacy-event-translator.test.ts` | Moved verbatim from `lib/generation/__tests__/mutationMapper.test.ts`. Import paths adjusted. |
| `scripts/migrate-logs-to-events.ts` | One-time migration: reads `apps/{appId}/logs/`, converts each run to `Event[]` via the translator, writes to `apps/{appId}/events/` + seeds `apps/{appId}/runs/{runId}`. Supports `--dry-run`, `--app=<id>`, `--force`. Idempotent via deterministic doc IDs. |

### Files to modify

| File | Change |
|------|--------|
| `lib/db/types.ts` | Delete `JsonValue`, `TokenUsage`, `LogToolCall`, `MessageEvent`, `StepEvent`, `EmissionEvent`, `ConfigEvent`, `ErrorEvent`, `LogEvent`, `StoredEvent`, `storedEventSchema`, `jsonValue`, `tokenUsageSchema`, `logToolCallSchema`, `messageEventSchema`, `stepEventSchema`, `emissionEventSchema`, `configEventSchema`, `errorEventSchema`, `logEventSchema`. Add `runSummaryDocSchema` + `RunSummaryDoc`. |
| `lib/db/firestore.ts` | Replace `collections.logs` → `collections.events` (new converter). Add `collections.runs`, `docs.run`. Drop `docs.logEntry`. |
| `lib/db/usage.ts` | Add `UsageAccumulator` class (track + flush). Keep existing `getMonthlyUsage` / `incrementUsage`. |
| `lib/agent/generationContext.ts` | Replace `logger: EventLogger` with `writer: LogWriter` + `usage: UsageAccumulator`. Rewrite `emit` (lifecycle-only, no logging), `emitMutations` (SSE + per-mutation `MutationEvent`), `emitError` (SSE + one `ConversationEvent` + usage snapshot unchanged). Add `emitConversation(payload)` and `logUserMessage(text, attachments?)` helpers. Rewrite `runAgent`'s `onStepFinish` to emit one conversation event per step-output artifact (reasoning, text, each tool-call + result) and increment `usage`. |
| `lib/agent/solutionsArchitect.ts` | Remove the now-unused `wireFormSnapshot` / `fieldToWireQuestion` helpers (dead after Phase 3 migration; Phase 4 finishes the cleanup because they're only referenced by the `getForm` / `getQuestion` read tools that already render fresh). Trim `ctx.emit("data-blueprint-updated", ...)` — the only remaining caller is `data-done` which keeps its PersistableDoc payload. Update type imports for `GenerationContext`. |
| `lib/agent/validationLoop.ts` | Replace the `ctx.emit("data-phase", …)` + `ctx.emit("data-fix-attempt", …)` pair with the same shape (lifecycle-only, unchanged). Drop any `ctx.logger.*` references. |
| `lib/agent/errorClassifier.ts` | Remove `JsonValue` import if any; update `ClassifiedError` type if necessary for `ConversationPayload`. |
| `app/api/chat/route.ts` | Construct `LogWriter` + `UsageAccumulator` instead of `EventLogger`. Write a `user-message` ConversationEvent at the start of every request (replaces `logger.logConversation`). `req.signal.abort` calls `writer.flush()` + `usage.flush()`. Drop the `logConfig` call — the `ConfigEvent` is deleted; its equivalent (`prompt_mode`, `fresh_edit`, `app_ready`, `cache_expired`, `module_count`) is written onto the per-run summary doc by `UsageAccumulator.flush`. |
| `lib/generation/streamDispatcher.ts` | Delete the `LEGACY_REPLAY_DOC_MUTATION_EVENTS` set and its dispatcher branch. Update the module header + signal-grid table comment. |
| `lib/generation/__tests__/streamDispatcher.test.ts` | Drop every test case inside the `describe("data-schema")` / `describe("data-scaffold")` / `describe("data-module-done")` / `describe("data-form-done")` blocks (legacy). Keep signal-grid, `data-start-build`, `data-mutations`, `data-done`, `data-blueprint-updated`, `data-error`, `data-app-saved`, `data-phase`, `data-fix-attempt`, `data-partial-scaffold`, unknown-event tests. |
| `components/builder/BuilderProvider.tsx` | Rewrite `ReplayHydrator` to replay `Event[]` via `replayEvents` instead of `replay.stages[].emissions`. Remove the `applyStreamEvent` loop over stage emissions. |
| `components/builder/ReplayController.tsx` | Replay navigation now steps through chapters (from `deriveReplayChapters`). Clicking a chapter resets the builder and replays events from `events[0]` through `events[chapter.endIndex]`. |
| `app/build/replay/[id]/replay-builder.tsx` | Accept `Event[]` + derived chapters instead of `StoredEvent[]`. Replace `extractReplayStages` call with `deriveReplayChapters`. |
| `app/build/replay/[id]/page.tsx` | Call `readEvents`/`readLatestRunId` from `@/lib/log/reader`. |
| `app/api/apps/[id]/logs/route.ts` | Rename import path from `@/lib/db/logs` → `@/lib/log/reader`. Return `{ events: Event[], runId }`. |
| `app/api/admin/users/[id]/apps/[appId]/logs/route.ts` | Same as above. |
| `lib/session/types.ts` | Rework `ReplayStage` → `ReplayChapter { header: string; subtitle?: string; startIndex: number; endIndex: number }`. Update `ReplayData` / `ReplayInit` to carry `events: Event[]` + `chapters: ReplayChapter[]` + `cursor: number`. |
| `lib/session/store.ts` | Update `loadReplay` signature and field shapes to match the new session types. `setReplayMessages` becomes `setReplayCursor(index: number)`. Messages are derived on read (see next row). |
| `lib/session/hooks.tsx` | Add `useReplayMessages()` — derives `UIMessage[]` from `replay.events.slice(0, replay.cursor+1)` whenever the cursor advances. |
| `components/chat/ChatContainer.tsx` | Replace `const replayMessages = useBuilderSession((s) => s.replay?.messages ?? EMPTY_MESSAGES)` with `const replayMessages = useReplayMessages()`. |
| `scripts/lib/types.ts` | Drop `LogEvent`/`StoredEvent`/etc. exports. Export the new `Event` + `ConversationPayload` types. Add `RunSummaryDoc` export. |
| `scripts/lib/log-stats.ts` | Rewrite for the new shape. Cost analysis sources the per-run summary doc. Event-level analysis operates on `Event[]`. |
| `scripts/inspect-logs.ts` | Rewrite for the new shape. `--steps` becomes `--runs` (per-run summary table). `--timeline` analyzes `ts` gaps on `Event[]`. `--tools` counts `tool-call` conversation events. |
| `scripts/inspect-compare.ts` | Rewrite to compare run summaries + event counts. |
| `CLAUDE.md` | Update the "Builder state" section if needed (still accurate). Add a note under "Chat threads" referencing the separate event log at `apps/{appId}/events/`. |
| `lib/services/CLAUDE.md` | Remove the `eventLogger` / `logReplay` callout sentence (the services directory no longer owns them). |
| `lib/agent/CLAUDE.md` | Update the `generationContext.ts` description (now owns `LogWriter` + `UsageAccumulator`, not `EventLogger`). |

### Files to delete

| File | Reason |
|------|--------|
| `lib/log.ts` | Renamed to `lib/logger.ts` — same behavior, new path. |
| `lib/services/eventLogger.ts` | Replaced by `lib/log/writer.ts` + `UsageAccumulator`. |
| `lib/services/logReplay.ts` | Replaced by `lib/log/replay.ts` (`replayEvents` + `deriveReplayChapters`). |
| `lib/db/logs.ts` | Replaced by `lib/log/writer.ts` + `lib/log/reader.ts`. |
| `lib/generation/mutationMapper.ts` | Moved to `scripts/migrate/legacy-event-translator.ts` (not deleted — the translator powers the one-time migration). |
| `lib/generation/__tests__/mutationMapper.test.ts` | Moved to `scripts/migrate/__tests__/legacy-event-translator.test.ts`. |
| `lib/generation/__tests__/generationLifecycle.test.ts` (if present + uses legacy events) | Verify; prune legacy-only cases. |

---

## Task 1: Rename `lib/log.ts` → `lib/logger.ts`

Free up the `lib/log/` namespace for the event log directory by renaming the GCP structured logger. Mechanical move; no behavior change.

**Files:**
- Move: `lib/log.ts` → `lib/logger.ts`
- Modify: every file importing `@/lib/log` (14 callers)

Callers to update (verified via `rg 'from "@/lib/log"' --type ts`):

```
lib/db/apps.ts
lib/agent/solutionsArchitect.ts
lib/agent/generationContext.ts
app/api/compile/route.ts
app/api/chat/route.ts
app/api/commcare/upload/route.ts
app/api/apps/[id]/route.ts
lib/commcare/client.ts
app/settings/actions.ts
lib/db/threads.ts
lib/db/logs.ts
lib/apiError.ts
app/api/log/error/route.ts
lib/services/eventLogger.ts    (via "../log")
```

- [ ] **Step 1: Create `lib/logger.ts` with identical content**

Copy `lib/log.ts` verbatim to `lib/logger.ts`. No content edits.

```bash
git mv lib/log.ts lib/logger.ts
```

- [ ] **Step 2: Sweep imports**

In each caller, replace `from "@/lib/log"` with `from "@/lib/logger"`. The `lib/services/eventLogger.ts` relative import `from "../log"` becomes `from "../logger"`. Use a single ripgrep-driven sed pass or an editor-assisted refactor; every file changes exactly one line.

Expected: 14 files modified.

- [ ] **Step 3: Verify typecheck + lint + tests**

```bash
npx tsc --noEmit && echo "✓ tsc"
npm run lint
npm test -- --run
```

Expected: all green. 1191 tests passing.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(log): rename lib/log.ts → lib/logger.ts

Free up the lib/log/ namespace for the Phase 4 event log directory.
Mechanical import sweep — no behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Define `Event` types + Zod schemas at `lib/log/types.ts`

The new event log shape from spec §5. Two families, self-describing, validated at read time via Zod.

**Files:**
- Create: `lib/log/types.ts`
- Create: `lib/log/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/log/__tests__/types.test.ts`:

```typescript
/**
 * Tests for the event log type + schema. Covers Zod round-trip for every
 * event variant and payload shape — the Firestore read converter relies on
 * `eventSchema.parse()` to validate persisted data.
 */
import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import {
	type ConversationEvent,
	type Event,
	eventSchema,
	type MutationEvent,
} from "../types";

describe("eventSchema", () => {
	it("parses a mutation event round-trip", () => {
		const event: MutationEvent = {
			kind: "mutation",
			runId: "run-1",
			ts: 1_700_000_000_000,
			seq: 0,
			actor: "agent",
			stage: "scaffold",
			mutation: { kind: "setAppName", name: "App" },
		};
		const parsed = eventSchema.parse(event);
		expect(parsed).toEqual(event);
	});

	it("parses a mutation event without optional stage", () => {
		const event: MutationEvent = {
			kind: "mutation",
			runId: "run-1",
			ts: 1,
			seq: 1,
			actor: "user",
			mutation: {
				kind: "addField",
				parentUuid: asUuid("form-1"),
				field: {
					kind: "text",
					uuid: asUuid("fld-1"),
					id: "name",
					label: "Name",
				},
			},
		};
		const parsed = eventSchema.parse(event);
		expect(parsed).toEqual(event);
	});

	it("parses every conversation payload variant", () => {
		const samples: ConversationEvent[] = [
			{
				kind: "conversation",
				runId: "r",
				ts: 0,
				seq: 0,
				payload: { type: "user-message", text: "hi" },
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 1,
				seq: 1,
				payload: { type: "assistant-text", text: "hi back" },
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 2,
				seq: 2,
				payload: {
					type: "assistant-reasoning",
					text: "thinking …",
				},
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 3,
				seq: 3,
				payload: {
					type: "tool-call",
					toolCallId: "tc-1",
					toolName: "addModule",
					input: { name: "m1" },
				},
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 4,
				seq: 4,
				payload: {
					type: "tool-result",
					toolCallId: "tc-1",
					toolName: "addModule",
					output: "Success",
				},
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 5,
				seq: 5,
				payload: {
					type: "error",
					error: {
						type: "api_auth",
						message: "Unauthorized",
						fatal: false,
					},
				},
			},
		];
		for (const ev of samples) {
			expect(eventSchema.parse(ev)).toEqual(ev);
		}
	});

	it("rejects unknown event kinds", () => {
		const bad: Partial<Event> = {
			// @ts-expect-error — intentional invalid kind
			kind: "spooky",
			runId: "r",
			ts: 0,
			seq: 0,
		};
		expect(() => eventSchema.parse(bad)).toThrow();
	});

	it("rejects unknown conversation payload types", () => {
		const bad = {
			kind: "conversation" as const,
			runId: "r",
			ts: 0,
			seq: 0,
			payload: { type: "gossip", text: "…" },
		};
		expect(() => eventSchema.parse(bad)).toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --run lib/log/__tests__/types.test.ts
```

Expected: FAIL — module not found (`@/lib/log/types`).

- [ ] **Step 3: Implement `lib/log/types.ts`**

```typescript
/**
 * Event log types — one time-ordered stream, two event families.
 *
 * `MutationEvent` captures every doc state change (actor=user or agent).
 * `ConversationEvent` captures user messages, assistant output, tool calls,
 * tool results, and classified errors. The log is supplemental: blueprint
 * state lives on the `AppDoc.blueprint` snapshot. If the event log is lost
 * or corrupt, the app still loads — only replay and admin inspection are
 * affected.
 *
 * Schema authority: Zod schemas below are the source of truth. TS types
 * infer via `z.infer`. Firestore reads validate via `eventSchema.parse()`.
 *
 * Storage: one document per event at `apps/{appId}/events/{runId}_{seqPad}`,
 * where `seqPad = String(seq).padStart(6, "0")`. Sorting by document id
 * yields chronological order within a run.
 */
import { z } from "zod";
import { mutationSchema } from "@/lib/doc/types";

// ── Conversation payloads ──────────────────────────────────────────

/**
 * Attachment metadata for user messages. Today the builder doesn't ship
 * attachments; the shape exists so we can add file/image uploads later
 * without breaking the event log schema.
 */
export const conversationAttachmentSchema = z.object({
	name: z.string(),
	mimeType: z.string(),
	/** Firestore Storage URI or data URL, depending on pipeline. */
	uri: z.string(),
});
export type ConversationAttachment = z.infer<
	typeof conversationAttachmentSchema
>;

/**
 * Classified error payload — a small subset of `ClassifiedError` shared on
 * the log. We deliberately drop the raw stack trace: the log is not a
 * crash-report surface, and raw stacks can leak internal paths.
 */
export const classifiedErrorPayloadSchema = z.object({
	/** Classifier bucket: "api_auth" | "rate_limit" | "internal" | … */
	type: z.string(),
	/** User-safe message. */
	message: z.string(),
	/** True if the error halted generation; false if the auto-fixer recovered. */
	fatal: z.boolean(),
});
export type ClassifiedErrorPayload = z.infer<
	typeof classifiedErrorPayloadSchema
>;

/**
 * Conversation payload discriminated union. One per chat-visible moment.
 *
 * `tool-call` + `tool-result` are paired by `toolCallId`; the result event
 * follows the call event in `ts` order when the tool finishes. `toolName`
 * is duplicated onto the result so downstream consumers don't need to
 * rebuild the pairing map for simple tool-usage counts.
 */
export const conversationPayloadSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("user-message"),
		text: z.string(),
		attachments: z.array(conversationAttachmentSchema).optional(),
	}),
	z.object({
		type: z.literal("assistant-text"),
		text: z.string(),
	}),
	z.object({
		type: z.literal("assistant-reasoning"),
		text: z.string(),
	}),
	z.object({
		type: z.literal("tool-call"),
		toolCallId: z.string(),
		toolName: z.string(),
		/** Tool arguments — JSON-safe. Validated lazily downstream. */
		input: z.unknown(),
	}),
	z.object({
		type: z.literal("tool-result"),
		toolCallId: z.string(),
		toolName: z.string(),
		/** Tool return value — JSON-safe. `null` when the tool returned void. */
		output: z.unknown(),
	}),
	z.object({
		type: z.literal("error"),
		error: classifiedErrorPayloadSchema,
	}),
]);
export type ConversationPayload = z.infer<typeof conversationPayloadSchema>;

// ── Event envelope ────────────────────────────────────────────────

/**
 * Shared envelope fields. Every event carries `runId` (groups a generation
 * session), `ts` (millisecond timestamp for chronological sort), and `seq`
 * (per-run monotonic counter — the tie-breaker when multiple events share
 * `ts` under SSE bursts).
 */
const envelopeSchema = z.object({
	runId: z.string(),
	ts: z.number().int().nonnegative(),
	seq: z.number().int().nonnegative(),
});

/** An agent or user mutation against the doc. */
export const mutationEventSchema = envelopeSchema.extend({
	kind: z.literal("mutation"),
	actor: z.enum(["user", "agent"]),
	/** Optional semantic tag: "scaffold" | "module:0" | "form:0-1" | "fix" | … */
	stage: z.string().optional(),
	mutation: mutationSchema,
});
export type MutationEvent = z.infer<typeof mutationEventSchema>;

/** A conversation-visible artifact from the current run. */
export const conversationEventSchema = envelopeSchema.extend({
	kind: z.literal("conversation"),
	payload: conversationPayloadSchema,
});
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

/**
 * Discriminated union over both event families. The Firestore converter's
 * `fromFirestore` runs `eventSchema.parse(snapshot.data())`, so any shape
 * drift on disk surfaces as a parse error at read time (caught by the
 * reader and logged via `@/lib/logger`).
 */
export const eventSchema = z.discriminatedUnion("kind", [
	mutationEventSchema,
	conversationEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;

/**
 * Build a chronological-sort document ID from an event. Padding `seq` to
 * 6 digits keeps lexicographic ordering of document IDs aligned with the
 * intended chronological order — Firestore's default query sort is over
 * document IDs when no `orderBy` is specified.
 *
 * Shape: `{runId}_{seqPad}`. `ts` intentionally NOT in the ID — multiple
 * events in a single SSE burst share `ts` to the millisecond, and seq is
 * already globally unique within a run.
 */
export function eventDocId(event: Event): string {
	return `${event.runId}_${String(event.seq).padStart(6, "0")}`;
}
```

**Note:** `mutationSchema` must already exist in `@/lib/doc/types`. Phase 2 landed `Mutation` as a TS type; verify whether a Zod schema exists. If not, export one alongside the TS type — it's needed for the event schema. Defer to an explicit check in Step 4.

- [ ] **Step 4: Confirm `mutationSchema` exists**

```bash
rg "^export const mutationSchema" lib/doc/types.ts
```

If it's missing, add a minimal Zod schema that validates a `Mutation` discriminated union. The Mutation kinds live at `lib/doc/types.ts`; mirror them as a `z.discriminatedUnion("kind", [...])`. One schema per Mutation variant; the `field`, `module`, `form`, `patch` payloads use their respective `*Schema` from `@/lib/domain`.

If `mutationSchema` must be added, include it in the same commit as Task 2 and add a round-trip test for each variant in `lib/doc/__tests__/mutations.test.ts` (one `expect(mutationSchema.parse(m)).toEqual(m)` per kind).

- [ ] **Step 5: Run test to verify pass**

```bash
npm test -- --run lib/log/__tests__/types.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run wider suite**

```bash
npx tsc --noEmit && echo "✓ tsc"
npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add lib/log/ lib/doc/types.ts lib/doc/__tests__/
git commit -m "$(cat <<'EOF'
feat(log): define Event type + Zod schema

Adds lib/log/types.ts with MutationEvent + ConversationEvent
discriminated union and round-trip tests. Defines the chronological
event doc-ID builder used by writer + reader.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Firestore collection + per-run summary schema

Add the new `apps/{appId}/events/` converter and the `apps/{appId}/runs/` per-run summary doc. Delete the old `storedEventSchema` + `collections.logs` at the same time — they share a collision-free rewrite window.

**Files:**
- Modify: `lib/db/types.ts`
- Modify: `lib/db/firestore.ts`
- Create: `lib/db/runSummary.ts`
- Create: `lib/db/__tests__/runSummary.test.ts`

- [ ] **Step 1: Write the failing test for `runSummary`**

Create `lib/db/__tests__/runSummary.test.ts`:

```typescript
/**
 * Round-trips a RunSummaryDoc through the Zod schema. The Firestore write
 * path is fire-and-forget; we only validate shape here, not network.
 */
import { describe, expect, it } from "vitest";
import { runSummaryDocSchema } from "../types";

describe("runSummaryDocSchema", () => {
	const sample = {
		runId: "run-abc",
		startedAt: "2026-04-18T12:00:00.000Z",
		finishedAt: "2026-04-18T12:01:30.000Z",
		promptMode: "build" as const,
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
		stepCount: 7,
		model: "claude-opus-4-7",
		inputTokens: 1234,
		outputTokens: 567,
		cacheReadTokens: 891,
		cacheWriteTokens: 0,
		costEstimate: 0.0421,
		toolCallCount: 14,
	};

	it("parses a populated summary", () => {
		expect(runSummaryDocSchema.parse(sample)).toEqual(sample);
	});

	it("rejects missing required fields", () => {
		const { costEstimate: _c, ...partial } = sample;
		expect(() => runSummaryDocSchema.parse(partial)).toThrow();
	});
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- --run lib/db/__tests__/runSummary.test.ts
```

Expected: FAIL — `runSummaryDocSchema` not exported.

- [ ] **Step 3: Edit `lib/db/types.ts`**

Delete the entire "Log Events" block (lines 53–270-ish — `JsonValue`, `TokenUsage`, `LogToolCall`, every event variant, `logEventSchema`, `storedEventSchema`, `jsonValue`, `tokenUsageSchema`, `logToolCallSchema`, and all per-variant schemas). Also remove their exports from module level. Add:

```typescript
// ── Per-run summary ───────────────────────────────────────────────

/**
 * Per-run cost + behavior summary written once on request finalization.
 *
 * Stored at `apps/{appId}/runs/{runId}`. Admin tools (inspect-logs,
 * inspect-compare) source cost breakdowns here — the event log itself
 * intentionally does NOT carry token usage (spec §5: log is supplemental,
 * mutation + conversation only).
 *
 * All token counts are Anthropic-reported. `inputTokens` is the total
 * including `cacheReadTokens`; `cacheHitRate` is derived downstream
 * (`cacheReadTokens / inputTokens`).
 */
export const runSummaryDocSchema = z.object({
	runId: z.string(),
	/** ISO timestamp of first event written. */
	startedAt: z.string(),
	/** ISO timestamp of finalize. */
	finishedAt: z.string(),
	/** Which prompt the SA received. */
	promptMode: z.enum(["build", "edit"]),
	/** Fresh-edit mode (cache expired + editing). */
	freshEdit: z.boolean(),
	/** Client signal: app existed when request was sent. */
	appReady: z.boolean(),
	/** Client signal: Anthropic prompt cache TTL had lapsed. */
	cacheExpired: z.boolean(),
	/** Number of modules on the blueprint at request time (0 for new builds). */
	moduleCount: z.number().int().nonnegative(),
	/** Number of agent LLM steps in the run. */
	stepCount: z.number().int().nonnegative(),
	/** SA model id (e.g. "claude-opus-4-7"). */
	model: z.string(),
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheWriteTokens: z.number().int().nonnegative(),
	costEstimate: z.number().nonnegative(),
	toolCallCount: z.number().int().nonnegative(),
});
export type RunSummaryDoc = z.infer<typeof runSummaryDocSchema>;
```

Also remove the `StoredEvent`-shaped exports from the file header comment block.

- [ ] **Step 4: Edit `lib/db/firestore.ts`**

Replace `storedEventSchema` import with `eventSchema` from `@/lib/log/types` (not `@/lib/db/types`) and add `runSummaryDocSchema`:

```typescript
import { eventSchema, type Event } from "@/lib/log/types";
import {
	type AppDoc,
	appDocSchema,
	type RunSummaryDoc,
	runSummaryDocSchema,
	type ThreadDoc,
	threadDocSchema,
	type UsageDoc,
	type UserSettingsDoc,
	usageDocSchema,
	userSettingsDocSchema,
} from "./types";
```

Replace the `storedEventConverter` line with:

```typescript
const eventConverter = zodConverter(eventSchema);
const runSummaryConverter = zodConverter(runSummaryDocSchema);
```

Replace `collections.logs(appId)` with `collections.events(appId)`:

```typescript
/** Per-app event stream: `apps/{appId}/events/{eventId}` */
events: (appId: string): CollectionReference<Event> =>
	getDb()
		.collection("apps")
		.doc(appId)
		.collection("events")
		.withConverter(eventConverter),

/** Per-app per-run summaries: `apps/{appId}/runs/{runId}` */
runs: (appId: string): CollectionReference<RunSummaryDoc> =>
	getDb()
		.collection("apps")
		.doc(appId)
		.collection("runs")
		.withConverter(runSummaryConverter),
```

Drop `docs.logEntry`. Add:

```typescript
/** Direct reference: `apps/{appId}/runs/{runId}` */
run: (appId: string, runId: string): DocumentReference<RunSummaryDoc> =>
	collections.runs(appId).doc(runId),
```

Update the header comment's "Document hierarchy" block to replace `apps/{appId}/logs` with `apps/{appId}/events` and add `apps/{appId}/runs`.

- [ ] **Step 5: Create `lib/db/runSummary.ts`**

```typescript
/**
 * Per-run cost/behavior summary writer. One document per generation run
 * at `apps/{appId}/runs/{runId}`. Fire-and-forget; a Firestore outage
 * does not block request finalization.
 */
import { docs } from "./firestore";
import type { RunSummaryDoc } from "./types";
import { log } from "@/lib/logger";

/**
 * Write (or overwrite) a run summary document. Safe to call multiple
 * times — the same runId maps to the same doc ID. The last call wins.
 *
 * Used by `UsageAccumulator.flush` on request end. Admin inspection
 * scripts read from here for per-run cost analytics.
 */
export function writeRunSummary(
	appId: string,
	runId: string,
	summary: RunSummaryDoc,
): void {
	docs
		.run(appId, runId)
		.set(summary)
		.catch((err) =>
			log.error("[writeRunSummary] Firestore write failed", err, {
				appId,
				runId,
			}),
		);
}
```

- [ ] **Step 6: Run test — expect pass**

```bash
npm test -- --run lib/db/__tests__/runSummary.test.ts
npx tsc --noEmit
```

Expected: runSummary test PASS. `tsc` will still fail on removed exports — every call site referencing `StoredEvent`, `LogEvent`, `collections.logs`, etc. needs updating in the subsequent tasks. Note the errors; they are expected until Tasks 4–10 land.

- [ ] **Step 7: Commit**

```bash
git add lib/db/ lib/log/
git commit -m "$(cat <<'EOF'
feat(log): add events + runs Firestore collections

- Replace apps/{appId}/logs with apps/{appId}/events collection
- Add apps/{appId}/runs/{runId} per-run summary doc + schema
- Delete StoredEvent/LogEvent/etc. in lib/db/types.ts
- Add writeRunSummary fire-and-forget helper

tsc will fail until Tasks 4–10 rewrite callers; this commit lands
the schema+collection foundation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Build `lib/log/writer.ts`

Batched fire-and-forget writer. Events queue in memory; a timer flushes every ~100ms. `flush()` drains on demand. All errors log via `@/lib/logger` and never throw to callers — logging is never on the critical path.

**Files:**
- Create: `lib/log/writer.ts`
- Create: `lib/log/__tests__/writer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * Tests for the LogWriter batcher.
 *
 * We verify batching semantics and failure isolation WITHOUT touching a
 * real Firestore. The writer accepts an injectable "sink" function whose
 * real default is `docs.events(appId).doc(...).set(event)`. Tests pass a
 * capture function so we can assert exactly which events land with which
 * doc ids, in which batches, and at which times.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/domain";
import type { Event } from "../types";
import { LogWriter } from "../writer";

function makeEvent(seq: number, runId = "r"): Event {
	return {
		kind: "mutation",
		runId,
		ts: Date.now(),
		seq,
		actor: "agent",
		mutation: { kind: "setAppName", name: `app-${seq}` },
	};
}

describe("LogWriter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not write synchronously — buffers until the flush timer fires", () => {
		const sink = vi.fn();
		const writer = new LogWriter("app-1", { sink });

		writer.logEvent(makeEvent(0));
		expect(sink).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink).toHaveBeenCalledWith("app-1", [
			expect.objectContaining({ seq: 0 }),
		]);
	});

	it("coalesces bursts into a single batch", () => {
		const sink = vi.fn();
		const writer = new LogWriter("app-1", { sink });

		for (let i = 0; i < 5; i++) writer.logEvent(makeEvent(i));
		expect(sink).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(5);
	});

	it("flushes immediately when buffer exceeds MAX_BATCH", () => {
		const sink = vi.fn();
		const writer = new LogWriter("app-1", { sink, maxBatch: 3 });

		writer.logEvent(makeEvent(0));
		writer.logEvent(makeEvent(1));
		writer.logEvent(makeEvent(2));
		/* Threshold crossed during the third push — flush synchronously. */
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(3);
	});

	it("flush() drains the buffer immediately", async () => {
		const sink = vi.fn().mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", { sink });

		writer.logEvent(makeEvent(0));
		writer.logEvent(makeEvent(1));
		await writer.flush();

		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(2);
	});

	it("continues after a sink failure", async () => {
		const sink = vi
			.fn()
			.mockRejectedValueOnce(new Error("firestore down"))
			.mockResolvedValueOnce(undefined);
		const writer = new LogWriter("app-1", { sink });

		writer.logEvent(makeEvent(0));
		await writer.flush();
		writer.logEvent(makeEvent(1));
		await writer.flush();

		expect(sink).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- --run lib/log/__tests__/writer.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/log/writer.ts`**

```typescript
/**
 * Event log writer — batched fire-and-forget Firestore sink.
 *
 * A single `LogWriter` instance is created per HTTP request (chat route).
 * Callers invoke `logEvent(event)` for each mutation/conversation event
 * they want persisted; the writer buffers events, flushes every ~100ms
 * via a timer, and drains on demand via `flush()` (called on request
 * finalization + abort).
 *
 * Failures never throw — the writer is off the critical path. A Firestore
 * outage degrades observability but does NOT block generation or the
 * spend cap (usage tracking flushes via its own path).
 *
 * Doc IDs use `eventDocId(event)` = `{runId}_{seqPad}` so chronological
 * sort aligns with Firestore's default document-id ordering.
 */
import { collections } from "@/lib/db/firestore";
import { log } from "@/lib/logger";
import { type Event, eventDocId } from "./types";

/** Batch size beyond which the writer flushes synchronously. Matches the
 *  Firestore `WriteBatch` hard limit (500) with a safety margin. */
const DEFAULT_MAX_BATCH = 450;

/** Flush interval — coalesces SSE bursts into a single round-trip. */
const DEFAULT_FLUSH_MS = 100;

/** Firestore-facing sink. Tests inject a mock; production uses the default. */
export type EventSink = (
	appId: string,
	events: readonly Event[],
) => Promise<void>;

/** Production sink: one document per event, via WriteBatch for atomicity. */
const defaultSink: EventSink = async (appId, events) => {
	const db = collections.events(appId).firestore;
	const batch = db.batch();
	for (const ev of events) {
		batch.set(collections.events(appId).doc(eventDocId(ev)), ev);
	}
	await batch.commit();
};

export interface LogWriterOptions {
	sink?: EventSink;
	flushMs?: number;
	maxBatch?: number;
}

export class LogWriter {
	private buffer: Event[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly sink: EventSink;
	private readonly flushMs: number;
	private readonly maxBatch: number;

	constructor(
		private readonly appId: string,
		opts: LogWriterOptions = {},
	) {
		this.sink = opts.sink ?? defaultSink;
		this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
		this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
	}

	/**
	 * Enqueue an event for persistence. Never throws. When the buffer
	 * reaches `maxBatch`, flushes synchronously; otherwise arms a
	 * `flushMs` timer (idempotent — re-arming during an existing window
	 * is a no-op).
	 */
	logEvent(event: Event): void {
		this.buffer.push(event);
		if (this.buffer.length >= this.maxBatch) {
			void this.flush();
			return;
		}
		if (this.timer === null) {
			this.timer = setTimeout(() => {
				void this.flush();
			}, this.flushMs);
		}
	}

	/**
	 * Drain the buffer immediately. Returns the sink promise so callers
	 * that want to await the final write (e.g. request finalization) can.
	 * Errors from the sink are logged but not rethrown.
	 */
	async flush(): Promise<void> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.buffer.length === 0) return;
		const events = this.buffer;
		this.buffer = [];
		try {
			await this.sink(this.appId, events);
		} catch (err) {
			log.error("[LogWriter] batch flush failed", err, {
				appId: this.appId,
				count: String(events.length),
			});
		}
	}
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- --run lib/log/__tests__/writer.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/log/writer.ts lib/log/__tests__/writer.test.ts
git commit -m "$(cat <<'EOF'
feat(log): add LogWriter with ~100ms batching

Fire-and-forget Firestore sink that coalesces SSE bursts into a
single WriteBatch.commit(). flush() drains on request end. Sink
failures log but never throw — logging is off the critical path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Build `lib/log/reader.ts`

Sequential `readEvents` + `readLatestRunId`. Used by replay page, admin logs API, inspect scripts.

**Files:**
- Create: `lib/log/reader.ts`
- Create: `lib/log/__tests__/reader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * Tests for the event reader. We stub Firestore reads by monkey-patching
 * `collections.events` via vitest's `vi.mock` — the alternative (spinning
 * the emulator) is heavier than the reader logic warrants. Tests cover:
 *
 *   - ordering: events return sorted by (ts, seq)
 *   - empty result: returns []
 *   - runId filter: when omitted, reader resolves the most recent run
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../types";

const mockDocs: Event[] = [];
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockGet = vi.fn();

vi.mock("@/lib/db/firestore", () => ({
	collections: {
		events: vi.fn(() => ({
			where: mockWhere,
			orderBy: mockOrderBy,
		})),
	},
}));

// Simple chainable mock implementation
beforeEach(() => {
	mockDocs.length = 0;
	mockWhere.mockImplementation(() => ({ orderBy: mockOrderBy }));
	mockOrderBy.mockImplementation(() => ({
		orderBy: mockOrderBy,
		limit: vi.fn(() => ({ get: mockGet })),
		get: mockGet,
	}));
	mockGet.mockResolvedValue({
		empty: mockDocs.length === 0,
		docs: mockDocs.map((d) => ({ data: () => d })),
	});
});

describe("readEvents", () => {
	it("returns events sorted by ts then seq", async () => {
		const events: Event[] = [
			{
				kind: "mutation",
				runId: "r",
				ts: 10,
				seq: 0,
				actor: "agent",
				mutation: { kind: "setAppName", name: "a" },
			},
			{
				kind: "mutation",
				runId: "r",
				ts: 10,
				seq: 1,
				actor: "agent",
				mutation: { kind: "setAppName", name: "b" },
			},
			{
				kind: "mutation",
				runId: "r",
				ts: 11,
				seq: 2,
				actor: "agent",
				mutation: { kind: "setAppName", name: "c" },
			},
		];
		mockDocs.push(...events);
		mockGet.mockResolvedValue({
			empty: false,
			docs: events.map((d) => ({ data: () => d })),
		});

		const { readEvents } = await import("../reader");
		const result = await readEvents("app-1", "r");

		expect(result).toEqual(events);
		expect(mockOrderBy).toHaveBeenCalledWith("ts");
		expect(mockOrderBy).toHaveBeenCalledWith("seq");
	});

	it("returns [] on empty query", async () => {
		mockGet.mockResolvedValue({ empty: true, docs: [] });
		const { readEvents } = await import("../reader");
		expect(await readEvents("app-1", "r")).toEqual([]);
	});
});

describe("readLatestRunId", () => {
	it("returns the runId of the most recent event by ts", async () => {
		mockGet.mockResolvedValue({
			empty: false,
			docs: [
				{
					data: () => ({
						kind: "mutation",
						runId: "latest",
						ts: 999,
						seq: 0,
						actor: "agent",
						mutation: { kind: "setAppName", name: "x" },
					}),
				},
			],
		});
		const { readLatestRunId } = await import("../reader");
		expect(await readLatestRunId("app-1")).toBe("latest");
	});

	it("returns null when no events exist", async () => {
		mockGet.mockResolvedValue({ empty: true, docs: [] });
		const { readLatestRunId } = await import("../reader");
		expect(await readLatestRunId("app-1")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- --run lib/log/__tests__/reader.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/log/reader.ts`**

```typescript
/**
 * Event log reader.
 *
 * Three capabilities:
 *   - `readEvents(appId, runId)` — every event for one run, sorted
 *     chronologically by (ts, seq).
 *   - `readLatestRunId(appId)` — the runId of the single most recent
 *     event (by ts). Used when replay / admin tooling needs the "most
 *     recent run" without the user specifying it.
 *   - `readRunSummary(appId, runId)` — the per-run cost/behavior summary
 *     written by `UsageAccumulator.flush`.
 *
 * All reads hit Firestore directly; no caching. Callers either live in
 * admin/replay surfaces (one-time loads) or diagnostic scripts (manual
 * invocation), so cache complexity isn't justified.
 */
import { collections, docs } from "@/lib/db/firestore";
import type { RunSummaryDoc } from "@/lib/db/types";
import type { Event } from "./types";

/**
 * Load every event for a specific generation run, sorted by `ts` then
 * `seq`. The Firestore converter validates each doc via `eventSchema`;
 * malformed entries surface as a parse error at this boundary.
 */
export async function readEvents(
	appId: string,
	runId: string,
): Promise<Event[]> {
	const snap = await collections
		.events(appId)
		.where("runId", "==", runId)
		.orderBy("ts")
		.orderBy("seq")
		.get();
	return snap.docs.map((doc) => doc.data());
}

/**
 * Resolve the most recent runId for an app. Returns `null` when no events
 * exist.
 *
 * Ordering is on `ts` (globally monotonic across runs) rather than `seq`
 * (per-run; resets to 0 per new run). A single top-1 query replaces the
 * full-collection scan.
 */
export async function readLatestRunId(appId: string): Promise<string | null> {
	const snap = await collections
		.events(appId)
		.orderBy("ts", "desc")
		.limit(1)
		.get();
	if (snap.empty) return null;
	return snap.docs[0].data().runId;
}

/** Load the per-run summary doc. Returns `null` if none was written. */
export async function readRunSummary(
	appId: string,
	runId: string,
): Promise<RunSummaryDoc | null> {
	const snap = await docs.run(appId, runId).get();
	return snap.exists ? (snap.data() ?? null) : null;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- --run lib/log/__tests__/reader.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/log/reader.ts lib/log/__tests__/reader.test.ts
git commit -m "$(cat <<'EOF'
feat(log): add event log reader

- readEvents(appId, runId): ordered by (ts, seq)
- readLatestRunId(appId): top-1 query for most recent run
- readRunSummary(appId, runId): per-run cost summary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Build `lib/log/replay.ts`

Two exports: `replayEvents` (the ~30-line dispatch loop from spec §5) and `deriveReplayChapters` (metadata extraction for the ReplayController's chapter navigation).

**Files:**
- Create: `lib/log/replay.ts`
- Create: `lib/log/__tests__/replay.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import type { Event, MutationEvent, ConversationEvent } from "../types";
import { deriveReplayChapters, replayEvents } from "../replay";

function mut(seq: number, stage?: string): MutationEvent {
	return {
		kind: "mutation",
		runId: "r",
		ts: seq,
		seq,
		actor: "agent",
		...(stage && { stage }),
		mutation: { kind: "setAppName", name: `v${seq}` },
	};
}

function conv(
	seq: number,
	payload: ConversationEvent["payload"],
): ConversationEvent {
	return { kind: "conversation", runId: "r", ts: seq, seq, payload };
}

describe("replayEvents", () => {
	it("dispatches mutation + conversation events in order", async () => {
		const onMutation = vi.fn();
		const onConversation = vi.fn();
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			mut(1, "scaffold"),
			conv(2, { type: "assistant-text", text: "done" }),
		];
		await replayEvents(events, onMutation, onConversation, 0);
		expect(onMutation).toHaveBeenCalledTimes(1);
		expect(onConversation).toHaveBeenCalledTimes(2);
		expect(onMutation.mock.calls[0][0]).toEqual(events[1].mutation);
	});

	it("short-circuits when signal is aborted", async () => {
		const onMutation = vi.fn();
		const onConversation = vi.fn();
		const controller = new AbortController();
		controller.abort();
		await replayEvents([mut(0)], onMutation, onConversation, 0, controller.signal);
		expect(onMutation).not.toHaveBeenCalled();
	});
});

describe("deriveReplayChapters", () => {
	it("groups mutation events by stage tag", () => {
		const events: Event[] = [
			mut(0, "schema"),
			mut(1, "schema"),
			mut(2, "scaffold"),
			mut(3, "module:0"),
			mut(4, "module:0"),
			mut(5, "form:0-0"),
		];
		const chapters = deriveReplayChapters(events);
		expect(chapters.map((c) => c.header)).toEqual([
			"Data Model",
			"Scaffold",
			"Module",
			"Form",
		]);
		expect(chapters.map((c) => [c.startIndex, c.endIndex])).toEqual([
			[0, 1],
			[2, 2],
			[3, 4],
			[5, 5],
		]);
	});

	it("creates a leading Conversation chapter for pre-mutation chat", () => {
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			conv(1, { type: "assistant-text", text: "sure" }),
			mut(2, "scaffold"),
		];
		const chapters = deriveReplayChapters(events);
		expect(chapters[0].header).toBe("Conversation");
		expect(chapters[0].endIndex).toBe(1);
		expect(chapters[1].header).toBe("Scaffold");
	});

	it("adds a synthetic Done chapter at the end", () => {
		const events: Event[] = [mut(0, "scaffold")];
		const chapters = deriveReplayChapters(events);
		expect(chapters[chapters.length - 1].header).toBe("Done");
	});
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- --run lib/log/__tests__/replay.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/log/replay.ts`**

```typescript
/**
 * Event log replay.
 *
 * `replayEvents` is the ~30-line dispatcher from spec §5: walk events in
 * order, call the appropriate callback, sleep between events for visual
 * pacing, and short-circuit on an abort signal.
 *
 * `deriveReplayChapters` is the chapter-metadata helper the ReplayController
 * uses to render its chapter navigation. Chapters are derived from:
 *   - a leading "Conversation" chapter (if events begin with chat-only
 *     events before any mutations)
 *   - one chapter per contiguous run of mutation events sharing the same
 *     `stage` tag (header/subtitle derived from the tag)
 *   - a synthetic "Done" chapter at the end
 *
 * The chapter start/end indices reference `events[]` directly; clicking a
 * chapter replays events[0..endIndex].
 */
import type {
	ConversationPayload,
	Event,
	MutationEvent,
} from "./types";
import type { Mutation } from "@/lib/doc/types";

/** Sleep helper — fraction of a ms ok for fast tests. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk a log in chronological order, dispatching each event to the
 * appropriate callback. `delayPerEvent` controls visual pacing during
 * live replay; tests pass 0.
 *
 * `signal` (e.g. from an abort controller in the ReplayController) halts
 * the loop mid-iteration.
 */
export async function replayEvents(
	events: readonly Event[],
	onMutation: (m: Mutation) => void,
	onConversation: (p: ConversationPayload) => void,
	delayPerEvent = 150,
	signal?: AbortSignal,
): Promise<void> {
	for (const e of events) {
		if (signal?.aborted) return;
		if (e.kind === "mutation") onMutation(e.mutation);
		else onConversation(e.payload);
		if (delayPerEvent > 0) await sleep(delayPerEvent);
	}
}

// ── Chapter derivation ──────────────────────────────────────────────

/**
 * Chapter metadata for the ReplayController's transport UI.
 *
 * `startIndex` / `endIndex` bracket a span of `events[]`. Clicking the
 * chapter replays from `events[0]` through `events[endIndex]` — chapters
 * are cumulative scrub points, not independent segments.
 */
export interface ReplayChapter {
	header: string;
	subtitle?: string;
	startIndex: number;
	endIndex: number;
}

/** Map a `stage` tag on a MutationEvent to a chapter header. */
function headerForStage(stage: string | undefined): string {
	if (!stage) return "Update";
	if (stage === "schema") return "Data Model";
	if (stage === "scaffold") return "Scaffold";
	if (stage.startsWith("module:")) return "Module";
	if (stage.startsWith("form:")) return "Form";
	if (stage.startsWith("fix")) return "Validation Fix";
	if (stage.startsWith("rename")) return "Edit";
	if (stage.startsWith("edit")) return "Edit";
	return "Update";
}

/** Map a `stage` tag onto a display subtitle (indexed references surface here). */
function subtitleForStage(stage: string | undefined): string | undefined {
	if (!stage) return undefined;
	if (stage.startsWith("module:") || stage.startsWith("form:"))
		return stage;
	return undefined;
}

export function deriveReplayChapters(events: readonly Event[]): ReplayChapter[] {
	const chapters: ReplayChapter[] = [];

	let cursor = 0;

	/* Leading "Conversation" chapter — the span of events before the first
	 * mutation, if any. Represents the initial chat exchange (user
	 * message + assistant preamble) before the SA starts building. */
	let firstMutationIdx = events.findIndex((e) => e.kind === "mutation");
	if (firstMutationIdx === -1) firstMutationIdx = events.length;
	if (firstMutationIdx > 0) {
		chapters.push({
			header: "Conversation",
			startIndex: 0,
			endIndex: firstMutationIdx - 1,
		});
		cursor = firstMutationIdx;
	}

	/* Now walk mutation events, grouping contiguous runs with the same
	 * `stage` tag. Intervening conversation events are absorbed into the
	 * current chapter — they ride alongside the mutations that produced
	 * them. A chapter ends when the `stage` tag changes. */
	while (cursor < events.length) {
		const e = events[cursor];
		if (e.kind !== "mutation") {
			cursor++;
			continue;
		}
		const stage = e.stage;
		const start = cursor;
		let end = cursor;
		while (end + 1 < events.length) {
			const next = events[end + 1];
			if (next.kind === "mutation" && next.stage !== stage) break;
			end++;
		}
		chapters.push({
			header: headerForStage(stage),
			...(subtitleForStage(stage) && {
				subtitle: subtitleForStage(stage) as string,
			}),
			startIndex: start,
			endIndex: end,
		});
		cursor = end + 1;
	}

	/* Synthetic trailing "Done" chapter so the ReplayController has a
	 * terminal scrub target. Re-uses the final event's index so
	 * replaying to the Done chapter still dispatches every event. */
	const lastIdx = events.length - 1;
	if (lastIdx >= 0) {
		chapters.push({
			header: "Done",
			startIndex: lastIdx,
			endIndex: lastIdx,
		});
	}

	return chapters;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- --run lib/log/__tests__/replay.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/log/replay.ts lib/log/__tests__/replay.test.ts
git commit -m "$(cat <<'EOF'
feat(log): add replayEvents + deriveReplayChapters

- replayEvents: ~30 lines, dispatches mutation/conversation callbacks
  with per-event pacing and abort-signal support (spec §5)
- deriveReplayChapters: groups contiguous stage-tagged mutation runs
  into scrub targets for the ReplayController transport UI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add `UsageAccumulator` + per-run summary plumbing

Extract the cost-tracking logic from `EventLogger` into a standalone class. The accumulator lives in `lib/db/usage.ts` (colocated with `incrementUsage`) so both are part of the same Firestore-write layer.

**Files:**
- Modify: `lib/db/usage.ts`
- Create: `lib/db/__tests__/usage-accumulator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * UsageAccumulator — in-memory per-request token + cost totals. flush()
 * writes the monthly increment and the per-run summary doc.
 */
import { describe, expect, it, vi } from "vitest";

const incrementUsageMock = vi.fn();
const writeRunSummaryMock = vi.fn();

vi.mock("../usage", async () => {
	const actual = await vi.importActual("../usage");
	return {
		...actual,
		incrementUsage: incrementUsageMock,
	};
});

vi.mock("../runSummary", () => ({
	writeRunSummary: writeRunSummaryMock,
}));

import { UsageAccumulator } from "../usage";

describe("UsageAccumulator", () => {
	it("tracks cumulative tokens + cost across track() calls", () => {
		const acc = new UsageAccumulator({
			appId: "app-1",
			userId: "user-1",
			runId: "run-1",
			model: "claude-opus-4-7",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
		});
		acc.track({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 20,
			cacheWriteTokens: 0,
		});
		acc.track({
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 40,
			cacheWriteTokens: 10,
		});

		const snap = acc.snapshot();
		expect(snap.inputTokens).toBe(300);
		expect(snap.outputTokens).toBe(150);
		expect(snap.cacheReadTokens).toBe(60);
		expect(snap.cacheWriteTokens).toBe(10);
		expect(snap.costEstimate).toBeGreaterThan(0);
	});

	it("stepCount increments on track(...,{step:true}) calls only", () => {
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "claude-opus-4-7",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
		});
		acc.track({ inputTokens: 10, outputTokens: 5 }, { step: true });
		acc.track({ inputTokens: 5, outputTokens: 2 }); // sub-gen; no step
		acc.track({ inputTokens: 10, outputTokens: 5 }, { step: true });
		expect(acc.snapshot().stepCount).toBe(2);
	});

	it("flush() is idempotent", async () => {
		incrementUsageMock.mockResolvedValue(undefined);
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "claude-opus-4-7",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
			startedAt: "2026-04-18T12:00:00.000Z",
		});
		acc.track({ inputTokens: 1, outputTokens: 1 }, { step: true });
		await acc.flush();
		await acc.flush();
		expect(incrementUsageMock).toHaveBeenCalledTimes(1);
		expect(writeRunSummaryMock).toHaveBeenCalledTimes(1);
	});

	it("flush() with zero cost skips the monthly increment", async () => {
		incrementUsageMock.mockReset();
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "claude-opus-4-7",
			promptMode: "edit",
			freshEdit: true,
			appReady: true,
			cacheExpired: true,
			moduleCount: 5,
		});
		await acc.flush();
		expect(incrementUsageMock).not.toHaveBeenCalled();
		// Run summary still written so the inspect tools see the run at all
		expect(writeRunSummaryMock).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- --run lib/db/__tests__/usage-accumulator.test.ts
```

Expected: FAIL — `UsageAccumulator` not exported.

- [ ] **Step 3: Implement `UsageAccumulator` in `lib/db/usage.ts`**

Append to the existing `lib/db/usage.ts`:

```typescript
import { log } from "@/lib/logger";
import { DEFAULT_PRICING, MODEL_PRICING } from "@/lib/models";
import { writeRunSummary } from "./runSummary";
import type { RunSummaryDoc } from "./types";

/** Estimate USD cost from token counts using MODEL_PRICING. */
export function estimateCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
): number {
	const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
	const uncachedInput = inputTokens - cacheReadTokens - cacheWriteTokens;
	return (
		(uncachedInput * pricing.input +
			cacheReadTokens * pricing.cacheRead +
			cacheWriteTokens * pricing.cacheWrite +
			outputTokens * pricing.output) /
		1_000_000
	);
}

/** Per-LLM-call token usage accepted by the accumulator. */
export interface LLMCallUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/** Seed metadata captured at request start. */
export interface AccumulatorSeed {
	appId: string;
	userId: string;
	runId: string;
	model: string;
	promptMode: "build" | "edit";
	freshEdit: boolean;
	appReady: boolean;
	cacheExpired: boolean;
	moduleCount: number;
	/** ISO timestamp. Defaults to "now" at construction. */
	startedAt?: string;
}

/**
 * Accumulates per-request LLM usage for two write targets:
 *
 * 1. **Monthly spend cap** — `incrementUsage(userId, …)` at request end.
 *    This path is fail-closed via the pre-request `getMonthlyUsage` read
 *    (see route handler); an error here logs but does not re-throw.
 * 2. **Per-run summary doc** — `writeRunSummary(appId, runId, …)` with
 *    full token + cost breakdown for admin inspect tools. The event log
 *    itself does NOT carry token usage (spec §5), so this is the only
 *    persistence surface for per-run cost observability.
 *
 * `track({…}, {step: true})` marks an outer agent step (vs. a sub-gen
 * inside a tool). `stepCount` goes onto the run summary for admin use.
 * Sub-gen usage still accumulates into the totals — just not step count.
 *
 * `flush()` is idempotent via a `_finalized` guard so the route can call
 * it from multiple places (finally block, onFinish, abort handler)
 * without double-writing.
 */
export class UsageAccumulator {
	private readonly seed: AccumulatorSeed;
	private readonly startedAt: string;
	private inputTokens = 0;
	private outputTokens = 0;
	private cacheReadTokens = 0;
	private cacheWriteTokens = 0;
	private stepCount = 0;
	private toolCallCount = 0;
	private _finalized = false;

	constructor(seed: AccumulatorSeed) {
		this.seed = seed;
		this.startedAt = seed.startedAt ?? new Date().toISOString();
	}

	/** Record one LLM call's usage. `step: true` counts it as an outer
	 *  agent step; sub-gen calls omit the option. */
	track(usage: LLMCallUsage, opts: { step?: boolean } = {}): void {
		this.inputTokens += usage.inputTokens;
		this.outputTokens += usage.outputTokens;
		this.cacheReadTokens += usage.cacheReadTokens ?? 0;
		this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		if (opts.step) this.stepCount++;
	}

	/** Record a tool call — feeds the `toolCallCount` run-summary field. */
	noteToolCall(): void {
		this.toolCallCount++;
	}

	/** Current snapshot — used by the run summary writer + tests. */
	snapshot(): Omit<RunSummaryDoc, "finishedAt"> {
		return {
			runId: this.seed.runId,
			startedAt: this.startedAt,
			promptMode: this.seed.promptMode,
			freshEdit: this.seed.freshEdit,
			appReady: this.seed.appReady,
			cacheExpired: this.seed.cacheExpired,
			moduleCount: this.seed.moduleCount,
			stepCount: this.stepCount,
			model: this.seed.model,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cacheReadTokens: this.cacheReadTokens,
			cacheWriteTokens: this.cacheWriteTokens,
			costEstimate: estimateCost(
				this.seed.model,
				this.inputTokens,
				this.outputTokens,
				this.cacheReadTokens,
				this.cacheWriteTokens,
			),
			toolCallCount: this.toolCallCount,
		};
	}

	/**
	 * Flush both write targets. Idempotent. Safe to call from the execute
	 * finally block, onFinish, AND the abort handler — the first call does
	 * the work; subsequent calls no-op.
	 */
	async flush(): Promise<void> {
		if (this._finalized) return;
		this._finalized = true;

		const snap = this.snapshot();
		const summary: RunSummaryDoc = {
			...snap,
			finishedAt: new Date().toISOString(),
		};

		/* Run summary — always written, even on zero-cost edit replays, so
		 * inspect tools have a row to display. */
		writeRunSummary(this.seed.appId, this.seed.runId, summary);

		/* Monthly usage — skip writes that would increment nothing. */
		if (summary.costEstimate > 0) {
			try {
				await incrementUsage(this.seed.userId, {
					input_tokens: summary.inputTokens,
					output_tokens: summary.outputTokens,
					cost_estimate: summary.costEstimate,
				});
			} catch (err) {
				log.error("[UsageAccumulator] monthly increment failed", err, {
					userId: this.seed.userId,
				});
			}
		}
	}
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- --run lib/db/__tests__/usage-accumulator.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/db/usage.ts lib/db/__tests__/usage-accumulator.test.ts
git commit -m "$(cat <<'EOF'
feat(usage): extract UsageAccumulator from EventLogger

Per-request token + cost totals with two write targets:
- monthly spend cap via incrementUsage (fail-closed)
- per-run summary doc at apps/{appId}/runs/{runId}

Replaces the cost-tracking half of EventLogger (Phase 4 removes the
class entirely). Run summary doc preserves admin inspect-tool
observability that the event log intentionally drops (spec §5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rewrite `GenerationContext` to use `LogWriter` + `UsageAccumulator`

The context is the fan-in for all agent-side emission + usage tracking. Phase 4 swaps its dependencies from `EventLogger` to the new pair. Every doc-mutating SSE emission also writes one `MutationEvent` per mutation to the log. Every agent step writes conversation events (reasoning/text/tool-call/tool-result) via `emitConversation`. Errors write one `ConversationEvent` with the `error` payload.

**Files:**
- Modify: `lib/agent/generationContext.ts`
- Modify: `lib/agent/__tests__/generationContext-emitMutations.test.ts`

- [ ] **Step 1: Update `generationContext-emitMutations.test.ts`**

Replace the `EventLogger` mock with writer + accumulator mocks. Assertions become:

```typescript
it("writes one MutationEvent per mutation via the LogWriter", () => {
	const logEventSpy = vi.fn();
	const writer = { logEvent: logEventSpy, flush: vi.fn() } as any;
	const usage = new UsageAccumulator({
		appId: "a",
		userId: "u",
		runId: "r-1",
		model: "claude-opus-4-7",
		promptMode: "build",
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
	});
	const ctx = new GenerationContext({
		apiKey: "k",
		writer: writer,
		usage,
		writerLog: writer,  // alias for clarity; see impl below
		session: makeSession(),
		appId: "a",
		// Injected writer/stream shims as before
		streamWriter: streamWriter,
	});
	ctx.emitMutations([TEXT_FIELD_MUTATION], "form:0-0");
	expect(logEventSpy).toHaveBeenCalledTimes(1);
	expect(logEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "mutation",
			runId: "r-1",
			stage: "form:0-0",
			actor: "agent",
			mutation: TEXT_FIELD_MUTATION,
		}),
	);
});
```

Full rewrite of the test file should cover:
- `emitMutations([m1, m2])` writes 2 MutationEvents with monotonic `seq`
- `emitMutations([], "stage")` no-ops (no SSE write, no log write)
- `emitMutations([m])` without `stage` writes an event without `stage`
- `emitConversation({type: "user-message", text: "hi"})` writes a ConversationEvent
- `emit("data-phase", {...})` writes SSE only, no log event
- `emitError(err)` writes one conversation error event
- Every log event carries the constructor-seeded `runId`

Reference the existing test's import paths + setup shape; swap `EventLogger` for `writer + usage`.

- [ ] **Step 2: Run failing tests**

```bash
npm test -- --run lib/agent/__tests__/generationContext-emitMutations.test.ts
```

Expected: FAIL on `TypeError: writer is not a function` / shape mismatches.

- [ ] **Step 3: Rewrite `generationContext.ts`**

Replace the imports:

```typescript
import { updateApp } from "@/lib/db/apps";
import { UsageAccumulator } from "@/lib/db/usage";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import type { LogWriter } from "@/lib/log/writer";
import type {
	ClassifiedErrorPayload,
	ConversationPayload,
	Event,
	MutationEvent,
} from "@/lib/log/types";
import { MODEL_DEFAULT, type ReasoningEffort } from "@/lib/models";
import { type ClassifiedError, classifyError } from "./errorClassifier";
```

Replace the `EventLogger`-related fields + constructor options:

```typescript
export interface GenerationContextOptions {
	apiKey: string;
	writer: UIMessageStreamWriter;       // SSE writer (unchanged)
	logWriter: LogWriter;                // NEW — event log
	usage: UsageAccumulator;             // NEW — cost tracking
	session: Session;
	appId?: string;
}
```

Replace the constructor body:

```typescript
constructor(opts: GenerationContextOptions) {
	this.anthropic = createAnthropic({ apiKey: opts.apiKey });
	this.writer = opts.writer;
	this.logWriter = opts.logWriter;
	this.usage = opts.usage;
	this.session = opts.session;
	this.appId = opts.appId;
}
```

Add a monotonic sequence counter + helper:

```typescript
/** Per-request monotonic counter. Each event gets a unique `seq` even
 *  when multiple events land within the same millisecond. */
private seq = 0;

/** Build and queue a mutation event from a single `Mutation`. */
private queueMutation(mutation: Mutation, stage?: string): void {
	const event: MutationEvent = {
		kind: "mutation",
		runId: this.usage.runId,
		ts: Date.now(),
		seq: this.seq++,
		actor: "agent",
		...(stage && { stage }),
		mutation,
	};
	this.logWriter.logEvent(event);
}

/** Build and queue a conversation event. */
emitConversation(payload: ConversationPayload): void {
	this.logWriter.logEvent({
		kind: "conversation",
		runId: this.usage.runId,
		ts: Date.now(),
		seq: this.seq++,
		payload,
	});
}
```

Update `emit` — SSE only, no logging:

```typescript
emit(type: `data-${string}`, data: unknown): void {
	this.writer.write({ type, data, transient: true });
	/* Save the blueprint snapshot when a mutation-bearing SSE event fires.
	 * Phase 4 drops the legacy wire-format emissions, so the trigger set
	 * collapses to one: `data-mutations`. Kept as a set for future
	 * readability. */
	if (type === "data-mutations") this.saveBlueprint();
}
```

Update `emitMutations`:

```typescript
emitMutations(mutations: Mutation[], stage?: string): void {
	if (mutations.length === 0) return;
	/* SSE — unchanged wire format for the live client. */
	this.emit("data-mutations", {
		mutations,
		...(stage !== undefined && { stage }),
	});
	/* Event log — one MutationEvent per mutation. */
	for (const m of mutations) this.queueMutation(m, stage);
}
```

Update `emitError`:

```typescript
emitError(error: ClassifiedError, context?: string): void {
	const payload: ClassifiedErrorPayload = {
		type: error.type,
		message: error.message,
		fatal: !error.recoverable,
	};
	/* Event log carries the classified error payload; context goes to
	 * server-side structured logger (GCP). */
	this.emitConversation({ type: "error", error: payload });
	try {
		this.emit("data-error", {
			message: error.message,
			type: error.type,
			fatal: !error.recoverable,
		});
	} catch {
		log.error(
			"[emitError] failed to emit — error is in event log",
			undefined,
			{ errorMessage: error.message, context: context ?? "" },
		);
	}
}
```

Rewrite `runAgent` — drop `logStep`/`logSubResult`; emit conversation events per artifact, track usage per step:

```typescript
async runAgent<CO, T extends ToolSet>(
	agent: ToolLoopAgent<CO, T>,
	opts: { prompt: string; label: string; agentName: string; model?: string },
): Promise<void> {
	const model = opts.model ?? MODEL_DEFAULT;

	const result = await agent.stream({
		prompt: opts.prompt,
		onStepFinish: ({ usage, text, reasoningText, toolCalls, toolResults, warnings }) => {
			logWarnings(`runAgent:${opts.label}`, warnings);
			if (!usage) return;

			/* Usage — counts as an outer agent step. */
			this.usage.track(
				{
					inputTokens: usage.inputTokens ?? 0,
					outputTokens: usage.outputTokens ?? 0,
					cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
					cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
				},
				{ step: true },
			);

			/* Conversation events — one per artifact produced by this step.
			 * Reasoning first (what it thought), then text (what it said),
			 * then tool-call + tool-result pairs keyed by toolCallId. */
			if (reasoningText) {
				this.emitConversation({
					type: "assistant-reasoning",
					text: reasoningText,
				});
			}
			if (text) {
				this.emitConversation({ type: "assistant-text", text });
			}
			const resultByCallId = new Map<string, unknown>();
			for (const tr of (toolResults ?? []) as Array<{
				toolCallId: string;
				output: unknown;
			}>) {
				resultByCallId.set(tr.toolCallId, tr.output);
			}
			for (const tc of toolCalls ?? []) {
				this.usage.noteToolCall();
				this.emitConversation({
					type: "tool-call",
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					input: tc.input,
				});
				const out = resultByCallId.get(tc.toolCallId);
				if (out !== undefined) {
					this.emitConversation({
						type: "tool-result",
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						output: out,
					});
				}
			}
		},
	});

	const reader = result.toUIMessageStream().getReader();
	while (!(await reader.read()).done) {}
}
```

Update `generate` / `generatePlainText` / `streamGenerate` to use `this.usage.track(...)` instead of `logger.logSubResult`.

- [ ] **Step 4: Update the other GenerationContext test (solutionsArchitect-emitMutations)**

Same shape update — replace `EventLogger` with `writer + usage`.

- [ ] **Step 5: Run tests**

```bash
npm test -- --run lib/agent/__tests__/
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/
git commit -m "$(cat <<'EOF'
refactor(agent): GenerationContext → LogWriter + UsageAccumulator

- Replace EventLogger dependency with LogWriter + UsageAccumulator
- emitMutations writes one MutationEvent per mutation (Phase 4 log)
- emitConversation + emitError write ConversationEvents
- runAgent.onStepFinish emits reasoning/text/tool-call/tool-result
  conversation events and tracks usage (step + tool-call counts)
- emit() is lifecycle-only; no log writes for data-phase/fix-attempt/etc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update chat route — construct writer + accumulator, emit user-message events

**Files:**
- Modify: `app/api/chat/route.ts`

- [ ] **Step 1: Rewrite the relevant block**

Replace the `EventLogger` construction with:

```typescript
import { LogWriter } from "@/lib/log/writer";
import { UsageAccumulator } from "@/lib/db/usage";
import { SA_MODEL } from "@/lib/models";
```

Replace:

```typescript
const logger = new EventLogger(runId);
// ...
if (appId) {
	logger.enableFirestore(appId, keyResult.session.user.id);
}
req.signal.addEventListener("abort", () => {
	void logger.finalize();
});
logger.logConversation(messages);
```

With:

```typescript
/* The event log requires an appId — if appId is still null here (shouldn't
 * happen: createApp above throws on failure), we skip logging. In practice
 * appId is always set by this point. */
const effectiveRunId = runId ?? crypto.randomUUID();
const logWriter = appId
	? new LogWriter(appId)
	: null;

/* Usage accumulator — flushed on request end or abort. */
const usage = appId
	? new UsageAccumulator({
			appId,
			userId: keyResult.session.user.id,
			runId: effectiveRunId,
			model: SA_MODEL,
			promptMode: /* set inside execute once we know editing */ "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
		})
	: null;

req.signal.addEventListener("abort", () => {
	void usage?.flush();
	void logWriter?.flush();
});

/* User-message conversation event — the most recent user message. */
if (logWriter && messages.length > 0) {
	const last = messages[messages.length - 1];
	if (last.role === "user") {
		const text = last.parts
			.filter((p: { type: string }) => p.type === "text")
			.map((p: { type: string; text?: string }) => p.text ?? "")
			.join("\n");
		logWriter.logEvent({
			kind: "conversation",
			runId: effectiveRunId,
			ts: Date.now(),
			seq: 0,
			payload: { type: "user-message", text },
		});
	}
}
```

Inside `execute`, after computing `editing` + `cacheExpired`:

```typescript
/* Attach final seed fields to the accumulator now that the route knows
 * edit vs. build mode. The accumulator accepts runtime updates on these
 * fields through a helper; alternatively, construct the accumulator
 * here instead of above. See impl for the chosen shape. */
if (usage) {
	usage.configureRun({
		promptMode: editing ? "edit" : "build",
		freshEdit: editing && cacheExpired,
		appReady: editing,
		cacheExpired,
		moduleCount: sessionDoc.moduleOrder.length,
	});
}
```

Add a corresponding `configureRun` mutator to `UsageAccumulator`:

```typescript
configureRun(fields: {
	promptMode: "build" | "edit";
	freshEdit: boolean;
	appReady: boolean;
	cacheExpired: boolean;
	moduleCount: number;
}): void {
	if (this._finalized) return;
	Object.assign(this.seed, fields);
}
```

Construct the context with the new options:

```typescript
const ctx = new GenerationContext({
	apiKey: keyResult.apiKey,
	writer,
	logWriter: logWriter!, // appId guaranteed above via createApp
	usage: usage!,
	session: keyResult.session,
	appId,
});
```

Flush on finally / onFinish:

```typescript
} finally {
	await usage?.flush();
	await logWriter?.flush();
}

// onFinish:
void usage?.flush();
void logWriter?.flush();
```

- [ ] **Step 2: Run tests + build**

```bash
npm test -- --run
npx tsc --noEmit && echo "✓ tsc"
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add app/api/chat/route.ts lib/db/usage.ts
git commit -m "$(cat <<'EOF'
refactor(chat-route): swap EventLogger → LogWriter + UsageAccumulator

- Construct LogWriter + UsageAccumulator once appId is known
- Emit user-message ConversationEvent at request start
- flush() both on finally / onFinish / abort (idempotent)
- UsageAccumulator.configureRun for late-arriving seed fields

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Delete `lib/services/eventLogger.ts` + its tests

With all callers now routed through `LogWriter` + `UsageAccumulator`, the legacy class has no consumers. Remove it.

**Files:**
- Delete: `lib/services/eventLogger.ts`
- Delete (if present): `lib/services/__tests__/eventLogger*.test.ts`

- [ ] **Step 1: Verify no remaining imports**

```bash
rg "from \"@/lib/services/eventLogger\"" -l
rg "EventLogger" -l
```

Expected: no files (only docs / CLAUDE.md references remain).

- [ ] **Step 2: Delete**

```bash
rm lib/services/eventLogger.ts
```

- [ ] **Step 3: Run tests**

```bash
npm test -- --run
npx tsc --noEmit && echo "✓ tsc"
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(log): delete lib/services/eventLogger.ts

All callers migrated to LogWriter + UsageAccumulator in Tasks 7–9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Simplify `streamDispatcher.ts` — drop the legacy replay branch

**Files:**
- Modify: `lib/generation/streamDispatcher.ts`
- Modify: `lib/generation/__tests__/streamDispatcher.test.ts`

- [ ] **Step 1: Delete the legacy branch**

Remove the `LEGACY_REPLAY_DOC_MUTATION_EVENTS` constant and its handler block. Update the header comment to remove category 2. Drop the `toDocMutations` import.

Resulting dispatch order: category 1 (`data-mutations`), category 2 (lifecycle), category 3 (session-only). The header comment must reflect this.

- [ ] **Step 2: Prune the test file**

Delete the `describe("data-schema", …)`, `describe("data-scaffold", …)`, `describe("data-module-done", …)`, `describe("data-form-done", …)` blocks. Delete the associated fixtures (`SCAFFOLD_DATA`, `incomingForm`, etc.) if unused elsewhere. Keep everything else.

- [ ] **Step 3: Run tests**

```bash
npm test -- --run lib/generation/
```

Expected: green (remaining 12-ish streamDispatcher tests + `streamDispatcher-mutations.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add lib/generation/streamDispatcher.ts lib/generation/__tests__/streamDispatcher.test.ts
git commit -m "$(cat <<'EOF'
refactor(stream): drop legacy replay doc-mutation branch

Phase 4 replays Event[] directly from the new log; the legacy
wire-event branch is no longer reachable. Remove the
LEGACY_REPLAY_DOC_MUTATION_EVENTS set, its handler, and the
mutationMapper import.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Move `mutationMapper.ts` → `scripts/migrate/legacy-event-translator.ts`

The translator is no longer reachable from production code (Task 11 removed the legacy `streamDispatcher` branch), but the one-time migration script (Task 19) needs it to convert stored `StoredEvent[]` logs into the new `Event[]` shape. Move the file + its tests into `scripts/migrate/` so the migration script can import them and the test suite still runs.

**Files:**
- Move: `lib/generation/mutationMapper.ts` → `scripts/migrate/legacy-event-translator.ts`
- Move: `lib/generation/__tests__/mutationMapper.test.ts` → `scripts/migrate/__tests__/legacy-event-translator.test.ts`

- [ ] **Step 1: Verify no production-code references remain**

```bash
rg "from \"@/lib/generation/mutationMapper\"" -l
rg "toDocMutations" lib/ app/ components/ -l
```

Expected: no results. If any remain, they're leftover from Task 11 and must be fixed before the move.

- [ ] **Step 2: Move the files**

```bash
mkdir -p scripts/migrate/__tests__
git mv lib/generation/mutationMapper.ts scripts/migrate/legacy-event-translator.ts
git mv lib/generation/__tests__/mutationMapper.test.ts scripts/migrate/__tests__/legacy-event-translator.test.ts
```

- [ ] **Step 3: Update the translator's header comment**

Rewrite the top-of-file comment block in `scripts/migrate/legacy-event-translator.ts` to describe its NEW role — no longer a replay shim, now the one-time migration's wire-event translator. Drop the "Phase 4 removes this" note; the file IS the Phase 4 end state for this logic.

Example header:

```typescript
/**
 * Legacy wire-event → domain Mutation translator.
 *
 * Used exclusively by scripts/migrate-logs-to-events.ts to convert
 * historical Firestore log entries (StoredEvent[] at apps/{appId}/logs/)
 * into the new event log shape (Event[] at apps/{appId}/events/).
 *
 * Production code no longer reaches this file — Phase 4 removed the
 * legacy wire events from the live SA emission path.
 *
 * Preserved here (not deleted) so the migration script can translate
 * pre-Phase-4 logs at any point in the future without resurrecting the
 * code from git history.
 */
```

- [ ] **Step 4: Update import paths in the test file**

The moved test imports from `../mutationMapper` — update to `../legacy-event-translator`. If it also imports `@/lib/doc/types`, `@/lib/domain`, etc. by alias, those stay as-is (TypeScript path mapping works from `scripts/`).

Verify `tsconfig.json` includes `scripts/**/*` in its `include` list. If not, add:

```json
"include": ["scripts/**/*", ...existing]
```

- [ ] **Step 5: Run tests + build**

```bash
npm test -- --run scripts/migrate/__tests__/legacy-event-translator.test.ts
npx tsc --noEmit && echo "✓ tsc"
npm run build
```

Expected: test file runs (still part of the vitest glob if the config picks up `scripts/**/*.test.ts` — verify `vitest.config.ts`; extend `include` if needed). Build clean — scripts aren't part of the client bundle.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(generation): move mutationMapper → scripts/migrate/

The wire-event translator has no production consumers after Task 11
removed the legacy streamDispatcher branch. Moving to scripts/migrate/
reserves it for the one-time logs → events migration (Task 19).

- lib/generation/mutationMapper.ts → scripts/migrate/legacy-event-translator.ts
- companion test moves alongside; update aliased imports
- header comment rewritten to describe the new role

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Rewrite session replay types + store

Replace `ReplayStage` (chunked view with pre-rendered messages + emissions) with `ReplayChapter` (cursor-into-events). `ReplayData` holds `Event[]` + `ReplayChapter[]` + `cursor`.

**Files:**
- Modify: `lib/session/types.ts`
- Modify: `lib/session/store.ts`
- Modify: `lib/session/__tests__/store.test.ts`

- [ ] **Step 1: Update `types.ts`**

Replace the `ReplayStage` interface:

```typescript
/** Chapter metadata for replay navigation. Start/end index into the
 *  `events` array; chapters are cumulative — replaying to chapter N means
 *  dispatching events[0..chapters[N].endIndex]. */
export interface ReplayChapter {
	header: string;
	subtitle?: string;
	startIndex: number;
	endIndex: number;
}

/** Replay session data stored on the session store. */
export interface ReplayData {
	events: Event[];
	chapters: ReplayChapter[];
	/** Current scrub position — an index into `events`, not `chapters`. */
	cursor: number;
	exitPath: string;
}

/** Replay init data passed to BuilderProvider (pre-doneIndex cursor). */
export interface ReplayInit {
	events: Event[];
	chapters: ReplayChapter[];
	initialCursor: number;
	exitPath: string;
}
```

Add the import:

```typescript
import type { Event } from "@/lib/log/types";
```

Remove the old `ReplayStage` export.

- [ ] **Step 2: Update `store.ts`**

`loadReplay` signature:

```typescript
loadReplay(init: {
	events: Event[];
	chapters: ReplayChapter[];
	initialCursor: number;
	exitPath: string;
}): void;
```

Implementation sets `replay = { events, chapters, cursor: initialCursor, exitPath }`.

Remove `setReplayMessages`. Add:

```typescript
setReplayCursor(cursor: number): void;
```

- [ ] **Step 3: Update test file**

The existing `loadReplay` tests pass `(stages, doneIndex, exitPath)` — convert them to `({events, chapters, initialCursor, exitPath})` and assert `cursor` instead of `messages`.

- [ ] **Step 4: Run tests**

```bash
npm test -- --run lib/session/
```

- [ ] **Step 5: Commit**

```bash
git add lib/session/
git commit -m "$(cat <<'EOF'
refactor(session): ReplayStage → ReplayChapter + events cursor

Replay data now references the raw Event[] log and a list of
derived chapters. Cursor is an index into events (chapters are
cumulative scrub targets).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Add `useReplayMessages` — derive UIMessage[] from events

Replay chat history is now derived from `events.slice(0, cursor+1)` instead of stored as a pre-rendered string on each stage.

**Files:**
- Modify: `lib/session/hooks.tsx`
- Create: `lib/session/__tests__/useReplayMessages.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import { createBuilderSessionStore } from "../store";
import { BuilderSessionContext } from "../provider";
import type { Event } from "@/lib/log/types";
import { useReplayMessages } from "../hooks";

function evConv(seq: number, payload: any): Event {
	return { kind: "conversation", runId: "r", ts: seq, seq, payload };
}

describe("useReplayMessages", () => {
	it("builds progressive messages up to the cursor", () => {
		const events: Event[] = [
			evConv(0, { type: "user-message", text: "build me an app" }),
			evConv(1, { type: "assistant-reasoning", text: "thinking…" }),
			evConv(2, { type: "assistant-text", text: "ok" }),
			evConv(3, { type: "tool-call", toolCallId: "t1", toolName: "addModule", input: {} }),
			evConv(4, { type: "tool-result", toolCallId: "t1", toolName: "addModule", output: "ok" }),
		];
		const store = createBuilderSessionStore({
			replay: {
				events,
				chapters: [],
				cursor: 2,
				exitPath: "/",
			},
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<BuilderSessionContext.Provider value={store}>
				{children}
			</BuilderSessionContext.Provider>
		);
		const { result } = renderHook(() => useReplayMessages(), { wrapper });
		const msgs = result.current;
		expect(msgs).toHaveLength(2);
		expect(msgs[0].role).toBe("user");
		expect(msgs[1].role).toBe("assistant");
		expect(msgs[1].parts.some((p: any) => p.type === "text")).toBe(true);
	});
});
```

- [ ] **Step 2: Run test — expect failure**

Expected: FAIL — `useReplayMessages` not exported.

- [ ] **Step 3: Implement `useReplayMessages` in `hooks.tsx`**

```typescript
/**
 * Derives progressive UIMessage[] from replay events up to the cursor.
 *
 * Re-runs whenever cursor or events change. Groups conversation events
 * into user / assistant messages by walking sequentially:
 *   - `user-message` → a new user UIMessage
 *   - `assistant-text` / `assistant-reasoning` / `tool-call` / `tool-result`
 *     → parts of the current assistant UIMessage (new assistant message
 *     begins after a user-message)
 *   - `error` → an error part on the current assistant message
 *
 * Mutation events are skipped entirely — they're applied to the doc
 * store, not rendered in chat.
 */
export function useReplayMessages(): UIMessage[] {
	return useBuilderSession(
		useShallow((s) => {
			const replay = s.replay;
			if (!replay) return EMPTY_REPLAY_MESSAGES;
			return buildReplayMessages(replay.events, replay.cursor);
		}),
	);
}

const EMPTY_REPLAY_MESSAGES: UIMessage[] = [];

/** Pure builder — exported for testing. */
export function buildReplayMessages(
	events: readonly Event[],
	cursor: number,
): UIMessage[] {
	const messages: UIMessage[] = [];
	let current: UIMessage | null = null;
	for (let i = 0; i <= cursor && i < events.length; i++) {
		const e = events[i];
		if (e.kind !== "conversation") continue;
		const p = e.payload;
		if (p.type === "user-message") {
			if (current) messages.push(current);
			messages.push({
				id: `u-${i}`,
				role: "user",
				parts: [{ type: "text", text: p.text }],
			} as unknown as UIMessage);
			current = null;
			continue;
		}
		if (!current) {
			current = {
				id: `a-${i}`,
				role: "assistant",
				parts: [],
			} as unknown as UIMessage;
		}
		switch (p.type) {
			case "assistant-text":
				current.parts.push({ type: "text", text: p.text } as any);
				break;
			case "assistant-reasoning":
				current.parts.push({
					type: "reasoning",
					reasoning: p.text,
					text: p.text,
				} as any);
				break;
			case "tool-call":
				current.parts.push({
					type: `tool-${p.toolName}`,
					toolCallId: p.toolCallId,
					toolName: p.toolName,
					input: p.input,
					state: "output-available",
				} as any);
				break;
			case "tool-result":
				/* Merge output into the matching tool-call part if present. */
				{
					const target = current.parts.find(
						(x: any) => x.toolCallId === p.toolCallId,
					) as any;
					if (target) target.output = p.output;
				}
				break;
			case "error":
				current.parts.push({
					type: "error",
					error: p.error.message,
				} as any);
				break;
		}
	}
	if (current) messages.push(current);
	return messages;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- --run lib/session/__tests__/useReplayMessages.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add lib/session/
git commit -m "$(cat <<'EOF'
feat(session): add useReplayMessages derived from events + cursor

Replaces the pre-rendered messages field on ReplayStage. Messages
are now derived on read via a pure builder over events.slice(0, cursor+1).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Rewrite `ReplayBuilder` + replay page

**Files:**
- Modify: `app/build/replay/[id]/page.tsx`
- Modify: `app/build/replay/[id]/replay-builder.tsx`

- [ ] **Step 1: Update `page.tsx`**

```typescript
import { readEvents, readLatestRunId } from "@/lib/log/reader";
import type { Event } from "@/lib/log/types";
// ...
const runId = await readLatestRunId(id);
// ...
const events: Event[] = await readEvents(id, runId);
```

Pass `events` (not `StoredEvent[]`) to `ReplayBuilder`.

- [ ] **Step 2: Update `replay-builder.tsx`**

```typescript
import { deriveReplayChapters } from "@/lib/log/replay";
import type { Event } from "@/lib/log/types";
import type { ReplayInit } from "@/lib/session/types";

interface ReplayBuilderProps {
	events: Event[];
	exitPath: string;
}

export function ReplayBuilder({ events, exitPath }: ReplayBuilderProps) {
	const [replay] = useState<ReplayInit>(() => {
		if (events.length === 0) throw new Error("No events in log.");
		const chapters = deriveReplayChapters(events);
		return {
			events,
			chapters,
			/* Initial cursor = final event; user scrolls back through
			 * chapters to visit earlier states. */
			initialCursor: events.length - 1,
			exitPath,
		};
	});
	return (
		<BuilderProvider buildId="replay" replay={replay}>
			<BuilderLayout />
		</BuilderProvider>
	);
}
```

- [ ] **Step 3: Run build + tests**

```bash
npm run build
npm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add app/build/replay/
git commit -m "$(cat <<'EOF'
refactor(replay): page + ReplayBuilder read Event[] from new log

- page.tsx reads via lib/log/reader (events collection)
- ReplayBuilder calls deriveReplayChapters, seeds replay state with
  raw events + chapters + cursor instead of pre-chunked stages

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Rewrite `ReplayHydrator` + `ReplayController`

**Files:**
- Modify: `components/builder/BuilderProvider.tsx`
- Modify: `components/builder/ReplayController.tsx`

- [ ] **Step 1: Update `ReplayHydrator`**

```typescript
import { replayEvents } from "@/lib/log/replay";

function ReplayHydrator({ replay }: { replay: ReplayInit }) {
	const docStore = useContext(BlueprintDocContext);
	const sessionStore = useContext(BuilderSessionContext);
	const hydratedRef = useRef(false);

	useEffect(() => {
		if (hydratedRef.current || !docStore || !sessionStore) return;
		hydratedRef.current = true;

		sessionStore.getState().loadReplay({
			events: replay.events,
			chapters: replay.chapters,
			initialCursor: replay.initialCursor,
			exitPath: replay.exitPath,
		});

		/* Replay events synchronously (delayPerEvent=0) during hydration —
		 * the user sees the final state immediately. The transport UI then
		 * lets them scrub back through chapters. */
		const eventsToReplay = replay.events.slice(0, replay.initialCursor + 1);
		void replayEvents(
			eventsToReplay,
			(m) => docStore.getState().applyMany([m]),
			() => {
				/* Conversation events have no doc effect; they're rendered
				 * by useReplayMessages from the session store's events. */
			},
			0,
		);

		sessionStore.getState().setLoading(false);
	}, [replay, docStore, sessionStore]);

	return null;
}
```

- [ ] **Step 2: Update `ReplayController`**

```typescript
import { replayEvents } from "@/lib/log/replay";

export function ReplayController() {
	const router = useRouter();
	const docStore = useContext(BlueprintDocContext);
	const sessionStore = useContext(BuilderSessionContext);
	const engineController = useBuilderFormEngine();

	const replay = useBuilderSession((s) => s.replay);
	const events = replay?.events ?? EMPTY_EVENTS;
	const chapters = replay?.chapters ?? EMPTY_CHAPTERS;
	const cursor = replay?.cursor ?? 0;
	const [error, setError] = useState<string>();

	const currentChapterIndex = chapters.findIndex(
		(c) => cursor >= c.startIndex && cursor <= c.endIndex,
	);

	const doReset = useCallback(() => {
		if (!docStore || !sessionStore) {
			throw new Error("ReplayController.reset: missing stores");
		}
		resetBuilder({ sessionStore, docStore, engineController });
	}, [docStore, sessionStore, engineController]);

	const goToChapter = useCallback(
		(chapterIndex: number) => {
			const ch = chapters[chapterIndex];
			if (!ch || !docStore || !sessionStore) return;
			try {
				doReset();
				const slice = events.slice(0, ch.endIndex + 1);
				void replayEvents(
					slice,
					(m) => docStore.getState().applyMany([m]),
					() => {},
					0,
				);
				sessionStore.getState().setReplayCursor(ch.endIndex);
				setError(undefined);
			} catch (err) {
				setError(
					`Cannot load chapter: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		[chapters, events, doReset, docStore, sessionStore],
	);

	// ... arrow handlers call goToChapter(currentChapterIndex ± 1) ...
	// ... render header/subtitle from chapters[currentChapterIndex] ...
}

const EMPTY_EVENTS: readonly Event[] = [];
const EMPTY_CHAPTERS: readonly ReplayChapter[] = [];
```

Update the rendered `stage.header` / `stage.subtitle` reads to use `chapters[currentChapterIndex]`. Update the counter `{currentIndex + 1}/{stages.length}` to `{currentChapterIndex + 1}/{chapters.length}`.

- [ ] **Step 3: Update `ChatContainer.tsx`**

Swap the replay-messages read:

```typescript
import { useReplayMessages } from "@/lib/session/hooks";
// ...
const replayMessages = useReplayMessages();
```

- [ ] **Step 4: Run tests + build**

```bash
npm test -- --run
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add components/builder/ components/chat/
git commit -m "$(cat <<'EOF'
refactor(replay): drive ReplayController + hydrator from events log

- ReplayHydrator walks events via replayEvents (lib/log/replay)
- ReplayController navigates via derived chapters (cursor into events)
- ChatContainer reads replay messages via useReplayMessages (derived)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Update admin logs API routes

**Files:**
- Modify: `app/api/apps/[id]/logs/route.ts`
- Modify: `app/api/admin/users/[id]/apps/[appId]/logs/route.ts`

- [ ] **Step 1: Rewrite imports + return shape**

Both files:

```typescript
import { readEvents, readLatestRunId } from "@/lib/log/reader";
// ...
const runId = searchParams.get("runId") ?? (await readLatestRunId(appId));
if (!runId) return Response.json({ events: [], runId: null });
const events = await readEvents(appId, runId);
return Response.json({ events, runId });
```

- [ ] **Step 2: Delete `lib/db/logs.ts`**

```bash
rg "from \"@/lib/db/logs\"" -l
```

Expected: no files. Then:

```bash
rm lib/db/logs.ts
```

- [ ] **Step 3: Run tests + build**

```bash
npm test -- --run
npx tsc --noEmit && echo "✓ tsc"
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(api): admin logs API reads new events collection

- Routes import from lib/log/reader (readEvents, readLatestRunId)
- Delete lib/db/logs.ts — fully replaced

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Rewrite inspect scripts

Rich per-step cost view moves to per-run summary docs. Event-level views operate on `Event[]`.

**Files:**
- Modify: `scripts/lib/types.ts`
- Modify: `scripts/lib/log-stats.ts`
- Modify: `scripts/inspect-logs.ts`
- Modify: `scripts/inspect-compare.ts`

- [ ] **Step 1: Update `scripts/lib/types.ts`**

```typescript
export type {
	ConversationEvent,
	ConversationPayload,
	Event,
	MutationEvent,
} from "../../lib/log/types";

export type { RunSummaryDoc } from "../../lib/db/types";

// Blueprint + pricing exports unchanged
```

- [ ] **Step 2: Rewrite `scripts/lib/log-stats.ts`**

Replace the `StoredEvent`-shaped functions with Event-shaped equivalents:

```typescript
import type { Event } from "./types";

/** Group events by runId. */
export function groupByRun(events: Event[]): Map<string, Event[]> {
	const groups = new Map<string, Event[]>();
	for (const e of events) {
		if (!groups.has(e.runId)) groups.set(e.runId, []);
		groups.get(e.runId)!.push(e);
	}
	return groups;
}

/** Count tool calls across conversation events. */
export function computeToolUsage(events: Event[]): Array<{
	tool: string;
	calls: number;
}> {
	const counts = new Map<string, number>();
	for (const e of events) {
		if (e.kind === "conversation" && e.payload.type === "tool-call") {
			const prev = counts.get(e.payload.toolName) ?? 0;
			counts.set(e.payload.toolName, prev + 1);
		}
	}
	return [...counts.entries()]
		.map(([tool, calls]) => ({ tool, calls }))
		.sort((a, b) => b.calls - a.calls);
}

/** Timing gaps between consecutive events — spot hangs / burst periods. */
export function computeTimeline(events: Event[]): Array<{
	ts: number;
	gapMs: number;
	kind: string;
}> {
	return events.map((e, i) => ({
		ts: e.ts,
		gapMs: i === 0 ? 0 : e.ts - events[i - 1].ts,
		kind:
			e.kind === "mutation"
				? `mutation${e.stage ? `:${e.stage}` : ""}`
				: `conversation:${e.payload.type}`,
	}));
}

/** Mutation-event counts per stage. */
export function computeMutationsByStage(events: Event[]): Array<{
	stage: string;
	count: number;
}> {
	const counts = new Map<string, number>();
	for (const e of events) {
		if (e.kind !== "mutation") continue;
		const key = e.stage ?? "(untagged)";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([stage, count]) => ({ stage, count }))
		.sort((a, b) => b.count - a.count);
}
```

Remove the `CostSummary`, `StepBreakdown`, `analyzeRun`, `computeStepBreakdown` exports — cost lives on the run summary doc now.

- [ ] **Step 3: Rewrite `scripts/inspect-logs.ts`**

New CLI surface:

```
npx tsx scripts/inspect-logs.ts <appId>                  # events + runs
npx tsx scripts/inspect-logs.ts <appId> --verbose         # full event detail
npx tsx scripts/inspect-logs.ts <appId> --runs            # per-run summary table
npx tsx scripts/inspect-logs.ts <appId> --timeline        # timing analysis
npx tsx scripts/inspect-logs.ts <appId> --tools           # tool usage
npx tsx scripts/inspect-logs.ts <appId> --stages          # mutations by stage
npx tsx scripts/inspect-logs.ts <appId> --run=<runId>     # filter to run
```

Source cost summary from `apps/{appId}/runs/{runId}` via `readRunSummary`. The events collection is scanned for event-level views.

- [ ] **Step 4: Rewrite `scripts/inspect-compare.ts`**

Side-by-side comparison of two runs' summary docs (tokens, cost, stages, tool usage). No more per-step cost table — just summary + event counts + tool call deltas.

- [ ] **Step 5: Verify scripts run**

```bash
npx tsx scripts/inspect-logs.ts --help 2>&1 | head -30
# (Won't actually hit Firestore without creds; just verify it loads)
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add scripts/
git commit -m "$(cat <<'EOF'
refactor(scripts): inspect scripts read new events + runs collections

- types.ts re-exports Event/ConversationPayload/RunSummaryDoc
- log-stats.ts rewritten for Event[] — computeToolUsage / Timeline /
  MutationsByStage / groupByRun
- inspect-logs.ts: per-run summary from apps/{appId}/runs; event-level
  views over the new Event shape
- inspect-compare.ts: diff run summaries

Drops per-step cost table (cost lives on run summary doc now).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Write + run the one-time `logs` → `events` migration

Convert every historical `apps/{appId}/logs/` subcollection into the new `apps/{appId}/events/` shape, seeding `apps/{appId}/runs/{runId}` summaries from aggregated StepEvents. The script is pure TypeScript, runs via `tsx`, and is idempotent.

**Files:**
- Create: `scripts/migrate-logs-to-events.ts`
- Create: `scripts/migrate/__tests__/migration-smoke.test.ts` (optional — a fixture-based smoke test for the translator pipeline)

### Design

The migration runs per-app, per-run. For each run's sorted `StoredEvent[]`, a reducer walks the events in sequence order, maintaining a running `BlueprintDoc` state so legacy index-based emissions (`data-scaffold`, `data-module-done`, `data-form-done`, `data-form-fixed`, `data-form-updated`) translate to the correct uuid-keyed mutations via `toDocMutations`. The resulting `Event[]` is written to `apps/{appId}/events/` via `collections.events(appId)`, and a per-run summary is written via `writeRunSummary`.

Mapping rules:

| Source `StoredEvent` | Destination `Event(s)` |
|---|---|
| `MessageEvent { text, id }` | One `ConversationEvent { type: 'user-message', text }` |
| `StepEvent { reasoning }` (non-empty) | One `ConversationEvent { type: 'assistant-reasoning', text: reasoning }` |
| `StepEvent { text }` (non-empty) | One `ConversationEvent { type: 'assistant-text', text }` |
| `StepEvent { tool_calls[] }` | One `ConversationEvent { type: 'tool-call', toolCallId: synthesized, toolName, input: args }` per call. `toolCallId` synthesized as `${runId}-${stepIdx}-${toolIdx}` (legacy logs didn't persist SDK ids). |
| `StepEvent.tool_calls[].output` (non-null) | One paired `ConversationEvent { type: 'tool-result', toolCallId, toolName, output }` |
| `EmissionEvent { emission_type: 'data-mutations', emission_data: {mutations, stage?} }` | One `MutationEvent { actor: 'agent', stage, mutation }` per entry in `mutations`. Preserves stage tag. |
| `EmissionEvent { emission_type in LEGACY_WIRE_EVENTS }` | Zero-or-more `MutationEvent`s produced by `toDocMutations(type, data, runningDoc)`. `runningDoc` is advanced by applying the emitted mutations so subsequent legacy events resolve their indexes against current state. `stage` is derived heuristically: `'schema'` for `data-schema`, `'scaffold'` for `data-scaffold`, `'module:${i}'` for `data-module-done`, `'form:${m}-${f}'` for `data-form-*`. |
| `EmissionEvent { emission_type: 'data-blueprint-updated', emission_data: {doc} }` | SKIPPED. Edit-mode full-doc replacements can't be losslessly decomposed. The final doc is on `AppDoc.blueprint`; admin replay of edit runs will show the conversation events but no mutations. Noted in the migration report. |
| `EmissionEvent { emission_type: 'data-done' | 'data-phase' | 'data-start-build' | 'data-fix-attempt' | 'data-partial-scaffold' | 'data-app-saved' | 'data-run-id' | 'data-error' }` | SKIPPED (ephemeral — not part of the Phase 4 persisted shape). |
| `ErrorEvent` | One `ConversationEvent { type: 'error', error: { type, message, fatal } }` |
| `ConfigEvent` | SKIPPED on the event stream; its fields seed the per-run summary doc instead. |

The per-run summary is built by summing all `StepEvent.usage` + sub-tool `generation` fields (matching today's `EventLogger.logStep` accumulation logic), plus `ConfigEvent` seed fields. `startedAt` = timestamp of first event in run; `finishedAt` = timestamp of last event in run; `model` = the final StepEvent's model string.

All destination event `seq` fields use a per-run monotonic counter assigned during translation (not the source's `sequence` — that was a StoredEvent field with different semantics). `ts` copies from the source's `timestamp` (ISO string → ms via `Date.parse`).

### CLI

```
npx tsx scripts/migrate-logs-to-events.ts                   # migrate every app
npx tsx scripts/migrate-logs-to-events.ts --app=<id>        # one app only
npx tsx scripts/migrate-logs-to-events.ts --dry-run         # log what would be written, write nothing
npx tsx scripts/migrate-logs-to-events.ts --force           # re-migrate apps that already have events (default skips them)
npx tsx scripts/migrate-logs-to-events.ts --app=<id> --dry-run --verbose
```

Output per app:
```
[migrate] app abc123 — found 847 logs across 3 runs
[migrate]   run run-1 (142 logs) → 198 events + summary (cost $0.34, 12 steps)
[migrate]   run run-2 (... ) → ...
[migrate]   legacy blueprint-updated events skipped: 3
[migrate] done. Apps migrated: 1, runs migrated: 3, events written: 512.
```

### Implementation

- [ ] **Step 1: Write the script skeleton**

Create `scripts/migrate-logs-to-events.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * One-time migration: apps/{appId}/logs (StoredEvent) →
 *                     apps/{appId}/events (Event) + apps/{appId}/runs (RunSummaryDoc).
 *
 * Idempotent. Deterministic doc IDs mean re-running is safe; `--force`
 * re-migrates apps that already have events. `--dry-run` prints the
 * translation plan without writing.
 *
 * Run against staging first. Take a Firestore backup before production.
 */

import { FieldValue, WriteBatch } from "@google-cloud/firestore";
import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { collections, getDb } from "@/lib/db/firestore";
import { writeRunSummary } from "@/lib/db/runSummary";
import type { RunSummaryDoc } from "@/lib/db/types";
import type {
	ConversationEvent,
	Event,
	MutationEvent,
} from "@/lib/log/types";
import { eventDocId } from "@/lib/log/types";
import { estimateCost } from "@/lib/db/usage";
import { toDocMutations } from "./migrate/legacy-event-translator";

// ── CLI parsing ─────────────────────────────────────────────────

interface Flags {
	app?: string;
	dryRun: boolean;
	force: boolean;
	verbose: boolean;
}

function parseFlags(): Flags {
	const args = process.argv.slice(2);
	return {
		app: args.find((a) => a.startsWith("--app="))?.split("=")[1],
		dryRun: args.includes("--dry-run"),
		force: args.includes("--force"),
		verbose: args.includes("--verbose"),
	};
}

// ── Legacy StoredEvent shape (re-declared locally — types.ts no longer exports it) ──

/**
 * Minimal subset of the pre-Phase-4 StoredEvent shape. We ONLY redeclare
 * the fields the translator actually reads — the live Zod schema for
 * these docs was deleted in Task 3, so reads here are intentionally
 * untyped (plain JS objects from Firestore).
 */
interface LegacyStoredEvent {
	run_id: string;
	sequence: number;
	request: number;
	timestamp: string;
	event:
		| { type: "message"; id: string; text: string }
		| {
				type: "step";
				step_index: number;
				text: string;
				reasoning: string;
				tool_calls: Array<{
					name: string;
					args: unknown;
					output: unknown;
					generation: {
						model: string;
						input_tokens: number;
						output_tokens: number;
						cache_read_tokens: number;
						cache_write_tokens: number;
						cost: number;
					} | null;
					reasoning: string;
				}>;
				usage: {
					model: string;
					input_tokens: number;
					output_tokens: number;
					cache_read_tokens: number;
					cache_write_tokens: number;
					cost: number;
				};
		  }
		| {
				type: "emission";
				step_index: number;
				emission_type: string;
				emission_data: unknown;
		  }
		| {
				type: "config";
				prompt_mode: "build" | "edit";
				fresh_edit: boolean;
				app_ready: boolean;
				cache_expired: boolean;
				module_count: number;
		  }
		| {
				type: "error";
				error_type: string;
				error_message: string;
				error_raw: string;
				error_fatal: boolean;
				error_context: string;
		  };
}

// ── Event types we skip during migration ────────────────────────

const EPHEMERAL_EMISSION_TYPES = new Set([
	"data-done",
	"data-phase",
	"data-start-build",
	"data-fix-attempt",
	"data-partial-scaffold",
	"data-app-saved",
	"data-run-id",
	"data-error",          // recorded separately from ErrorEvent
	"data-blueprint-updated", // lossy for edits — see design notes
]);

const LEGACY_WIRE_EMISSION_TYPES = new Set([
	"data-schema",
	"data-scaffold",
	"data-module-done",
	"data-form-done",
	"data-form-fixed",
	"data-form-updated",
]);

// ── Empty starting doc — matches the chat route's sessionDoc seed ─

function emptyDoc(appId: string): BlueprintDoc {
	return {
		appId,
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

// ── Per-run translation ─────────────────────────────────────────

interface TranslatedRun {
	events: Event[];
	summary: RunSummaryDoc;
	skippedBlueprintUpdated: number;
}

function translateRun(
	appId: string,
	runId: string,
	stored: LegacyStoredEvent[],
): TranslatedRun {
	const events: Event[] = [];
	let seq = 0;
	let doc = emptyDoc(appId);

	let cfg: Extract<LegacyStoredEvent["event"], { type: "config" }> | null =
		null;
	let stepCount = 0;
	let toolCallCount = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let lastModel = "unknown";
	let skippedBlueprintUpdated = 0;

	const startedAt = stored[0]?.timestamp ?? new Date().toISOString();
	const finishedAt =
		stored[stored.length - 1]?.timestamp ?? new Date().toISOString();

	for (const s of stored) {
		const ts = Date.parse(s.timestamp);

		// ── message → user-message conversation event ─────────
		if (s.event.type === "message") {
			const ev: ConversationEvent = {
				kind: "conversation",
				runId,
				ts,
				seq: seq++,
				payload: { type: "user-message", text: s.event.text },
			};
			events.push(ev);
			continue;
		}

		// ── config → seed the run summary; no stream event ────
		if (s.event.type === "config") {
			cfg = s.event;
			continue;
		}

		// ── error → error conversation event ──────────────────
		if (s.event.type === "error") {
			events.push({
				kind: "conversation",
				runId,
				ts,
				seq: seq++,
				payload: {
					type: "error",
					error: {
						type: s.event.error_type,
						message: s.event.error_message,
						fatal: s.event.error_fatal,
					},
				},
			});
			continue;
		}

		// ── step → reasoning + text + tool-call + tool-result ─
		if (s.event.type === "step") {
			stepCount++;
			lastModel = s.event.usage.model;
			inputTokens += s.event.usage.input_tokens;
			outputTokens += s.event.usage.output_tokens;
			cacheReadTokens += s.event.usage.cache_read_tokens;
			cacheWriteTokens += s.event.usage.cache_write_tokens;

			if (s.event.reasoning) {
				events.push({
					kind: "conversation",
					runId,
					ts,
					seq: seq++,
					payload: { type: "assistant-reasoning", text: s.event.reasoning },
				});
			}
			if (s.event.text) {
				events.push({
					kind: "conversation",
					runId,
					ts,
					seq: seq++,
					payload: { type: "assistant-text", text: s.event.text },
				});
			}
			s.event.tool_calls.forEach((tc, tIdx) => {
				toolCallCount++;
				/* Fold sub-generation cost into the run totals — this is where
				 * the old EventLogger's sub-result accumulator lived. */
				if (tc.generation) {
					inputTokens += tc.generation.input_tokens;
					outputTokens += tc.generation.output_tokens;
					cacheReadTokens += tc.generation.cache_read_tokens;
					cacheWriteTokens += tc.generation.cache_write_tokens;
				}
				const toolCallId = `${runId}-${s.event.type === "step" ? s.event.step_index : 0}-${tIdx}`;
				events.push({
					kind: "conversation",
					runId,
					ts,
					seq: seq++,
					payload: {
						type: "tool-call",
						toolCallId,
						toolName: tc.name,
						input: tc.args,
					},
				});
				if (tc.output !== null && tc.output !== undefined) {
					events.push({
						kind: "conversation",
						runId,
						ts,
						seq: seq++,
						payload: {
							type: "tool-result",
							toolCallId,
							toolName: tc.name,
							output: tc.output,
						},
					});
				}
			});
			continue;
		}

		// ── emission → mutation event(s) OR skip ──────────────
		if (s.event.type === "emission") {
			const type = s.event.emission_type;

			if (type === "data-blueprint-updated") {
				skippedBlueprintUpdated++;
				continue;
			}
			if (EPHEMERAL_EMISSION_TYPES.has(type)) continue;

			if (type === "data-mutations") {
				const data = s.event.emission_data as {
					mutations?: Mutation[];
					stage?: string;
				};
				const stage = data.stage;
				for (const m of data.mutations ?? []) {
					const ev: MutationEvent = {
						kind: "mutation",
						runId,
						ts,
						seq: seq++,
						actor: "agent",
						...(stage && { stage }),
						mutation: m,
					};
					events.push(ev);
					/* Apply to running doc so later legacy emissions resolve
					 * indexes against current state. */
					doc = produce(doc, (draft) => {
						applyMutations(draft, [m]);
					});
				}
				continue;
			}

			if (LEGACY_WIRE_EMISSION_TYPES.has(type)) {
				const stage = deriveLegacyStage(
					type,
					s.event.emission_data as Record<string, unknown>,
				);
				const mutations = toDocMutations(
					type,
					s.event.emission_data as Record<string, unknown>,
					doc,
				);
				for (const m of mutations) {
					events.push({
						kind: "mutation",
						runId,
						ts,
						seq: seq++,
						actor: "agent",
						...(stage && { stage }),
						mutation: m,
					});
				}
				/* Apply the whole batch atomically to the running doc so the
				 * next legacy emission's index lookup sees the state the live
				 * SA would have seen. */
				doc = produce(doc, (draft) => {
					applyMutations(draft, mutations);
				});
				continue;
			}

			/* Unknown emission type — warn and skip. */
			console.warn(
				`[migrate] app ${appId} run ${runId}: unknown emission type ${type}, skipping`,
			);
		}
	}

	/* Build the run summary. */
	const summary: RunSummaryDoc = {
		runId,
		startedAt,
		finishedAt,
		promptMode: cfg?.prompt_mode ?? "build",
		freshEdit: cfg?.fresh_edit ?? false,
		appReady: cfg?.app_ready ?? false,
		cacheExpired: cfg?.cache_expired ?? false,
		moduleCount: cfg?.module_count ?? 0,
		stepCount,
		model: lastModel,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costEstimate: estimateCost(
			lastModel,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
		),
		toolCallCount,
	};

	return { events, summary, skippedBlueprintUpdated };
}

/** Derive a stage tag from a legacy wire-event type + payload. */
function deriveLegacyStage(
	type: string,
	data: Record<string, unknown>,
): string | undefined {
	if (type === "data-schema") return "schema";
	if (type === "data-scaffold") return "scaffold";
	if (type === "data-module-done") {
		const i = data.moduleIndex as number | undefined;
		return typeof i === "number" ? `module:${i}` : "module";
	}
	if (type.startsWith("data-form-")) {
		const m = data.moduleIndex as number | undefined;
		const f = data.formIndex as number | undefined;
		return typeof m === "number" && typeof f === "number"
			? `form:${m}-${f}`
			: "form";
	}
	return undefined;
}

// ── Firestore sink ──────────────────────────────────────────────

async function writeRun(
	appId: string,
	runId: string,
	translated: TranslatedRun,
	dryRun: boolean,
): Promise<void> {
	if (dryRun) {
		console.log(
			`[dry-run] ${appId}/${runId}: ${translated.events.length} events + summary (cost $${translated.summary.costEstimate.toFixed(4)}, ${translated.summary.stepCount} steps)` +
				(translated.skippedBlueprintUpdated > 0
					? ` — skipped ${translated.skippedBlueprintUpdated} blueprint-updated emissions`
					: ""),
		);
		return;
	}

	/* Firestore batch limit is 500 ops; chunk and commit. */
	const db = getDb();
	const eventsCol = collections.events(appId);
	const CHUNK = 450;
	for (let i = 0; i < translated.events.length; i += CHUNK) {
		const slice = translated.events.slice(i, i + CHUNK);
		const batch = db.batch();
		for (const ev of slice) {
			batch.set(eventsCol.doc(eventDocId(ev)), ev);
		}
		await batch.commit();
	}

	/* Summary is a single set() — not batched with events. */
	writeRunSummary(appId, runId, translated.summary);
}

// ── App discovery ───────────────────────────────────────────────

async function migrateApp(appId: string, flags: Flags): Promise<{
	runsMigrated: number;
	eventsWritten: number;
	blueprintUpdatedSkipped: number;
}> {
	const db = getDb();
	const logsSnap = await db.collection(`apps/${appId}/logs`).get();
	if (logsSnap.empty) {
		if (flags.verbose)
			console.log(`[migrate] ${appId}: no legacy logs — skipping`);
		return { runsMigrated: 0, eventsWritten: 0, blueprintUpdatedSkipped: 0 };
	}

	/* Unless --force, skip apps that already have events. */
	if (!flags.force) {
		const existingEvents = await collections
			.events(appId)
			.limit(1)
			.get();
		if (!existingEvents.empty) {
			console.log(
				`[migrate] ${appId}: already has events — use --force to re-migrate. Skipping.`,
			);
			return { runsMigrated: 0, eventsWritten: 0, blueprintUpdatedSkipped: 0 };
		}
	}

	const allStored = logsSnap.docs.map((d) => d.data() as LegacyStoredEvent);
	const byRun = new Map<string, LegacyStoredEvent[]>();
	for (const s of allStored) {
		if (!byRun.has(s.run_id)) byRun.set(s.run_id, []);
		byRun.get(s.run_id)!.push(s);
	}
	for (const arr of byRun.values()) {
		arr.sort((a, b) => a.sequence - b.sequence);
	}

	console.log(
		`[migrate] app ${appId} — found ${allStored.length} logs across ${byRun.size} runs`,
	);

	let runsMigrated = 0;
	let eventsWritten = 0;
	let blueprintUpdatedSkipped = 0;
	for (const [runId, stored] of byRun) {
		const translated = translateRun(appId, runId, stored);
		await writeRun(appId, runId, translated, flags.dryRun);
		runsMigrated++;
		eventsWritten += translated.events.length;
		blueprintUpdatedSkipped += translated.skippedBlueprintUpdated;
		console.log(
			`[migrate]   run ${runId} (${stored.length} logs) → ${translated.events.length} events + summary (cost $${translated.summary.costEstimate.toFixed(4)}, ${translated.summary.stepCount} steps)`,
		);
	}
	return { runsMigrated, eventsWritten, blueprintUpdatedSkipped };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
	const flags = parseFlags();
	const db = getDb();

	const appIds = flags.app
		? [flags.app]
		: (await db.collection("apps").get()).docs.map((d) => d.id);

	let appsMigrated = 0;
	let totalRuns = 0;
	let totalEvents = 0;
	let totalSkipped = 0;
	for (const appId of appIds) {
		try {
			const r = await migrateApp(appId, flags);
			if (r.runsMigrated > 0) appsMigrated++;
			totalRuns += r.runsMigrated;
			totalEvents += r.eventsWritten;
			totalSkipped += r.blueprintUpdatedSkipped;
		} catch (err) {
			console.error(`[migrate] ${appId}: FAILED`, err);
		}
	}

	console.log(
		`[migrate] done. Apps migrated: ${appsMigrated}, runs migrated: ${totalRuns}, events written: ${totalEvents}` +
			(totalSkipped > 0
				? `, blueprint-updated skipped: ${totalSkipped}`
				: ""),
	);
}

main().catch((err) => {
	console.error("[migrate] fatal", err);
	process.exit(1);
});
```

- [ ] **Step 2: Dry-run against local/staging Firestore**

With Firestore credentials configured (ADC or emulator), run:

```bash
npx tsx scripts/migrate-logs-to-events.ts --dry-run --verbose
```

Expected: for each app, logs-per-run counts + translated event counts + run-summary cost/step breakdown. No writes.

- [ ] **Step 3: Spot-check against a real app**

Pick an app with a known-good build. Run against one app:

```bash
npx tsx scripts/migrate-logs-to-events.ts --app=<id> --dry-run --verbose
```

Verify:
- Every run from `logs/` shows a translated event count ≥ the StepEvent + MessageEvent count (because steps expand into multiple conversation events).
- The run summary's cost matches what `inspect-logs.ts` would have computed pre-migration (cross-check with the pre-Phase-4 version of the script if available, or compute manually from StepEvent usage).
- `blueprint-updated skipped` count is 0 for build-only runs; non-zero is expected for edit runs and documented as a known limitation.

- [ ] **Step 4: Execute the migration live**

Back up Firestore first (export to GCS). Then:

```bash
# Staging first
GOOGLE_CLOUD_PROJECT=staging-project-id npx tsx scripts/migrate-logs-to-events.ts

# After staging-replay verification in the builder UI:
GOOGLE_CLOUD_PROJECT=prod-project-id npx tsx scripts/migrate-logs-to-events.ts
```

- [ ] **Step 5: Post-migration verification**

1. Pick 3 recently-built apps. Load `/build/replay/{appId}` for each. Chapters render; scrubbing replays mutations; chat history populates.
2. Run `npx tsx scripts/inspect-logs.ts <appId> --runs`. Per-run summaries match Firestore's `apps/{appId}/runs/{runId}` docs.
3. `apps/{appId}/events/` collection has ≥ logs-count events for every migrated app.

- [ ] **Step 6: Cleanup decision (deferred, not in this task)**

The old `apps/{appId}/logs/` subcollection is NOT deleted by this migration. Deleting it is a separate decision once replay + inspect workflows are confirmed on the new data. Add a TODO to a follow-up task or issue; Phase 4 scope ends at "new-collection reads work; old collection coexists."

- [ ] **Step 7: Commit**

```bash
git add scripts/migrate-logs-to-events.ts
git commit -m "$(cat <<'EOF'
feat(migrate): one-time logs → events migration script

Converts historical apps/{appId}/logs (StoredEvent) to the Phase 4
apps/{appId}/events (Event) shape. Seeds per-run summaries from
aggregated StepEvent usage.

- StepEvent → reasoning / text / tool-call / tool-result events
- EmissionEvent(data-mutations) → MutationEvent per mutation (stage preserved)
- Legacy wire emissions → MutationEvent(s) via the translator, with a
  running BlueprintDoc to resolve moduleIndex / formIndex
- ErrorEvent → error conversation event; ConfigEvent seeds the summary
- data-blueprint-updated skipped (edit-mode full-doc replacements;
  lossy without diff). Skipped count reported per run.

Idempotent via deterministic doc ids. Supports --dry-run, --app=<id>,
--force, --verbose.

Run against staging first; take a Firestore backup before prod. Old
logs/ collection coexists post-migration — deletion is a separate call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Delete `lib/services/logReplay.ts`

**Files:**
- Delete: `lib/services/logReplay.ts`

- [ ] **Step 1: Verify no imports remain**

```bash
rg "from \"@/lib/services/logReplay\"" -l
rg "extractReplayStages" -l
```

Expected: only this plan + spec + old Phase 3 plan docs.

- [ ] **Step 2: Delete**

```bash
rm lib/services/logReplay.ts
```

- [ ] **Step 3: Run tests + build**

```bash
npm test -- --run
npx tsc --noEmit && echo "✓ tsc"
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(log): delete lib/services/logReplay.ts

All callers migrated to lib/log/replay (replayEvents +
deriveReplayChapters).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Update CLAUDE.md files + docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `lib/services/CLAUDE.md`
- Modify: `lib/agent/CLAUDE.md`
- Create: `lib/log/CLAUDE.md`

- [ ] **Step 1: Write `lib/log/CLAUDE.md`**

```markdown
# lib/log — Event log

The single persistent stream of what happened during a generation run.

## Boundary

Writes come from one place: `GenerationContext` (server-side). It owns a
`LogWriter` for the current request. Reads come from three places:

- `app/build/replay/[id]/page.tsx` → loads a run for replay
- `app/api/apps/[id]/logs/route.ts` → admin log inspection
- Diagnostic scripts (`inspect-logs.ts`, `inspect-compare.ts`)

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
walks the log in order. Mutations go to `docStore.applyMany`;
conversation events feed `useReplayMessages` (a pure derivation). No
state reconstruction — mutations are the state delta and conversation
events are pre-rendered.

## No historical migration

Apps generated before Phase 4 have events at the old `apps/{appId}/logs/`
subcollection. They are not migrated; replay silently returns empty for
those runs. Spec non-goal: "log compaction / archival deferred."
```

- [ ] **Step 2: Update root `CLAUDE.md`**

In the "Firestore" section, replace the `apps/{appId}/logs/` bullet with:

```
**Event log** at `apps/{appId}/events/` captures generation runs as a
flat stream of MutationEvent + ConversationEvent; per-run cost/behavior
summary at `apps/{appId}/runs/{runId}`. See `lib/log/CLAUDE.md`.
```

- [ ] **Step 3: Update `lib/services/CLAUDE.md`**

Remove the sentence listing `eventLogger` / `logReplay` in the services utility surface description. Keep the CommCare / form derivation / UI plumbing sections.

- [ ] **Step 4: Update `lib/agent/CLAUDE.md`**

Change the `generationContext.ts` bullet to:

```
- `generationContext.ts` — shared wrapper around the Anthropic client, SSE
  stream writer, `LogWriter` (event log), and `UsageAccumulator` (cost).
  Owns `emitMutations`, `emitConversation`, `emitError`, and the
  `runAgent` step-emission loop. The only sanctioned way to write a
  doc-mutating stream event and the only way to write an agent-side log
  event.
```

Drop the `mutationMapper.ts` line entirely (file deleted).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md lib/log/CLAUDE.md lib/services/CLAUDE.md lib/agent/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: update CLAUDE.md for Phase 4 event log unification

- Add lib/log/CLAUDE.md explaining the new boundary
- Root CLAUDE.md points at apps/{appId}/events/ + runs/
- lib/services/CLAUDE.md drops eventLogger/logReplay
- lib/agent/CLAUDE.md updates generationContext description

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Final verification

**Files:** none modified.

- [ ] **Step 1: Run full verification gate**

```bash
npx tsc --noEmit && echo "✓ tsc"
npm run lint
npm test -- --run
npm run build
```

Expected: all green. Test count should be within ±30 of baseline 1191 (drops from deleted mutationMapper + logReplay tests; gains from new log tests).

- [ ] **Step 2: Spot-check manual flow**

In a development server (`npm run dev`):

1. Kick off a new build with a short prompt. Verify:
   - Chat messages stream in.
   - `apps/{appId}/events/` fills with `MutationEvent` + `ConversationEvent` docs in Firestore.
   - `apps/{appId}/runs/{runId}` writes once at completion with non-zero cost.
2. Navigate to `/build/replay/{appId}`. Verify:
   - Chapters show: Conversation, Data Model, Scaffold, Module (one per), Form (one per), Validation, Done.
   - Arrow navigation scrubs between chapters.
   - Chat history populates progressively.
3. Run `npx tsx scripts/inspect-logs.ts <appId>` and `--runs`. Verify the run summary shows tokens/cost matching the monthly usage increment.

- [ ] **Step 3: Check bundle trace for server-only leaks**

```bash
npm run build 2>&1 | grep -i "cannot be used on the client"
```

Expected: no output. `lib/log/writer.ts` imports `lib/db/firestore.ts` (server-only) — it must not appear in the client bundle. Per Phase 3 lesson: only `npm run build` actually exercises the client/server split.

- [ ] **Step 4: Commit any final fix-ups**

If anything surfaces, fix in-place and commit with a `fix(phase-4): …` message.

- [ ] **Step 5: Summarize**

Write a short progress note at the top of this plan file (prepend under the header):

```
**Status:** Phase 4 complete — event log unified under lib/log/, EventLogger
deleted, streamDispatcher simplified, replay consumes Event[] directly.
Baseline: {N} tests, tsc/lint/build clean.
```

---

## Self-review

The following list maps each spec §5/§6 requirement to a task; re-check during subagent-driven execution:

- **§5 Event type (MutationEvent + ConversationEvent)** → Task 2
- **§5 Writer (Firestore sink, ~100ms batching)** → Task 4
- **§5 Reader (paginates by ts)** → Task 5
- **§5 Replay ~30 lines** → Task 6 (`replayEvents`)
- **§5 Storage format `apps/{appId}/events/{runId}:{ts}:{seq}`** → Task 3 (doc id = `{runId}_{seqPad}` — deviation: we use seq alone for the tiebreaker because `ts` isn't in the ID shape and would be redundant given `runId`+`seq` is already unique. Chronological sort still lands correctly via the `ts` orderBy clause)
- **§5 "blueprint snapshot is authoritative; log is supplemental"** → preserved: the chat route still writes `AppDoc.blueprint`, and the event log is fire-and-forget
- **§5 "conversation events are in the log directly; no reconstruction"** → Task 14 (`useReplayMessages` is a pure mapper, not a reconstruction)
- **§6 "lib/services/logReplay.ts deleted"** → Task 20
- **§6 "lib/services/eventLogger.ts deleted"** → Task 10
- **§6 "logging moves out of the agent layer"** → Task 8 (agent imports `LogWriter` as a plain client)
- **Spec risk: "server-side mutation mapper changes streaming timing"** → preserved: SSE `data-mutations` wire format unchanged; only log behavior changes
- **Phase 4 migration row: "Replay UI consumes events from the log"** → Tasks 15, 16
- **User requirement: "one-time migration script for old logs to convert over"** → Task 12 (move translator) + Task 19 (migration script + execution)

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-phase-4-event-log-unification.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
