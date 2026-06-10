import type { Draft } from "immer";
import type { FieldPath } from "@/lib/doc/fieldPath";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import {
	caseDataTypeForFieldKind,
	type Field,
	fieldKindDeclaresKey,
	fieldSchema,
	getConvertibleTypes,
	pickFieldKeysForKind,
	reconcileFieldForKind,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import {
	rewriteHashtagRefs,
	rewriteXPathRefs,
} from "@/lib/preview/xpath/rewrite";
import {
	cascadeDeleteField,
	cloneFieldSubtree,
	computeFieldPath,
	dedupeSiblingId,
	findContainingForm,
	findFieldParent,
	walkFormFieldUuids,
} from "./helpers";
import { rewriteXPathOnMove } from "./pathRewrite";
import {
	rewriteFieldReferenceSlots,
	rewriteFormReferenceSlots,
	rewriteModuleCaseRefs,
} from "./referenceRewrites";

/**
 * Metadata returned by `moveField`.
 *
 * `renamed` is populated when a cross-level move triggers sibling-id
 * deduplication (CommCare requires unique IDs per parent level). Reference
 * rewriting is total for SAME-FORM moves: absolute paths AND `#form/`
 * hashtag refs re-anchor across any depth change (`rewriteXPathOnMove`),
 * refs to a moved CONTAINER's descendants included (segment-prefix
 * re-anchor), so a same-form move never leaves a dangling reference
 * behind. A CROSS-FORM move re-anchors every ref that named the moved
 * field — the source form's slots plus the moved subtree's own — but
 * those refs cannot resolve in the source form afterwards: XPath
 * references are form-scoped by CommCare semantics, so the dangle is
 * inherent to moving the referent away, not a rewrite gap (the rewrite
 * keeps them naming the field they referenced, never a stale name a
 * future same-named sibling would capture).
 *
 * `xpathFieldsRewritten` counts the reference-carrying SLOTS whose
 * value changed across the move's rewrite pass — the walked fields'
 * expression/prose slots plus the walked form's own wiring slots
 * (form-link conditions/datums, Connect expressions). It feeds the
 * "N references updated" toast (`notify.ts::notifyMoveRename`).
 */
export interface MoveFieldResult {
	renamed?: {
		oldId: string;
		newId: string;
		newPath: FieldPath;
		xpathFieldsRewritten: number;
	};
}

/**
 * Metadata returned by `renameField`.
 *
 * A rename is either **form-local** (the field does not write to a case, so
 * only its own form's XPath references change) or **cascaded** (the field
 * has a `case_property_on` — renaming its id is semantically a rename of the
 * case property it holds, so the reducer propagates the change across every
 * module/form that references the property).
 *
 * Sub-counts let callers surface precise toast copy without having to
 * re-derive what changed:
 *   - `xpathFieldsRewritten` — count of DISTINCT fields whose contents were
 *     modified. A single field is counted once regardless of how many refs
 *     inside it matched and regardless of how many passes (form-local
 *     `/data/…`+`#form/…` pass plus cross-form `#case/…` pass) touched it.
 *     This is the "how many expressions moved with me" number and drives
 *     the UI toast ("N references updated").
 *   - `peerFieldsRenamed` — how many OTHER fields were renamed because
 *     they represented the same case property (same `id` + same
 *     `case_property_on`) in a different form. Those are authoritative peers
 *     of the renamed field, not references to it.
 *   - `columnsRewritten` — number of `caseListConfig.columns`
 *     entries on matching modules whose `field` value was
 *     updated. Calculated columns have no `field` slot and are
 *     skipped during the rewrite (their expressions are ASTs and
 *     count under `moduleRefsRewritten`).
 *   - `formWiringRewritten` — count of DISTINCT FORMS whose
 *     form-level wiring slots (form-link conditions / datum values,
 *     Connect expressions, `closeCondition.field`) were rewritten by
 *     any pass. Per-form (not per-slot) so a form touched by both the
 *     path pass and the case-hashtag pass counts once.
 *   - `moduleRefsRewritten` — count of case-property reference NODES
 *     renamed inside module-level ASTs (case-list filter, calculated
 *     column expressions, search-input predicates/defaults,
 *     search-button display condition, excluded-owner-ids) plus
 *     simple search-input `property` slots. Module-level state — a
 *     non-zero value forces `cascadedAcrossForms`.
 *   - `catalogEntryRenamed` — `true` iff `doc.caseTypes[caseType].properties[]`
 *     had a matching entry renamed (or merged into an already-declared
 *     `newId` entry). The catalog is the authoritative list
 *     of known case properties for the XPath linter, `#case/` chip
 *     hydrator, and autocompleter; a stale catalog makes freshly-valid
 *     refs look "unknown." Consumers can use this to invalidate autocomplete
 *     / lint caches; for most callers it's informational.
 *   - `cascadedAcrossForms` — `true` iff the rename visibly touched state
 *     OUTSIDE the primary field's containing form: any peer rename, any
 *     column rewrite, any catalog entry rename, or any `#case/` ref rewrite
 *     in a non-primary form. Consumers (the SA's egress emitter, the UI
 *     toast) branch on this to decide whether a single-form update is
 *     sufficient or a full blueprint refresh is needed. A `#case/` rewrite
 *     in the primary's own form does NOT set this flag — same-form rewrites
 *     can be handled by a form-level refresh alone.
 */
export interface FieldRenameMeta {
	xpathFieldsRewritten: number;
	peerFieldsRenamed: number;
	columnsRewritten: number;
	formWiringRewritten: number;
	moduleRefsRewritten: number;
	catalogEntryRenamed: boolean;
	cascadedAcrossForms: boolean;
}

/**
 * Field mutations. Six kinds:
 *   - addField, updateField: simple entity-level edits
 *   - removeField: cascade delete subtree
 *   - moveField: cross-parent reorder + xpath rewrite + sibling dedup
 *   - renameField: id change + xpath rewrite of any referencing fields
 *   - duplicateField: deep clone with new UUIDs, dedupe sibling id
 */
export function applyFieldMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addField"
				| "removeField"
				| "moveField"
				| "renameField"
				| "duplicateField"
				| "updateField"
				| "convertField"
				| "setFieldMedia";
		}
	>,
): MoveFieldResult | FieldRenameMeta | undefined {
	switch (mut.kind) {
		case "addField": {
			// Parent must be a form or a group/repeat that already has an
			// order entry (groups/repeats are added via addField + an
			// empty order slot, so we also allow parents that are registered
			// fields).
			const parentExists =
				draft.forms[mut.parentUuid] !== undefined ||
				draft.fields[mut.parentUuid] !== undefined;
			if (!parentExists) return;
			const order = draft.fieldOrder[mut.parentUuid] ?? [];
			const index = mut.index ?? order.length;
			const clamped = Math.max(0, Math.min(index, order.length));
			order.splice(clamped, 0, mut.field.uuid);
			draft.fieldOrder[mut.parentUuid] = order;
			draft.fields[mut.field.uuid] = mut.field;
			// If the new field is a group/repeat, pre-seed its order slot
			// so child insertions have a valid parent to target immediately.
			if (mut.field.kind === "group" || mut.field.kind === "repeat") {
				draft.fieldOrder[mut.field.uuid] ??= [];
			}
			// A landed case-property writer declares its property — sync
			// the catalog (see `ensureCatalogProperty`).
			ensureCatalogProperty(draft as unknown as BlueprintDoc, mut.field);
			return;
		}
		case "updateField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			// Identity + kind guard. `mut.targetKind` is the kind the caller
			// constructed the patch against. If the field's actual kind has
			// drifted (e.g. a `convertField` ran between mutation construction
			// and dispatch in a parallel batch), the patch's allowed keys no
			// longer match the field — skip the stale mutation rather than
			// merging keys that don't apply to the current kind.
			if (field.kind !== mut.targetKind) {
				console.warn(
					`updateField: skipped a stale patch for ${mut.uuid} — the patch was built for a "${mut.targetKind}" field, but the field is now a "${field.kind}". The field probably converted kind between when this update was queued and when it ran. Re-read the field, rebuild the patch, and try again.`,
				);
				return;
			}
			// Apply the patch onto the current entity key-by-key. A patch
			// value of `null` (the wire representation of a blank — see
			// `partialOf`) or `undefined` (a client in-memory clear) means
			// "delete this key"; any other value sets it. Deleting rather
			// than assigning the null/undefined keeps the resulting object
			// free of the unrepresentable/invalid value before the parse.
			const spread: Record<string, unknown> = { ...field };
			for (const [key, value] of Object.entries(mut.patch)) {
				if (value === null || value === undefined) {
					delete spread[key];
				} else {
					spread[key] = value;
				}
			}
			// Filter the result through `pickFieldKeysForKind` before
			// parsing. The type-level discriminator on `targetKind` catches
			// cross-kind patches at compile time, but the repeat kind has an
			// inner `repeat_mode` discriminator the per-kind partial schema
			// can't guard: a patch that switches `count_bound →
			// user_controlled` leaves the previous mode's `repeat_count` key
			// behind, and the strict per-variant schema would reject it. The
			// filter dispatches on the merged result's `repeat_mode` so a
			// mode-switch picks up the destination variant's key set,
			// dropping the stale slot. For non-repeat kinds the filter is
			// a tight no-op (the picked key set covers every key the merge
			// can carry) — defense-in-depth without a meaningful cost.
			const merged = pickFieldKeysForKind(spread, mut.targetKind);
			const result = fieldSchema.safeParse(merged);
			if (!result.success) {
				// A patch that fails the schema is a programmer error — log
				// with the exact issues so the offending call site is easy
				// to locate, then skip the update rather than throwing from
				// inside an Immer reducer (a throw would propagate up through
				// `store.applyMany()` and crash the surrounding render).
				console.warn(
					`updateField: a patch for ${mut.uuid} (kind=${field.kind}) didn't fit the field's schema and was skipped. The merged shape failed validation — check that every patch value is the right type for its key.`,
					{ patch: mut.patch, issues: result.error.issues },
				);
				return;
			}
			// Install the validated entity — replaces the existing entry rather
			// than mutating it in place, which is the canonical Immer-friendly
			// way to write a known-good replacement.
			draft.fields[mut.uuid] = result.data;
			// The patch may have set `case_property_on` or changed `id` —
			// either way the field's (case type, property) pair may be new.
			// Sync the catalog off the merged result; a pair that didn't
			// change is a no-op (see `ensureCatalogProperty`).
			ensureCatalogProperty(draft as unknown as BlueprintDoc, result.data);
			return;
		}
		case "removeField": {
			// Guard: nothing to remove if the entity doesn't exist.
			if (draft.fields[mut.uuid] === undefined) return;
			// Splice the uuid out of its parent's order, if it's registered
			// in any order map. A field that exists but isn't in any order
			// map is an unusual state, but we still fall through to cascade.
			const parent = findFieldParent(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			if (parent) {
				const order = draft.fieldOrder[parent.parentUuid];
				if (order) {
					order.splice(parent.index, 1);
					draft.fieldOrder[parent.parentUuid] = order;
				}
			}
			// Recursively delete the field entity and any descendants
			// (children of a group/repeat, their children, etc.).
			cascadeDeleteField(draft as unknown as BlueprintDoc, mut.uuid);
			return;
		}
		case "moveField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			// Destination parent must exist as either a form or a group/repeat.
			const destIsForm = draft.forms[mut.toParentUuid] !== undefined;
			const destField = draft.fields[mut.toParentUuid];
			const destIsContainer =
				destField &&
				(destField.kind === "group" || destField.kind === "repeat");
			if (!destIsForm && !destIsContainer) return;

			const sourceParent = findFieldParent(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			const oldPathStr =
				computeFieldPath(draft as unknown as BlueprintDoc, mut.uuid) ?? "";
			// Resolved BEFORE the removal below — `findContainingForm` walks
			// `fieldOrder`, which won't reach the field once it's spliced out.
			const sourceFormUuid = findContainingForm(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			const crossParent =
				sourceParent !== undefined &&
				sourceParent.parentUuid !== mut.toParentUuid;

			// Remove from source order.
			if (sourceParent) {
				const srcOrder = draft.fieldOrder[sourceParent.parentUuid];
				if (srcOrder) {
					srcOrder.splice(sourceParent.index, 1);
					draft.fieldOrder[sourceParent.parentUuid] = srcOrder;
				}
			}

			// Dedupe id against new siblings if we crossed a parent boundary.
			// Capture the old id so we can detect and report auto-rename.
			const oldId = field.id;
			if (crossParent) {
				const deduped = dedupeSiblingId(
					draft as unknown as BlueprintDoc,
					mut.toParentUuid,
					field.id,
					mut.uuid,
				);
				field.id = deduped;
			}
			// A dedup rename changes the field's (case type, property) pair —
			// the move does NOT ride the rename cascade, so sync the catalog
			// here. The old pair stays (the colliding destination sibling
			// still writes it); a move that didn't rename changed no pair.
			if (field.id !== oldId) {
				ensureCatalogProperty(draft as unknown as BlueprintDoc, field);
			}

			// Insert at destination.
			const destOrder = draft.fieldOrder[mut.toParentUuid] ?? [];
			const clamped = Math.max(0, Math.min(mut.toIndex, destOrder.length));
			destOrder.splice(clamped, 0, mut.uuid);
			draft.fieldOrder[mut.toParentUuid] = destOrder;

			// Rewrite absolute-path / hashtag references that now point at a
			// stale path. Covers cross-level moves (where the prefix changes —
			// hashtag refs re-anchor across depth, `#form/foo` ↔
			// `#form/grp/foo`, descendants of a moved container included) and
			// reorder+rename (where the leaf segment changes from dedup).
			// Registry-driven: every XPath/prose slot on the walked fields
			// plus the walked form's own wiring slots (form-link
			// conditions/datums, Connect expressions). `closeCondition.field`
			// is a bare leaf-id ref and is deliberately NOT rewritten here:
			// a move only changes the leaf id through sibling-dedup, and in
			// that case the destination sibling that forced the dedup still
			// holds the old id — the ref keeps resolving to it (see
			// `FormSlotRewriteContext.fieldIdRename`'s unique-holder rule).
			//
			// WHICH fields get walked follows from pre-move resolution, which
			// is form-scoped (`/data/foo` means "this form's foo"): a ref
			// matched the moved field's old path iff it lived in the SOURCE
			// form — its remaining fields, its wiring, and the moved subtree
			// itself (now re-parented). For a same-form move that set IS the
			// (single) containing form. For a cross-form move the rest of the
			// DESTINATION form is deliberately NOT walked: its same-path refs
			// named its OWN fields (the dedup collider that keeps the old id,
			// for one), and rewriting them would retarget working expressions
			// at the incomer. Source-form refs to the moved field can no
			// longer resolve either way — the rewrite keeps them naming the
			// field they referenced instead of leaving a stale name a future
			// same-named sibling would silently capture.
			let xpathFieldsRewritten = 0;
			const newPathStr =
				computeFieldPath(draft as unknown as BlueprintDoc, mut.uuid) ?? "";
			if (oldPathStr && newPathStr && oldPathStr !== newPathStr) {
				const oldSegments = oldPathStr.split("/");
				const newSegments = newPathStr.split("/");
				const moveRewriter = (expr: string) =>
					rewriteXPathOnMove(expr, oldSegments, newSegments);
				const destFormUuid = findContainingForm(
					draft as unknown as BlueprintDoc,
					mut.uuid,
				);
				const crossForm =
					sourceFormUuid !== undefined &&
					destFormUuid !== undefined &&
					sourceFormUuid !== destFormUuid;
				const walkFormUuid = crossForm ? sourceFormUuid : destFormUuid;
				if (walkFormUuid) {
					const fieldUuids = walkFormFieldUuids(
						draft as unknown as BlueprintDoc,
						walkFormUuid,
					);
					if (crossForm) {
						// The moved subtree left the source form's walk — its own
						// slots (intra-subtree refs included) still re-anchor.
						fieldUuids.push(
							mut.uuid,
							...walkFormFieldUuids(draft as unknown as BlueprintDoc, mut.uuid),
						);
					}
					for (const fUuid of fieldUuids) {
						const target = draft.fields[fUuid];
						if (!target) continue;
						xpathFieldsRewritten += rewriteFieldReferenceSlots(
							target,
							moveRewriter,
						);
					}
					const form = draft.forms[walkFormUuid];
					if (form) {
						xpathFieldsRewritten += rewriteFormReferenceSlots(form, {
							xpath: moveRewriter,
						});
					}
				}
			}

			// Build rename metadata when cross-level dedup changed the id.
			const renamed =
				oldId !== field.id
					? {
							oldId,
							newId: field.id,
							newPath: (newPathStr || "") as FieldPath,
							xpathFieldsRewritten,
						}
					: undefined;
			return { renamed } satisfies MoveFieldResult;
		}
		case "renameField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;

			const oldId = field.id;
			const newId = mut.newId;

			// Early-exit on a rename to the same id. Avoids pointless scans
			// of the blueprint and keeps metadata honest for consumers that
			// rely on non-zero counts to trigger toasts.
			if (oldId === newId) {
				return emptyFieldRenameMeta();
			}

			// The cascade target case type is the field's `case_property_on`
			// value — the case type this field WRITES TO, which may differ
			// from the containing module's `caseType` when the field creates
			// a child case. A non-empty value triggers the case-property
			// cascade: #case/<oldId> hashtags across every form bound to a
			// module with the matching caseType, column renames on those
			// modules, and peer-field renames of any other field that
			// declares the same (id, case_property_on) pair.
			const caseType = extractCaseProperty(field);
			const doc = draft as unknown as BlueprintDoc;

			// Track state across both passes:
			//   - `touchedFields` dedupes multi-pass rewrites on the same
			//     field (e.g. a field with both `/data/old` and `#case/old`
			//     refs is touched by both passes but counts once).
			//   - `rewiredForms` does the same for form-level wiring slots —
			//     per-form, so a form whose wiring is touched by both the
			//     path pass and the case-hashtag pass counts once.
			//   - `affectedForms` records every form that had ANY change
			//     (field or wiring); used to compute `cascadedAcrossForms`
			//     without resorting to fragile subtraction arithmetic.
			const tracking: RenameTracking = {
				touchedFields: new Set<Uuid>(),
				affectedForms: new Set<Uuid>(),
				rewiredForms: new Set<Uuid>(),
			};
			// Capture the primary form BEFORE the rename mutates the id; used
			// to decide which forms count as "other" for the cross-form flag.
			const primaryFormUuid = findContainingForm(doc, mut.uuid);

			// (1) Rename the primary field and rewrite its containing form's
			//     path / hashtag references + form-level wiring.
			renameSingleField(doc, mut.uuid, newId, tracking);

			// (2) Case-property cascade, when applicable. Safe to run even
			//     when no module has matching caseType — the walkers visit
			//     nothing and counts stay at zero.
			let peerFieldsRenamed = 0;
			let columnsRewritten = 0;
			let moduleRefsRewritten = 0;
			let catalogEntryRenamed = false;
			if (caseType !== undefined) {
				const cascade = cascadeCasePropertyRename(
					doc,
					caseType,
					oldId,
					newId,
					mut.uuid,
					tracking,
				);
				peerFieldsRenamed = cascade.peerFieldsRenamed;
				columnsRewritten = cascade.columnsRewritten;
				moduleRefsRewritten = cascade.moduleRefsRewritten;
				catalogEntryRenamed = cascade.catalogEntryRenamed;
			}

			// A cascade is "across forms" iff it produced state changes the
			// primary form's refresh cannot cover: another form gained a
			// rewrite (field or wiring), a peer got renamed (peers live in
			// other forms by the uniqueness invariant, but we still count
			// explicitly), a column or module AST changed (module-level
			// state), or the catalog entry moved (app-level state, affects
			// lint/autocomplete on every form).
			let touchedOtherForm = false;
			for (const f of tracking.affectedForms) {
				if (f !== primaryFormUuid) {
					touchedOtherForm = true;
					break;
				}
			}
			const cascadedAcrossForms =
				peerFieldsRenamed > 0 ||
				columnsRewritten > 0 ||
				moduleRefsRewritten > 0 ||
				catalogEntryRenamed ||
				touchedOtherForm;

			return {
				xpathFieldsRewritten: tracking.touchedFields.size,
				peerFieldsRenamed,
				columnsRewritten,
				formWiringRewritten: tracking.rewiredForms.size,
				moduleRefsRewritten,
				catalogEntryRenamed,
				cascadedAcrossForms,
			} satisfies FieldRenameMeta;
		}
		case "duplicateField": {
			const src = draft.fields[mut.uuid];
			if (!src) return;
			const parent = findFieldParent(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			if (!parent) return;

			// Clone the subtree off the current draft state. `cloneFieldSubtree`
			// returns undefined if the source or a descendant is missing — we
			// already guarded on the source above, so undefined here means
			// something is structurally wrong with the doc. Skip the duplicate
			// rather than propagating a throw out of the reducer.
			const cloned = cloneFieldSubtree(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			if (!cloned) return;
			const { fields: clonedF, fieldOrder: clonedO, rootUuid } = cloned;

			// Install all cloned entities into the draft.
			for (const [uuid, f] of Object.entries(clonedF)) {
				draft.fields[uuid as Uuid] = f;
			}
			for (const [parentUuid, order] of Object.entries(clonedO)) {
				draft.fieldOrder[parentUuid as Uuid] = order;
			}

			// Dedupe the top-level clone's id against existing siblings at this
			// parent level. Nested clones live under the new (cloned) parent and
			// therefore can't conflict with the originals — no dedup needed there.
			const clone = draft.fields[rootUuid];
			if (clone) {
				const deduped = dedupeSiblingId(
					draft as unknown as BlueprintDoc,
					parent.parentUuid,
					clone.id,
					rootUuid,
				);
				clone.id = deduped;
			}

			// Splice the clone right after the source in the parent's order.
			const parentOrder = draft.fieldOrder[parent.parentUuid];
			if (parentOrder) {
				parentOrder.splice(parent.index + 1, 0, rootUuid);
				draft.fieldOrder[parent.parentUuid] = parentOrder;
			}
			// Every cloned writer declares its (case type, property) pair —
			// the deduped root clone introduces a NEW pair (suffixed id);
			// descendant clones keep their source ids, so their sync is an
			// idempotent re-assert. Read post-dedup state off the draft.
			for (const uuid of Object.keys(clonedF)) {
				const clonedField = draft.fields[uuid as Uuid];
				if (clonedField) {
					ensureCatalogProperty(draft as unknown as BlueprintDoc, clonedField);
				}
			}
			return;
		}
		case "convertField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			// No-op if the kind is already the target (treat as idempotent).
			if (field.kind === mut.toKind) return;
			// Convertibility gate — the UI gates on this list too, but the
			// reducer is the authoritative second layer. Without it, the
			// `fieldSchema.safeParse` inside `reconcileFieldForKind` will
			// happily accept structurally destructive swaps that Zod cannot
			// detect:
			//   - container → leaf: a group with children becomes a text
			//     entity, leaving `fieldOrder[uuid]` populated with orphan
			//     descendants that walkers + navigation still see.
			//   - leaf → container: a text entity becomes a group with no
			//     `fieldOrder` entry, breaking the "every container has an
			//     order slot" invariant enforced everywhere else.
			// The convertTargets list in each kind's FieldKindMetadata is the
			// single source of truth for which swaps are semantically valid.
			const allowed = getConvertibleTypes(field.kind);
			if (!allowed.includes(mut.toKind)) {
				log.warn(
					`convertField: ${field.kind} cannot convert to ${mut.toKind}`,
					{ uuid: mut.uuid, validTargets: allowed },
				);
				return;
			}
			const reconciled = reconcileFieldForKind(field, mut.toKind);
			if (!reconciled) {
				// Unreachable under current schemas: every kind pair in any
				// `convertTargets` list has schemas compatible enough that
				// `fieldSchema.safeParse` on `{ ...source, kind: toKind }`
				// succeeds. This branch stays as defense-in-depth — if a
				// future schema introduces a required key that isn't present
				// on every would-be source kind, throwing inside an Immer
				// reducer propagates up through `store.applyMany()` and crashes
				// the surrounding render. Logging + no-op keeps the app alive
				// while making the anomaly visible in dev tools.
				log.warn(
					`convertField: cannot reconcile ${field.kind} → ${mut.toKind}`,
					{ uuid: mut.uuid, field },
				);
				return;
			}
			draft.fields[mut.uuid] = reconciled;
			// The destination kind may derive a different catalog
			// `data_type` for a surviving `case_property_on` pointer; a
			// pair already declared is left untouched (declared wins —
			// the kind/declaration agreement rule owns mismatches).
			ensureCatalogProperty(draft as unknown as BlueprintDoc, reconciled);
			return;
		}
		case "setFieldMedia": {
			// Set or clear one message slot's media bundle. The mutation
			// carries an explicit `media: Media | null` (null survives JSON
			// where `{ key: undefined }` would not), so both set and clear
			// cross the SSE wire intact. The slot name maps to the
			// `<slot>_media` field key.
			const field = draft.fields[mut.fieldUuid];
			if (!field) return;
			const mediaKey = `${mut.slot}_media` as const;
			// Guard slot-vs-kind against the schema key set (not `key in field`
			// — an unset optional slot is absent as an own property even on a
			// supporting kind). A slot the kind doesn't declare is skipped
			// rather than written as a stray key the strict field schema would
			// later reject. The SA tool rejects this up front; the reducer
			// guard is the backstop for any other emitter.
			if (!fieldKindDeclaresKey(field.kind, mediaKey)) {
				log.warn(
					`setFieldMedia: ${field.kind} field has no ${mediaKey} slot — skipped.`,
					{ uuid: mut.fieldUuid, slot: mut.slot },
				);
				return;
			}
			// Map `null → undefined` so a cleared slot drops off the field
			// (the slot is `.optional()`, never a stored `null`). Cast through
			// a record view: the four `<slot>_media` keys live on different
			// arms of the discriminated `Field` union with no single common
			// parent, so a structural write is the cleanest way to set one.
			(field as Record<string, unknown>)[mediaKey] = mut.media ?? undefined;
			return;
		}
	}
}

/** Zero-valued `FieldRenameMeta`, returned on no-op renames. */
function emptyFieldRenameMeta(): FieldRenameMeta {
	return {
		xpathFieldsRewritten: 0,
		peerFieldsRenamed: 0,
		columnsRewritten: 0,
		formWiringRewritten: 0,
		moduleRefsRewritten: 0,
		catalogEntryRenamed: false,
		cascadedAcrossForms: false,
	};
}

/**
 * Mutable accumulators shared by every pass of one rename: the
 * primary rename, each peer rename, and the case-property cascade all
 * write into the same three sets so the meta's distinct-entity counts
 * and the cross-form flag see one unified view of what changed.
 */
interface RenameTracking {
	/** Fields whose expression/prose slots changed — distinct. */
	touchedFields: Set<Uuid>;
	/** Forms with ANY change (field slots or form wiring). */
	affectedForms: Set<Uuid>;
	/** Forms whose form-level wiring slots changed — distinct. */
	rewiredForms: Set<Uuid>;
}

/**
 * Read a field's `case_property_on` value in a kind-agnostic way.
 *
 * `case_property_on` lives on the `InputFieldBase` mixin (every input-like
 * kind: text, int, select, date, …) but not on structural kinds (group,
 * repeat). Walking the discriminated union at every call site would bloat
 * the reducer with type guards; a narrow helper isolates the cast. The
 * empty-string case clears the property — we treat it as "not set" so a
 * media-field `case_property_on: ""` clear doesn't accidentally cascade.
 */
function extractCaseProperty(field: { kind: string }): string | undefined {
	const value = (field as { case_property_on?: string }).case_property_on;
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value;
}

/**
 * Catalog sync at source: register a field's `(case_property_on,
 * field.id)` pair in the case-type catalog iff absent.
 *
 * The catalog (`doc.caseTypes[].properties`) is the authoritative
 * admission set for `#<type>/<prop>` references — the deep validator,
 * inline linter, chip hydrator, and autocomplete all read it via
 * `reachableCaseTypes`. A field that writes to a case property IS a
 * declaration of that property, so every reducer arm that lands a
 * field with (or changes a field to have) a non-empty
 * `case_property_on` calls this — `addField`, `updateField`,
 * `convertField`, `duplicateField`, and `moveField`'s dedup-rename —
 * mirroring the in-place entry rename `cascadeCasePropertyRename`
 * already performs. Reducer-side so server, client, and event-log
 * replay derive byte-identical catalogs from the same mutation.
 *
 * Admission rules, matching the validator's model:
 *   - A declared entry is never touched — no duplicate, no
 *     `data_type` / `label` overwrite. Writer/declaration mismatches
 *     stay visible to the `FIELD_KIND_PROPERTY_TYPE_MISMATCH` rule.
 *   - An absent case TYPE is created as a bare `{ name, properties }`
 *     record. The system already treats naming a type as bringing its
 *     namespace into existence (`reachableCaseTypes` admits an
 *     undeclared module type at depth 0), and writer-derived
 *     properties are already admitted by the case-list rules
 *     (`validator/rules/case-list/shared.ts::augmentCaseType`).
 *     Ancestry (`parent_type` / `relationship`) is a declaration-level
 *     act made via `setCaseTypes` — never invented here.
 *   - New entries carry the kind-derived `data_type` from the locked
 *     domain table (`caseDataTypeForFieldKind`); kinds that don't pin
 *     a value type (`hidden`) yield an untyped entry, read as `text`
 *     everywhere via the `effectiveDataType` convention. `label`
 *     defaults to the property name, the same shape `augmentCaseType`
 *     gives writer-derived entries.
 *   - Removal/clear never prunes — declared properties outlive their
 *     writers by design.
 */
function ensureCatalogProperty(doc: BlueprintDoc, field: Field): void {
	const caseType = extractCaseProperty(field);
	if (caseType === undefined || field.id.length === 0) return;
	doc.caseTypes ??= [];
	const catalog = doc.caseTypes;
	let ct = catalog.find((c) => c.name === caseType);
	if (!ct) {
		ct = { name: caseType, properties: [] };
		catalog.push(ct);
	}
	if (ct.properties.some((p) => p.name === field.id)) return;
	const dataType = caseDataTypeForFieldKind(field.kind);
	ct.properties.push({
		name: field.id,
		label: field.id,
		...(dataType !== undefined && { data_type: dataType }),
	});
}

/**
 * Rename one field's `id` and rewrite XPath / hashtag references that live
 * inside the same form. This is the form-local half of the rename: it does
 * NOT walk modules or other forms. Used both for the primary rename and
 * for every peer rename discovered by the case-property cascade.
 *
 * Reference coverage is the registry's per-kind projection
 * (`referenceRewrites.ts::rewriteFieldReferenceSlots`): every XPath
 * slot runs through `rewriteXPathRefs`, which surgically edits
 * matching absolute paths (`/data/…/old_id` → `/data/…/new_id`) and
 * `#form/` hashtags at any depth (`#form/grp/old_id` →
 * `#form/grp/new_id`), prefix-matched on the renamed field's segments
 * so renaming a CONTAINER re-anchors refs to its descendants too
 * (`#form/grp/inner` → `#form/grp2/inner`) while a cousin sharing the
 * leaf under a different group is untouched; every prose slot is
 * regex-located first so only the embedded hashtag refs are rewritten
 * while the surrounding text is preserved verbatim. The containing form's own wiring slots
 * (form-link conditions/datums, Connect expressions,
 * `closeCondition.field`) are rewritten in the same pass — they
 * reference this form's fields (see `FormSlotRewriteContext`).
 *
 * `tracking` is passed in so multiple invocations (primary rename plus
 * each peer rename plus the cascade's `#case/` pass) share one view of
 * "what was touched" — the meta's distinct-entity counts and
 * `cascadedAcrossForms` both need a view that spans every pass.
 */
function renameSingleField(
	doc: BlueprintDoc,
	uuid: Uuid,
	newId: string,
	tracking: RenameTracking,
): void {
	const field = doc.fields[uuid];
	if (!field) return;

	// Capture old id + path BEFORE mutating so `computeFieldPath` produces
	// the pre-rename path segments that references will match against.
	const oldId = field.id;
	const oldPath = computeFieldPath(doc, uuid);
	const formUuid = findContainingForm(doc, uuid);
	field.id = newId;

	// An unreachable field (not in any form) still has its id updated, but
	// there's no form to walk for reference rewrites.
	if (oldPath === undefined || formUuid === undefined) return;

	rewriteFormLocalRefs(doc, formUuid, oldPath, newId, tracking);

	// Form-level wiring on the containing form. `closeCondition.field`
	// is a bare leaf-id ref, so it follows the rename only when the
	// renamed field was the unique holder of the old id in this form —
	// if a cousin still answers to it, the ref keeps resolving there.
	const form = doc.forms[formUuid];
	if (form) {
		let oldIdStillTaken = false;
		for (const fUuid of walkFormFieldUuids(doc, formUuid)) {
			if (fUuid === uuid) continue;
			if (doc.fields[fUuid]?.id === oldId) {
				oldIdStillTaken = true;
				break;
			}
		}
		const wiringChanges = rewriteFormReferenceSlots(form, {
			xpath: (expr) => rewriteXPathRefs(expr, oldPath, newId),
			fieldIdRename: { oldId, newId, oldIdStillTaken },
		});
		if (wiringChanges > 0) {
			tracking.rewiredForms.add(formUuid);
			tracking.affectedForms.add(formUuid);
		}
	}
}

/**
 * Walk every field under `formUuid` and rewrite path / hashtag references
 * to a field whose path ended in `oldPath` and whose leaf id is now
 * `newLeafId`. Scoped to a single form because XPath references don't
 * cross form boundaries — `/data/foo` means this form's `foo`, and
 * `#form/foo` is form-scoped by CommCare semantics.
 *
 * Records every modified field in `tracking.touchedFields` (so callers
 * dedupe multi-pass hits) and adds `formUuid` to `affectedForms` on
 * any change.
 */
function rewriteFormLocalRefs(
	doc: BlueprintDoc,
	formUuid: Uuid,
	oldPath: string,
	newLeafId: string,
	tracking: RenameTracking,
): void {
	const xpathRewriter = (expr: string) =>
		rewriteXPathRefs(expr, oldPath, newLeafId);
	for (const fUuid of walkFormFieldUuids(doc, formUuid)) {
		const target = doc.fields[fUuid];
		if (!target) continue;
		if (rewriteFieldReferenceSlots(target, xpathRewriter) > 0) {
			tracking.touchedFields.add(fUuid);
			tracking.affectedForms.add(formUuid);
		}
	}
}

/**
 * Cross-form cascade triggered when a field with `case_property_on` is
 * renamed. Because `field.id` IS the case property name for fields that
 * save to a case, a rename is semantically a rename of the case property.
 * That property is referenced from several places outside the containing
 * form:
 *
 *   1. **Peer fields** — other input fields whose `id === oldId` AND
 *      `case_property_on === caseType`. Those are not references; they're
 *      authoritative declarations of the same property in a different
 *      form (common when multiple forms read/write the same case
 *      property). Each peer is renamed + has its own form's local refs
 *      rewritten via `renameSingleField`.
 *
 *   2. **Transitional `#case/` hashtag references** — `#case/<oldId>` inside
 *      XPath expressions, prose, or form-level wiring (form-link
 *      conditions/datums, Connect expressions) on ANY form bound to a
 *      module whose `caseType === caseType`. `#case/` resolves to the
 *      containing module's case type, so refs in modules with a different
 *      caseType point at a different property and must NOT be rewritten.
 *
 *   3. **Module-level slots** — `col.field` cells holding a bare case
 *      property name (same caseType scope as (2)) plus the predicate /
 *      value-expression ASTs and search-input property slots, all owned
 *      by `referenceRewrites.ts::rewriteModuleCaseRefs` (per-slot
 *      scoping documented there — AST `PropertyRef` leaves self-encode
 *      their case type and match on the relation walk's destination).
 *
 *   4. **Case-type catalog** — `doc.caseTypes[<caseType>].properties[]` is
 *      the authoritative list of known case properties for a case type.
 *      Every builder-time consumer (XPath linter, chip hydrator,
 *      validator, autocompleter) reads it via `buildLintContext`. If the
 *      catalog still advertises `age` after we've renamed to `age_1`, the
 *      linter rejects `#mother/age_1` as an unknown property and the chip
 *      decorator refuses to render a chip (hashtag name not recognized).
 *
 *   5. **Per-type hashtag references** — `#<caseType>/<oldId>` inside XPath
 *      expressions or prose on ANY field APP-WIDE. Unlike `#case/`, a
 *      per-type ref names its case type explicitly, so it resolves to the
 *      same type from any form that can reach it (own or ancestor) — the
 *      rewrite spans every module, matching the namespace exactly so a
 *      `#<otherType>/<oldId>` ref to a different type is never touched.
 *
 * The cascade runs entirely on the Immer draft. `excludeUuid` is the
 * primary field's uuid — excluded from the peer-field rename walk so it
 * doesn't get renamed twice. The primary field IS included in the hashtag
 * rewrite walks because it may reference its own old property name in a
 * label or calculate (unusual but legal).
 *
 * Returns counts for metadata surfacing; callers add them to any
 * form-local counts produced by the primary rename.
 */
interface CaseCascadeResult {
	peerFieldsRenamed: number;
	columnsRewritten: number;
	/** `PropertyRef` AST nodes + simple search-input `property` slots
	 *  renamed across module-level ASTs. See `FieldRenameMeta`. */
	moduleRefsRewritten: number;
	/** True iff a `caseTypes[caseType].properties[]` entry named `oldId`
	 *  was found and renamed — or merged away because an entry named
	 *  `newId` already existed (the declared entry wins; see the catalog
	 *  pass below). Reported on `FieldRenameMeta` so consumers know the
	 *  catalog changed (e.g. to refresh autocomplete caches). */
	catalogEntryRenamed: boolean;
}
function cascadeCasePropertyRename(
	doc: BlueprintDoc,
	caseType: string,
	oldId: string,
	newId: string,
	excludeUuid: Uuid,
	tracking: RenameTracking,
): CaseCascadeResult {
	let peerFieldsRenamed = 0;
	let columnsRewritten = 0;
	let moduleRefsRewritten = 0;
	let catalogEntryRenamed = false;

	// ── (1) Peer field renames ──────────────────────────────────────────
	// Collect peers by a full snapshot BEFORE renaming any so the loop
	// doesn't race a rename mutating its own predicate (post-rename a peer
	// has id === newId, not oldId). Snapshot iteration also means a
	// theoretical duplicate uuid in `fields` can't double-rename.
	const peers: Uuid[] = [];
	for (const [fieldUuid, field] of Object.entries(doc.fields)) {
		if (!field) continue;
		if (fieldUuid === excludeUuid) continue;
		if (field.id !== oldId) continue;
		if (extractCaseProperty(field) !== caseType) continue;
		peers.push(fieldUuid as Uuid);
	}
	for (const peerUuid of peers) {
		renameSingleField(doc, peerUuid, newId, tracking);
		peerFieldsRenamed++;
	}

	// ── (4) Case-type catalog rename ────────────────────────────────────
	// The catalog is the single source of truth for which property names
	// the XPath linter + chip hydrator recognize. Rename BEFORE the column
	// / hashtag passes so any code reading the draft mid-traversal sees
	// the updated catalog — matches the ordering invariant that a given
	// name is either `oldId` or `newId` but never both.
	//
	// When an entry named `newId` ALREADY exists on the type (nothing
	// blocks renaming a field onto another property's name — the
	// identifier verdicts check sibling FIELD ids only), the rename is a
	// MERGE: the existing entry's declaration wins (the same
	// declared-never-touched rule `ensureCatalogProperty` applies on the
	// add path) and the `oldId` entry is dropped. Renaming it anyway
	// would mint a duplicate name, and every by-name consumer
	// (`properties.find(...)`) is first-match — resolution would depend
	// on insertion order forever, since removal never prunes.
	if (doc.caseTypes) {
		for (const ct of doc.caseTypes) {
			if (ct.name !== caseType) continue;
			const newIdDeclared = ct.properties.some((p) => p.name === newId);
			if (newIdDeclared) {
				const kept = ct.properties.filter((p) => p.name !== oldId);
				if (kept.length !== ct.properties.length) {
					ct.properties = kept;
					catalogEntryRenamed = true;
				}
			} else {
				for (const prop of ct.properties) {
					if (prop.name === oldId) {
						prop.name = newId;
						catalogEntryRenamed = true;
					}
				}
			}
		}
	}

	// ── (2) + (3) + (5) Hashtag + module-slot rewrites, in a SINGLE
	// app-wide walk. Two hashtag rewriters with different scopes:
	//
	//   - The per-type ref `#<caseType>/<oldId>` names its case type
	//     explicitly, so it resolves to the SAME type from every form that can
	//     reach it (own OR ancestor) — a child module's followup form can read
	//     `#mother/<oldId>`. So it's rewritten APP-WIDE. The namespace match is
	//     EXACT, so a `#<otherType>/<oldId>` ref to a different type that shares
	//     the property name is untouched.
	//   - The transitional `#case/<oldId>` ref means "this module's case type",
	//     so it's rewritten ONLY in modules whose own caseType matches — a
	//     module with a different caseType references a different case entity.
	//
	// Module-level slots route through `rewriteModuleCaseRefs`, which
	// owns the per-slot scoping (columns + simple search-input
	// properties key on the module's contextual case type; AST
	// `PropertyRef` leaves self-encode theirs and are matched per node).
	const caseRewriter = (expr: string) =>
		rewriteHashtagRefs(expr, "#case/", oldId, newId);
	const perTypeRewriter = (expr: string) =>
		rewriteHashtagRefs(expr, `#${caseType}/`, oldId, newId);
	const rename = { caseType, oldName: oldId, newName: newId };
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const matchesCaseType = mod?.caseType === caseType;

		if (mod) {
			const moduleRewrites = rewriteModuleCaseRefs(mod, rename);
			columnsRewritten += moduleRewrites.columnsRewritten;
			moduleRefsRewritten += moduleRewrites.astRefsRewritten;
		}

		// Per-form field expressions + display text + form-level wiring.
		// In a matching-caseType module both rewriters run (the per-type
		// AND the context-dependent `#case/`); elsewhere only the per-type
		// one. A field touched here may also have been touched by a
		// form-local pass earlier (peer renames walk their own forms);
		// adding to `touchedFields` dedupes so `xpathFieldsRewritten`
		// counts each field once, not once per pass. Form wiring carries
		// case hashtags too (Connect expressions and form-link conditions
		// validate against case refs), so the same rewriter runs over the
		// form's XPath wiring slots — `closeCondition.field` is a form-
		// local field id, untouched by a case pass (peer renames handle
		// their own forms' close conditions).
		const rewriter = matchesCaseType
			? (expr: string) => caseRewriter(perTypeRewriter(expr))
			: perTypeRewriter;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			for (const fUuid of walkFormFieldUuids(doc, formUuid)) {
				const field = doc.fields[fUuid];
				if (!field) continue;
				if (rewriteFieldReferenceSlots(field, rewriter) > 0) {
					tracking.touchedFields.add(fUuid);
					tracking.affectedForms.add(formUuid);
				}
			}
			const form = doc.forms[formUuid];
			if (form && rewriteFormReferenceSlots(form, { xpath: rewriter }) > 0) {
				tracking.rewiredForms.add(formUuid);
				tracking.affectedForms.add(formUuid);
			}
		}
	}

	return {
		peerFieldsRenamed,
		columnsRewritten,
		moduleRefsRewritten,
		catalogEntryRenamed,
	};
}
