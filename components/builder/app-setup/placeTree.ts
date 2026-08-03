import type { StoredLocation } from "@/lib/organization/types";

/** One place plus its accessible position in depth-first display order. */
export interface PlaceTreeRow {
	readonly location: StoredLocation;
	readonly depth: number;
	readonly positionInSet: number;
	readonly setSize: number;
}

export interface PlaceTree {
	readonly rows: readonly PlaceTreeRow[];
	readonly childrenOf: ReadonlyMap<string | null, readonly StoredLocation[]>;
	readonly locations: readonly StoredLocation[];
}

/**
 * Build the hierarchy without recursion so even a corrupt or extremely deep
 * imported tree remains inspectable. The store makes cycles unreachable, but
 * disconnected rows are still shown as roots so operators can repair them.
 */
export function buildPlaceTree(
	locations: readonly StoredLocation[],
): PlaceTree {
	const childrenOf = new Map<string | null, StoredLocation[]>();
	for (const location of locations) {
		const siblings = childrenOf.get(location.parentId);
		if (siblings === undefined) childrenOf.set(location.parentId, [location]);
		else siblings.push(location);
	}
	const rows: PlaceTreeRow[] = [];
	const seen = new Set<string>();
	const roots = childrenOf.get(null) ?? [];
	const pending = roots
		.map((location, index) => ({
			location,
			depth: 0,
			positionInSet: index + 1,
			setSize: roots.length,
		}))
		.reverse();
	while (pending.length > 0) {
		const row = pending.pop();
		if (row === undefined || seen.has(row.location.id)) continue;
		seen.add(row.location.id);
		rows.push(row);
		const children = childrenOf.get(row.location.id) ?? [];
		for (let index = children.length - 1; index >= 0; index--) {
			const location = children[index];
			if (location === undefined) continue;
			pending.push({
				location,
				depth: row.depth + 1,
				positionInSet: index + 1,
				setSize: children.length,
			});
		}
	}
	const disconnected = locations.filter((location) => !seen.has(location.id));
	for (const [index, location] of disconnected.entries()) {
		rows.push({
			location,
			depth: 0,
			positionInSet: index + 1,
			setSize: disconnected.length,
		});
	}
	return { rows, childrenOf, locations };
}

export const PLACE_PAGE_SIZE = 100;
