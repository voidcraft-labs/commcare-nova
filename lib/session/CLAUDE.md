# lib/session — Builder ephemeral session store

Transient UI state scoped to the builder route: cursor mode, sidebar visibility, agent run status, active field, connect-mode stash. None of it is undoable; none of it persists across page loads.

## Boundary rule

Same as `lib/doc`: the store is private. Consumers go through the named hooks in this package — never import the store file directly from outside.

## Why a separate store from `lib/doc`

- **Clean undo/redo.** Zundo can track the entire document store without a `partialize` allow-list, because UI fields don't live in it. Adding transient UI to the doc store would require hand-maintaining a list of fields to exclude from history.
- **Write from outside React.** Stream handlers and route handlers toggle run lifecycle via the store without threading through context.
- **Disjoint responsibilities.** Mutations to the blueprint and mutations to UI state are visibly different call sites, so reviewers can reason about each independently.

## Lifecycle = events buffer + runCompletedAt + the run-start capture

Four session fields describe "what phase is the builder in":

- `events: Event[]` — the current active run's events. **Cleared at both `beginRun()` and `endRun()`**, so `events.length > 0` is itself the "a run is in progress" signal — no `agentActive` shadow flag, no mirror to drift. Live: stream dispatcher appends as `data-mutations` + `data-conversation-event` envelopes arrive. Replay: hydrator seeds + `ReplayController` replaces on scrub.
- `runStartedWithData: boolean` — captured once in `beginRun()` (did the doc already have data when the run opened?). The build-vs-edit discriminator: builds and edits emit the SAME stage tags now (`app`, `module:create`, `form:M-F`), so the buffer alone can't tell them apart, and a build's own mutations populating the doc mid-run must not flip the derivation. False outside runs and in replay (which always replays builds).
- `runCompletedAt: number | undefined` — stamped by the dispatcher's `data-done` handler (the chat route's drain-end build-finished signal). Cleared by `acknowledgeCompletion()` after the celebration timer. askQuestions / clarifying-text / edit-tool runs never stamp — they close silently.
- `loading: boolean` — initial hydration flag (existing app load or replay).

Run-boundary actions are orthogonal and atomic:

- `beginRun()` — pause doc undo, clear events buffer, clear runCompletedAt, capture runStartedWithData.
- `endRun()` — resume doc undo, clear events buffer. Does NOT touch runCompletedAt.
- `markRunCompleted()` — stamp runCompletedAt. Does NOT touch events or doc undo.
- `acknowledgeCompletion()` — clear runCompletedAt.

**Every other lifecycle signal is derived from these fields** via pure functions in `lifecycle.ts`: phase, stage, classified error, validation attempt, status message, postBuildEdit. No `agentActive` / `agentStage` / `agentError` / `statusMessage` / `postBuildEdit` / `justCompleted` flags exist — those were shadow state populated only by the live SSE path, causing replay to render the wrong layout mid-chapter. Live and replay now share one code path.

**Disambiguation: initial build vs post-build edit.** Both emit the same stage tags (`module:create` during construction, `form:M-F` for field work). `derivePhase` and `derivePostBuildEdit` key on `runStartedWithData` — a run that opened on an empty doc is an initial build (Generating layout); one that opened on a populated doc is an edit (the builder stays Ready/interactive while the agent works).

When adding a new lifecycle signal: add a derivation in `lifecycle.ts`, expose a named hook in `hooks.tsx`. Don't add a field to the store.
