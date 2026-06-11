/**
 * Shared field-batch assembly — the one pipeline that turns the SA's flat
 * per-kind field items into `addField` mutations, used by every tool that
 * lands fields (`addFields` on an existing form; `createForm` /
 * `createModule` on a form minted in the same batch).
 *
 * Per item: sentinel strip (`stripEmpty`) → case-type default merge
 * (`applyDefaults`) → uuid mint → domain `Field` assembly
 * (`flatFieldToField`) → the shared identifier verdict
 * (`lib/doc/identifierVerdicts.ts` — XML-name legality, the reserved
 * `__nova_` prefix, the case-property length cap, sibling uniqueness
 * against the doc AND this batch's earlier items). Parent resolution
 * covers containers minted earlier in the same batch (`mintedByBareId`)
 * before falling back to the doc-wide lookup, so a group + its children
 * compose in one call.
 *
 * The insertion root (`formUuid`) does not have to exist on `doc` yet —
 * a form minted by an `addForm` mutation earlier in the same batch has no
 * `fieldOrder` entry, which reads as "no existing siblings", exactly
 * right for a brand-new form.
 *
 * One identifier rejection fails the WHOLE assembly (`ok: false`) with
 * every failing item named, so the agent fixes them in one re-issue —
 * a partial batch would leave it guessing which fields landed.
 */

import { fieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid, isContainer } from "@/lib/domain";
import { findFieldByBareId } from "../../blueprintHelpers";
import {
	applyDefaults,
	type FlatField,
	flatFieldToField,
	stripEmpty,
} from "../../contentProcessing";

export interface FieldAssemblyArgs {
	/** The doc the batch will apply to — parent lookups + sibling scans. */
	doc: BlueprintDoc;
	/** Insertion root: an existing form's uuid, or the uuid of a form an
	 *  earlier mutation in the same batch creates. */
	formUuid: Uuid;
	/** The SA's flat field items, in order. */
	items: readonly FlatField[];
	/** Default parent for the batch (a group/repeat's bare id). A field's
	 *  own `parentId` overrides it. */
	batchParentId?: string;
	/** Insertion anchor for the batch's top-level block — only meaningful
	 *  against an EXISTING form (a new form has nothing to anchor to). */
	anchor?: { beforeFieldId?: string; afterFieldId?: string };
}

export type FieldAssemblyResult =
	| {
			ok: true;
			mutations: Mutation[];
			/** Items that didn't assemble into a valid Field for their kind —
			 *  reported, never silently dropped. */
			skipped: Array<{ id: string; reason: string }>;
	  }
	| {
			ok: false;
			/** Every item the identifier verdict refused, with its reason. */
			rejected: Array<{ id: string; reason: string }>;
	  };

