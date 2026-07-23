import { describe, expect, it } from "vitest";
import { emitOnDeviceExpression } from "@/lib/commcare/expression/onDeviceEmitter";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { emitCaseListFilter } from "@/lib/commcare/predicate/caseListFilterEmitter";
import { ROOT_ON_DEVICE_CASE_ANCHOR } from "@/lib/commcare/predicate/relationPresenceEmitter";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	ancestorPath,
	and,
	count,
	eq,
	exists,
	literal,
	matchAll,
	matchNone,
	prop,
	relationStep,
	sessionUser,
	subcasePath,
	tableColumn,
	tableLookup,
} from "@/lib/domain/predicate";
import type { LookupRevision } from "@/lib/lookup/types";

// One hand-built table, tag "regions", with the four columns the S05b
// lowering contract exercises: a select value/label pair plus a `name`
// result column and an `int` `pop` column.
const REGIONS = "018f3e8a-7b2c-7def-8abc-0000000000a1" as LookupTableId;
const OTHER_TABLE = "018f3e8a-7b2c-7def-8abc-0000000000a2" as LookupTableId;
const VALUE = "018f3e8a-7b2c-7def-8abc-0000000000b1" as LookupColumnId;
const LABEL = "018f3e8a-7b2c-7def-8abc-0000000000b2" as LookupColumnId;
const NAME = "018f3e8a-7b2c-7def-8abc-0000000000b3" as LookupColumnId;
const POP = "018f3e8a-7b2c-7def-8abc-0000000000b4" as LookupColumnId;

