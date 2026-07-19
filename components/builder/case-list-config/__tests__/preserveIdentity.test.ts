/**
 * The builder search-input / column edit path preserves order + uuid.
 *
 * The workspace edits a case-list item by rebuilding its body and replacing it
 * through a wholesale `updateModule({ caseListConfig })`. `withPreservedIdentity`
 * is what keeps the item's `order` key (display position) and `uuid` (identity)
 * from being dropped by that rebuild — without it, the item would sort ahead of
 * its keyed siblings and read as a remove+add on the auto-save diff.
 */

import { describe, expect, it } from "vitest";
import { withPreservedIdentity } from "../preserveIdentity";

describe("withPreservedIdentity", () => {
	it("carries identity and every surface position onto a rebuilt body", () => {
		const existing = {
			uuid: "col-1",
			order: "V",
			listOrder: "b",
			detailOrder: "x",
			kind: "plain",
			field: "a",
			header: "A",
		};
		// The editor rebuilt the body with NO uuid / order (the exact leak).
		const rebuilt = {
			kind: "plain",
			field: "b",
			header: "B",
		} as typeof existing;
		const result = withPreservedIdentity(existing, rebuilt);
		expect(result.uuid).toBe("col-1"); // identity preserved
		expect(result.order).toBe("V"); // display position preserved
		expect(result.listOrder).toBe("b");
		expect(result.detailOrder).toBe("x");
		expect(result.field).toBe("b"); // body actually updated
		expect(result.header).toBe("B");
	});

	it("overrides a re-minted uuid on the rebuilt body with the existing one", () => {
		const existing = {
			uuid: "s-1",
			order: "m",
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
		expect(result.order).toBe("m");
		expect(result.kind).toBe("advanced"); // the kind swap landed
	});

	it("leaves order absent when the existing item is (legacy) keyless", () => {
		const existing = { uuid: "s-1", kind: "simple" };
		const result = withPreservedIdentity(existing, {
			uuid: "other",
			kind: "advanced",
		} as typeof existing);
		expect(result.uuid).toBe("s-1");
		expect("order" in result).toBe(false);
	});
});
