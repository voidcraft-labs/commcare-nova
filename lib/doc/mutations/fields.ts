import type { Draft } from "immer";
import type {
	BlueprintDoc,
	QuestionEntity as Field,
	Mutation,
	Uuid,
} from "@/lib/doc/types";
import { transformBareHashtags } from "@/lib/preview/engine/labelRefs";
import { rewriteXPathRefs } from "@/lib/preview/xpath/rewrite";
import type { QuestionPath } from "@/lib/services/questionPath";
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
 * Metadata returned by `moveField` when a cross-level move triggers
 * sibling-id deduplication (CommCare requires unique IDs per parent level).
 * When no dedup is needed, `renamed` is `undefined`.
 */
export interface MoveFieldResult {
	renamed?: {
		oldId: string;
		newId: string;
		newPath: QuestionPath;
		xpathFieldsRewritten: number;
	};
}

/**
 * Metadata returned by `renameField` with the count of XPath expression
 * fields that were rewritten to reflect the new field ID.
 */
export interface FieldRenameMeta {
	xpathFieldsRewritten: number;
}

// ── Legacy aliases for callers that have not yet migrated ─────────────────
// Phase 21 removes these once all consumers use Field-named types directly.
/** @deprecated Use MoveFieldResult */
export type MoveQuestionResult = MoveFieldResult;
/** @deprecated Use FieldRenameMeta */
export type QuestionRenameMeta = FieldRenameMeta;

/**
 * Fields on a `Field` entity that carry XPath expressions directly —
 * these get rewritten via the Lezer-based `rewriteXPathRefs` parser when
 * a referenced field is renamed.
 *
 * Notably excluded:
 *   - `validation_msg`: user-facing error text, not an XPath expression.
 *   - `label`, `hint`: prose fields that may embed bare hashtag refs
 *     (`#form/foo`), handled separately via DISPLAY_FIELDS below.
 *   - `required`: not an XPath field in the current schema.
 */
// biome-ignore lint/suspicious/noExplicitAny: XPATH_FIELDS keys only apply to
// some members of the Field union (text, int, etc.). The runtime code checks
// for presence via `in` / `typeof === "string"` before reading, so narrowing
// to a single member's keys would be overly strict.
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
 */
// Same caveat as XPATH_FIELDS above — `hint` and `label` don't exist on every
// Field variant (e.g. hidden has no label; secret has no hint), so we avoid
// pinning this to a single member's keyof.
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
				| "updateField";
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
			Object.assign(field, mut.patch);
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
								const rewritten = rewriteXPathOnMove(
									expr,
									oldSegments,
									newSegments,
								);
								if (rewritten !== expr) {
									(target as Record<string, unknown>)[f] = rewritten;
									xpathFieldsRewritten++;
								}
							}
						}
						for (const f of DISPLAY_FIELDS) {
							const text = (target as Record<string, unknown>)[f];
							if (typeof text === "string" && text.length > 0) {
								const rewritten = transformBareHashtags(text, (expr) =>
									rewriteXPathOnMove(expr, oldSegments, newSegments),
								);
								if (rewritten !== text) {
									(target as Record<string, unknown>)[f] = rewritten;
									xpathFieldsRewritten++;
								}
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
							newPath: (newPathStr || "") as QuestionPath,
							xpathFieldsRewritten,
						}
					: undefined;
			return { renamed } satisfies MoveFieldResult;
		}
		case "renameField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			const oldPath = computeFieldPath(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			field.id = mut.newId;
			let xpathFieldsRewritten = 0;
			if (oldPath !== undefined) {
				xpathFieldsRewritten = rewriteRefsAllFields(
					draft as unknown as BlueprintDoc,
					oldPath,
					mut.newId,
				);
			}
			return { xpathFieldsRewritten } satisfies FieldRenameMeta;
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
	}
}

/**
 * Walk every field in the doc and rewrite references to a field
 * whose path ended in `oldLeafId` and now ends in `newLeafId`. This is a
 * leaf-rename operation: the field stays at the same tree position,
 * only its final `id` segment changes.
 *
 * Two passes:
 *   1. `XPATH_FIELDS` (calculate/relevant/validation/default_value) run
 *      through the Lezer-based `rewriteXPathRefs`, which surgically edits
 *      matching absolute paths (`/data/.../old_id` → `/data/.../new_id`).
 *   2. `DISPLAY_FIELDS` (label/hint) run through `transformBareHashtags`
 *      so only the embedded `#form/...` references are rewritten, not the
 *      surrounding prose.
 *
 * Called by `renameField` only — `moveField` cannot use this path
 * because it has to rewrite path PREFIXES, not leaf segments.
 */
function rewriteRefsAllFields(
	doc: BlueprintDoc,
	oldPath: string,
	newLeafId: string,
): number {
	let count = 0;
	const xpathRewriter = (expr: string) =>
		rewriteXPathRefs(expr, oldPath, newLeafId);
	for (const field of Object.values(doc.fields)) {
		for (const f of XPATH_FIELDS) {
			const expr = (field as Record<string, unknown>)[f];
			if (typeof expr === "string" && expr.length > 0) {
				const rewritten = xpathRewriter(expr);
				if (rewritten !== expr) {
					(field as Record<string, unknown>)[f] = rewritten;
					count++;
				}
			}
		}
		for (const f of DISPLAY_FIELDS) {
			const text = (field as Record<string, unknown>)[f];
			if (typeof text === "string" && text.length > 0) {
				const rewritten = transformBareHashtags(text, xpathRewriter);
				if (rewritten !== text) {
					(field as Record<string, unknown>)[f] = rewritten;
					count++;
				}
			}
		}
	}
	return count;
}
