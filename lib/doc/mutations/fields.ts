import type { Draft } from "immer";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import {
	fieldRegistry,
	fieldSchema,
	reconcileFieldForKind,
} from "@/lib/domain";
import { transformBareHashtags } from "@/lib/preview/engine/labelRefs";
import {
	rewriteHashtagRefs,
	rewriteXPathRefs,
} from "@/lib/preview/xpath/rewrite";
import type { FieldPath } from "@/lib/services/fieldPath";
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

/**
 * Metadata returned by `moveField`.
 *
 * `renamed` is populated when a cross-level move triggers sibling-id
 * deduplication (CommCare requires unique IDs per parent level).
 *
 * `droppedCrossDepthRefs` counts hashtag refs (`#form/foo`) that pointed at
 * the moved field's old id but became dangling because the new path has
 * depth > 1 (hashtag syntax only encodes single top-level names). No
 * consumer surfaces this to the UI yet; the count is captured so a
 * future toast can warn the user that N references silently broke.
 */
export interface MoveFieldResult {
	renamed?: {
		oldId: string;
		newId: string;
		newPath: FieldPath;
		xpathFieldsRewritten: number;
	};
	droppedCrossDepthRefs: number;
}

/**
 * Metadata returned by `renameField`.
 *
 * A rename is either **form-local** (the field does not write to a case, so
 * only its own form's XPath references change) or **cascaded** (the field
 * has a `case_property` — renaming its id is semantically a rename of the
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
 *     `case_property`) in a different form. Those are authoritative peers
 *     of the renamed field, not references to it.
 *   - `columnsRewritten` — number of `caseListColumns` / `caseDetailColumns`
 *     entries on matching modules whose `field` value was updated.
 *   - `catalogEntryRenamed` — `true` iff `doc.caseTypes[caseType].properties[]`
 *     had a matching entry renamed. The catalog is the authoritative list
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
	catalogEntryRenamed: boolean;
	cascadedAcrossForms: boolean;
}

/**
 * Fields on a `Field` entity that carry XPath expressions directly —
 * these get rewritten via the Lezer-based `rewriteXPathRefs` parser when
 * a referenced field is renamed.
 *
 * Typed as `readonly string[]` rather than a union-specific keyof because
 * these keys only apply to some members of the `Field` union (text, int,
 * etc.); the runtime code reads each field via `(target as Record<string,
 * unknown>)[f]` with a `typeof === "string"` guard, so narrowing to a
 * single variant's keys would be overly strict.
 *
 * Notably excluded:
 *   - `validation_msg`: user-facing error text, not an XPath expression.
 *   - `label`, `hint`: prose fields that may embed bare hashtag refs
 *     (`#form/foo`), handled separately via DISPLAY_FIELDS below.
 *   - `required`: not an XPath field in the current schema.
 */
const XPATH_FIELDS = [
	"relevant",
	"calculate",
	"default_value",
	"validate",
] as const;

/**
 * Fields that contain prose text which may embed bare hashtag references
 * (`#form/field_id`, `#case/property`) inside otherwise-plain content.
 * These fields are rewritten via `transformBareHashtags` → `rewriteXPathRefs`
 * so only the hashtag substrings are parsed, not the entire field as XPath.
 *
 * Same typing caveat as `XPATH_FIELDS`: `hint` and `label` don't exist on
 * every Field variant (hidden has no label; secret has no hint), so we
 * avoid pinning this to a single member's keyof.
 */
