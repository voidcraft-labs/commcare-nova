# lib/session — Builder ephemeral session store

Transient UI state scoped to the builder route: cursor mode, sidebar visibility, agent run status, active field, connect-mode stash. None of it is undoable; none of it persists across page loads.

## Boundary rule

Same as `lib/doc`: the store is private. Consumers go through the named hooks in this package — never import the store file directly from outside.

## Why a separate store from `lib/doc`

- **Clean undo/redo.** Zundo can track the entire document store without a `partialize` allow-list, because UI fields don't live in it. Adding transient UI to the doc store would require hand-maintaining a list of fields to exclude from history.
- **Write from outside React.** Stream handlers and route handlers toggle run lifecycle via the store without threading through context.
- **Disjoint responsibilities.** Mutations to the blueprint and mutations to UI state are visibly different call sites, so reviewers can reason about each independently.

## Lifecycle = events buffer + two booleans, no shadow state

The session store holds four fields that describe "what phase of generation are we in":

- `events: Event[]` — the live mirror of the persisted event log. Live path: stream dispatcher appends as `data-mutations` + `data-conversation-event` envelopes arrive. Replay path: hydrator seeds + `ReplayController` replaces on scrub. Cleared by `beginRun()` and `reset()`.
- `agentActive: boolean` — SSE stream open (live: chat-transport status effect drives begin/end; replay: always false).
- `runCompletedAt: number | undefined` — timestamp stamped by `endRun(true)`; cleared by `acknowledgeCompletion()` when the celebration animation settles.
- `loading: boolean` — initial hydration flag (existing app load or replay).

**Every other lifecycle signal is derived from the buffer** via pure functions in `lifecycle.ts`: current stage, classified error, validation attempt, status message, postBuildEdit latch. No `agentStage` / `agentError` / `statusMessage` / `postBuildEdit` / `justCompleted` fields exist — those were shadow state populated only by the live SSE path, which caused replay to render the wrong layout mid-chapter. Live and replay now share one code path.

When adding a new lifecycle signal: add a derivation in `lifecycle.ts`, expose a named hook in `hooks.tsx`. Don't add a field to the store.
