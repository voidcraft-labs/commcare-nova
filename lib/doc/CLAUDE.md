# lib/doc — Builder document store

The normalized, undoable source of truth for the blueprint domain. Every module, form, and field the builder edits lives here, keyed by UUID.

## Boundary rule

The store is private. Consumers must go through the named domain hooks in `hooks/` — never import the store file directly from outside this package.

Consumers get narrow, memoized hooks with predictable selector shapes; no component passes a raw selector function to a Zustand hook for this store. This boundary keeps undo/redo semantics sane and lets the internal store shape evolve without touching call sites.

## The write surface

`applyMany(mutations: Mutation[]): MutationResult[]` is the only write action on the store. `renameField` and `moveField` produce a `MutationResult` entry at their array position — `FieldRenameMeta` (XPath rewrite count) and `MoveFieldResult` (cross-level sibling-id dedup info) respectively. Every other mutation produces `undefined`. There is no `apply` / `applyWithResult` — single-mutation dispatches wrap as `applyMany([m])` with `[result]` destructuring for metadata.

The public `Mutation` union is fine-grained. There is no `replaceForm`: wholesale form replacements decompose into `updateForm` + `removeField × N` + `addField × M` at the emission boundary — live generation produces that sequence directly via `lib/agent/blueprintHelpers.ts`. There are no `notify*` mutations: XPath hashtag rewrites + sibling-id dedup are reducer side-effects of `renameField` / `moveField`, surfaced to UI as `MutationResult` return values. The `notifyMoveRename` helper in `mutations/notify.ts` is a UI toast emitter consumers call with the `MoveFieldResult` they destructure from `applyMany`'s return array — not a mutation kind.

**Clearing an optional slot uses an explicit `null`, never `undefined`.** A clear must survive two serialization hops: the SSE `data-mutations` wire (the SA streams mutations as JSON, and `JSON.stringify` DROPS `undefined`-valued keys) and the Firestore event log (`ignoreUndefinedProperties` strips `undefined` leaves on write, omitting the now-empty map). An `undefined`-valued clear applies in memory but round-trips through neither — it never reaches the client doc store, and the next auto-save re-writes the stale value. `null` survives both. So `updateField` blanks a property by setting it to `null` (the reducer deletes the key on `null` or `undefined`; only `null` round-trips), and the edit-tool schema reserves `null` for "clear". Media slots — field message media, module/form menu media, app logo — clear through dedicated mutation kinds (`setFieldMedia` / `setModuleMedia` / `setFormMedia` / `setAppLogo`), each carrying `media: Media | null` mapped to `undefined` INSIDE the reducer, because media is deliberately excluded from the generic field-edit surface and `updateModule` / `updateForm` carry no null-clear. Do NOT add a blanket "null-means-clear" rule to the `update*` reducers: `setConnectType`'s slot is genuinely `.nullable()` and stores `null` as a real value. (`updateModule` / `updateForm` clears still travel as `undefined` today — reader-safe via their patch defaulting to `{}` on read, but not yet log-faithful; convert a specific slot to a dedicated `null`-carrying kind when it must be clearable. A concrete array survives JSON whole, so a wholesale `{ options: [...] }` patch can clear a nested key by omitting it from the rebuilt element — that path stays on `updateField`.)

## Doc-shaped helpers colocated here

Pure functions that read or produce a `BlueprintDoc` (or a subtree of one) live in this package alongside the store:

- `fieldPath.ts` — path ↔ uuid resolution (`resolveFieldByPath`, `getFieldPath`). The doc stores fields by uuid; blueprint mutations and the agent tool surface operate in path strings.
- `fieldParent.ts` / `fieldWalk.ts` / `searchBlueprint.ts` / `predicates.ts` — reducer-shaped utilities the store and UI share.
- `navigation.ts` — doc-aware `Location` resolution for the routing hooks.
- `resetBuilder.ts` — tear-down of doc + session state for new-app scaffolding.
- `connectConfig.ts` — connect-config doc helpers: `deriveConnectDefaults` (Layer-2 validate-time defaults), `normalizeConnectConfig` (empty-sub-config stripper), and `dedupeRestoredConnectIds` (forces ids unique at the source when the form-settings UI restores or seeds a connect block). Consumed by the agent's mutation builders (`lib/agent/blueprintHelpers.ts`), the validation loop, and the form-settings Connect toggles. Wire-emit defaults for `deliver_unit.entity_id` / `entity_name` live separately at `lib/commcare/connectDefaults.ts`.
- `types.ts` — the `PersistableDoc` serialized shape.