export function assembleFieldMutations(
	args: FieldAssemblyArgs,
): FieldAssemblyResult {
	const { doc, formUuid, items, batchParentId, anchor } = args;

	// Resolve the batch's insertion parent — the form root, or the
	// batch-level `parentId` when it names an existing container (mirrors
	// the per-field fallback in the loop). When an anchor is given, find
	// the index in that parent's CURRENT order where the batch's top-level
	// block should start; `topLevelNextIndex` then walks forward as each
	// top-level field is placed, so the inserted fields land contiguously
	// in batch order. A field carrying its OWN parentId nests under that
	// parent and never consumes an anchor slot.
	let batchInsertParent: Uuid = formUuid;
	if (batchParentId) {
		const existing = findFieldByBareId(doc, formUuid, batchParentId);
		// Only a container can be a parent — a `parentId` naming a leaf
		// field falls through to form-level (matching the per-field path
		// below). Nesting under a leaf would make every batch field
		// invisible to the emitter.
		if (existing && isContainer(existing.field)) {
			batchInsertParent = existing.field.uuid;
		}
	}
	let topLevelNextIndex: number | undefined;
	if (anchor?.beforeFieldId || anchor?.afterFieldId) {
		const order = doc.fieldOrder[batchInsertParent] ?? [];
		if (anchor.beforeFieldId) {
			const i = order.findIndex(
				(u) => doc.fields[u]?.id === anchor.beforeFieldId,
			);
			if (i !== -1) topLevelNextIndex = i;
		} else if (anchor.afterFieldId) {
			const i = order.findIndex(
				(u) => doc.fields[u]?.id === anchor.afterFieldId,
			);
			if (i !== -1) topLevelNextIndex = i + 1;
		}
	}

	// `mintedByBareId` records only containers added earlier in this batch
	// so a later item's `parentId` can resolve to them; `pendingByParent`
	// carries the ids earlier items claimed per parent (they aren't in
	// `doc` yet), so two new siblings can't land with the same id.
	const mintedByBareId = new Map<string, Uuid>();
	const mutations: Mutation[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	const rejected: Array<{ id: string; reason: string }> = [];
	const pendingByParent = new Map<Uuid, Set<string>>();

	for (const raw of items) {
		// `stripEmpty` narrows `parentId?: string | null` (sentinel empty
		// string → null) and `applyDefaults` preserves that narrowing while
		// merging case-type metadata onto the field.
		const processed = applyDefaults(stripEmpty(raw), doc.caseTypes);

		// Resolve parentUuid: the field's OWN `parentId` wins; if it didn't
		// set one, fall back to the batch-level `parentId`; if neither is
		// set, the field lands at the form's top level.
		let parentUuid: Uuid = formUuid;
		const parentId = processed.parentId ?? batchParentId;
		if (parentId && typeof parentId === "string") {
			const minted = mintedByBareId.get(parentId);
			if (minted) {
				parentUuid = minted;
			} else {
				const existing = findFieldByBareId(doc, formUuid, parentId);
				if (existing && isContainer(existing.field)) {
					parentUuid = existing.field.uuid;
				}
				// A non-existent parentId, or one naming a non-container
				// (a leaf field), falls through to form-level insert.
				// Never nest under a leaf: the reducer would create a
				// child order under it and the emitter — which only
				// recurses into containers — would silently drop the
				// field.
			}
		}

		const fieldUuid = asUuid(crypto.randomUUID());
		const assembled = flatFieldToField(processed, fieldUuid);
		if (!assembled.ok) {
			// The payload didn't assemble into a valid Field for its kind.
			// Carry the specific reason so the caller reports WHY each field
			// was skipped, not just that it was.
			skipped.push({ id: raw.id, reason: assembled.reason });
			continue;
		}
		const field = assembled.field;

		// Pre-dispatch identifier guard. A rejected field claims nothing —
		// it never joins the pending scope or the minted-parent lookup.
		const pending = pendingByParent.get(parentUuid);
		const verdict = fieldIdVerdict({
			doc,
			parentUuid,
			proposedId: field.id,
			pendingSiblingIds: pending,
		});
		if (!verdict.ok) {
			rejected.push({ id: field.id, reason: verdict.message });
			continue;
		}
		if (pending) pending.add(field.id);
		else pendingByParent.set(parentUuid, new Set([field.id]));

		if (isContainer(field)) mintedByBareId.set(field.id, fieldUuid);
		// Top-level batch fields honor the anchor (a contiguous block at
		// the resolved index, walking forward per field); everything else
		// — fields nested under their own parentId, or any field when no
		// anchor was given — appends.
		if (topLevelNextIndex !== undefined && parentUuid === batchInsertParent) {
			mutations.push({
				kind: "addField",
				parentUuid,
				field,
				index: topLevelNextIndex,
			});
			topLevelNextIndex += 1;
		} else {
			mutations.push({ kind: "addField", parentUuid, field });
		}
	}

	if (rejected.length > 0) return { ok: false, rejected };
	return { ok: true, mutations, skipped };
}

/**
 * Compose the person-to-person error for an `ok: false` assembly: every
 * failing id with its reason, plus the frame (nothing was added, fix and
 * re-issue). Shared by the field-landing tools so the agent reads one
 * message shape wherever ids bounce.
 */
export function describeRejectedFieldIds(
	formName: string,
	totalCount: number,
	rejected: ReadonlyArray<{ id: string; reason: string }>,
): string {
	const lines = rejected.map((r) => `- "${r.id}": ${r.reason}`).join("\n");
	return `No fields were added to "${formName}" — ${rejected.length} of ${totalCount} field id(s) can't be used:\n${lines}\nFix the listed id(s) and re-issue the call.`;
}
