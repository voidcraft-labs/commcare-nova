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

import { dedupeSiblingId, findFieldParent } from "@/lib/doc/mutations/helpers";
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
	const cloneInto = (sourceUuid: Uuid, intoParent: Uuid): Uuid | undefined => {
		const field = doc.fields[sourceUuid];
		if (field === undefined) return undefined;
		const cloneUuid = asUuid(crypto.randomUUID());
		const copy = structuredClone(field);
		copy.uuid = cloneUuid;
		if (
			(copy.kind === "single_select" || copy.kind === "multi_select") &&
			copy.optionsSource.kind === "inline"
		) {
			copy.optionsSource.options = copy.optionsSource.options.map((option) => ({
				...option,
				uuid: asUuid(crypto.randomUUID()),
			}));
		}
		cloned.push({ parentUuid: intoParent, field: copy });
		for (const childUuid of doc.fieldOrder[sourceUuid] ?? []) {
			cloneInto(childUuid, cloneUuid);
		}
		return cloneUuid;
	};

	const cloneUuid = cloneInto(uuid, parentUuid);
	if (cloneUuid === undefined) return undefined;

	// Only the ROOT clone can collide: every descendant lands under a cloned
	// parent, where the source's own children are the only other members and
	// they are not there.
	const root = cloned[0];
	if (root !== undefined) {
		root.field.id = dedupeSiblingId(doc, parentUuid, root.field.id, cloneUuid);
	}

	// The root lands directly after its source; each descendant appends to its
	// (already-added) cloned parent, which is empty until its siblings arrive,
	// so writing them in order is the whole placement.
	return {
		cloneUuid,
		mutations: cloned.map((entry, index) => ({
			kind: "addField",
			parentUuid: entry.parentUuid,
			field: entry.field,
			...(index === 0 && { after: uuid }),
		})),
	};
}
