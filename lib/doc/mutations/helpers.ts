/**
 * Shared helpers for builder-doc mutations.
 *
 * These helpers encapsulate the recurring patterns — cascade deletion,
 * sibling id deduplication, field path computation — that multiple
 * mutation kinds need. Keeping them in one place prevents subtle drift
 * (e.g. renameField and moveField both need consistent path logic).
 */

import type { Draft } from "immer";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { Field } from "@/lib/domain";

/**
 * Remove a field and all of its descendants from the doc. Called by
 * `removeField` and by `removeForm`/`removeModule` when they cascade.
 * Also strips the field from any ordering array; callers that delete
 * a field from a specific parent's order should do that themselves.
 */
export function cascadeDeleteField(
	draft: Draft<BlueprintDoc>,
	uuid: Uuid,
): void {
	const children = draft.fieldOrder[uuid];
	if (children) {
		// Snapshot the children list; recursive deletes mutate fieldOrder.
		for (const childUuid of [...children]) {
			cascadeDeleteField(draft, childUuid);
		}
		delete draft.fieldOrder[uuid];
	}
	delete draft.fields[uuid];
}

/**
 * Remove a form from the doc, cascading to its field subtree. Does NOT
 * remove the form from its module's `formOrder[]` — that's the caller's
 * job, since `removeForm` knows the module uuid but a cascading
 * `removeModule` does not (the form order maps to the module directly).
 */
export function cascadeDeleteForm(
	draft: Draft<BlueprintDoc>,
	uuid: Uuid,
): void {
	const topLevelFields = draft.fieldOrder[uuid] ?? [];
	for (const fUuid of [...topLevelFields]) {
		cascadeDeleteField(draft, fUuid);
	}
	delete draft.fieldOrder[uuid];
	delete draft.forms[uuid];
}

/**
 * Locate a field's parent (either a form or a group/repeat).
 * Returns the parent uuid and the field's current index within
 * that parent, or `undefined` if the field isn't in any order map.
 *
 * O(parents × siblings). Mutation code paths typically call this once
 * per mutation, so the cost is acceptable; if this ever shows up in
 * profiles we can maintain a reverse index on the doc.
 */
export function findFieldParent(
	doc: BlueprintDoc,
	uuid: Uuid,
): { parentUuid: Uuid; index: number } | undefined {
	for (const [parentUuid, order] of Object.entries(doc.fieldOrder)) {
		const index = order.indexOf(uuid);
		if (index !== -1) {
			return { parentUuid: parentUuid as Uuid, index };
		}
	}
	return undefined;
}

/**
 * Find the form uuid that contains a given field (direct child or any
 * nested descendant). Returns `undefined` if the field isn't reachable
 * from any form.
 *
 * Traverses up from the field through its parents until a form uuid is
 * found (form uuids appear as keys in both `formOrder[]` values and
 * `fieldOrder` — but `draft.forms[uuid]` is the definitive check).
 */
export function findContainingForm(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): Uuid | undefined {
	let cursor: Uuid | undefined = fieldUuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined; // Defensive: cycle detection.
		visited.add(cursor);
		const parent = findFieldParent(doc, cursor);
		if (!parent) return undefined;
		if (doc.forms[parent.parentUuid] !== undefined) {
			return parent.parentUuid;
		}
		cursor = parent.parentUuid;
	}
	return undefined;
}

/**
 * Collect all field uuids under a form (BFS across groups and repeats).
 * Returns a flat array — no depth info. Used when the caller needs to
 * iterate every field in a form to rewrite references, etc.
 */
export function walkFormFieldUuids(doc: BlueprintDoc, formUuid: Uuid): Uuid[] {
	const result: Uuid[] = [];
	const stack: Uuid[] = [formUuid];
	while (stack.length > 0) {
		const parent = stack.pop() as Uuid;
		const order = doc.fieldOrder[parent] ?? [];
		for (const childUuid of order) {
			result.push(childUuid);
			// Push onto the stack so children of groups/repeats are visited too.
			stack.push(childUuid);
		}
	}
	return result;
}

/**
 * Deduplicate a field id against its siblings. If `desired` conflicts
 * with any existing sibling id, append `_2`, `_3`, ... until unique.
 *
 * CommCare requires unique field ids within each parent level — see
 * the "Sibling IDs must be unique" note in the root CLAUDE.md.
 */
