# lib/doc — Builder document store

The normalized, undoable source of truth for the blueprint domain. Every module, form, and question the builder edits lives here, keyed by UUID.

## Boundary rule

The store is private. Consumers must go through the named domain hooks in `hooks/` — never import the store file directly from outside this package.

Consumers get narrow, memoized hooks with predictable selector shapes; no component passes a raw selector function to a Zustand hook for this store. This boundary keeps undo/redo semantics sane and lets the internal store shape evolve without touching call sites.

## The write surface

`applyMany(mutations: Mutation[]): MutationResult[]` is the only write action on the store. `renameField` and `moveField` produce a `MutationResult` entry at their array position — `FieldRenameMeta` (XPath rewrite count) and `MoveFieldResult` (cross-level sibling-id dedup info + dropped cross-depth hashtag refs) respectively. Every other mutation produces `undefined`. There is no `apply` / `applyWithResult` — single-mutation dispatches wrap as `applyMany([m])` with `[result]` destructuring for metadata.

The public `Mutation` union is fine-grained. There is no `replaceForm`: wholesale form replacements decompose into `updateForm` + `removeField × N` + `addField × M` at the emission boundary — live generation produces that sequence directly via `lib/agent/blueprintHelpers.ts`, and the parallel legacy decomposition for stored wire events lives in `scripts/migrate/legacy-event-translator.ts::mapFormContent`. There are no `notify*` mutations: XPath hashtag rewrites + sibling-id dedup are reducer side-effects of `renameField` / `moveField`, surfaced to UI as `MutationResult` return values. The `notifyMoveRename` helper in `mutations/notify.ts` is a UI toast emitter consumers call with the `MoveFieldResult` they destructure from `applyMany`'s return array — not a mutation kind.
