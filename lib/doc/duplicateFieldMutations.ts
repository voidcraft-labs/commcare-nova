import { v4 as uuidv4 } from "uuid";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
/**
 * Duplicating a field, planned as ordinary adds.
 *
 * A duplicate is a clone of a subtree, and every clone needs a fresh identity.
 * Minting those identities HERE, at the gesture, is what keeps the reducers
 * deterministic: a mutation that minted identity on the way past would produce
 * a different document on every apply, so it could never be persisted, replayed,
 * or folded onto a peer's state, and every boundary handling a batch would need
 * a special case saying so.
 *
 * The reducer gets the same `addField` mutations any other creation uses, so
 * the batch is an ordinary batch: it replays to the same document, it persists,
 * it undoes by removing what it added, and no boundary needs to know it was a
 * duplicate.
 */

import {
	dedupeSiblingId,
	findContainingForm,
	findFieldParent,
} from "@/lib/doc/mutations/helpers";
import { HELD_FIELD_KEYS, type HeldFieldKey } from "@/lib/domain/fields";
import { submissionLayout } from "@/lib/domain/submissionLayout";
import { asUuid, type BlueprintDoc, type Mutation, type Uuid } from "./types";

/** One field's clone, in the order the adds must land. */
interface ClonedField {
	readonly parentUuid: Uuid;
	readonly field: BlueprintDoc["fields"][Uuid];
}

/**
 * The batch that duplicates `uuid` — one `addField` per cloned field, parents
 * before children, the root clone landing directly after its source.
 *
 * Returns the batch together with the root clone's minted uuid, which is what
 * the caller needs to select the new field. Empty when the field or its parent
 * is missing: the gesture addressed something that is no longer there.
 */
export function duplicateFieldMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
): { readonly mutations: Mutation[]; readonly cloneUuid: Uuid } | undefined {
	const source = doc.fields[uuid];
	if (source === undefined) return undefined;
	// Resolved from `fieldOrder` rather than the derived `fieldParent` index:
	// a planner may be handed a doc from any source, and the membership arrays
	// are the thing that is always present.
	const parentUuid = findFieldParent(doc, uuid)?.parentUuid;
	if (parentUuid === undefined) return undefined;

	const cloned: ClonedField[] = [];
	const clonedIds = new Map<Uuid, Uuid>();
	const cloneInto = (sourceUuid: Uuid, intoParent: Uuid): Uuid | undefined => {
		const field = doc.fields[sourceUuid];
		if (field === undefined) return undefined;
		const cloneUuid = asUuid(uuidv4());
		const copy = structuredClone(field);
		copy.uuid = cloneUuid;
		// A held identity belongs to the source the publish carried; the
		// clone is new and starts unheld (`HELD_FIELD_KEYS`).
		for (const key of HELD_FIELD_KEYS)
			delete (copy as Partial<Record<HeldFieldKey, unknown>>)[key];
		clonedIds.set(sourceUuid, cloneUuid);
		cloned.push({ parentUuid: intoParent, field: copy });
		for (const childUuid of doc.fieldOrder[sourceUuid] ?? []) {
			cloneInto(childUuid, cloneUuid);
		}
		return cloneUuid;
	};

	const cloneUuid = cloneInto(uuid, parentUuid);
	if (cloneUuid === undefined) return undefined;

	for (const { field } of cloned) {
		if (
			(field.kind === "single_select" || field.kind === "multi_select") &&
			field.optionsSource.kind !== "inline" &&
			field.optionsSource.filter
		) {
			walkExpressionTerms(field.optionsSource.filter, (term) => {
				if (term.kind === "field")
					term.uuid = clonedIds.get(term.uuid) ?? term.uuid;
			});
		}
	}

	// An ordinary duplicate stays beside the source. When the screen and
	// submission differ, clone each tree independently. Submitted siblings
	// outside the duplicate receive a new answer next to the original. A
	// submitted parent inside it is rebased to its own new UUID.
	const form = findContainingForm(doc, uuid);
	if (form === undefined) return undefined;
	const layout = submissionLayout(form, doc.fields, doc.fieldOrder);
	const moves: Mutation[] = [];
	if (layout.independent) {
		const copies = new Map(cloned.map(({ field }) => [field.uuid, field]));
		for (const { field } of cloned) delete field.submissionPlacement;
		for (const [parent, siblings] of layout.children) {
			const clonedParent = clonedIds.get(parent);
			let previous: Uuid | null = null;
			const taken = new Set(siblings.map((id) => doc.fields[id].id));
			for (const sourceId of siblings) {
				const copyId = clonedIds.get(sourceId);
				if (copyId === undefined) continue;
				const copy = copies.get(copyId);
				if (copy === undefined) continue;
				if (clonedParent === undefined) {
					const desired = copy.id;
					for (let suffix = 2; taken.has(copy.id); suffix++)
						copy.id = `${desired}_${suffix}`;
					taken.add(copy.id);
				}
				moves.push({
					kind: "moveField",
					where: "submission",
					uuid: copyId,
					toParentUuid: clonedParent ?? parent,
					after: clonedParent === undefined ? sourceId : previous,
				});
				previous = copyId;
			}
		}
	} else {
		const root = cloned[0];
		root.field.id = dedupeSiblingId(doc, parentUuid, root.field.id, cloneUuid);
	}

	const adds: Mutation[] = cloned.map((entry, index) => ({
		kind: "addField",
		parentUuid: entry.parentUuid,
		field: entry.field,
		...(index === 0 && { after: uuid }),
	}));
	return { cloneUuid, mutations: [...adds, ...moves] };
}
