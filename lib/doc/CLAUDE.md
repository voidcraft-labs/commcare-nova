# lib/doc — Builder document store

The normalized, undoable source of truth for the blueprint domain. Every module, form, and question the builder edits lives here, keyed by UUID.

## Boundary rule

The store is private. Consumers must go through the named domain hooks in `hooks/` — never import the store file directly from outside this package.

Consumers get narrow, memoized hooks with predictable selector shapes; no component passes a raw selector function to a Zustand hook for this store. This boundary keeps undo/redo semantics sane and lets the internal store shape evolve without touching call sites.
