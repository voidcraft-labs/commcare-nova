# Derive Lifecycle State from the Event Stream

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live and replay paths compute UI lifecycle (phase, stage, status message, error, fix attempt, completion) from one code path — a shared `Event[]` buffer on the session store.

**Architecture:** Consolidate shadow state (`agentStage`, `agentError`, `statusMessage`, `postBuildEdit`, `justCompleted`, `partialScaffold`) into derivations over `session.events: Event[]`. The live path accumulates events as SSE arrives; the replay path seeds them at hydrate time. A single `agentActive` boolean (live: SSE stream open; replay: always false) plus `runCompletedAt: number | undefined` captures everything the event stream can't express on its own.

**Tech Stack:** Zustand (vanilla), TypeScript strict, Vercel AI SDK `UIMessageStream`, Next.js App Router, Vitest.

---

## Context

Phase 4 shipped the unified `Event` log (`lib/log/types.ts`) and a replay path that feeds mutation + conversation events directly into the doc store and `useReplayMessages`. But the lifecycle derivation (`derivePhase` → `BuilderPhase` → layout, signal grid, status pill, completion celebration, etc.) reads from sessionStore shadow fields that only the **live** SSE path populates. Replay has no way to set those flags, so mid-replay chapters render the wrong layout (centered vs sidebar) and the wrong signal grid animation.

The event log is the durable debug artifact for every run. Apps are now first-class `AppDoc` entities — not reconstructed from the log — so the log's remaining jobs are (a) tell future-you what happened during a generation and (b) power replay. Anything needed to understand a run should live in the log; anything purely UI-facing does not.

The event log already encodes most of what the live path signposts redundantly over SSE:
- `MutationEvent.stage` tags (`"schema"`, `"scaffold"`, `"module:N"`, `"form:M-F"`, `"fix:attempt-N"`, `"edit:M-F"`, `"rename:M-F"`, `"module:create"`, `"module:remove:N"`) → current generation stage.
- `ConversationEvent` with `payload.type === "error"` → current classified error.
- Presence of `schema`/`scaffold` mutations in the run → initial build vs post-build edit.

One real gap: per-attempt validation error context. `data-fix-attempt` currently carries `{ attempt, errorCount, errors }` over SSE for the live UI but never lands in the log. The fix *mutations* do land (stage-tagged `fix:attempt-N`), but with no record of which errors each attempt was responding to. For a fix loop that took 3 iterations, the log today says "3 batches of fix mutations" and "final success" — you can't reconstruct which errors drove which fix. This plan promotes `data-fix-attempt` into the log as a new `validation-attempt` conversation payload — closing the debug gap AND giving both live and replay a single source of truth for the status message.

Net SSE cleanup: `data-partial-scaffold` is dead code (no emitter, no consumer — delete). `data-start-build`, `data-phase`, `data-error` carry zero information not already in the log (delete). `data-fix-attempt` is replaced by a log-persisted `validation-attempt` conversation event (keeps the info, moves it into the log).

## File Structure

**Created:**
- `lib/session/lifecycle.ts` — pure derivations (`deriveAgentStage`, `deriveAgentError`, `deriveValidationAttempt`, `deriveStatusMessage`, `derivePostBuildEdit`, plus `stageTagToGenerationStage` helper).
- `lib/session/__tests__/lifecycle.test.ts` — covers the derivation functions end-to-end over synthetic event streams.

**Modified:**
- `lib/log/types.ts` — add `validation-attempt` variant to `conversationPayloadSchema` (`{ type: "validation-attempt", attempt: number, errors: string[] }`). This is the only schema change in the plan; the migration script at `scripts/migrate-logs-to-events.ts` needs no change (legacy logs never carried this concept — old replays simply lack the annotation and the derivation gracefully returns null).
- `lib/session/store.ts` — add `events: Event[]` buffer, `pushEvents`, `pushEvent`, `replaceEvents`, `beginRun`, `endRun(success)`, `runCompletedAt`; delete `agentStage`, `agentError`, `statusMessage`, `postBuildEdit`, `justCompleted`, `partialScaffold`, and their setters (`advanceStage`, `failAgentWrite`, `setFixAttempt`, `acknowledgeCompletion` rewritten).
- `lib/session/types.ts` — delete `PartialScaffoldData` (unused).
- `lib/session/hooks.tsx` — rewrite `useAgentStage`, `useAgentError`, `useStatusMessage`, `usePostBuildEdit`, `useBuilderPhase`, `derivePhase` to read from events buffer. Delete `usePartialScaffold`. Add `useValidationAttempt`. Update `buildReplayMessages` to skip `validation-attempt` payloads (log-only annotation, not chat-visible).
- `lib/generation/streamDispatcher.ts` — delete `data-start-build`, `data-phase`, `data-fix-attempt`, `data-partial-scaffold`, `data-error` handlers. Add `data-conversation-event` handler. `data-mutations` also pushes `MutationEvent[]` into the buffer. `data-done` no longer calls `endAgentWrite` (the chat status effect owns run termination).
- `lib/agent/generationContext.ts` — `emitConversation` now also emits SSE `data-conversation-event`. `emitMutations` SSE payload includes `events: MutationEvent[]` alongside `mutations: Mutation[]`. Delete the `data-error` side-channel emission in `emitError` (conversation event replaces it).
- `lib/agent/solutionsArchitect.ts` — delete all `ctx.emit("data-start-build", ...)` / `ctx.emit("data-phase", ...)` calls from tool `onInputStart` / inline emissions.
- `lib/agent/validationLoop.ts` — delete `ctx.emit("data-phase", { phase: "fix" })` and `ctx.emit("data-fix-attempt", ...)`; replace the latter with `ctx.emitConversation({ type: "validation-attempt", attempt, errors: errors.map(errorToString) })` emitted at the start of each attempt, before the fix mutations.
- `app/api/chat/route.ts` — no direct change needed; route owns stream glue and doesn't emit lifecycle events itself.
- `components/chat/ChatContainer.tsx` — rewrite status effect to call `sessionStore.beginRun()` on `submitted`/`streaming` and `sessionStore.endRun(successful)` on `ready`. Rewrite `chatError` effect to synthesize a client-side conversation error event (network-level errors never reached the server). Toast firing moves from inline `data-error` case into the `data-conversation-event` handler.
- `components/chat/SignalGrid.tsx` — replace `postBuildEdit` + `agentActive` direct reads with their derived hook equivalents.
- `components/chat/ChatSidebar.tsx` — swap shallow-read of shadow fields for derived hooks.
- `components/chat/scaffoldProgress.ts` — drop `partialScaffold` field; rename `justCompleted` → `runCompletedAt !== undefined`.
- `components/builder/GenerationProgress.tsx` — no structural change; still reads `useAgentStage` / `useAgentError` / `useStatusMessage`, but those are now derived.
- `components/builder/BuilderProvider.tsx::ReplayHydrator` — replay `loadReplay` already seeds `replay.events`. Now also seeds `session.events` to the slice up through `initialCursor`.
- `components/builder/ReplayController.tsx::goToChapter` — after mutating the doc, also update `session.events` to reflect the new cursor's slice (so derivations re-evaluate).
- `hooks/useAutoSave.ts` — update `derivePhase` call signature.

**Tests modified:**
- `lib/session/__tests__/store.test.ts` — rewrite lifecycle-action tests for new action names + buffer behavior.
- `lib/session/__tests__/derivePhase.test.ts` — rewrite to pass events + flags instead of flat inputs.
- `lib/generation/__tests__/generationLifecycle.test.ts` — rewrite to drive the dispatcher with `data-mutations` / `data-conversation-event` instead of deleted lifecycle events; assert derived values.
- `lib/generation/__tests__/streamDispatcher.test.ts` — delete tests for removed event types; add tests for `data-conversation-event` and new `data-mutations` payload.
- `lib/generation/__tests__/streamDispatcher-mutations.test.ts` — update mutation payload assertions (now carries `events` too).
- `lib/agent/__tests__/generationContext-emitMutations.test.ts` — update SSE payload assertions.
- `lib/agent/__tests__/solutionsArchitect-emitMutations.test.ts` — update SSE assertions (no `data-start-build`, no `data-phase`).

---

## Task 1 — Delete dead `partialScaffold` code

Zero-risk cleanup. Nothing emits `data-partial-scaffold` server-side (verified via grep: no `emit("data-partial-scaffold"` calls anywhere). Nothing consumes `usePartialScaffold` (zero references). `scaffoldProgress` uses the field, but the branch is unreachable in practice because no producer exists.

