// lib/doc/order/searchInput.ts
//
// Fractional-order planning for one search-field move. A direct gesture writes
// only the moved input's key; sibling keys stay untouched so two collaborators
// moving different fields do not overwrite one another during guarded replay.

import type { Mutation, Uuid } from "@/lib/doc/types";
import type { SearchInputDef } from "@/lib/domain";
import { bySortKey } from "./compare";
import { plannedMoveSlotKey } from "./keys";

/** Search inputs in the exact order the authoring and running screens use. */
export function orderedSearchInputs(
	inputs: readonly SearchInputDef[],
): SearchInputDef[] {
	return [...inputs].sort(bySortKey);
}

/**
 * Plan one search-field move as one granular `moveSearchInput` mutation.
 *
 * `toIndex` is the desired FINAL index after removing the moved input. The
 * planner reads neighbor bounds from the supplied current snapshot and returns
 * `undefined` for an unknown or already-placed input.
 */
export function searchInputMoveMutation(args: {
	readonly moduleUuid: Uuid;
	readonly inputs: readonly SearchInputDef[];
	readonly uuid: Uuid;
	readonly toIndex: number;
}): Mutation | undefined {
	const { moduleUuid, inputs, uuid } = args;
	const ordered = orderedSearchInputs(inputs);
	const fromIndex = ordered.findIndex((input) => input.uuid === uuid);
	if (fromIndex < 0) return undefined;

	const siblings = ordered.filter((input) => input.uuid !== uuid);
	const toIndex = Math.max(0, Math.min(args.toIndex, siblings.length));
	if (toIndex === fromIndex) return undefined;

	const order = plannedMoveSlotKey(
		siblings.map((input) => input.order),
		toIndex,
	);

	return { kind: "moveSearchInput", moduleUuid, uuid, order };
}