export function dedupeSiblingId(
	draft: Draft<BlueprintDoc>,
	parentUuid: Uuid,
	desired: string,
	excludeUuid: Uuid | undefined,
): string {
	const siblings = draft.fieldOrder[parentUuid] ?? [];
	const takenIds = new Set<string>();
	for (const sibUuid of siblings) {
		if (sibUuid === excludeUuid) continue;
		const sibId = draft.fields[sibUuid]?.id;
		if (sibId) takenIds.add(sibId);
	}
	if (!takenIds.has(desired)) return desired;
	for (let n = 2; n < 10_000; n++) {
		const candidate = `${desired}_${n}`;
		if (!takenIds.has(candidate)) return candidate;
	}
	// Exhausted 9999 suffixes — extraordinarily unlikely in practice, but if
	// it ever happens we prefer to return the original id (accepting a
	// duplicate) over throwing from inside an Immer reducer. A throw here
	// would propagate up through `store.applyMany()` and crash the caller's
	// render or route handler; a silent duplicate is detectable downstream
	// and recoverable by the user. A warning makes the anomaly visible in
	// dev tools without taking the process down.
	console.warn(
		`dedupeSiblingId: exhausted 9999 suffixes trying to dedupe "${desired}"; returning original id (may conflict)`,
	);
	return desired;
}

/**
 * Compute the slash-delimited path from a form to a field, using its
 * CommCare ids (NOT UUIDs). Used by `rewriteXPathRefs` — XPath references
 * in the blueprint are path-based (`group_id/child_q`), not UUID-based.
 *
 * Returns `undefined` if the field isn't reachable from a form.
 */
export function computeFieldPath(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): string | undefined {
	const segments: string[] = [];
	let cursor: Uuid | undefined = fieldUuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined;
		visited.add(cursor);
		if (doc.forms[cursor] !== undefined) {
			// Reached the form — path is complete.
			return segments.reverse().join("/");
		}
		const field = doc.fields[cursor];
		if (!field) return undefined;
		segments.push(field.id);
		const parent = findFieldParent(doc, cursor);
		if (!parent) return undefined;
		cursor = parent.parentUuid;
	}
	return undefined;
}

/**
 * `never` assertion for exhaustive switch defaults. TypeScript flags
 * any missing mutation kinds as unassignable to `never` at compile time.
 */
export function assertNever(x: never): never {
	throw new Error(
		`unreachable: unexpected mutation kind: ${JSON.stringify(x)}`,
	);
}

/**
 * Deep-clone a field subtree with fresh UUIDs for every entity. The
 * returned object contains the new entities to insert into `fields`
 * and the `fieldOrder` entries for the cloned subtree (keyed by the
 * new UUIDs).
 *
 * Field values (`id`, `label`, `calculate`, …) are preserved verbatim —
 * duplicated fields are intentionally identical to their source except
 * for identity. Sibling id deduplication is the caller's responsibility;
 * only the top-level duplicate typically needs deduping since nested
 * clones don't collide with sibling ids (they live under the newly-cloned
 * parent, which is a different context from the originals).
 *
 * Reads from `doc` (a plain BlueprintDoc or an Immer draft cast back to
 * read-only). Immer drafts read through the original, so this traversal
 * is safe even when called inside a `produce` callback.
 */
export function cloneFieldSubtree(
	doc: BlueprintDoc,
	srcUuid: Uuid,
):
	| {
			fields: Record<Uuid, Field>;
			fieldOrder: Record<Uuid, Uuid[]>;
			rootUuid: Uuid;
	  }
	| undefined {
	// If the requested root doesn't exist, the caller can't do anything
	// useful with a clone — return undefined instead of throwing from inside
	// an Immer reducer. Callers (`duplicateField`) already guard on the
	// source field existing before calling, so hitting this path means
	// the doc is already in an inconsistent state.
	if (doc.fields[srcUuid] === undefined) return undefined;

	const clonedFields: Record<Uuid, Field> = {};
	const clonedOrder: Record<Uuid, Uuid[]> = {};

	function cloneOne(uuid: Uuid): Uuid | undefined {
		const src = doc.fields[uuid];
		if (!src) {
			// A missing descendant means `fieldOrder` references a uuid that
			// isn't in `fields` — corrupt state we shouldn't crash over.
			// Log, skip this child, and let the clone proceed with one fewer
			// entry in the parent's order.
			console.warn(
				`cloneFieldSubtree: fieldOrder references missing field ${uuid}; skipping`,
			);
			return undefined;
		}
		const newUuid = asUuid(crypto.randomUUID());
		clonedFields[newUuid] = { ...src, uuid: newUuid };
		const childOrder = doc.fieldOrder[uuid];
		if (childOrder !== undefined) {
			// Recursively clone each child and record the new child order under
			// the new parent UUID. `filter` drops any children that hit the
			// missing-entity branch above so the new order only references
			// uuids we actually cloned.
			clonedOrder[newUuid] = childOrder
				.map((childUuid) => cloneOne(childUuid))
				.filter((uuid): uuid is Uuid => uuid !== undefined);
		}
		return newUuid;
	}

	const rootUuid = cloneOne(srcUuid);
	if (rootUuid === undefined) return undefined;
	return { fields: clonedFields, fieldOrder: clonedOrder, rootUuid };
}