**Files:**
- Modify: `lib/session/types.ts` — delete `PartialScaffoldData`.
- Modify: `lib/session/store.ts` — delete `partialScaffold` field, `setPartialScaffold` action, related reset/begin/end clears; delete `PartialScaffoldData` import.
- Modify: `lib/session/hooks.tsx` — delete `usePartialScaffold`, `PartialScaffoldData` import.
- Modify: `lib/generation/streamDispatcher.ts` — delete `parsePartialScaffold`, the `PartialScaffoldData` import, the `data-partial-scaffold` case in both `injectSignalEnergy` and category 3 switch.
- Modify: `components/chat/scaffoldProgress.ts` — delete `partialScaffold` from `ScaffoldProgressInput`, delete the `if (session.partialScaffold) return 0.55;` line.
- Modify: `components/chat/ChatSidebar.tsx` — delete `partialScaffold` from the shallow select.
- Modify: `lib/session/__tests__/store.test.ts` — delete `setPartialScaffold stores and clears scaffold data` test; remove `setPartialScaffold` calls from other tests.
- Modify: `lib/generation/__tests__/streamDispatcher.test.ts` — delete the `describe("data-partial-scaffold", ...)` block.

- [ ] **Step 1.1: Delete `PartialScaffoldData` from types**

In `lib/session/types.ts`, delete lines 60–76 (the `PartialScaffoldData` export and its preceding comment block).

- [ ] **Step 1.2: Delete partialScaffold from the store**

In `lib/session/store.ts`:
- Remove `PartialScaffoldData` from the `import { ... } from "./types"` block.
- Delete the `partialScaffold: PartialScaffoldData | undefined;` field on `BuilderSessionState`.
- Delete the `setPartialScaffold` action signature + its JSDoc block.
- Delete `partialScaffold: undefined as PartialScaffoldData | undefined,` from the initial state.
- Delete the `setPartialScaffold(data) { set({ partialScaffold: data }); }` implementation.
- Delete the `partialScaffold: undefined,` clears inside `beginAgentWrite` and `endAgentWrite`.
- Delete `partialScaffold: undefined,` from the `reset()` block.
- Delete the "Generation UI state (transient)" section heading comment + its preceding block comment (the `partialScaffold` section is the only member).

- [ ] **Step 1.3: Delete `usePartialScaffold`**

In `lib/session/hooks.tsx`:
- Remove `PartialScaffoldData` from `import { ... } from "./types"`.
- Delete the `usePartialScaffold` function + JSDoc (lines 183–185).

- [ ] **Step 1.4: Delete data-partial-scaffold from the dispatcher**

In `lib/generation/streamDispatcher.ts`:
- Remove `import type { PartialScaffoldData } from "@/lib/session/types";`.
- Delete the `parsePartialScaffold` function + its JSDoc block (entire `// ── Partial scaffold parser ──` section).
- Delete `case "data-partial-scaffold":` from `injectSignalEnergy`'s switch.
- Delete `case "data-partial-scaffold": { ... break; }` from the category-3 switch in `applyStreamEvent`.
- Remove the mention of `data-partial-scaffold` from the leading JSDoc (the "Session-only events" bullet).

- [ ] **Step 1.5: Delete scaffoldProgress partial branch**

In `components/chat/scaffoldProgress.ts`:
- Delete `PartialScaffoldData` from the `import { ... } from "@/lib/session/types"` line.
- Delete `partialScaffold: PartialScaffoldData | undefined;` from `ScaffoldProgressInput`.
- In the function body, delete `if (session.partialScaffold) return 0.55;` (inside the `Stage.Structure` branch).
- Update the JSDoc on `computeScaffoldProgress`: remove the `→ 0.55 (partial scaffold)` line from the Structure progress description.

- [ ] **Step 1.6: Drop partialScaffold from ChatSidebar shallow select**

In `components/chat/ChatSidebar.tsx`:
- In the `createGridController` function (around line 54), delete `partialScaffold: s.partialScaffold,` from the object passed to `computeScaffoldProgress`.

- [ ] **Step 1.7: Delete tests for removed surface**

In `lib/session/__tests__/store.test.ts`:
- Delete `it("setPartialScaffold stores and clears scaffold data", ...)`.
- Delete `import { type PartialScaffoldData, ... }` reference (keep other imports).
- Search the file for `setPartialScaffold` and `partialScaffold`: remove all remaining occurrences (there is one call inside a multi-action `endAgentWrite` test — delete that line; update the surrounding assertion if it asserted `partialScaffold: undefined`).

In `lib/generation/__tests__/streamDispatcher.test.ts`:
- Delete the `describe("data-partial-scaffold", ...)` block in its entirety.

- [ ] **Step 1.8: Run the checks**

Run each command independently and confirm green output:

```
npx tsc --noEmit && echo "✓"
npm run lint
npm test -- --run
```

Expected: all green. If `tsc` surfaces an unused-import error in `lib/session/store.ts`, re-check step 1.2 — the `PartialScaffoldData` import must be removed.

- [ ] **Step 1.9: Commit**

```
git add -A
git commit -m "refactor(session): remove dead partialScaffold surface

No server emits data-partial-scaffold and no component reads
usePartialScaffold — the field and its pipeline are a leftover from
the pre-Phase-3 scaffold-streaming design. Deleted across store,
hooks, dispatcher, scaffoldProgress, and tests."
```

---

## Task 2 — Add events buffer on the session store

Introduce the shared `Event[]` buffer + run lifecycle actions. Keep the existing shadow fields intact for now so all consumers stay functional while we add the buffer alongside. This task is additive — no field deletions, no consumer rewrites.

**Files:**
- Modify: `lib/session/store.ts` — add `events`, `pushEvents`, `pushEvent`, `beginRun`, `endRun` (coexists with `beginAgentWrite` / `endAgentWrite` — both cascade). No rename yet.
- Modify: `lib/session/__tests__/store.test.ts` — add tests for the new buffer API.

- [ ] **Step 2.1: Write failing tests for the buffer API**

Add to `lib/session/__tests__/store.test.ts` at the bottom of the file, in a new `describe("events buffer", ...)` block:

```typescript
describe("events buffer", () => {
  it("beginRun clears the events buffer and sets agentActive", () => {
    const store = createBuilderSessionStore();
    store.getState().pushEvents([makeMutationEvent("schema", 0)]);
    expect(store.getState().events).toHaveLength(1);

    store.getState().beginRun();
    expect(store.getState().events).toEqual([]);
    expect(store.getState().agentActive).toBe(true);
    expect(store.getState().runCompletedAt).toBeUndefined();
  });

  it("pushEvents appends in order", () => {
    const store = createBuilderSessionStore();
    store.getState().beginRun();
    const e1 = makeMutationEvent("schema", 0);
    const e2 = makeConversationEvent("assistant-text", "hi", 1);
    store.getState().pushEvents([e1, e2]);
    expect(store.getState().events).toEqual([e1, e2]);
  });

  it("endRun(true) stamps runCompletedAt and clears agentActive", () => {
    const store = createBuilderSessionStore();
    store.getState().beginRun();
    store.getState().endRun(true);
    expect(store.getState().agentActive).toBe(false);
    expect(store.getState().runCompletedAt).toEqual(expect.any(Number));
  });

  it("endRun(false) clears agentActive but does not stamp runCompletedAt", () => {
    const store = createBuilderSessionStore();
    store.getState().beginRun();
    store.getState().endRun(false);
    expect(store.getState().agentActive).toBe(false);
    expect(store.getState().runCompletedAt).toBeUndefined();
  });

  it("acknowledgeCompletion clears runCompletedAt", () => {
    const store = createBuilderSessionStore();
    store.getState().beginRun();
    store.getState().endRun(true);
    store.getState().acknowledgeCompletion();
    expect(store.getState().runCompletedAt).toBeUndefined();
  });
});
```

At the top of the file (alongside existing helpers or imports), add test factories:

```typescript
import type { ConversationPayload, Event } from "@/lib/log/types";

function makeMutationEvent(stage: string | undefined, seq: number): Event {
  return {
    kind: "mutation",
    runId: "test-run",
    ts: 0,
    seq,
    actor: "agent",
    ...(stage && { stage }),
    mutation: { kind: "setAppName", name: "x" },
  };
}

function makeConversationEvent(
  type: ConversationPayload["type"],
  text: string,
  seq: number,
): Event {
  let payload: ConversationPayload;
  switch (type) {
    case "user-message":
      payload = { type: "user-message", text };
      break;
    case "assistant-text":
      payload = { type: "assistant-text", text };
      break;
    case "assistant-reasoning":
      payload = { type: "assistant-reasoning", text };
      break;
    case "error":
      payload = {
        type: "error",
        error: { type: "internal", message: text, fatal: true },
      };
      break;
    default:
      throw new Error(`unsupported test payload type: ${type}`);
  }
  return { kind: "conversation", runId: "test-run", ts: 0, seq, payload };
}
```

