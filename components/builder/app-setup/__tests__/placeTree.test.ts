import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { buildPlaceTree, PLACE_PAGE_SIZE } from "../placeTree";

function location(index: number, parentId: string | null): StoredLocation {
	return {
		id: asUuid(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
		levelUuid: "10000000-0000-4000-8000-000000000000",
		parentId: parentId === null ? null : asUuid(parentId),
		siteCode: `place-${index}`,
		name: `Place ${index}`,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: String(index),
	};
}

describe("place hierarchy projection", () => {
	it("keeps exact hierarchy semantics in depth-first order", () => {
		const root = location(1, null);
		const peer = location(2, null);
		const child = location(3, root.id);
		const tree = buildPlaceTree([root, peer, child]);

		expect(
			tree.rows.map(({ location: row, ...position }) => ({
				id: row.id,
				...position,
			})),
		).toEqual([
			{ id: root.id, depth: 0, positionInSet: 1, setSize: 2 },
			{ id: child.id, depth: 1, positionInSet: 1, setSize: 1 },
			{ id: peer.id, depth: 0, positionInSet: 2, setSize: 2 },
		]);
	});

	it("projects ten thousand nested places without recursive overflow", () => {
		const locations: StoredLocation[] = [];
		for (let index = 1; index <= 10_000; index++) {
			locations.push(location(index, locations.at(-1)?.id ?? null));
		}

		const tree = buildPlaceTree(locations);
		expect(tree.rows).toHaveLength(10_000);
		expect(tree.rows.at(-1)?.depth).toBe(9_999);
		expect(tree.rows.slice(0, PLACE_PAGE_SIZE)).toHaveLength(100);
	});
});
