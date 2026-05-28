# lib/doc — Builder document store

The normalized, undoable source of truth for the blueprint domain. Every module, form, and field the builder edits lives here, keyed by UUID.

## Boundary rule

The store is private. Consumers must go through the named domain hooks in `hooks/` — never import the store file directly from outside this package.

Consumers get narrow, memoized hooks with predictable selector shapes; no component passes a raw selector function to a Zustand hook for this store. This boundary keeps undo/redo semantics sane and lets the internal store shape evolve without touching call sites.

## The write surface

`applyMany(mutations: Mutation[]): MutationResult[]` is the only write action on the store. `renameField` and `moveField` produce a `MutationResult` entry at their array position — `FieldRenameMeta` (XPath rewrite count) and `MoveFieldResult` (cross-level sibling-id dedup info + dropped cross-depth hashtag refs) respectively. Every other mutation produces `undefined`. There is no `apply` / `applyWithResult` — single-mutation dispatches wrap as `applyMany([m])` with `[result]` destructuring for metadata.

The public `Mutation` union is fine-grained. There is no `replaceForm`: wholesale form replacements decompose into `updateForm` + `removeField × N` + `addField × M` at the emission boundary — live generation produces that sequence directly via `lib/agent/blueprintHelpers.ts`. There are no `notify*` mutations: XPath hashtag rewrites + sibling-id dedup are reducer side-effects of `renameField` / `moveField`, surfaced to UI as `MutationResult` return values. The `notifyMoveRename` helper in `mutations/notify.ts` is a UI toast emitter consumers call with the `MoveFieldResult` they destructure from `applyMany`'s return array — not a mutation kind.

**Clearing a field property uses a `null` sentinel, not `undefined`.** An `updateField` patch blanks a property by setting it to `null`; the reducer deletes the key on `null` or `undefined`, but only `null` survives the event log's Firestore writes (`ignoreUndefinedProperties` strips `undefined` leaves and omits the now-empty map), so an `undefined`-only clear applies in memory yet silently fails to round-trip in the log. The type system permits both, so this is a convention to follow when adding a clearable property. `updateModule` / `updateForm` clears still travel as `undefined`: reader-safe (their patch defaults to `{}` on read) but not yet log-faithful.

## Doc-shaped helpers colocated here

Pure functions that read or produce a `BlueprintDoc` (or a subtree of one) live in this package alongside the store:

- `fieldPath.ts` — path ↔ uuid resolution (`resolveFieldByPath`, `getFieldPath`). The doc stores fields by uuid; blueprint mutations and the agent tool surface operate in path strings.
- `fieldParent.ts` / `fieldWalk.ts` / `searchBlueprint.ts` / `predicates.ts` — reducer-shaped utilities the store and UI share.
- `navigation.ts` — doc-aware `Location` resolution for the routing hooks.
- `resetBuilder.ts` — tear-down of doc + session state for new-app scaffolding.
- `connectConfig.ts` — connect-config doc helpers: `deriveConnectDefaults` (Layer-2 validate-time defaults), `normalizeConnectConfig` (empty-sub-config stripper), and `dedupeRestoredConnectIds` (forces ids unique at the source when the form-settings UI restores or seeds a connect block). Consumed by the agent's mutation builders (`lib/agent/blueprintHelpers.ts`), the validation loop, and the form-settings Connect toggles. Wire-emit defaults for `deliver_unit.entity_id` / `entity_name` live separately at `lib/commcare/connectDefaults.ts`.
- `types.ts` — the `PersistableDoc` serialized shape.