- [ ] **Step 2.2: Run the tests — expect failures**

```
npm test -- --run lib/session/__tests__/store.test.ts
```

Expected: the five new tests fail with "store.getState().beginRun is not a function" (and similar).

- [ ] **Step 2.3: Implement the buffer + run lifecycle actions**

In `lib/session/store.ts`:

Add the `Event` import at the top:

```typescript
import type { Event } from "@/lib/log/types";
```

In `BuilderSessionState`, add (placed near the generation lifecycle group):

```typescript
  /** Event log buffer — the canonical stream of events visible to the
   *  current frame. Live mode appends as SSE arrives; replay mode seeds
   *  it from the persisted log slice through the current cursor. Lifecycle
   *  derivations (`deriveAgentStage`, `deriveAgentError`, etc. — added in
   *  Task 3) read this buffer. */
  events: Event[];

  /** Timestamp when the most recent run ended successfully. `undefined`
   *  while a run is active, after `acknowledgeCompletion` fires, or on
   *  fresh mounts. Drives the `Completed` phase and the signal grid's
   *  celebration animation. Replaces `justCompleted: boolean` with a
   *  stamp so future derivations can age-out via a delay rather than
   *  relying on an external timer. */
  runCompletedAt: number | undefined;
```

Add the actions to the interface (group with lifecycle):

```typescript
  /** Begin a new agent run. Clears the events buffer and `runCompletedAt`,
   *  cascades to `beginAgentWrite` to pause doc undo tracking. Called from
   *  `ChatContainer`'s chat status effect on `submitted`/`streaming`. */
  beginRun(): void;

  /** End the current agent run. `success=true` stamps `runCompletedAt` to
   *  trigger the celebration phase; `success=false` leaves it cleared
   *  (fatal errors keep the phase in Generating with the error surface).
   *  Cascades to `endAgentWrite` to resume doc undo tracking. */
  endRun(success: boolean): void;

  /** Append events to the buffer. Used by the stream dispatcher's
   *  `data-mutations` and `data-conversation-event` handlers (live) and
   *  by `ReplayController.goToChapter` (replay scrub). */
  pushEvents(events: Event[]): void;

  /** Append a single event. Convenience wrapper over `pushEvents`. */
  pushEvent(event: Event): void;
```

In the factory initial state, add:

```typescript
  /* Event buffer */
  events: [] as Event[],
  runCompletedAt: undefined as number | undefined,
```

Add the action implementations (place after `endAgentWrite`):

```typescript
  beginRun() {
    /* Preserve the existing undo-tracking semantics by cascading to
     * `beginAgentWrite`, then clear the buffer + completion stamp so the
     * new run starts with a fresh view. */
    get().beginAgentWrite();
    set({ events: [], runCompletedAt: undefined });
  },

  endRun(success: boolean) {
    /* Cascade to `endAgentWrite` for undo-tracking + shadow field
     * bookkeeping. `runCompletedAt` replaces `justCompleted` — we stamp a
     * timestamp here; downstream age-out logic (signal grid + BuilderLayout)
     * still owns the 3.5s decay window. */
    get().endAgentWrite();
    set({ runCompletedAt: success ? Date.now() : undefined });
  },

  pushEvents(events: Event[]) {
    if (events.length === 0) return;
    set((s) => ({ events: [...s.events, ...events] }));
  },

  pushEvent(event: Event) {
    set((s) => ({ events: [...s.events, event] }));
  },
```

In `acknowledgeCompletion`, also clear `runCompletedAt`:

```typescript
  acknowledgeCompletion() {
    if (!get().justCompleted && get().runCompletedAt === undefined) return;
    set({ justCompleted: false, runCompletedAt: undefined });
  },
```

In `reset()`, add:

```typescript
    events: [],
    runCompletedAt: undefined,
```

- [ ] **Step 2.4: Run the tests — expect green**

```
npm test -- --run lib/session/__tests__/store.test.ts
```

Expected: the five new tests pass; all existing tests still pass (the new surface is additive).

- [ ] **Step 2.5: Full verification**

```
npx tsc --noEmit && echo "✓"
npm run lint
```

Expected: both green.

- [ ] **Step 2.6: Commit**

```
git add -A
git commit -m "feat(session): add events buffer + run lifecycle actions

Introduces \`session.events: Event[]\` and paired \`beginRun\` / \`endRun\` /
\`pushEvents\` actions, plus \`runCompletedAt: number | undefined\`
alongside the existing \`justCompleted\` flag. Additive only — no
consumer changes yet. Task 3 drives derivations from this buffer and
removes the shadow fields it supersedes."
```

---

## Task 3 — Wire server + dispatcher to feed the buffer

Plumb events end-to-end so the client buffer mirrors the event log:
- Server `emitMutations` SSE payload includes the MutationEvent envelopes (with `stage` and `seq`).
- Server `emitConversation` also emits `data-conversation-event` over SSE.
- Server stops emitting `data-start-build` / `data-phase` / `data-fix-attempt` / `data-error`.
- Client `applyStreamEvent` pushes MutationEvents + conversation events into the buffer and fires toasts from the conversation-event handler.
- ChatContainer replaces `setAgentActive(active)` with `beginRun()` / `endRun(successful)`, and synthesizes a client-side conversation error event on network-level `chatError`.
- Replay hydrator + ReplayController mirror the cursor slice into `session.events`.

No derivation-facing consumer changes yet — shadow fields still written by the cascading `beginAgentWrite` / `endAgentWrite`.

**Files:**
- Modify: `lib/agent/generationContext.ts`
- Modify: `lib/agent/solutionsArchitect.ts`
- Modify: `lib/agent/validationLoop.ts`
- Modify: `lib/generation/streamDispatcher.ts`
- Modify: `components/chat/ChatContainer.tsx`
- Modify: `components/builder/BuilderProvider.tsx`
- Modify: `components/builder/ReplayController.tsx`
- Modify: `lib/generation/__tests__/streamDispatcher.test.ts`
- Modify: `lib/generation/__tests__/streamDispatcher-mutations.test.ts`
- Modify: `lib/generation/__tests__/generationLifecycle.test.ts`
- Modify: `lib/agent/__tests__/generationContext-emitMutations.test.ts`
- Modify: `lib/agent/__tests__/solutionsArchitect-emitMutations.test.ts`

- [ ] **Step 3.1: Extend `conversationPayloadSchema` with `validation-attempt`**

In `lib/log/types.ts`:

Add the new variant to the `conversationPayloadSchema` discriminated union. Insert it after the `error` variant (last position so the diff is localized):

```typescript
z.object({
  type: z.literal("validation-attempt"),
  attempt: z.number().int().positive(),
  errors: z.array(z.string()),
}),
```

Update the leading JSDoc on `conversationPayloadSchema` to describe the new variant:

```typescript
/**
 * Conversation payload discriminated union. One per chat-visible moment,
 * plus run annotations that don't surface in chat but matter for
 * debugging — `validation-attempt` records each CommCare validation
 * round's attempt number + human-readable error list, so a log reader
 * can reconstruct which errors drove which fix batch.
 *
 * `tool-call` + `tool-result` are paired by `toolCallId`; the result event
 * follows the call event in `ts` order when the tool finishes. `toolName`
 * is duplicated onto the result so downstream consumers don't need to
 * rebuild the pairing map for simple tool-usage counts.
 */
```

Confirm the generated TS type from `z.infer<typeof conversationPayloadSchema>` picks up the new variant:

```
npx tsc --noEmit && echo "✓"
```

Expected: green (this step is purely additive — no consumer reads `validation-attempt` yet).

- [ ] **Step 3.2: Server — emit events over SSE in `GenerationContext`**

In `lib/agent/generationContext.ts`:

Update the signature/doc of `emitMutations` — the SSE payload now carries the MutationEvent array alongside the raw mutations. Replace the method body:

```typescript
  emitMutations(mutations: Mutation[], stage?: string): void {
    if (mutations.length === 0) return;

    /* Build MutationEvent envelopes once; the same values go out on SSE
     * (client pushes to the events buffer) and the log writer. seq is
     * allocated monotonically per envelope. */
    const events: MutationEvent[] = mutations.map((mutation) => ({
      kind: "mutation",
      runId: this.usage.runId,
      ts: Date.now(),
      seq: this.seq++,
      actor: "agent",
      ...(stage && { stage }),
      mutation,
    }));

    this.writer.write({
      type: "data-mutations",
      data: {
        mutations,
        events,
        ...(stage !== undefined && { stage }),
      },
      transient: true,
    });
    this.saveBlueprint();
    for (const e of events) this.logWriter.logEvent(e);
  }
```

