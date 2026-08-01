/**
 * The builder search-input / column edit path preserves identity and place.
 *
 * The workspace edits a case-list item by rebuilding its body and replacing it
 * through a wholesale `updateModule({ caseListConfig })`. `withPreservedIdentity`
 * is what keeps the item's `uuid` and its tile square from being dropped by
 * that rebuild: without the uuid the replacement reads as a remove+add on the
 * auto-save diff, and without the square the commit gate refuses a column the
 * tile shows.
 */

import { describe, expect, it } from "vitest";
import { withPreservedIdentity } from "../preserveIdentity";

describe("withPreservedIdentity", () => {
	it("carries identity onto a rebuilt body", () => {
		const existing = {
			uuid: "col-1",
			kind: "plain",
			field: "a",
			header: "A",
		};
		// The editor rebuilt the body with NO uuid (the exact leak).
		const rebuilt = {
			kind: "plain",
			field: "b",
			header: "B",
		} as typeof existing;
		const result = withPreservedIdentity(existing, rebuilt);
		expect(result.uuid).toBe("col-1"); // identity preserved
		expect(result.field).toBe("b"); // body actually updated
		expect(result.header).toBe("B");
	});

	it("overrides a re-minted uuid on the rebuilt body with the existing one", () => {
		const existing = {
			uuid: "s-1",
			kind: "simple",
			name: "by_name",
		};
		const rebuilt = {
			uuid: "s-999-freshly-minted",
			kind: "advanced",
			name: "by_name",
		} as typeof existing;
		const result = withPreservedIdentity(existing, rebuilt);
		expect(result.uuid).toBe("s-1");
		expect(result.kind).toBe("advanced"); // the kind swap landed
	});

	it("carries a tile placement through a rebuild that dropped it", () => {
		// A column the tile SHOWS must hold a place; a display-style change
		// that lost the cell would be refused by the commit gate outright.
		const existing = {
			uuid: "c-1",
			kind: "plain",
			tile: { x: 0, y: 2, width: 6, height: 1, fontSize: "large" },
		};
		const rebuilt = { uuid: "c-999", kind: "date" } as typeof existing;
		expect(withPreservedIdentity(existing, rebuilt).tile).toEqual({
			x: 0,
			y: 2,
			width: 6,
			height: 1,
			fontSize: "large",
		});
	});

	it("adds no tile slot to an item that never had one", () => {
		const result = withPreservedIdentity(
			{ uuid: "s-1", kind: "simple" },
			{ uuid: "other", kind: "advanced" },
		);
		expect("tile" in result).toBe(false);
	});
});
