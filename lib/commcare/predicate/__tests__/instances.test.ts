import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { LookupColumnId, LookupTableId } from "@/lib/domain";
import {
	eq,
	fixedLocation,
	literal,
	matchAll,
	ownerLocationAtLevel,
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

	it("accumulates the XForm-local id in XForm scope", () => {
		expect(
			collectExpressionInstances(
				tableLookup(TABLE, VALUE_COLUMN, matchAll()),
				NAMING,
				"xform",
			),
		).toEqual(new Set(["statuses"]));
	});

	it("adds no fixture for a fixed place and both rows needed by an owner reverse hop", () => {
		expect(
			collectExpressionInstances(
				term(fixedLocation(testUuid("fixed-location"))),
			),
		).toEqual(new Set());
		expect(
			collectExpressionInstances(
				term(ownerLocationAtLevel(testUuid("bucket-level"), "patient")),
			),
		).toEqual(new Set(["locations", "casedb"]));
		expect(instanceSourceFor("locations")).toBe("jr://fixture/locations");
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
	it.each([
		"selected_cases",
		"parent_selected_cases",
		"parent_parent_selected_cases",
		"search_selected_cases",
		"selected_cases_guppy",
		"parent_selected_cases_gold-fish",
	])(
		"maps the generated selected-case id %s to its exact virtual source",
		(id) => {
			expect(instanceSourceFor(id)).toBe(
				`jr://instance/selected-entities/${id}`,
			);
		},
	);

	it.each([
		"my_selected_cases",
		"unrelatedselected_cases",
		"parent_search_selected_cases",
		"search_selected_cases_guppy",
		"selected_cases_9guppy",
		"selected_cases_guppy/unsafe",
		"parent_selected_cases_",
	])("rejects arbitrary selected-case-like id %s", (id) => {
		expect(() => instanceSourceFor(id)).toThrow(`Unknown instance id '${id}'`);
	});

	it("maps both scoped lookup ids to the exact fixture source", () => {
		expect(instanceSourceFor("statuses", NAMING)).toBe(
			"jr://fixture/item-list:statuses",
		);
		expect(instanceSourceFor("item-list:statuses", NAMING)).toBe(
			"jr://fixture/item-list:statuses",
		);
	});
});
