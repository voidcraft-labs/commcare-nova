# Derive lifecycle state from the event stream

## Context

We're wrapping Phase 4 (event log unification) on branch `refactor/phase-4-event-log-unification` in `.worktrees/phase-4-event-log-unification/`. The spec is `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`; the plan is `docs/superpowers/plans/2026-04-18-phase-4-event-log-unification.md`. Phase 4 shipped the `Event` log (`lib/log/`), the new `apps/{appId}/events/` + `apps/{appId}/runs/{runId}` collections, and replay consuming `Event[]` directly via `useReplayMessages` + `deriveReplayChapters`.

This work is a prerequisite for merging Phase 4 to `main`. Do it before the merge.

## The problem

The live path and the replay path compute the same UI lifecycle state two different ways, and they diverged.

Live generation relies on sessionStore shadow fields — `agentActive`, `agentStage`, `justCompleted`, `statusMessage`, `partialScaffold`, `fixAttempt` — populated by SSE events (`data-start-build`, `data-phase`, `data-done`, `data-fix-attempt`, `data-partial-scaffold`) through `beginAgentWrite` / `advanceStage` / `endAgentWrite` etc. `derivePhase` reads those flags to decide `Idle | Loading | Generating | Ready | Completed`, which in turn drives the layout (centered vs sidebar), the signal grid animation, status text, etc.

Replay has no SSE push and no way to push those flags. The replay path seeds `session.replay` and dispatches mutations + conversation events, but can't reconstruct `agentStage`, and `derivePhase` falls through to `Idle` on any cursor where `docHasData` is false (notably the Data Model chapter — only `setCaseTypes` has applied, no modules yet). Result: replay renders the centered landing layout mid-chapter.

I previously "fixed" this by adding `if (session.replay) return BuilderPhase.Ready;` to `derivePhase`. That was wrong — it bypassed the actual semantics instead of fixing the divergence. I reverted that shortcut in commit `4f71dd8`; the replay's Data Model chapter currently shows the wrong layout on purpose, so the smell stays visible until this is done right.

## The goal

One code path for lifecycle state. Live and replay feed `derivePhase` (and anything else that reads lifecycle) the same way. Adding or removing a lifecycle signal in one path makes it work in both automatically.

## The insight that makes this cheap

The event log already contains almost everything needed. Every `MutationEvent` carries a `stage` tag (`"schema"` = data-model, `"scaffold"` = structure, `"module:N"` = modules, `"form:M-F"` = forms, `"fix:…"` = fix). Conversation events signal "the agent is working." The stream terminating (live: SSE closes; replay: cursor reaches the end) is "done."

Shadow state like `agentStage` is redundant with the mutation stream's stage tags. `agentActive` is redundant with "there are events in the run that haven't been terminated yet." `justCompleted` is redundant with "the run just ended."

## Why, not what

The spec was explicit that the event log stores mutation + conversation only, no lifecycle events. Good decision — don't revisit it. I'm NOT asking you to persist lifecycle events. I'm asking you to stop maintaining shadow state that duplicates what the mutations already encode.

The live path should populate an in-memory `events: Event[]` buffer on the session store as SSE arrives. The replay path already seeds a `session.replay.events` buffer at hydration. Both paths hold the same shape of data in the same place. `derivePhase` and the rest of the lifecycle derivation read from that buffer. The chat route stops sending `data-phase` / `data-start-build` / `data-fix-attempt` / `data-partial-scaffold` as separate SSE events — those are all derivable from the mutation + conversation events the route is already sending.

The only lifecycle question the event stream can't answer on its own is "has the run terminated?" For live that's SSE closure. For replay that's "this was loaded from a persisted run so the run is done by definition." A single boolean (`runActive` or equivalent) captures it.

Everything else — current phase, what the status pill says, whether to show the signal grid animation, whether to fire celebration on completion — derives from the buffer + that boolean.

## Scope, honestly

This touches the live chat route, the session store shape, several hooks (`useBuilderPhase`, any place reading `agentStage` / `statusMessage` / etc.), the signal grid driver, the stream dispatcher, probably `ChatContainer`'s `onData`. Not a one-file patch. But every divergence between live and replay collapses to zero after it.

Expect 2–4 commits. Plan first if the design isn't obvious once you read the code. Don't be afraid to delete sessionStore fields if they're now derived — that's the point.

## Validation

When done:
- Live build behaves identically to before (run a real generation, see the same signal grid, the same phase transitions, the same status text).
- Replay at every chapter renders the layout that chapter rendered during live generation. In particular: Data Model chapter shows sidebar layout.
- `derivePhase` has no special-case for replay. No `if (session.replay)` anywhere in lifecycle-adjacent code.
- No sessionStore field exists solely to mirror information the event buffer already holds.
- `lifecycle`-family SSE events (`data-start-build`, `data-phase`, `data-fix-attempt`, `data-partial-scaffold`) are gone — the chat route emits only `data-mutations` + whatever conversation-stream events the AI SDK already provides. If one of those events carries information that genuinely can't be derived (argue explicitly for each), it stays; but the bar is "prove it's irreducible."

Run `npx tsc --noEmit && npm run lint && npm test -- --run && npm run build` before merging into the phase-4 branch.

## Starting pointers, not prescriptions

- `lib/session/store.ts` — sessionStore shape; shadow fields are here.
- `lib/session/hooks.tsx` — `derivePhase` + `useBuilderPhase`.
- `hooks/useAutoSave.ts` — already has a replay gate; that's fine.
- `lib/generation/streamDispatcher.ts` — current SSE-to-sessionStore translator. Likely shrinks.
- `components/chat/ChatContainer.tsx` — `onData` callback is where live events arrive.
- `app/api/chat/route.ts` — server side. Probably stops emitting the lifecycle SSE events once the client derives them.
- `components/builder/BuilderProvider.tsx::ReplayHydrator` — already seeds replay events; unchanged or simplified.
- `components/builder/ReplayController.tsx::goToChapter` — scrubs through events; should not need lifecycle fiddling after the refactor.
- `lib/signalGrid/` — probably a consumer of lifecycle state.

Read before writing. Trust that you understand the problem once you've read the code. Don't prescribe a mechanical plan before you've seen it.
