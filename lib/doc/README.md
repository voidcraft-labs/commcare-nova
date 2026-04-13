# lib/doc — The Builder Document Store

The normalized, undoable source of truth for the blueprint domain. Every
module, form, and question the builder edits lives here, keyed by UUID.

## Boundary rule

**Anything outside `lib/doc/hooks/**` must NOT import from `lib/doc/store.*`
directly.** The store is private; its public surface is the hooks under
`lib/doc/hooks/`.

Consumer code imports named domain hooks (e.g. `useQuestion(uuid)`,
`useOrderedChildren(parentUuid)`) that handle subscription, selector
shape, and memoization internally. No component ever passes a raw selector
function to a Zustand hook for this store.

This rule will be enforced by a Biome `noRestrictedImports` rule in Phase 6
of the builder re-architecture. Until then it is enforced by convention and
code review.

## Status

**Phase 0 (scaffolding):** only `types.ts` exists. The actual store and
hook implementations are added in later phases. Nothing in the running app
imports from this directory yet.

- Phase 1: builds the Zustand store with Immer + zundo middleware, adds the
  mutation reducer, introduces the `hooks/` directory with `useQuestion`,
  `useForm`, `useModule`, `useOrderedChildren`, etc.
- Phase 2+: only additions; the types here do not change shape.

See `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`.