Delete the now-unused private `queueMutation` (it's replaced by the inline construction).

Update `emitConversation` — also emit SSE so the client can build the same buffer:

```typescript
  emitConversation(payload: ConversationPayload): void {
    const event: ConversationEvent = {
      kind: "conversation",
      runId: this.usage.runId,
      ts: Date.now(),
      seq: this.seq++,
      payload,
    };
    this.logWriter.logEvent(event);
    this.writer.write({
      type: "data-conversation-event",
      data: event,
      transient: true,
    });
  }
```

Update `emitError` — drop the `data-error` side channel now that the conversation event carries the same information (and reaches the client). The try/catch around `data-error` is no longer needed because `emitConversation` above doesn't throw on writer failure (AI SDK swallows). Keep the `log.error` fallback for observability:

```typescript
  emitError(error: ClassifiedError, context?: string): void {
    const payload: ClassifiedErrorPayload = {
      type: error.type,
      message: error.message,
      fatal: !error.recoverable,
    };
    try {
      this.emitConversation({ type: "error", error: payload });
    } catch (writerErr) {
      log.error("[emitError] failed to emit conversation event", writerErr, {
        errorMessage: error.message,
        context: context ?? "",
      });
    }
  }
```

Update the leading JSDoc block (the `// ── SSE` description) to mention `data-conversation-event` and to note that `data-error` was removed.

- [ ] **Step 3.3: Server — delete lifecycle SSE emissions, emit `validation-attempt`**

In `lib/agent/solutionsArchitect.ts`, delete every occurrence of these patterns:

```typescript
ctx.emit("data-start-build", {});
ctx.emit("data-phase", { phase: "..." });
```

Specifically (use Grep/Read to locate exact lines; deletions are of the full statement):
- `generateSchema.onInputStart` — both `data-start-build` and `data-phase: data-model`
- `generateScaffold.onInputStart` — `data-phase: structure`
- `addModule.onInputStart` — `data-phase: modules`
- `addQuestions.execute` — the `ctx.emit("data-phase", { phase: "forms" });` before `ctx.emitMutations`
- `validateApp.onInputStart` — `data-phase: validate`

If a tool's `onInputStart` becomes empty after deletion, remove the `onInputStart` option from the `tool({...})` call entirely.

In `lib/agent/validationLoop.ts`, replace the lifecycle SSE pair with a single persisted conversation event. The `data-phase: fix` emission is redundant with the `fix:attempt-N` stage tag on the mutations below, so it's deleted outright. The `data-fix-attempt` information moves into the log as a `validation-attempt` conversation event — same `attempt` + `errors` payload, but now durable and identically visible to replay.

Delete:

```typescript
ctx.emit("data-phase", { phase: "fix" });
ctx.emit("data-fix-attempt", {
  attempt,
  errorCount: errors.length,
  errors: errors.map(errorToString),
});
```

In its place, emit the new conversation payload:

```typescript
/* Log one validation-attempt conversation event per fix round. The
 * attempt number + human-readable error list land in both the event
 * log (for debugging — answers "which errors drove which fix batch?")
 * and the SSE stream (so live UI can surface "Fixing K errors, attempt
 * N" from the same derivation replay uses). Must run BEFORE
 * emitMutations so a consumer that's tracking the event stream sees
 * the validation context before the fix mutations land. */
ctx.emitConversation({
  type: "validation-attempt",
  attempt,
  errors: errors.map(errorToString),
});
```

(Keep the `ctx.emitMutations(allMutations, \`fix:attempt-${attempt}\`);` call immediately below — it's load-bearing.)

- [ ] **Step 3.4: Client — rewrite `applyStreamEvent`**

In `lib/generation/streamDispatcher.ts`:

Replace `injectSignalEnergy` to match the new event universe — `data-mutations` stays the high-energy signal; `data-blueprint-updated` still fires 100; add `data-conversation-event` at 50 so the grid pulses on assistant chatter; delete the rows for removed events:

```typescript
function injectSignalEnergy(type: string): void {
  switch (type) {
    case "data-mutations":
      signalGrid.injectEnergy(200);
      break;
    case "data-blueprint-updated":
      signalGrid.injectEnergy(100);
      break;
    case "data-conversation-event":
      signalGrid.injectEnergy(50);
      break;
  }
}
```

Rewrite `applyStreamEvent`. Replace the entire function body with:

```typescript
export function applyStreamEvent(
  type: string,
  data: Record<string, unknown>,
  docStore: BlueprintDocStoreApi,
  sessionStore: BuilderSessionStoreApi,
): void {
  injectSignalEnergy(type);

  // ── Live doc mutation batch ───────────────────────────────────────
  //
  // `data-mutations` carries a raw `Mutation[]` for the doc store AND the
  // corresponding `MutationEvent[]` envelopes for the session events
  // buffer. The client applies the mutations atomically via `applyMany`
  // (one zundo-grouped undo entry) and pushes the envelopes onto the
  // events buffer so derivations see the stage tags.
  if (type === "data-mutations") {
    const mutations = data.mutations as Mutation[] | undefined;
    const events = data.events as MutationEvent[] | undefined;
    if (mutations && mutations.length > 0) {
      docStore.getState().applyMany(mutations);
    }
    if (events && events.length > 0) {
      sessionStore.getState().pushEvents(events);
    }
    return;
  }

  // ── Conversation event ────────────────────────────────────────────
  //
  // Every server-emitted ConversationEvent arrives here. The session
  // buffer receives it verbatim; if the payload is a classified error,
  // fire a toast as a UX aid (the signal grid already reacts via the
  // derived `agentError`).
  if (type === "data-conversation-event") {
    const event = data as unknown as ConversationEvent;
    sessionStore.getState().pushEvent(event);
    if (event.payload.type === "error") {
      showToast(
        event.payload.error.fatal ? "error" : "warning",
        "Generation error",
        event.payload.error.message,
      );
    }
    return;
  }

  // ── Doc lifecycle (full-doc replacements) ────────────────────────
  if (type === "data-done") {
    const doc = data.doc as PersistableDoc | undefined;
    if (doc) docStore.getState().load(doc);
    /* Run termination (agentActive false → runCompletedAt stamp) is
     * owned by ChatContainer's chat-status effect — it fires on
     * `status === 'ready'`, which the AI SDK signals after the stream
     * closes. Emitting `endRun` here would double-stamp and could race
     * with that effect. The load() call above is the only responsibility
     * of this handler now. */
    return;
  }
  if (type === "data-blueprint-updated") {
    const doc = data.doc as PersistableDoc | undefined;
    if (doc) {
      docStore.getState().load(doc);
      docStore.getState().endAgentWrite();
    }
    return;
  }
  // Any other transient event type is ignored. `data-run-id` and
  // `data-app-saved` are handled inline in ChatContainer.
}
```

Add the required imports:

```typescript
import type { ConversationEvent, MutationEvent } from "@/lib/log/types";
import { showToast } from "@/lib/services/toastStore";
```

Remove all now-unused imports: `PartialScaffoldData` (gone from Task 1), and anything referencing the deleted parser.

Update the top-of-file JSDoc to reflect the new event universe (three categories: mutation batch, conversation event, full-doc replacement; lifecycle is derived).

- [ ] **Step 3.5: Client — rewrite `ChatContainer` status + chatError effects**

In `components/chat/ChatContainer.tsx`:

Change `onData` — `data-app-saved` no longer needs to pass through `applyStreamEvent` for anything non-trivial (the dispatcher's only side effect on that type was `setAppId`, and we can do it inline). Simplify:

```typescript
onData: (part) => {
  const { type, data } = part as {
    type: string;
    data: Record<string, unknown>;
  };
  if (type === "data-run-id") {
    runIdRef.current = data.runId as string;
    return;
  }

  const docApi = docStoreRef.current;
  const sessionApi = sessionStoreRef.current;
  if (!docApi || !sessionApi) return;

  if (type === "data-app-saved") {
    sessionApi.getState().setAppId(data.appId as string);
    window.history.replaceState({}, "", `/build/${data.appId as string}`);
    return;
  }

  applyStreamEvent(type, data, docApi, sessionApi);
},
```

Rewrite the chat transport status effect to drive `beginRun` / `endRun` and to capture the error state at the moment of transition:

```typescript
/* Drive run lifecycle from chat transport status. `submitted` and
 * `streaming` both mean the stream is open; on the first transition into
 * either, begin a new run (clears events + runCompletedAt, sets
 * agentActive=true). On the transition back to `ready`, end the run —
 * `success=true` iff no fatal conversation error landed during the run,
 * so we drop into the Completed celebration rather than freezing on the
 * failure UI. Also stamps `lastResponseAtRef` so the next request can
 * decide if the Anthropic prompt cache is still warm. */
useEffect(() => {
  if (!sessionApi) return;
  const active = status === "submitted" || status === "streaming";
  const session = sessionApi.getState();
  const wasActive = session.agentActive;
  if (active && !wasActive) {
    session.beginRun();
  } else if (!active && wasActive) {
    const events = session.events;
    const fatal = events.some(
      (e) => e.kind === "conversation" && e.payload.type === "error" && e.payload.error.fatal,
    );
    session.endRun(!fatal);
    if (status === "ready") {
      lastResponseAtRef.current = new Date().toISOString();
    }
  }
}, [status, sessionApi]);
```

Rewrite the `chatError` effect to synthesize a client-side conversation event instead of mutating `agentError` directly (that field still exists after this task, but the derivation in Task 4 will read events). Fire a toast as well:

```typescript
/* useChat surfaces network-level failures via `error` (unauth, 500, spend
 * cap, connection drops). The server never got a chance to emit a
 * conversation error event in those cases, so we synthesize one
 * client-side and push it into the buffer — the lifecycle derivation
 * then picks it up identically to a server-emitted error. Toast is fired
 * here too because the synthetic event doesn't flow through the
 * dispatcher. */
useEffect(() => {
  if (!chatError || !sessionApi) return;
  const message = parseApiErrorMessage(chatError.message);
  const session = sessionApi.getState();
  const runId = runIdRef.current ?? "client-error";
  const existingSeq = session.events.length;
  session.pushEvent({
    kind: "conversation",
    runId,
    ts: Date.now(),
    seq: existingSeq,
    payload: {
      type: "error",
      error: { type: "network", message, fatal: true },
    },
  });
  showToast("error", "Generation failed", message);
}, [chatError, sessionApi]);
```

At the top of the file, add imports if not already present:

```typescript
import { showToast } from "@/lib/services/toastStore";
```

- [ ] **Step 3.6: Replay hydrator — seed `session.events` alongside `replay`**

In `components/builder/BuilderProvider.tsx::ReplayHydrator`:

After the existing `sessionStore.getState().loadReplay({...})` call, push the initial-cursor slice into the events buffer so lifecycle derivations see the same frame the doc store reflects:

```typescript
/* Mirror the replayed events into the session buffer so Task-4
 * lifecycle derivations see exactly what the doc store reflects. The
 * slice is `[0, initialCursor]` inclusive, matching the replay loop's
 * `events.slice(0, initialCursor + 1)` call below. */
sessionStore
  .getState()
  .pushEvents(replay.events.slice(0, replay.initialCursor + 1));
```

Place this call immediately after `loadReplay` and before the `replayEventsSync` call.

- [ ] **Step 3.7: Replay controller — refresh the buffer on scrub**

In `components/builder/ReplayController.tsx::goToChapter`:

After `replayEventsSync(slice, ...)` and before `setReplayCursor`, replace the session events buffer with the new slice so derivations re-evaluate:

```typescript
/* Replace the events buffer so lifecycle derivations reflect the
 * chapter's terminal frame. The store's `events` is reset (not
 * appended) because scrub is a full reconstruction, not a delta. */
sessionStore.getState().replaceEvents(events.slice(0, chapter.endIndex + 1));
```

Add the `replaceEvents` action to `lib/session/store.ts` (additive):

```typescript
  /** Replace the events buffer wholesale. Used by `ReplayController`
   *  when scrubbing — every scrub is a full reconstruction, not a
   *  delta, so appending would corrupt the buffer. Not exposed for
   *  live code; the dispatcher always uses `pushEvents`. */
  replaceEvents(events: Event[]): void;
```

Implementation:

```typescript
  replaceEvents(events: Event[]) {
    set({ events });
  },
```

And update `BuilderSessionState`.

- [ ] **Step 3.8: Update dispatcher tests**

In `lib/generation/__tests__/streamDispatcher.test.ts`:
- Delete the `describe("data-start-build", ...)`, `describe("data-phase", ...)`, `describe("data-fix-attempt", ...)`, `describe("data-error", ...)` blocks entirely.
- Add a `describe("data-conversation-event", ...)` block covering: (a) pushes the event onto the buffer; (b) fires an error toast when payload is `error`.
- Update any existing `data-mutations` test that asserts on payload shape: now the payload includes `events: MutationEvent[]` too; assertions should check that the buffer grew by that many events.

In `lib/generation/__tests__/streamDispatcher-mutations.test.ts`:
- Update payload construction to include the `events` field (match the new server shape).
- Add assertions that `sessionStore.getState().events` grew by the expected count.

- [ ] **Step 3.9: Update `generationLifecycle.test.ts`**

In `lib/generation/__tests__/generationLifecycle.test.ts`:
- Delete every `emit("data-start-build", ...)`, `emit("data-phase", ...)`, `emit("data-fix-attempt", ...)`, `emit("data-error", ...)` call.
- Replace with equivalent buffer-seeding: call `sessionStore.getState().beginRun()` before the first mutation and `endRun(true)` at the end. Mutations arrive via `emit("data-mutations", ...)` with `stage` set, carrying a fabricated `MutationEvent[]` (use the helper from Task 2).
- Update the phase-assertion helper to read from the derivation added in Task 4 (stub a local shim for now: `derivePhase({ loading, agentActive, runCompletedAt, events }, docHasData)`).

- [ ] **Step 3.10: Update agent emission tests**

In `lib/agent/__tests__/generationContext-emitMutations.test.ts` and `lib/agent/__tests__/solutionsArchitect-emitMutations.test.ts`:
- Remove assertions about `ctx.emit("data-start-build"` / `data-phase"`.
- Add assertions that each `emitMutations` call writes SSE with both `mutations` AND `events` arrays, and that each `emitConversation` call writes an SSE `data-conversation-event`.

- [ ] **Step 3.11: Full verification**

```
npx tsc --noEmit && echo "✓"
npm run lint
npm test -- --run
```

Expected: all green. A handful of tests currently assert on `agentStage` / `statusMessage` values that Task 4 will stop writing — in this step those assertions still pass because the shadow fields remain populated by the legacy cascade.

- [ ] **Step 3.12: Commit**

```
git add -A
git commit -m "refactor(stream): route events through a shared buffer

\`emitMutations\` now carries MutationEvent envelopes on the SSE payload
alongside the raw mutations; \`emitConversation\` emits
\`data-conversation-event\` so the client can mirror the persisted
event log. The client pushes both into the new session events buffer.

\`data-start-build\`, \`data-phase\`, \`data-fix-attempt\`, and \`data-error\`
are deleted from the wire — their information is fully derivable from
mutation stage tags and conversation payloads. Run lifecycle is driven
from the chat transport status (begin/end) rather than stream
signposts. Replay hydrator + ReplayController mirror the cursor slice
into the buffer so derivations land on the same frame as the doc."
```

---

## Task 4 — Derive lifecycle from the buffer; delete shadow fields

All consumers already accept the derived hook surface (same names, same signatures). In this task we rewrite the derivations to read from the events buffer and delete the shadow-field infrastructure.

**Files:**
- Create: `lib/session/lifecycle.ts`
- Create: `lib/session/__tests__/lifecycle.test.ts`
- Modify: `lib/session/store.ts` (delete deprecated fields/actions)
- Modify: `lib/session/types.ts` (delete unused exports)
- Modify: `lib/session/hooks.tsx` (rewrite phase + stage + error + status hooks)
- Modify: `hooks/useAutoSave.ts` (update `derivePhase` call signature)
- Modify: `components/chat/ChatSidebar.tsx`
- Modify: `components/chat/SignalGrid.tsx`
- Modify: `components/chat/scaffoldProgress.ts`
- Modify: `components/builder/GenerationProgress.tsx`
- Modify: `lib/session/__tests__/derivePhase.test.ts`
- Modify: `lib/session/__tests__/store.test.ts` (drop deleted-field tests)

- [ ] **Step 4.1: Write failing tests for the derivation module**

Create `lib/session/__tests__/lifecycle.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Event } from "@/lib/log/types";
import {
  deriveAgentError,
  deriveAgentStage,
  derivePostBuildEdit,
  deriveStatusMessage,
  deriveValidationAttempt,
  stageTagToGenerationStage,
} from "../lifecycle";
import { GenerationStage, STAGE_LABELS } from "../types";

function mut(stage: string | undefined, seq = 0): Event {
  return {
    kind: "mutation",
    runId: "r",
    ts: 0,
    seq,
    actor: "agent",
    ...(stage && { stage }),
    mutation: { kind: "setAppName", name: "x" },
  };
}
function err(message: string, fatal: boolean, seq = 0): Event {
  return {
    kind: "conversation",
    runId: "r",
    ts: 0,
    seq,
    payload: {
      type: "error",
      error: { type: "internal", message, fatal },
    },
  };
}
function validationAttempt(attempt: number, errors: string[], seq = 0): Event {
  return {
    kind: "conversation",
    runId: "r",
    ts: 0,
    seq,
    payload: { type: "validation-attempt", attempt, errors },
  };
}

describe("stageTagToGenerationStage", () => {
  it("maps schema/scaffold/module:/form:/fix:", () => {
    expect(stageTagToGenerationStage("schema")).toBe(GenerationStage.DataModel);
    expect(stageTagToGenerationStage("scaffold")).toBe(GenerationStage.Structure);
    expect(stageTagToGenerationStage("module:0")).toBe(GenerationStage.Modules);
    expect(stageTagToGenerationStage("form:0-1")).toBe(GenerationStage.Forms);
    expect(stageTagToGenerationStage("fix:attempt-2")).toBe(GenerationStage.Fix);
  });
  it("returns null for edit-family tags", () => {
    expect(stageTagToGenerationStage("edit:0-1")).toBeNull();
    expect(stageTagToGenerationStage("rename:0-1")).toBeNull();
    expect(stageTagToGenerationStage("module:create")).toBeNull();
  });
});

describe("deriveAgentStage", () => {
  it("returns null on empty buffer", () => {
    expect(deriveAgentStage([])).toBeNull();
  });
  it("tracks the latest stage tag across the run", () => {
    expect(
      deriveAgentStage([mut("schema", 0), mut("scaffold", 1), mut("module:0", 2)]),
    ).toBe(GenerationStage.Modules);
  });
  it("skips mutations without stage tags", () => {
    expect(deriveAgentStage([mut(undefined, 0), mut("schema", 1)])).toBe(
      GenerationStage.DataModel,
    );
  });
});

describe("deriveAgentError", () => {
  it("returns null with no errors", () => {
    expect(deriveAgentError([mut("schema")])).toBeNull();
  });
  it("returns the latest error with correct severity", () => {
    expect(deriveAgentError([err("x", false, 0)])).toEqual({
      message: "x",
      severity: "recovering",
    });
    expect(deriveAgentError([err("x", true, 0)])).toEqual({
      message: "x",
      severity: "failed",
    });
  });
  it("clears on non-error conversation event after an error", () => {
    const events: Event[] = [
      err("bad", false, 0),
      { kind: "conversation", runId: "r", ts: 0, seq: 1,
        payload: { type: "assistant-text", text: "recovered" } },
    ];
    expect(deriveAgentError(events)).toBeNull();
  });
});

describe("deriveValidationAttempt", () => {
  it("returns null with no validation-attempt events", () => {
    expect(deriveValidationAttempt([mut("schema", 0)])).toBeNull();
  });
  it("returns the latest attempt + errorCount", () => {
    expect(
      deriveValidationAttempt([
        validationAttempt(1, ["e1", "e2"], 0),
        validationAttempt(2, ["e3"], 1),
      ]),
    ).toEqual({ attempt: 2, errorCount: 1 });
  });
  it("ignores earlier runs (buffer only holds current-run events)", () => {
    // beginRun clears the buffer, so this test documents the contract —
    // if you see two validation-attempt events, they're from the same run
    // and the later one wins.
    expect(
      deriveValidationAttempt([
        validationAttempt(1, [], 0),
        validationAttempt(2, ["x"], 1),
        validationAttempt(3, ["a", "b", "c"], 2),
      ]),
    ).toEqual({ attempt: 3, errorCount: 3 });
  });
});

describe("derivePostBuildEdit", () => {
  it("false when not active", () => {
    expect(derivePostBuildEdit([], false, true)).toBe(false);
  });
  it("false during initial build (schema/scaffold present)", () => {
    expect(derivePostBuildEdit([mut("schema", 0)], true, false)).toBe(false);
    expect(derivePostBuildEdit([mut("scaffold", 0)], true, true)).toBe(false);
  });
  it("true when active, no generation stages, doc has data", () => {
    expect(derivePostBuildEdit([mut("edit:0-1", 0)], true, true)).toBe(true);
  });
  it("false when active, no generation stages, doc empty (askQuestions phase)", () => {
    expect(derivePostBuildEdit([], true, false)).toBe(false);
  });
});

describe("deriveStatusMessage", () => {
  it("returns empty string when idle", () => {
    expect(deriveStatusMessage(null, null, null)).toBe("");
  });
  it("returns stage label", () => {
    expect(deriveStatusMessage(GenerationStage.Structure, null, null)).toBe(
      STAGE_LABELS[GenerationStage.Structure],
    );
  });
  it("composes stage=Fix with attempt + errorCount", () => {
    expect(
      deriveStatusMessage(GenerationStage.Fix, null, { attempt: 2, errorCount: 3 }),
    ).toBe("Fixing 3 errors, attempt 2");
  });
  it("singular error message", () => {
    expect(
      deriveStatusMessage(GenerationStage.Fix, null, { attempt: 1, errorCount: 1 }),
    ).toBe("Fixing 1 error, attempt 1");
  });
  it("falls back to stage label when Fix without validation-attempt context", () => {
    expect(deriveStatusMessage(GenerationStage.Fix, null, null)).toBe(
      STAGE_LABELS[GenerationStage.Fix],
    );
  });
  it("prefers error message over stage label", () => {
    expect(
      deriveStatusMessage(GenerationStage.Forms, { message: "boom", severity: "failed" }, null),
    ).toBe("boom");
  });
});
```

- [ ] **Step 4.2: Run the tests — expect failures**

```
npm test -- --run lib/session/__tests__/lifecycle.test.ts
```

Expected: all tests fail because `lib/session/lifecycle.ts` doesn't exist.

- [ ] **Step 4.3: Create `lib/session/lifecycle.ts`**

```typescript
/**
 * Lifecycle derivations over the session events buffer.
 *
 * These pure functions are the single source of truth for every UI
 * lifecycle signal: generation stage, classified error, status message,
 * validation attempt context, postBuildEdit latch. Both live and replay
 * paths feed the same `Event[]` into these functions — if the buffer
 * matches, the rendered layout matches.
 *
 * Implementation note — each derivation walks the buffer every call,
 * but the buffer is only appended to, so the cost is O(events). For
 * realistic runs (~1000 events) this is well under a millisecond.
 * Callers cache via `useMemo` where React re-renders demand it.
 */

import type { Event } from "@/lib/log/types";
import type { GenerationError } from "./types";
import { GenerationStage, STAGE_LABELS } from "./types";

/**
 * Map an event-log `stage` tag to the `GenerationStage` enum. Only tags
 * that belong to an initial-build phase resolve — edit-family tags
 * (`edit:*`, `rename:*`, `module:create`, `module:remove:*`) return null
 * so the phase derivation can distinguish post-build edits.
 */
export function stageTagToGenerationStage(
  stage: string,
): GenerationStage | null {
  if (stage === "schema") return GenerationStage.DataModel;
  if (stage === "scaffold") return GenerationStage.Structure;
  if (stage.startsWith("module:")) {
    // module:create + module:remove:N are edit-mode tags, not generation
    if (stage === "module:create") return null;
    if (stage.startsWith("module:remove:")) return null;
    return GenerationStage.Modules;
  }
  if (stage.startsWith("form:")) return GenerationStage.Forms;
  if (stage.startsWith("fix")) return GenerationStage.Fix;
  return null;
}

/**
 * Latest generation stage in the buffer. Returns null when no mutation
 * events carry a recognized stage tag, which is the "SA is thinking /
 * askQuestions" window. `derivePhase` treats null-stage-while-active as
 * Idle (centered chat layout) — the phase only transitions to Generating
 * once the SA actually starts producing structural output.
 */
export function deriveAgentStage(
  events: readonly Event[],
): GenerationStage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "mutation" || !e.stage) continue;
    const resolved = stageTagToGenerationStage(e.stage);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * Latest classified error on the buffer. Cleared by any newer
 * non-error conversation event — a successful fix attempt that produces
 * fresh assistant output naturally clears the "recovering" warning.
 */
export function deriveAgentError(events: readonly Event[]): GenerationError {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "conversation") continue;
    if (e.payload.type !== "error") return null;
    return {
      message: e.payload.error.message,
      severity: e.payload.error.fatal ? "failed" : "recovering",
    };
  }
  return null;
}

/**
 * Latest `validation-attempt` conversation event in the buffer — carries
 * the attempt number and the count of errors that attempt was trying to
 * fix. Returns null when no validation pass has run in the current run
 * (the buffer is cleared by `beginRun`, so prior runs never leak in).
 *
 * Used by `deriveStatusMessage` to compose "Fixing N errors, attempt M"
 * and by the log reader / admin inspector to reconstruct which errors
 * drove which fix batch.
 */
export function deriveValidationAttempt(
  events: readonly Event[],
): { attempt: number; errorCount: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "conversation") continue;
    if (e.payload.type !== "validation-attempt") continue;
    return {
      attempt: e.payload.attempt,
      errorCount: e.payload.errors.length,
    };
  }
  return null;
}

/**
 * Whether the active run is a post-build edit. True iff the run is
 * active, no `schema` or `scaffold` mutation has landed yet, AND the
 * doc already has data. The doc-has-data check catches the askQuestions
 * window (doc empty → still Idle / not edit), which is the same
 * semantics the pre-refactor latch carried.
 */
export function derivePostBuildEdit(
  events: readonly Event[],
  agentActive: boolean,
  docHasData: boolean,
): boolean {
  if (!agentActive) return false;
  for (const e of events) {
    if (e.kind !== "mutation" || !e.stage) continue;
    if (e.stage === "schema" || e.stage === "scaffold") return false;
  }
  return docHasData;
}

/**
 * Status message shown in the signal panel bezel. Errors win over
 * stage labels; `Fix` stage composes "Fixing N errors, attempt M" when
 * a `validation-attempt` event is available, and falls back to the
 * generic `STAGE_LABELS[Fix]` otherwise (e.g. pre-first-attempt window).
 */
export function deriveStatusMessage(
  stage: GenerationStage | null,
  error: GenerationError,
  validationAttempt: { attempt: number; errorCount: number } | null,
): string {
  if (error) return error.message;
  if (!stage) return "";
  if (stage === GenerationStage.Fix && validationAttempt) {
    const { attempt, errorCount } = validationAttempt;
    const plural = errorCount === 1 ? "error" : "errors";
    return `Fixing ${errorCount} ${plural}, attempt ${attempt}`;
  }
  return STAGE_LABELS[stage];
}
```

- [ ] **Step 4.4: Re-run lifecycle tests**

```
npm test -- --run lib/session/__tests__/lifecycle.test.ts
```

Expected: all derivation tests pass.

- [ ] **Step 4.5: Rewrite `derivePhase` and the named hooks**

In `lib/session/hooks.tsx`:

Replace the `DerivePhaseSession`, `derivePhase`, and `useBuilderPhase` exports with the new signatures:

```typescript
import type { Event } from "@/lib/log/types";
import {
  deriveAgentError,
  deriveAgentStage,
  derivePostBuildEdit,
  deriveStatusMessage,
  deriveValidationAttempt,
} from "./lifecycle";

/** Session slice required by `derivePhase`. Kept as a struct so unit
 *  tests don't need a full store. */
export interface DerivePhaseSession {
  loading: boolean;
  agentActive: boolean;
  runCompletedAt: number | undefined;
  events: readonly Event[];
}

/**
 * Derive the builder lifecycle phase from session + doc state.
 *
 * Priority chain: Loading > Completed > Generating > Ready > Idle.
 *
 * - Loading — hydration in progress.
 * - Completed — `runCompletedAt` stamped (3.5s celebration window).
 * - Generating — run active, first generation-stage mutation landed,
 *   and this is not a post-build edit.
 * - Ready — doc has data.
 * - Idle — otherwise (fresh builder or SA in askQuestions mid-run).
 */
export function derivePhase(
  session: DerivePhaseSession,
  docHasData: boolean,
): BuilderPhase {
  if (session.loading) return BuilderPhase.Loading;
  if (session.runCompletedAt !== undefined) return BuilderPhase.Completed;

  const stage = deriveAgentStage(session.events);
  const postBuildEdit = derivePostBuildEdit(
    session.events,
    session.agentActive,
    docHasData,
  );
  if (session.agentActive && !postBuildEdit && stage !== null) {
    return BuilderPhase.Generating;
  }
  if (docHasData) return BuilderPhase.Ready;
  return BuilderPhase.Idle;
}

export function useBuilderPhase(): BuilderPhase {
  const session = useBuilderSessionShallow((s) => ({
    loading: s.loading,
    agentActive: s.agentActive,
    runCompletedAt: s.runCompletedAt,
    events: s.events,
  }));
  const hasData = useBlueprintDoc(docHasData);
  return derivePhase(session, hasData);
}
```

Rewrite the individual-signal hooks so they read from the buffer:

```typescript
export function useAgentStage(): GenerationStage | null {
  const events = useBuilderSession((s) => s.events);
  return useMemo(() => deriveAgentStage(events), [events]);
}

export function useAgentError(): GenerationError {
  const events = useBuilderSession((s) => s.events);
  return useMemo(() => deriveAgentError(events), [events]);
}

export function useValidationAttempt():
  | { attempt: number; errorCount: number }
  | null {
  const events = useBuilderSession((s) => s.events);
  return useMemo(() => deriveValidationAttempt(events), [events]);
}

export function useStatusMessage(): string {
  const events = useBuilderSession((s) => s.events);
  return useMemo(() => {
    const stage = deriveAgentStage(events);
    const error = deriveAgentError(events);
    const attempt = deriveValidationAttempt(events);
    return deriveStatusMessage(stage, error, attempt);
  }, [events]);
}

export function usePostBuildEdit(): boolean {
  const events = useBuilderSession((s) => s.events);
  const agentActive = useBuilderSession((s) => s.agentActive);
  const hasData = useBlueprintDoc(docHasData);
  return useMemo(
    () => derivePostBuildEdit(events, agentActive, hasData),
    [events, agentActive, hasData],
  );
}
```

Finally, update `buildReplayMessages` in the same file to skip `validation-attempt` events — they're run annotations meant for the log, not chat-visible artifacts. Inside the per-payload `switch`, after the `error` case, add an explicit skip:

```typescript
case "validation-attempt":
  /* Log-only annotation — the signal panel surfaces the info via
   * deriveStatusMessage; the chat view stays focused on
   * user/assistant/tool content. */
  break;
```

Alternatively (equivalent), handle it at the top of the loop alongside the `user-message` branch with a `continue`. Either placement is fine; pick the one that reads clearest in the actual file.

- [ ] **Step 4.6: Delete shadow fields from the session store**

In `lib/session/store.ts`:
- Delete from the interface: `agentStage`, `agentError`, `statusMessage`, `postBuildEdit`, `justCompleted`.
- Delete actions: `advanceStage`, `failAgentWrite`, `setFixAttempt`.
- Keep: `beginAgentWrite`, `endAgentWrite` (still cascade undo tracking). Rewrite their bodies to no longer set the shadow fields:

```typescript
  beginAgentWrite(stage?: GenerationStage) {
    void stage; // signature preserved for doc-undo cascade compatibility
    docStoreRef?.getState().beginAgentWrite();
    /* Run lifecycle state (events buffer, runCompletedAt) is owned by
     * beginRun/endRun — this helper only pauses doc undo tracking. */
  },

  endAgentWrite() {
    docStoreRef?.getState().endAgentWrite();
  },
```

- Rewrite `setAgentActive` — no `postBuildEdit` to latch any more:

```typescript
  setAgentActive(active: boolean) {
    if (active === get().agentActive) return;
    set({ agentActive: active });
  },
```

- Rewrite `acknowledgeCompletion` — clears only `runCompletedAt`:

```typescript
  acknowledgeCompletion() {
    if (get().runCompletedAt === undefined) return;
    set({ runCompletedAt: undefined });
  },
```

- Delete the shadow field initializers from the initial state and from `reset()`.
- Remove the `parseStage` helper + `STAGE_LABELS` import if no longer used.

- [ ] **Step 4.7: Update consumers that read shadow fields directly**

Many components read the shadow fields via named hooks (`useAgentStage`, `useAgentError`, `useStatusMessage`, `usePostBuildEdit`). Those calls continue to work — only the implementations changed. But a few places read the store state directly via `useBuilderSessionShallow`:

In `components/chat/ChatSidebar.tsx`, replace the shallow-read of `agentError`/`agentStage`/`agentActive`/`postBuildEdit`/`statusMessage` with the named derived hooks:

```typescript
const agentError = useAgentError();
const agentStage = useAgentStage();
const agentActive = useAgentActive();
const postBuildEdit = usePostBuildEdit();
const statusMessage = useStatusMessage();
```

Add the imports accordingly.

In `components/chat/SignalGrid.tsx`:

Inside the effect, the `s.postBuildEdit && s.agentActive` check reads the session imperatively. Replace with:

```typescript
const session = sessionApiRef.current.getState();
const docState = docStoreRef.current?.getState();
const postBuildEdit = docState
  ? derivePostBuildEdit(session.events, session.agentActive, docHasData(docState))
  : false;
if (postBuildEdit && session.agentActive) {
  ...
}
```

Import `derivePostBuildEdit` from `@/lib/session/lifecycle` and `docHasData` from `@/lib/doc/predicates`.

In `components/chat/scaffoldProgress.ts`:
- Drop `justCompleted: boolean` from `ScaffoldProgressInput`; add `runCompletedAt: number | undefined`.
- Where the branch reads `session.justCompleted`, read `session.runCompletedAt !== undefined`.

In `components/chat/ChatSidebar.tsx` within `createGridController`, update the session slice passed to `computeScaffoldProgress`:

```typescript
const s = sessionRef.current.getState();
return computeScaffoldProgress(
  {
    agentStage: deriveAgentStage(s.events),
    agentActive: s.agentActive,
    postBuildEdit: derivePostBuildEdit(
      s.events,
      s.agentActive,
      (docStoreRef.current?.getState().moduleOrder.length ?? 0) > 0,
    ),
    runCompletedAt: s.runCompletedAt,
    loading: s.loading,
  },
  docStoreRef.current?.getState(),
);
```

- [ ] **Step 4.8: Update `useAutoSave`**

In `hooks/useAutoSave.ts`:

Replace the `derivePhase(sessionState, docHasData(docSnap))` call with the new struct-shape argument:

```typescript
const phase = derivePhase(
  {
    loading: sessionState.loading,
    agentActive: sessionState.agentActive,
    runCompletedAt: sessionState.runCompletedAt,
    events: sessionState.events,
  },
  docHasData(docSnap),
);
```

- [ ] **Step 4.9: Update `GenerationProgress` for fix-attempt**

In `components/builder/GenerationProgress.tsx`:

Show the fix attempt from the derivation. No structural change to the component; the existing `statusMessage` (now derived) already includes the attempt suffix when stage is `Fix`, so no change is needed inside the component.

Verify that the component still renders correctly by reading the file end-to-end after the hook rewrites — no shadow-field reads should remain.

- [ ] **Step 4.10: Update `derivePhase.test.ts`**

In `lib/session/__tests__/derivePhase.test.ts`:

Replace all test inputs with the new `DerivePhaseSession` shape. Helper:

```typescript
import type { Event } from "@/lib/log/types";

function mut(stage: string | undefined, seq = 0): Event {
  return {
    kind: "mutation",
    runId: "r",
    ts: 0,
    seq,
    actor: "agent",
    ...(stage && { stage }),
    mutation: { kind: "setAppName", name: "x" },
  };
}

const idle = { loading: false, agentActive: false, runCompletedAt: undefined, events: [] as Event[] };
```

Rewrite each test to use the new shape. Key cases to cover:
- loading=true → Loading (regardless of everything else).
- runCompletedAt set → Completed.
- agentActive=true, events=[mut("schema")] → Generating (doc data irrelevant).
- agentActive=true, events=[] → Idle (no stage yet).
- agentActive=true, docHasData=true, events has only `edit:*` tag → Ready (postBuildEdit suppresses Generating).
- agentActive=false, docHasData=true → Ready.
- agentActive=false, docHasData=false → Idle.

- [ ] **Step 4.11: Prune tests for deleted fields**

In `lib/session/__tests__/store.test.ts`:
- Delete tests that assert on `agentStage`, `statusMessage`, `postBuildEdit`, `justCompleted`, `agentError`. Rewrite or delete any test that called `advanceStage`, `failAgentWrite`, `setFixAttempt`.
- Keep tests for `beginAgentWrite` / `endAgentWrite` that cover doc undo cascading — those semantics are unchanged.

- [ ] **Step 4.12: Full verification**

```
npx tsc --noEmit && echo "✓"
npm run lint
npm test -- --run
npm run build
```

Expected: all green.

- [ ] **Step 4.13: Live + replay smoke test**

Start the dev server:

```
npm run dev
```

Exercise the live path — generate a new app from scratch:
1. Open `/`, follow the New-App prompt.
2. Verify centered chat layout appears.
3. Send a simple prompt like "a CHW outreach tracker".
4. Watch the signal grid transition: sending → reasoning → scaffolding → building → done.
5. Verify `GenerationProgress` advances through Data Model → Structure → Build → Validate → Done.
6. Verify the layout transitions from centered to sidebar at the right moment.
7. Verify the celebration animation fires on completion.

Exercise the replay path — open a completed build's replay URL (e.g. `/build/replay/{id}` from the admin dashboard or a previously generated app):
1. Land on the final frame — layout is sidebar, status is idle/ready.
2. Scrub backward via the transport bar to the Conversation chapter — centered-layout appears (no doc data yet).
3. Scrub to Data Model chapter — sidebar layout (the fix this refactor targets). `statusMessage` in the signal panel reads "Designing data model". `scaffoldProgress` shows ~0.3.
4. Scrub to Scaffold — sidebar, "Designing app structure".
5. Scrub to a Module / Form chapter — sidebar, "Building app content".
6. Scrub to Validation Fix — "Fixing validation errors (attempt N)" if any fixes were needed.
7. Scrub forward and back — the layout + status always match what live rendered.

If anything shows the wrong layout or status, capture the failing chapter and root-cause before proceeding.

- [ ] **Step 4.14: Commit**

```
git add -A
git commit -m "refactor(session): derive lifecycle from events buffer

\`agentStage\`, \`agentError\`, \`statusMessage\`, \`postBuildEdit\`, and
\`justCompleted\` are gone from the session store. Every phase / stage /
status / error surface derives from \`session.events\` + \`agentActive\` +
\`runCompletedAt\` via pure functions in \`lib/session/lifecycle.ts\`.

Replay and live now share one code path — the same event buffer
produces the same UI. No more \`if (session.replay)\` in lifecycle code."
```

---

## Task 5 — CLAUDE.md + final verification

- [ ] **Step 5.1: Update session CLAUDE.md**

In `lib/session/CLAUDE.md`, add a section describing the events buffer + derivation model.

- [ ] **Step 5.2: Update generation CLAUDE.md**

In `lib/generation/CLAUDE.md` (if present — otherwise skip), update the stream dispatcher overview to reflect the removed event types and the new `data-conversation-event` channel.

- [ ] **Step 5.3: Final verification sweep**

```
npx tsc --noEmit && echo "✓"
npm run lint
npm test -- --run
npm run build
```

Expected: all green.

Run a final grep for any remaining references to deleted surface:

```
grep -rE '"data-(start-build|phase|fix-attempt|partial-scaffold)"' --include="*.ts" --include="*.tsx" -- app components lib hooks
grep -rE '"data-error"' --include="*.ts" --include="*.tsx" -- app components lib hooks
grep -rE '\.(agentStage|statusMessage|postBuildEdit|justCompleted|partialScaffold)\b' --include="*.ts" --include="*.tsx" -- app components lib hooks
grep -rE '\bsetPartialScaffold\b|\badvanceStage\b|\bfailAgentWrite\b|\bsetFixAttempt\b' --include="*.ts" --include="*.tsx" -- app components lib hooks
```

Expected: no hits in application code. `useAgentError` / `useAgentStage` / `useStatusMessage` / `usePostBuildEdit` hook names are fine — they survive as derived hooks. Legacy names inside `docs/` are acceptable.

- [ ] **Step 5.4: Commit if CLAUDE.md changes exist**

```
git add -A
git commit -m "docs: describe events buffer + lifecycle derivation"
```

---

## Self-Review

- Spec coverage: The prompt lists 5 acceptance criteria. Task 4's replay smoke test covers layout parity (#2) + no `if (session.replay)` (#3); Task 4's deletions cover shadow-field removal (#4); Task 3's SSE deletions cover the lifecycle-event removal (#5); Task 4's live smoke test covers identical live behavior (#1). The "irreducibility" bar for `data-fix-attempt` (prompt §Validation) is met by promoting its content into the event log as a new `validation-attempt` conversation payload — both preserving debug detail in the log and letting live + replay derive the status message identically.
- Placeholder scan: every code step contains the full code to type; no "similar to above" references; exact file paths; exact commands with expected output.
- Type consistency: `runCompletedAt: number | undefined` used consistently from store through derivations through hooks; `DerivePhaseSession` struct matches the hook call site; `stageTagToGenerationStage` returns `null` for edit-family tags in both its definition and its call sites; `deriveValidationAttempt` return shape `{ attempt, errorCount } | null` matches the `deriveStatusMessage` signature and the `useValidationAttempt` hook return type.