const DISPLAY_FIELDS = ["label", "hint"] as const;

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
				| "convertField";
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
			return;
		}
		case "updateField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			// Validate the merged result against the full `fieldSchema` discriminated
			// union. `FieldPatch` is a union-wide partial — at the type level it
			// allows any variant's keys, so e.g. a `{ label: "x" }` patch against a
			// HiddenField (which has no `label`) would compile fine and `Object.assign`
			// would silently install the stray key. Parsing here rejects patches
			// that introduce keys the target variant does not define, and also
			// rejects invalid values for keys that DO exist (e.g. wrong type).
			// Zod strips unknown keys by default, so the reducer installs a clean
			// entity rather than accumulating drift over time.
			const merged = { ...field, ...mut.patch };
			const result = fieldSchema.safeParse(merged);
			if (!result.success) {
				// A patch that fails the schema is a programmer error — log with
				// the exact issues so the offending call site is easy to locate,
				// then skip the update rather than throwing from inside an Immer
				// reducer (a throw would propagate up through `store.applyMany()`
				// and crash the surrounding render or route handler).
				console.warn(
					`updateField: patch rejected for ${mut.uuid} (kind=${field.kind})`,
					{ patch: mut.patch, issues: result.error.issues },
				);
				return;
			}
			// Install the parsed (and key-stripped) entity — replaces the existing
			// entry rather than mutating it in place, which is the canonical
			// Immer-friendly way to write a known-good replacement.
			draft.fields[mut.uuid] = result.data;
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

			// Insert at destination.
			const destOrder = draft.fieldOrder[mut.toParentUuid] ?? [];
			const clamped = Math.max(0, Math.min(mut.toIndex, destOrder.length));
			destOrder.splice(clamped, 0, mut.uuid);
			draft.fieldOrder[mut.toParentUuid] = destOrder;

			// Rewrite absolute-path / hashtag references that now point at a
			// stale path. Covers cross-level moves (where the prefix changes)
			// and reorder+rename (where the leaf segment changes from dedup).
			// Same-form only — xpath references never cross form boundaries.
			let xpathFieldsRewritten = 0;
			// Count of hashtag refs (`#form/foo`) that matched the moved field's
			// old id but could not be rewritten — a cross-depth move makes those
			// references unreachable via hashtag syntax. Captured for future UI
			// surfacing; no consumer reads it yet.
			let droppedCrossDepthRefs = 0;
			const newPathStr =
				computeFieldPath(draft as unknown as BlueprintDoc, mut.uuid) ?? "";
			if (oldPathStr && newPathStr && oldPathStr !== newPathStr) {
				const oldSegments = oldPathStr.split("/");
				const newSegments = newPathStr.split("/");
				const formUuid = findContainingForm(
					draft as unknown as BlueprintDoc,
					mut.uuid,
				);
				if (formUuid) {
					for (const fUuid of walkFormFieldUuids(
						draft as unknown as BlueprintDoc,
						formUuid,
					)) {
						const target = draft.fields[fUuid];
						if (!target) continue;
						for (const f of XPATH_FIELDS) {
							const expr = (target as Record<string, unknown>)[f];
							if (typeof expr === "string" && expr.length > 0) {
								const { expr: rewritten, droppedHashtagRefs } =
									rewriteXPathOnMove(expr, oldSegments, newSegments);
								if (rewritten !== expr) {
									(target as Record<string, unknown>)[f] = rewritten;
									xpathFieldsRewritten++;
								}
								droppedCrossDepthRefs += droppedHashtagRefs;
							}
						}
						for (const f of DISPLAY_FIELDS) {
							const text = (target as Record<string, unknown>)[f];
							if (typeof text === "string" && text.length > 0) {
								// `transformBareHashtags` passes each embedded hashtag's
								// parsed expression through the callback. We accumulate
								// dropped-ref counts via closure since the transformer
								// expects a string return.
								let localDropped = 0;
								const rewritten = transformBareHashtags(text, (expr) => {
									const r = rewriteXPathOnMove(expr, oldSegments, newSegments);
									localDropped += r.droppedHashtagRefs;
									return r.expr;
								});
								if (rewritten !== text) {
									(target as Record<string, unknown>)[f] = rewritten;
									xpathFieldsRewritten++;
								}
								droppedCrossDepthRefs += localDropped;
							}
						}
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
			return { renamed, droppedCrossDepthRefs } satisfies MoveFieldResult;
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

			// The cascade target case type is the field's `case_property`
			// value — the case type this field WRITES TO, which may differ
			// from the containing module's `caseType` when the field creates
			// a child case. A non-empty value triggers the case-property
			// cascade: #case/<oldId> hashtags across every form bound to a
			// module with the matching caseType, column renames on those
			// modules, and peer-field renames of any other field that
			// declares the same (id, case_property) pair.
			const caseType = extractCaseProperty(field);
			const doc = draft as unknown as BlueprintDoc;

			// Track state across both passes:
			//   - `touchedFields` dedupes multi-pass rewrites on the same
			//     field (e.g. a field with both `/data/old` and `#case/old`
			//     refs is touched by both passes but counts once).
			//   - `affectedForms` records every form that had at least one
			//     field modified; used to compute `cascadedAcrossForms`
			//     without resorting to fragile subtraction arithmetic.
			const touchedFields = new Set<Uuid>();
			const affectedForms = new Set<Uuid>();
			// Capture the primary form BEFORE the rename mutates the id; used
			// to decide which forms count as "other" for the cross-form flag.
			const primaryFormUuid = findContainingForm(doc, mut.uuid);

			// (1) Rename the primary field and rewrite its containing form's
			//     path / hashtag references.
			renameSingleField(doc, mut.uuid, newId, touchedFields, affectedForms);

			// (2) Case-property cascade, when applicable. Safe to run even
			//     when no module has matching caseType — the walkers visit
			//     nothing and counts stay at zero.
			let peerFieldsRenamed = 0;
			let columnsRewritten = 0;
			let catalogEntryRenamed = false;
			if (caseType !== undefined) {
				const cascade = cascadeCasePropertyRename(
					doc,
					caseType,
					oldId,
					newId,
					mut.uuid,
					touchedFields,
					affectedForms,
				);
				peerFieldsRenamed = cascade.peerFieldsRenamed;
				columnsRewritten = cascade.columnsRewritten;
				catalogEntryRenamed = cascade.catalogEntryRenamed;
			}

			// A cascade is "across forms" iff it produced state changes the
			// primary form's refresh cannot cover: another form gained a
			// rewrite, a peer got renamed (peers live in other forms by the
			// uniqueness invariant, but we still count explicitly), a column
			// changed (module-level state), or the catalog entry moved
			// (app-level state, affects lint/autocomplete on every form).
			let touchedOtherForm = false;
			for (const f of affectedForms) {
				if (f !== primaryFormUuid) {
					touchedOtherForm = true;
					break;
				}
			}
			const cascadedAcrossForms =
				peerFieldsRenamed > 0 ||
				columnsRewritten > 0 ||
				catalogEntryRenamed ||
				touchedOtherForm;

			return {
				xpathFieldsRewritten: touchedFields.size,
				peerFieldsRenamed,
				columnsRewritten,
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
			const allowed = fieldRegistry[field.kind].convertTargets;
			if (!allowed.includes(mut.toKind)) {
				console.warn(
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
				console.warn(
					`convertField: cannot reconcile ${field.kind} → ${mut.toKind}`,
					{ uuid: mut.uuid, field },
				);
				return;
			}
			draft.fields[mut.uuid] = reconciled;
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
		catalogEntryRenamed: false,
		cascadedAcrossForms: false,
	};
}

/**
 * Read a field's `case_property` value in a kind-agnostic way.
 *
 * `case_property` lives on the `InputFieldBase` mixin (every input-like
 * kind: text, int, select, date, …) but not on structural kinds (group,
 * repeat). Walking the discriminated union at every call site would bloat
 * the reducer with type guards; a narrow helper isolates the cast. The
 * empty-string case clears the property — we treat it as "not set" so a
 * media-field `case_property: ""` clear doesn't accidentally cascade.
 */
function extractCaseProperty(field: { kind: string }): string | undefined {
	const value = (field as { case_property?: string }).case_property;
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value;
}

/**
 * Rename one field's `id` and rewrite XPath / hashtag references that live
 * inside the same form. This is the form-local half of the rename: it does
 * NOT walk modules or other forms. Used both for the primary rename and
 * for every peer rename discovered by the case-property cascade.
 *
 * Reference coverage:
 *   - `XPATH_FIELDS` (relevant / calculate / default_value / validate)
 *     run through `rewriteXPathRefs`, which surgically edits matching
 *     absolute paths (`/data/…/old_id` → `/data/…/new_id`) and `#form/old_id`
 *     hashtags (top-level questions only — hashtag syntax cannot encode
 *     nested paths).
 *   - `DISPLAY_FIELDS` (label / hint) run through `transformBareHashtags`
 *     so only embedded hashtag refs are rewritten while the surrounding
 *     prose is preserved verbatim.
 *
 * Tracking sets are passed in so multiple invocations (primary rename plus
 * each peer rename plus the cascade's `#case/` pass) share one view of
 * "what was touched": distinct-field accounting for `xpathFieldsRewritten`
 * and affected-form accounting for `cascadedAcrossForms` both need a view
 * that spans every pass.
 */
function renameSingleField(
	doc: BlueprintDoc,
	uuid: Uuid,
	newId: string,
	touchedFields: Set<Uuid>,
	affectedForms: Set<Uuid>,
): void {
	const field = doc.fields[uuid];
	if (!field) return;

	// Capture old path BEFORE mutating id so `computeFieldPath` produces
	// the pre-rename path segments that references will match against.
	const oldPath = computeFieldPath(doc, uuid);
	const formUuid = findContainingForm(doc, uuid);
	field.id = newId;

	// An unreachable field (not in any form) still has its id updated, but
	// there's no form to walk for reference rewrites.
	if (oldPath === undefined || formUuid === undefined) return;

	rewriteFormLocalRefs(
		doc,
		formUuid,
		oldPath,
		newId,
		touchedFields,
		affectedForms,
	);
}

/**
 * Walk every field under `formUuid` and rewrite path / hashtag references
 * to a field whose path ended in `oldPath` and whose leaf id is now
 * `newLeafId`. Scoped to a single form because XPath references don't
 * cross form boundaries — `/data/foo` means this form's `foo`, and
 * `#form/foo` is form-scoped by CommCare semantics.
 *
 * Records every modified field in `touchedFields` (so callers dedupe
 * multi-pass hits) and adds `formUuid` to `affectedForms` on any change.
 */
function rewriteFormLocalRefs(
	doc: BlueprintDoc,
	formUuid: Uuid,
	oldPath: string,
	newLeafId: string,
	touchedFields: Set<Uuid>,
	affectedForms: Set<Uuid>,
): void {
	const xpathRewriter = (expr: string) =>
		rewriteXPathRefs(expr, oldPath, newLeafId);
	for (const fUuid of walkFormFieldUuids(doc, formUuid)) {
		const target = doc.fields[fUuid];
		if (!target) continue;
		if (rewriteFieldExpressions(target, xpathRewriter)) {
			touchedFields.add(fUuid);
			affectedForms.add(formUuid);
		}
	}
}

/**
 * Apply a rewriter function to every XPath expression + display text on a
 * field. Returns `true` iff at least one value changed. Encapsulates the
 * XPATH_FIELDS / DISPLAY_FIELDS distinction so both `rewriteFormLocalRefs`
 * and the case-property cascade share one traversal shape.
 *
 * The rewriter takes a raw XPath expression (or bare hashtag) and returns
 * the rewritten string. For display fields we route the rewriter through
 * `transformBareHashtags` so only the hashtag substrings are parsed, not
 * the surrounding markdown-style prose.
 */
function rewriteFieldExpressions(
	field: { kind: string },
	rewriter: (expr: string) => string,
): boolean {
	let changed = false;
	const anyField = field as Record<string, unknown>;
	for (const key of XPATH_FIELDS) {
		const expr = anyField[key];
		if (typeof expr !== "string" || expr.length === 0) continue;
		const next = rewriter(expr);
		if (next !== expr) {
			anyField[key] = next;
			changed = true;
		}
	}
	for (const key of DISPLAY_FIELDS) {
		const text = anyField[key];
		if (typeof text !== "string" || text.length === 0) continue;
		const next = transformBareHashtags(text, rewriter);
		if (next !== text) {
			anyField[key] = next;
			changed = true;
		}
	}
	return changed;
}

/**
 * Cross-form cascade triggered when a field with `case_property` is
 * renamed. Because `field.id` IS the case property name for fields that
 * save to a case, a rename is semantically a rename of the case property.
 * That property is referenced from three places outside the containing
 * form:
 *
 *   1. **Peer fields** — other input fields whose `id === oldId` AND
 *      `case_property === caseType`. Those are not references; they're
 *      authoritative declarations of the same property in a different
 *      form (common when multiple forms read/write the same case
 *      property). Each peer is renamed + has its own form's local refs
 *      rewritten via `renameSingleField`.
 *
 *   2. **Hashtag references** — `#case/<oldId>` inside XPath expressions
 *      or prose labels on ANY field that lives in a form bound to a
 *      module whose `caseType === caseType`. `#case/` resolves to the
 *      containing module's case type, so refs in modules with a different
 *      caseType point at a different property and must NOT be rewritten.
 *
 *   3. **Case list / case detail columns** — module-level string arrays
 *      where `col.field` holds a case property name. Same caseType scope
 *      as (2).
 *
 *   4. **Case-type catalog** — `doc.caseTypes[<caseType>].properties[]` is
 *      the authoritative list of known case properties for a case type.
 *      Every builder-time consumer (XPath linter, `#case/` chip hydrator,
 *      validator, autocompleter) reads it via `buildLintContext`. If the
 *      catalog still advertises `age` after we've renamed to `age_1`, the
 *      linter rejects `#case/age_1` as an unknown property and the chip
 *      decorator refuses to render a chip (hashtag name not recognized).
 *
 * The cascade runs entirely on the Immer draft. `excludeUuid` is the
 * primary field's uuid — excluded from the peer-field rename walk so it
 * doesn't get renamed twice. The primary field IS included in the #case/
 * rewrite walk because it may reference its own old property name in a
 * label or calculate (unusual but legal).
 *
 * Returns counts for metadata surfacing; callers add them to any
 * form-local counts produced by the primary rename.
 */
interface CaseCascadeResult {
	peerFieldsRenamed: number;
	columnsRewritten: number;
	/** True iff a `caseTypes[caseType].properties[]` entry named `oldId`
	 *  was found and renamed. Reported on `FieldRenameMeta` so consumers
	 *  know the catalog changed (e.g. to refresh autocomplete caches). */
	catalogEntryRenamed: boolean;
}
function cascadeCasePropertyRename(
	doc: BlueprintDoc,
	caseType: string,
	oldId: string,
	newId: string,
	excludeUuid: Uuid,
	touchedFields: Set<Uuid>,
	affectedForms: Set<Uuid>,
): CaseCascadeResult {
	let peerFieldsRenamed = 0;
	let columnsRewritten = 0;
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
		renameSingleField(doc, peerUuid, newId, touchedFields, affectedForms);
		peerFieldsRenamed++;
	}

	// ── (4) Case-type catalog rename ────────────────────────────────────
	// The catalog is the single source of truth for which property names
	// the XPath linter + chip hydrator recognize. Rename BEFORE the column
	// / hashtag passes so any code reading the draft mid-traversal sees
	// the updated catalog — matches the ordering invariant that a given
	// name is either `oldId` or `newId` but never both.
	if (doc.caseTypes) {
		for (const ct of doc.caseTypes) {
			if (ct.name !== caseType) continue;
			for (const prop of ct.properties) {
				if (prop.name === oldId) {
					prop.name = newId;
					catalogEntryRenamed = true;
				}
			}
		}
	}

	// ── (2) + (3) #case/ hashtag rewrites + column rewrites, scoped to
	// modules whose `caseType` matches. A module whose caseType is
	// different references a different case entity from `#case/`, so we
	// must not touch it. ─────────────────────────────────────────────────
	const hashtagRewriter = (expr: string) =>
		rewriteHashtagRefs(expr, "#case/", oldId, newId);
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod || mod.caseType !== caseType) continue;

		// Columns: both lists are optional + nullable; touch each entry in
		// place on the draft. The count reflects column cells, not modules,
		// so a module with two stale column refs contributes two.
		if (Array.isArray(mod.caseListColumns)) {
			for (const col of mod.caseListColumns) {
				if (col.field === oldId) {
					col.field = newId;
					columnsRewritten++;
				}
			}
		}
		if (Array.isArray(mod.caseDetailColumns)) {
			for (const col of mod.caseDetailColumns) {
				if (col.field === oldId) {
					col.field = newId;
					columnsRewritten++;
				}
			}
		}

		// Forms in this module: every field's expressions + display text.
		// A field touched here may also have been touched by a form-local
		// pass earlier (peer renames walk their own forms). Adding to
		// `touchedFields` dedupes — `xpathFieldsRewritten` counts each
		// field once, not once per pass.
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			for (const fUuid of walkFormFieldUuids(doc, formUuid)) {
				const field = doc.fields[fUuid];
				if (!field) continue;
				if (rewriteFieldExpressions(field, hashtagRewriter)) {
					touchedFields.add(fUuid);
					affectedForms.add(formUuid);
				}
			}
		}
	}

	return { peerFieldsRenamed, columnsRewritten, catalogEntryRenamed };
}
