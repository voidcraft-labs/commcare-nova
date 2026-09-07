import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	ancestorPath,
	anyRelationPath,
	count,
	eq,
	exists,
	fixedLocation,
	formField,
	gt,
	ifExpr,
	input,
	literal,
	matchAll,
	missing,
	ownerLocationAtLevel,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	sessionUserProperty,
	subcasePath,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { lookupWireNaming } from "../../lookup/naming";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "../instances";

const TABLE = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ab");
const OTHER = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ac");
const COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const OTHER_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ae",
);
const naming = lookupWireNaming([
	{
		id: TABLE,
		name: "Statuses",
		tag: "statuses",
		definitionRevision: parseLookupRevision("3"),
		columns: [
			{ id: COLUMN, wireName: "value", label: "Value", dataType: "text" },
		],
	},
	{
		id: OTHER,
		name: "Regions",
		tag: "regions",
		definitionRevision: parseLookupRevision("1"),
		columns: [
			{ id: OTHER_COLUMN, wireName: "code", label: "Code", dataType: "text" },
		],
	},
]);

// Dependency collection is a structural union, not admission or execution.
// Independent fully admitted forms and native Core execution cover the latter.
it.each([
	[literal("plain"), []],
	[formField(testUuid("field")), []],
	[fixedLocation(testUuid("place")), []],
	[prop("patient", "name"), ["casedb"]],
	[input(testUuid("answer")), ["search-input:results"]],
	[sessionUser("role"), ["commcaresession"]],
	[sessionUserProperty(testUuid("role")), ["commcaresession"]],
	[sessionContext("userid"), ["commcaresession"]],
	[ownerLocationAtLevel(testUuid("level"), "patient"), ["locations", "casedb"]],
	[tableColumn(TABLE, COLUMN), ["item-list:statuses"]],
] as const)("maps leaf %j to its data dependencies", (leaf, expected) => {
	expect(collectExpressionInstances(term(leaf), naming)).toEqual(
		new Set(expected),
	);
});

it.each(["suite", "xform"] as const)(
	"unions all dependencies across nested values and predicates in %s scope",
	(scope) => {
		const value = ifExpr(
			exists(
				subcasePath("parent", "visit"),
				eq(prop("visit", "name"), sessionUser("role")),
			),
			tableLookup(
				TABLE,
				COLUMN,
				eq(
					tableColumn(TABLE, COLUMN),
					tableLookup(
						OTHER,
						OTHER_COLUMN,
						eq(tableColumn(OTHER, OTHER_COLUMN), input(testUuid("region"))),
					),
				),
			),
			term(ownerLocationAtLevel(testUuid("level"), "patient")),
		);
		const before = structuredClone(value);
		const expected = new Set([
			scope === "suite" ? "item-list:statuses" : "statuses",
			scope === "suite" ? "item-list:regions" : "regions",
			"casedb",
			"commcaresession",
			"locations",
			"search-input:results:inline",
		]);
		expect(
			collectExpressionInstances(
				value,
				naming,
				scope,
				"search-input:results:inline",
			),
		).toEqual(expected);
		expect(
			collectPredicateInstances(
				eq(value, literal("x")),
				naming,
				scope,
				"search-input:results:inline",
			),
		).toEqual(expected);
		expect(value).toEqual(before);
	},
);

it("collects a lookup with no row references and refuses absent or incomplete naming", () => {
	const value = tableLookup(TABLE, COLUMN, matchAll());
	expect(collectExpressionInstances(value, naming)).toEqual(
		new Set(["item-list:statuses"]),
	);
	expect(collectExpressionInstances(value, naming, "xform")).toEqual(
		new Set(["statuses"]),
	);
	for (const collect of [
		() => collectExpressionInstances(value),
		() => collectPredicateInstances(eq(value, literal("x"))),
	]) {
		expect(collect).toThrow(
			"collectAstInstances: a lookup carrier reached instance collection with no lookup wire naming. Every compile boundary that admits lookup carriers must supply the validated Project lookup catalog.",
		);
	}
	expect(() => collectExpressionInstances(value, lookupWireNaming([]))).toThrow(
		`lookupWireNaming: table '${TABLE}' is not part of the validated definitions snapshot. Validation must reject a dangling table reference before emission.`,
	);
});

it.each([
	ancestorPath(relationStep("parent")),
	subcasePath("parent"),
	anyRelationPath("parent"),
])("collects a property-free %j relation through both AST families", (path) => {
	for (const predicate of [
		exists(path),
		missing(path),
		gt(count(path), literal(0)),
	]) {
		expect(collectPredicateInstances(predicate)).toEqual(new Set(["casedb"]));
		expect(
			collectExpressionInstances(
				ifExpr(predicate, term(literal(1)), term(literal(0))),
			),
		).toEqual(new Set(["casedb"]));
	}
	expect(collectExpressionInstances(count(path))).toEqual(new Set(["casedb"]));
});

it("does not manufacture a case dependency for a self relation with constant operands", () => {
	expect(collectExpressionInstances(count(selfPath()))).toEqual(new Set());
	expect(collectPredicateInstances(exists(selfPath()))).toEqual(new Set());
	expect(collectPredicateInstances(missing(selfPath()))).toEqual(new Set());
});

it.each([
	["casedb", "jr://instance/casedb"],
	["commcaresession", "jr://instance/session"],
	["results", "jr://instance/remote/results"],
	["results:inline", "jr://instance/remote/results:inline"],
	["search-input:results", "jr://instance/search-input/results"],
	["search-input:results:inline", "jr://instance/search-input/results:inline"],
	["locations", "jr://fixture/locations"],
	["statuses", "jr://fixture/item-list:statuses"],
	["item-list:statuses", "jr://fixture/item-list:statuses"],
])("maps %s to its exact source", (id, source) => {
	expect(instanceSourceFor(id, naming)).toBe(source);
});

it.each([
	"selected_cases",
	"parent_selected_cases",
	"parent_parent_selected_cases",
	"search_selected_cases",
	"selected_cases_guppy",
	"parent_selected_cases_gold-fish",
])("maps the generated selector %s", (id) => {
	expect(instanceSourceFor(id)).toBe(`jr://instance/selected-entities/${id}`);
});

it.each([
	"unknown",
	"statuses",
	"item-list:statuses",
	"my_selected_cases",
	"unrelatedselected_cases",
	"parent_search_selected_cases",
	"search_selected_cases_guppy",
	"selected_cases_9guppy",
	"selected_cases_guppy/unsafe",
	"parent_selected_cases_",
])("refuses an unbound or noncanonical instance %s", (id) => {
	expect(() => instanceSourceFor(id)).toThrow(
		`Unknown instance id '${id}' reached the suite-XML instance source helper. The instance accumulator surfaced an id with no known jr:// source. Verify the accumulator and this helper agree on the closed id set.`,
	);
});
