# lib/session — Builder ephemeral session store

Transient UI state scoped to the builder route: cursor mode, sidebar visibility, agent status, active field, connect-mode stash. None of it is undoable; none of it persists across page loads.

## Boundary rule

Same as `lib/doc`: the store is private. Consumers go through the named hooks in this package — never import the store file directly from outside.

## Why a separate store from `lib/doc`

- **Clean undo/redo.** Zundo can track the entire document store without a `partialize` allow-list, because UI fields don't live in it. Adding transient UI to the doc store would require hand-maintaining a list of fields to exclude from history.
- **Write from outside React.** Stream handlers and route handlers toggle agent status via the store without threading through context.
- **Disjoint responsibilities.** Mutations to the blueprint and mutations to UI state are visibly different call sites, so reviewers can reason about each independently.
