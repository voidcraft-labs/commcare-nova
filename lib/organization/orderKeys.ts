import { balancedKeysBetween, deriveKeyAtIndex } from "@/lib/lookup/orderKeys";

/**
 * Keep organization order keys well below PostgreSQL's btree tuple limit.
 * Ordinary edits retain their fractional-key locality. When one would cross
 * this ceiling, the locked sibling set is redistributed in one transaction.
 */
export const MAX_LOCATION_ORDER_KEY_LENGTH = 256;

export interface BoundedLocationOrderKeyPlan {
	readonly key: string;
	/** Existing siblings' replacement keys, in the same semantic order. */
	readonly rebalancedExistingKeys?: readonly string[];
}

export function boundedLocationOrderKeyAtIndex(
	orderedKeys: readonly string[],
	requestedIndex: number,
): BoundedLocationOrderKeyPlan {
	const index = Math.max(0, Math.min(requestedIndex, orderedKeys.length));
	const key = deriveKeyAtIndex([...orderedKeys], index);
	if (key.length <= MAX_LOCATION_ORDER_KEY_LENGTH) return { key };

	const balanced = balancedKeysBetween(null, null, orderedKeys.length + 1);
	return {
		key: balanced[index],
		rebalancedExistingKeys: [
			...balanced.slice(0, index),
			...balanced.slice(index + 1),
		],
	};
}