const naming = lookupWireNaming([
	{
		id: REGIONS,
		name: "Regions",
		tag: "regions",
		definitionRevision: "1" as LookupRevision,
		columns: [
			{ id: VALUE, wireName: "value", label: "Value", dataType: "text" },
			{ id: LABEL, wireName: "label", label: "Label", dataType: "text" },
			{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
			{ id: POP, wireName: "pop", label: "Population", dataType: "int" },
		],
	},
]);

/** Value-slot lowering with a live naming supplied. */
const withNaming = { lookup: { naming } } as const;

describe("emitOnDeviceExpression — table-lookup lowering", () => {
	it("lowers a match-all where to the bare first-match positional path", () => {
		expect(
			emitOnDeviceExpression(
				tableLookup(REGIONS, NAME, matchAll()),
				"casedb",
				{},
				ROOT_ON_DEVICE_CASE_ANCHOR,
				withNaming,
			),
		).toBe("instance('item-list:regions')/regions_list/regions[1]/name");
	});

	it("prints a column-term filter as a bare row-relative wire step", () => {
		expect(
			emitOnDeviceExpression(
				tableLookup(
					REGIONS,
					NAME,
					eq(tableColumn(REGIONS, VALUE), literal("north")),
				),
				"casedb",
				{},
				ROOT_ON_DEVICE_CASE_ANCHOR,
				withNaming,
			),
		).toBe(
			"instance('item-list:regions')/regions_list/regions[value = 'north'][1]/name",
		);
	});

	it("emits [false()][1] for a match-none where", () => {
		expect(
			emitOnDeviceExpression(
				tableLookup(REGIONS, NAME, matchNone()),
				"casedb",
				{},
				ROOT_ON_DEVICE_CASE_ANCHOR,
				withNaming,
			),
		).toBe(
			"instance('item-list:regions')/regions_list/regions[false()][1]/name",
		);
	});

	it("keeps a session-user term's absolute instance path inside the where", () => {
		expect(
			emitOnDeviceExpression(
				tableLookup(
					REGIONS,
					NAME,
					eq(tableColumn(REGIONS, VALUE), sessionUser("region")),
				),
				"casedb",
				{},
				ROOT_ON_DEVICE_CASE_ANCHOR,
				withNaming,
			),
		).toBe(
			"instance('item-list:regions')/regions_list/regions[value = instance('commcaresession')/session/user/data/region][1]/name",
		);
	});
});

describe("emitCaseListFilter — table-lookup in a case-list filter", () => {
	it("re-anchors a fixture-row self case-property through current()", () => {
		// The table-lookup sits at the case-list filter's root anchor, so the
		// case row is `current()`; a bare self property inside the fixture-row
		// where would read the fixture row, so it re-anchors on the case.
		expect(
			emitCaseListFilter(
				eq(
					tableLookup(
						REGIONS,
						NAME,
						eq(tableColumn(REGIONS, VALUE), prop("patient", "village")),
					),
					literal("North"),
				),
				"casedb",
				{},
				ROOT_ON_DEVICE_CASE_ANCHOR,
				withNaming,
			),
		).toBe(
			"instance('item-list:regions')/regions_list/regions[value = current()/village][1]/name = 'North'",
		);
	});

	it("clears the fixture-row scope inside a sibling relation where", () => {
		// The fixture-row self property re-anchors through current(); the
		// relation `where` evaluates with its own candidate case as context, so
		// its self property stays bare (candidate-relative), never current()/….
		const lowered = emitOnDeviceExpression(
			tableLookup(
				REGIONS,
				NAME,
				and(
					eq(tableColumn(REGIONS, VALUE), prop("patient", "village")),
					exists(
						subcasePath("parent", "visit"),
						eq(prop("visit", "outcome"), literal("open")),
					),
				),
			),
			"casedb",
			{},
			ROOT_ON_DEVICE_CASE_ANCHOR,
			withNaming,
		);

		expect(lowered).toContain("regions[value = current()/village and ");
		expect(lowered).toContain(
			"instance('casedb')/casedb/case[@case_type='visit' and (outcome = 'open')]/index/parent",
		);
		expect(lowered).not.toContain("current()/outcome");
		/* Inside the fixture predicate '.' is the fixture row, which has no
		 * @case_id — the presence test must name the case through current(). */
		expect(lowered).toContain("count(current()/@case_id) > 0");
		expect(lowered).toContain(", current()/@case_id)");
		expect(lowered).not.toContain("count(@case_id)");
	});
});

describe("emitOnDeviceExpression — case-operation self-property anchoring", () => {
	it("keeps a case-op absolute session anchor over the fixture-row current() re-anchor", () => {
		// A case-operation surface supplies a `caseProperty` resolver that
		// anchors direct self properties on the selected session case. That
		// resolver wins over the fixture-row current() re-anchor, so the where's
		// self property emits the absolute session-anchored path.
		const anchored =
			"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]";
		const lowered = emitOnDeviceExpression(
			tableLookup(
				REGIONS,
				NAME,
				eq(tableColumn(REGIONS, VALUE), prop("patient", "village")),
			),
			"casedb",
			{},
			ROOT_ON_DEVICE_CASE_ANCHOR,
			{
				caseProperty: (property, root, scope) =>
					scope === "root" && property.caseType === "patient"
						? `instance('${root}')/${root}/case[@case_id=instance('commcaresession')/session/data/case_id]/${property.property}`
						: undefined,
				lookup: { naming },
			},
		);

		expect(lowered).toBe(
			`instance('item-list:regions')/regions_list/regions[value = ${anchored}/village][1]/name`,
		);
		expect(lowered).not.toContain("current()/village");
	});
});

describe("table-lookup lowering guardrails", () => {
	it("throws when a table-lookup reaches a surface with no lookup wire naming", () => {
		expect(() =>
			emitOnDeviceExpression(tableLookup(REGIONS, NAME, matchAll())),
		).toThrow(/no lookup wire naming/i);
	});

	it("throws when a table-column term is used outside any fixture-row scope", () => {
		expect(() =>
			emitCaseListFilter(eq(tableColumn(REGIONS, VALUE), literal("north"))),
		).toThrow(/outside an explicit table scope/i);
	});

	it("throws when a where reads a column from a different table", () => {
		expect(() =>
			emitOnDeviceExpression(
				tableLookup(
					REGIONS,
					NAME,
					eq(tableColumn(OTHER_TABLE, VALUE), literal("x")),
				),
				"casedb",
				{},
				ROOT_ON_DEVICE_CASE_ANCHOR,
				withNaming,
			),
		).toThrow(/cross-table/i);
	});
});

describe("relation anchors inside a fixture-row where", () => {
	it("anchors an ancestor count on the case through current()", () => {
		const lowered = emitOnDeviceExpression(
			tableLookup(
				REGIONS,
				NAME,
				eq(
					count(ancestorPath(relationStep("parent", "household"))),
					literal(1),
				),
			),
			"casedb",
			{ currentCaseType: "patient" },
			ROOT_ON_DEVICE_CASE_ANCHOR,
			withNaming,
		);
		/* The immediate index read must resolve the case first — a bare
		 * `index/parent` would read the fixture row. */
		expect(lowered).toContain(
			"instance('casedb')/casedb/case[@case_id=current()/@case_id]/index/parent",
		);
		expect(lowered).not.toContain("count(index/parent)");
	});

	it("anchors presence tests on the session case id on form surfaces", () => {
		const sessionCaseId = "instance('commcaresession')/session/data/case_id";
		const lowered = emitOnDeviceExpression(
			tableLookup(
				REGIONS,
				NAME,
				and(
					eq(tableColumn(REGIONS, VALUE), literal("north")),
					exists(subcasePath("parent", "visit")),
				),
			),
			"casedb",
			{ currentCaseType: "patient" },
			ROOT_ON_DEVICE_CASE_ANCHOR,
			{ ...withNaming, rootCaseId: sessionCaseId },
		);
		/* On a form surface current() is the bind node; the presence test
		 * anchors on the session-selected case instead. */
		expect(lowered).toContain(`count(${sessionCaseId}) > 0`);
		expect(lowered).toContain(`, ${sessionCaseId})`);
		expect(lowered).not.toContain("current()/@case_id");
	});

	it("re-anchors a form-surface self property through the session case", () => {
		const sessionCaseId = "instance('commcaresession')/session/data/case_id";
		const lowered = emitOnDeviceExpression(
			tableLookup(
				REGIONS,
				NAME,
				eq(tableColumn(REGIONS, VALUE), prop("patient", "village")),
			),
			"casedb",
			{ currentCaseType: "patient" },
			ROOT_ON_DEVICE_CASE_ANCHOR,
			{ ...withNaming, rootCaseId: sessionCaseId },
		);
		expect(lowered).toBe(
			`instance('item-list:regions')/regions_list/regions[value = instance('casedb')/casedb/case[@case_id=${sessionCaseId}]/village][1]/name`,
		);
	});
});
