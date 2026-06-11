import type { Draft } from "immer";
import type { FieldPath } from "@/lib/doc/fieldPath";
import { declarersOf, referencingCarrierUuids } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import {
	caseDataTypeForFieldKind,
	casePropertyTargetKey,
	entityTargetKey,
	type Field,
	fieldCasePropertyOn,
	fieldKindDeclaresKey,
	fieldSchema,
	getConvertibleTypes,
	pickFieldKeysForKind,
	reconcileFieldForKind,
} from "@/lib/domain";
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
 * The reducer performs SAME-FORM moves only — a `toParentUuid` resolving
 * to a different form is warn-and-skipped (see the guard in the arm), and
 * so is a destination inside the moved field's OWN subtree (itself or a
 * descendant container — the splice would create a `fieldOrder` cycle
 * that detaches the subtree from every walk). Cross-form moves were never
 * designed: references are form-scoped, so a field that changes forms has
 * no defined meaning for its inbound OR outbound references; designing
 * the operation is future work that has to pick outbound-ref semantics
 * first.
 *
 * `renamed` is populated when a cross-level move triggers sibling-id
 * deduplication (CommCare requires unique IDs per parent level). Within
 * the form, reference rewriting is total: absolute paths AND `#form/`
 * hashtag refs re-anchor across any depth change (`rewriteXPathOnMove`),
 * refs to a moved CONTAINER's descendants included (segment-prefix
 * re-anchor), so a move never leaves a dangling reference behind.
 *
 * `xpathFieldsRewritten` counts the reference-carrying SLOTS whose
 * value changed across the move's rewrite pass — sibling fields'
 * expression/prose slots plus the containing form's own wiring slots
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
			//
			// Identity (`uuid`) and discriminant (`kind`) are immutable for
			// the lifetime of a field entity, so those keys are STRIPPED
			// (the rest of the patch applies normally). The per-kind patch
			// schemas omit both, which means a wire/event-log round-trip
			// silently drops them (`partialOf`'s default-mode object strips
			// unknown keys) — the reducer must drop them too or in-process
			// application and replay of the SAME mutation diverge, breaking
			// byte-identity. `convertField` is the single designed
			// kind-change path: it owns the convertibility gate (container ↔
			// leaf corruption) this merge has no equivalent of.
			const spread: Record<string, unknown> = { ...field };
			for (const [key, value] of Object.entries(mut.patch)) {
				if (key === "uuid" || key === "kind") {
					console.debug(
						`updateField: ignored the immutable "${key}" key in a patch for ${mut.uuid} — a field's identity and kind never change through a patch. Use convertField to change a field's kind.`,
					);
					continue;
				}
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

			// A destination inside the moved subtree (the moved field itself,
			// or any container under it) passes the same-form guard below —
			// both ends resolve to the same form PRE-move — but the splice
			// would insert the field into its own descendant's `fieldOrder`,
			// a cycle no form walk reaches: the whole subtree silently
			// vanishes from the builder tree, the validator, and every
			// emitter. Walk the destination's ancestry; hitting the moved
			// uuid before a form means the move folds the subtree into
			// itself — warn-and-skip, same convention as the cross-form
			// guard below.
			if (!destIsForm) {
				let insideMovedSubtree = false;
				let cursor: Uuid | undefined = mut.toParentUuid;
				const seen = new Set<Uuid>(); // Defensive: a pre-existing cycle must not hang the reducer.
				while (cursor !== undefined && !seen.has(cursor)) {
					if (cursor === mut.uuid) {
						insideMovedSubtree = true;
						break;
					}
					seen.add(cursor);
					const ancestor = findFieldParent(
						draft as unknown as BlueprintDoc,
						cursor,
					);
					// Stop at the form boundary or an orphan top — the
					// same-form guard below owns unreachable destinations.
					cursor =
						ancestor !== undefined &&
						draft.forms[ancestor.parentUuid] === undefined
							? ancestor.parentUuid
							: undefined;
				}
				if (insideMovedSubtree) {
					console.warn(
						`moveField: skipped moving "${field.id}" — the destination container is the field itself or one of its own descendants, and a field can't move inside its own subtree. Pick a destination outside the moved ${field.kind}.`,
						{ uuid: mut.uuid, toParentUuid: mut.toParentUuid },
					);
					return;
				}
			}

			// The move proceeds only when it is PROVABLY same-form: both
			// ends resolve to a containing form and the two are equal.
			// Everything else — a different form, OR either end unreachable
			// from any form (an orphaned container off a degenerate replay) —
			// is warn-and-skipped, the total-reducer convention for an
			// invalid mutation (same shape as the stale updateField patch
			// skip). Fail CLOSED: XPath references are form-scoped, so a
			// field that changes forms (or vanishes into an unreachable
			// container, with zero rewriting possible) has no defined
			// semantics for EITHER direction of its references — refs it
			// leaves behind and its own outbound refs can each silently
			// capture an unrelated same-named field. Every current emitter
			// stays within one form; designing cross-form moves is future
			// work that has to pick outbound-ref semantics first.
			//
			// `console.warn`, not the structured logger: reducers bundle
			// client-side, and the logger's production path writes to
			// `process.stdout`, which Next's browser process shim doesn't
			// define — it would throw from inside the reducer on the exact
			// degraded path this guard exists to soften.
			const sourceFormUuid = findContainingForm(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			const destFormUuid = destIsForm
				? mut.toParentUuid
				: findContainingForm(
						draft as unknown as BlueprintDoc,
						mut.toParentUuid,
					);
			if (
				sourceFormUuid === undefined ||
				destFormUuid === undefined ||
				sourceFormUuid !== destFormUuid
			) {
				console.warn(
					`moveField: skipped moving "${field.id}" — the move couldn't be confirmed to stay within one form (the destination is in a different form, or one end isn't reachable from any form). A field can't move between forms because its references can't follow it across the form boundary; remove the field and recreate it in the other form instead.`,
					{ uuid: mut.uuid, toParentUuid: mut.toParentUuid },
				);
				return;
			}

			const sourceParent = findFieldParent(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			const oldPathStr =
				computeFieldPath(draft as unknown as BlueprintDoc, mut.uuid) ?? "";
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
			// Same-form by the cross-form guard above — XPath references
			// never cross form boundaries. The carriers come from the
			// reference index: refs into a moved CONTAINER's subtree carry a
			// prefix edge to the container itself, so one lookup on the moved
			// field's uuid names every field whose slots can match, and the
			// rewriter re-parses just those carriers' slots. The containing
			// form's own wiring slots (form-link conditions/datums, Connect
			// expressions) rewrite alongside. `closeCondition.field` is a bare leaf-id ref and
			// is deliberately NOT rewritten here: a move only changes the
			// leaf id through sibling-dedup, and in that case the destination
			// sibling that forced the dedup still holds the old id — the ref
			// keeps resolving to it (see `FormSlotRewriteContext
			// .fieldIdRename`'s unique-holder rule).
			let xpathFieldsRewritten = 0;
			const newPathStr =
				computeFieldPath(draft as unknown as BlueprintDoc, mut.uuid) ?? "";
			if (oldPathStr && newPathStr && oldPathStr !== newPathStr) {
				const oldSegments = oldPathStr.split("/");
				const newSegments = newPathStr.split("/");
				const moveRewriter = (expr: string) =>
					rewriteXPathOnMove(expr, oldSegments, newSegments);
				const formUuid = findContainingForm(
					draft as unknown as BlueprintDoc,
					mut.uuid,
				);
				if (formUuid) {
					for (const carrierUuid of referencingCarrierUuids(
						draft as unknown as BlueprintDoc,
						entityTargetKey(mut.uuid),
					)) {
						const target = draft.fields[carrierUuid as Uuid];
						if (!target) continue;
						xpathFieldsRewritten += rewriteFieldReferenceSlots(target, {
							xpath: moveRewriter,
						});
					}
					const form = draft.forms[formUuid];
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
			const caseType = fieldCasePropertyOn(field);
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
				// `console.warn`, not the structured logger — reducers bundle
				// client-side, where the logger's production path throws (see
				// the moveField guard note).
				console.warn(
					`convertField: skipped converting "${field.id}" — a "${field.kind}" field can't convert to "${mut.toKind}".${allowed.length > 0 ? ` Valid targets: ${allowed.join(", ")}.` : ""}`,
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
				// the surrounding render. Warning + no-op keeps the app alive
				// while making the anomaly visible in dev tools.
				console.warn(
					`convertField: couldn't reconcile "${field.id}" from "${field.kind}" to "${mut.toKind}" — the converted shape failed the field schema, so the field was left unchanged.`,
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
				console.warn(
					`setFieldMedia: skipped setting ${mut.slot} media on "${field.id}" — a "${field.kind}" field has no ${mediaKey} slot.`,
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
	const caseType = fieldCasePropertyOn(field);
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

	// Capture the path BEFORE mutating so `computeFieldPath` produces
	// the pre-rename path segments that references will match against.
	const oldPath = computeFieldPath(doc, uuid);
	const formUuid = findContainingForm(doc, uuid);
	field.id = newId;

	// An unreachable field (not in any form) still has its id updated, but
	// there's no form to walk for reference rewrites.
	if (oldPath === undefined || formUuid === undefined) return;

	rewriteFormLocalRefs(doc, uuid, formUuid, oldPath, newId, tracking);

	// Form-level wiring on the containing form. `closeCondition.field`
	// holds the checked field's stable uuid, so it needs nothing from a
	// rename — only the string XPath wiring slots still rewrite here.
	const form = doc.forms[formUuid];
	if (form) {
		const wiringChanges = rewriteFormReferenceSlots(form, {
			xpath: (expr) => rewriteXPathRefs(expr, oldPath, newId),
		});
		if (wiringChanges > 0) {
			tracking.rewiredForms.add(formUuid);
			tracking.affectedForms.add(formUuid);
		}
	}
}

/**
 * Rewrite path / hashtag references to the renamed field (`targetUuid`,
 * whose pre-rename path was `oldPath`) across the fields that carry
 * them. The carriers come from the reference index — one lookup on the
 * renamed field's uuid, which covers refs into a renamed CONTAINER's
 * subtree too (every ref carries a prefix edge to each resolved
 * ancestor) — and the rewriter then re-parses just those carriers'
 * slots. Form-scoped by construction: XPath references don't cross
 * form boundaries, so every carrier of a `u:` edge to this field lives
 * in its own form.
 *
 * Records every modified field in `tracking.touchedFields` (so callers
 * dedupe multi-pass hits) and adds `formUuid` to `affectedForms` on
 * any change.
 */
function rewriteFormLocalRefs(
	doc: BlueprintDoc,
	targetUuid: Uuid,
	formUuid: Uuid,
	oldPath: string,
	newLeafId: string,
	tracking: RenameTracking,
): void {
	const xpathRewriter = (expr: string) =>
		rewriteXPathRefs(expr, oldPath, newLeafId);
	for (const carrierUuid of referencingCarrierUuids(
		doc,
		entityTargetKey(targetUuid),
	)) {
		// The containing form's own wiring slots rewrite in
		// `renameSingleField` — only field carriers rewrite here.
		const target = doc.fields[carrierUuid as Uuid];
		if (!target) continue;
		if (rewriteFieldReferenceSlots(target, { xpath: xpathRewriter }) > 0) {
			tracking.touchedFields.add(carrierUuid as Uuid);
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
	// Peers come from the declarations index — the fields writing the
	// same (caseType, oldId) pair. The primary field is excluded (its id
	// already changed); each candidate is verified against the CURRENT
	// doc so the collected set matches live state exactly, and the
	// collect-then-rename split keeps each rename from mutating the set
	// it was drawn from.
	const peers: Uuid[] = [];
	for (const peerUuid of declarersOf(doc, caseType, oldId)) {
		if (peerUuid === excludeUuid) continue;
		const peer = doc.fields[peerUuid as Uuid];
		if (!peer || peer.id !== oldId) continue;
		if (fieldCasePropertyOn(peer) !== caseType) continue;
		peers.push(peerUuid as Uuid);
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

	// ── (2) + (3) + (5) Hashtag + module-slot rewrites, driven by ONE
	// reference-index lookup: the carriers of the (caseType, oldId)
	// property edge. The index keys every spelling under that one
	// identity — explicit `#<caseType>/<oldId>` hashtags app-wide,
	// contextual `#case/<oldId>` refs in modules whose own caseType
	// matches (extraction keys them under the module's CURRENT type, so
	// a non-matching module's `#case/` refs are simply not in the
	// bucket), AST `PropertyRef` leaves whose relation walk lands on the
	// type, and the module config's contextual property slots. The
	// rewriters then re-parse just those carriers' slots:
	//
	//   - The per-type ref `#<caseType>/<oldId>` names its case type
	//     explicitly, so it resolves to the SAME type from every form that can
	//     reach it (own OR ancestor) — a child module's followup form can read
	//     `#mother/<oldId>`. So it's rewritten on every carrier. The namespace
	//     match is EXACT, so a `#<otherType>/<oldId>` ref to a different type
	//     that shares the property name is untouched.
	//   - The transitional `#case/<oldId>` rewriter joins only on carriers
	//     whose owning module's caseType matches — a module with a
	//     different caseType references a different case entity.
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
	for (const carrierUuid of referencingCarrierUuids(
		doc,
		casePropertyTargetKey(caseType, oldId),
	)) {
		const mod = doc.modules[carrierUuid as Uuid];
		if (mod) {
			const moduleRewrites = rewriteModuleCaseRefs(mod, rename);
			columnsRewritten += moduleRewrites.columnsRewritten;
			moduleRefsRewritten += moduleRewrites.astRefsRewritten;
			continue;
		}

		// Field / form carriers pick their rewriter by the owning module:
		// in a matching-caseType module both rewriters run (the per-type
		// AND the context-dependent `#case/`); elsewhere only the per-type
		// one. A field touched here may also have been touched by a
		// form-local pass earlier (peer renames rewrite their own forms);
		// adding to `touchedFields` dedupes so `xpathFieldsRewritten`
		// counts each field once, not once per pass. Form wiring carries
		// case hashtags too (Connect expressions and form-link conditions
		// validate against case refs), so the same rewriter runs over the
		// form's XPath wiring slots — `closeCondition.field` is a form-
		// local field id, untouched by a case pass (peer renames handle
		// their own forms' close conditions).
		const formUuid = doc.forms[carrierUuid as Uuid]
			? (carrierUuid as Uuid)
			: findContainingForm(doc, carrierUuid as Uuid);
		if (formUuid === undefined) continue;
		let owningModule: Uuid | undefined;
		for (const [modUuid, formUuids] of Object.entries(doc.formOrder)) {
			if (formUuids.includes(formUuid)) {
				owningModule = modUuid as Uuid;
				break;
			}
		}
		const matchesCaseType =
			owningModule !== undefined &&
			doc.modules[owningModule]?.caseType === caseType;
		const rewriter = matchesCaseType
			? (expr: string) => caseRewriter(perTypeRewriter(expr))
			: perTypeRewriter;
		const field = doc.fields[carrierUuid as Uuid];
		if (field) {
			const fieldOps = {
				xpath: rewriter,
				caseLeafRename: { rename, contextualMatches: matchesCaseType },
			};
			if (rewriteFieldReferenceSlots(field, fieldOps) > 0) {
				tracking.touchedFields.add(carrierUuid as Uuid);
				tracking.affectedForms.add(formUuid);
			}
			continue;
		}
		const form = doc.forms[carrierUuid as Uuid];
		if (form && rewriteFormReferenceSlots(form, { xpath: rewriter }) > 0) {
			tracking.rewiredForms.add(formUuid);
			tracking.affectedForms.add(formUuid);
		}
	}

	return {
		peerFieldsRenamed,
		columnsRewritten,
		moduleRefsRewritten,
		catalogEntryRenamed,
	};
}
