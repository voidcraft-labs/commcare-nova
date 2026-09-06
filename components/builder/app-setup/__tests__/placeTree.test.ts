import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { buildPlaceTree, placeTreePage } from "../placeTree";

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
			tree.rows.map(({ location: row, depth }) => ({ id: row.id, depth })),
		).toEqual([
			{ id: root.id, depth: 0 },
			{ id: child.id, depth: 1 },
			{ id: peer.id, depth: 0 },
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
		expect(tree.rows.map(({ location: row }) => row.id)).toEqual(
			locations.map((row) => row.id),
		);
	});
	it("keeps disconnected and cyclic imported rows inspectable without walking forever", () => {
		const root = location(1, null),
			child = location(2, root.id);
		const orphan = location(3, location(999, null).id);
		const cycleA = location(4, location(5, null).id),
			cycleB = location(5, cycleA.id);
		const rows = [orphan, cycleA, root, cycleB, child];
		const before = structuredClone(rows);
		const tree = buildPlaceTree(rows);
		expect(tree.rows).toEqual([
			{ location: root, depth: 0 },
			{ location: child, depth: 1 },
			{ location: orphan, depth: 0 },
			{ location: cycleA, depth: 0 },
			{ location: cycleB, depth: 0 },
		]);
		expect(tree.childrenOf.get(root.id)).toEqual([child]);
		expect(tree.childrenOf.get(cycleA.id)).toEqual([cycleB]);
		expect(rows).toEqual(before);
	});

	it("selects the open row's page in the same projection as a peer reorder", () => {
		const rows = Array.from({ length: 101 }, (_, index) =>
			location(index + 1, null),
		);
		const open = rows[0];
		if (open === undefined) throw new Error("Open row missing");
		expect(placeTreePage(buildPlaceTree(rows).rows, open.id, 0)).toEqual({
			page: 0,
			pageCount: 2,
		});
		const reordered = buildPlaceTree([...rows.slice(1), open]);
		expect(placeTreePage(reordered.rows, open.id, 0)).toEqual({
			page: 1,
			pageCount: 2,
		});
		expect(placeTreePage(reordered.rows, undefined, 0)).toEqual({
			page: 0,
			pageCount: 2,
		});
		expect(
			placeTreePage(buildPlaceTree(rows.slice(0, 99)).rows, undefined, 1),
		).toEqual({ page: 0, pageCount: 1 });
		expect(placeTreePage([], undefined, 4)).toEqual({ page: 0, pageCount: 1 });
	});
});
