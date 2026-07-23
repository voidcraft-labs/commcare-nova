import { describe, expect, it } from "vitest";
import type { LookupColumnId, LookupTableId } from "@/lib/domain";
import { eq, literal, matchAll, tableLookup } from "@/lib/domain/predicate";
import {
	collectExpressionInstances,
	collectPredicateInstances,
} from "../instances";

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

describe("collectPredicateInstances", () => {
	it("rejects a dormant table lookup whose filter has no terms", () => {
		expect(() =>
			collectPredicateInstances(
				eq(tableLookup(TABLE, VALUE_COLUMN, matchAll()), literal("active")),
			),
		).toThrow(
			"collectAstInstances: lookup-table expressions are dormant until fixture emission lands",
		);
	});

	it("rejects a dormant table lookup whose filter has only literal terms", () => {
		expect(() =>
			collectPredicateInstances(
				eq(
					tableLookup(
						TABLE,
						VALUE_COLUMN,
						eq(literal("active"), literal("active")),
					),
					literal("active"),
				),
			),
		).toThrow(
			"collectAstInstances: lookup-table expressions are dormant until fixture emission lands",
		);
	});
});
