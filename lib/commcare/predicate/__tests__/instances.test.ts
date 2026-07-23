import { describe, expect, it } from "vitest";
import type { LookupColumnId, LookupTableId } from "@/lib/domain";
import { matchAll, tableLookup } from "@/lib/domain/predicate";
import { collectExpressionInstances } from "../instances";

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;

describe("collectExpressionInstances", () => {
	it("rejects a dormant table lookup whose filter has no terms", () => {
		expect(() =>
			collectExpressionInstances(tableLookup(TABLE, VALUE_COLUMN, matchAll())),
		).toThrow(
			"collectAstInstances: lookup-table expressions are dormant until fixture emission lands",
		);
	});
});
