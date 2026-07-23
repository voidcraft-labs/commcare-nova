import { describe, expect, it } from "vitest";
import type { LookupColumnId, LookupTableId } from "@/lib/domain";
import {
	eq,
	literal,
	matchAll,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { lookupWireNaming } from "../../lookup/naming";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "../instances";

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;

const NAMING = lookupWireNaming([
	{
		id: TABLE,
		name: "Statuses",
		tag: "statuses",
		definitionRevision: "3" as never,
		columns: [
			{
				id: VALUE_COLUMN,
				wireName: "value",
				label: "Value",
				dataType: "text",
			},
		],
	},
]);

describe("collectExpressionInstances", () => {
	it("throws when a table lookup reaches collection with no naming", () => {
		expect(() =>
			collectExpressionInstances(tableLookup(TABLE, VALUE_COLUMN, matchAll())),
		).toThrow(
			"collectAstInstances: a lookup carrier reached suite instance collection with no lookup wire naming",
		);
	});

	it("accumulates the fixture instance for a table lookup, filter terms or not", () => {
		expect(
			collectExpressionInstances(
				tableLookup(TABLE, VALUE_COLUMN, matchAll()),
				NAMING,
			),
		).toEqual(new Set(["item-list:statuses"]));
	});
});

describe("collectPredicateInstances", () => {
	it("throws when a table lookup reaches collection with no naming", () => {
		expect(() =>
			collectPredicateInstances(
				eq(tableLookup(TABLE, VALUE_COLUMN, matchAll()), literal("active")),
			),
		).toThrow(
			"collectAstInstances: a lookup carrier reached suite instance collection with no lookup wire naming",
		);
	});

	it("throws for a literal-only filter with no naming, via the node walk", () => {
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
			"collectAstInstances: a lookup carrier reached suite instance collection with no lookup wire naming",
		);
	});

	it("accumulates one fixture instance for lookup and column terms alike", () => {
		expect(
			collectPredicateInstances(
				eq(
					tableLookup(
						TABLE,
						VALUE_COLUMN,
						eq(term(tableColumn(TABLE, VALUE_COLUMN)), literal("active")),
					),
					literal("active"),
				),
				NAMING,
			),
		).toEqual(new Set(["item-list:statuses"]));
	});
});

describe("instanceSourceFor", () => {
	it("maps a lookup fixture id to its jr://fixture source", () => {
		expect(instanceSourceFor("item-list:statuses")).toBe(
			"jr://fixture/item-list:statuses",
		);
	});
});
