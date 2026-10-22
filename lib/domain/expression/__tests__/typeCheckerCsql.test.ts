// The checker's rules for CommCare search queries and the record slots that
// read a case chosen in an earlier menu.
// Each case types an expression in a real slot of one document and asserts
// the finding the slot's targets and the node's search position decide.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	chosen,
	chosenCase,
	chosenCaseDoc,
	chosenCaseProperty,
} from "../../__tests__/chosenCaseFixture";
import type { BlueprintDoc } from "../../blueprint";
import { advancedSearchInputDef } from "../../modules";
import { proseText } from "../../prose";
import {
	ancestorPath,
	arith,
	between,
	concat,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	exists,
	formatDate,
	gt,
	gte,
	ifExpr,
	input,
	isIn,
	literal,
	matchAll,
	now,
	prop,
	relationStep,
	sessionUser,
	switchCase,
	switchExpr,
	term,
	today,
	within,
} from "../builders";
import { slotContext } from "../context";
import { walkSearchRuntimeValues } from "../searchRuntimeValues";
import { checkExpression } from "../typeChecker";
import type { Expression, ExpressionSlotRef } from "../types";

const LOOKUP = testUuid("csql-checker-lookup");

/** The chosen-case document with Search on Members, one advanced field and
 * the properties the rules below read. */
function searchDoc(): BlueprintDoc {
	const doc = structuredClone(chosenCaseDoc());
	const member = doc.caseTypes?.find((type) => type.name === "member");
	const household = doc.caseTypes?.find((type) => type.name === "household");
	if (member === undefined || household === undefined)
		throw new Error("The chosen-case fixture lost a case type.");
	member.properties.push(
		{ name: "dob", label: proseText("Born"), data_type: "date" },
		{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
		{ name: "home", label: proseText("Home"), data_type: "geopoint" },
		{
			name: "tags",
			label: proseText("Tags"),
			data_type: "multi_select",
			options: [
				{ value: "a", label: proseText("A") },
				{ value: "b", label: proseText("B") },
			],
		},
	);
	household.properties.push({
		name: "kind",
		label: proseText("Kind"),
		data_type: "single_select",
		options: [{ value: "farm", label: proseText("Farm") }],
	});
	const members = doc.modules[chosen.members];
	doc.modules[chosen.members] = {
		...members,
		caseSearchConfig: {},
		caseListConfig: {
			...(members.caseListConfig ?? caseListConfig([])),
			searchInputs: [
				advancedSearchInputDef(LOOKUP, "lookup", "Lookup", "text", matchAll()),
			],
		},
	};
	return doc;
}

const FILTER = (module: (typeof chosen)[keyof typeof chosen]) =>
	({ entity: "module", uuid: module, slot: "case_list_filter" }) as const;
const PREDICATE: ExpressionSlotRef = {
	entity: "module",
	uuid: chosen.members,
	slot: "search_input_predicate",
	member: { searchInputUuid: LOOKUP },
};
const DISPLAY: ExpressionSlotRef = {
	entity: "form",
	uuid: chosen.memberForm,
	slot: "form_display_condition",
};

function findings(
	slot: ExpressionSlotRef,
	expression: Expression,
	doc: BlueprintDoc = searchDoc(),
) {
	const ctx = slotContext(doc, slot, new Map());
	if (ctx === undefined) throw new Error("The slot has no owner here.");
	return checkExpression(expression, ctx).errors;
}
const codes = (slot: ExpressionSlotRef, expression: Expression) =>
	findings(slot, expression).map((error) => error.code);

const member = (property: string) => term(prop("member", property));
const caseRowType: Expression = {
	kind: "term",
	term: { kind: "case-row-type" },
};
const caseType = (name: string): Expression => ({
	kind: "term",
	term: { kind: "case-type", caseType: name },
});
const lookup = term(input(LOOKUP));

describe("Date closed", () => {
	const closed = member("closed_on");
	it("reads as a date and time where only CommCare's server search runs", () => {
		expect(
			codes(
				PREDICATE,
				gte(closed, datetimeCoerce(term(literal("2026-01-01")))),
			),
		).toEqual([]);
		// A related case is read where the search runs too.
		expect(
			codes(
				PREDICATE,
				exists(
					ancestorPath(relationStep("parent")),
					gte(
						term(prop("household", "closed_on")),
						datetimeCoerce(term(literal("2026-01-01"))),
					),
				),
			),
		).toEqual([]);
	});
	it("is refused wherever a device reads it", () => {
		const filter = findings(
			FILTER(chosen.members),
			gte(closed, datetimeCoerce(term(literal("2026-01-01")))),
		);
		expect(filter).toMatchObject([
			{
				code: "closed-on-not-on-device",
				message:
					"Date closed is known only to CommCare's server search, so it can't be read here. Case status shows whether a case is closed.",
			},
		]);
		// The chosen household is the device's casedb row, even in a search.
		expect(
			codes(
				PREDICATE,
				eq(
					member("village_name"),
					chosenCaseProperty(chosen.households, "household", "closed_on"),
				),
			),
		).toContain("closed-on-not-on-device");
	});
});

describe("the record's case type", () => {
	it("compares as equal or not equal with the app's case types", () => {
		expect(
			codes(FILTER(chosen.members), eq(caseRowType, caseType("member"))),
		).toEqual([]);
		expect(
			codes(FILTER(chosen.members), eq(caseRowType, term(literal("member")))),
		).toEqual([]);
	});
	it("refuses an ordering and a type the app doesn't have", () => {
		expect(
			codes(FILTER(chosen.members), gt(caseRowType, term(literal("a")))),
		).toEqual(["case-type-ordering"]);
		expect(
			codes(
				FILTER(chosen.members),
				between(caseRowType, {
					lower: term(literal("a")),
					upper: term(literal("z")),
				}),
			),
		).toEqual(["case-type-ordering"]);
		expect(
			findings(FILTER(chosen.members), eq(caseRowType, term(literal("ghost")))),
		).toMatchObject([{ code: "unknown-case-type", path: ["right"] }]);
		expect(
			findings(
				FILTER(chosen.members),
				isIn(caseRowType, literal("member"), literal("ghost")),
			),
		).toMatchObject([{ code: "unknown-case-type", path: ["values", 1] }]);
	});
	it("needs a case row", () => {
		expect(
			codes(
				{
					entity: "module",
					uuid: chosen.members,
					slot: "module_display_condition",
				},
				eq(caseRowType, caseType("member")),
			),
		).toEqual(["arm-unavailable", "arm-unavailable"]);
	});
});

describe("a number as a date", () => {
	it("refuses a date and time from a fraction only where a device works it out", () => {
		const fraction = gte(
			member("seen"),
			datetimeCoerce(term(literal(19000.5))),
		);
		expect(codes(PREDICATE, fraction)).toEqual([]);
		expect(codes(FILTER(chosen.members), fraction)).toEqual([
			"epoch-fraction-on-device",
		]);
		expect(
			codes(
				FILTER(chosen.members),
				gte(member("seen"), datetimeCoerce(term(literal(19000)))),
			),
		).toEqual([]);
	});
});

describe("a list of values", () => {
	const list = (...values: string[]): Expression => ({
		kind: "value-list",
		items: values.map((value) => term(literal(value))) as [
			Expression,
			...Expression[],
		],
	});
	it("compares as equal to a case value in a search field's condition", () => {
		expect(
			codes(PREDICATE, eq(member("village_name"), list("a", "b"))),
		).toEqual([]);
		expect(codes(PREDICATE, eq(caseRowType, list("member")))).toEqual([]);
	});
	it("holds its items to the case value's kind and stays out of a device's list", () => {
		expect(codes(PREDICATE, eq(member("age"), list("a")))).toEqual([
			"incompatible-values",
		]);
		expect(
			codes(FILTER(chosen.members), eq(member("village_name"), list("a"))),
		).toEqual(["arm-unavailable"]);
	});
});

describe("a value in place of a choice", () => {
	const selected = (value: Expression): Expression => ({
		kind: "multi-select-contains",
		property: prop("member", "tags"),
		values: [value],
		quantifier: "any",
	});
	it("takes text or a choice, and on a device a single choice", () => {
		expect(codes(PREDICATE, selected(lookup))).toEqual([]);
		expect(codes(PREDICATE, selected(double(lookup)))).toEqual([
			"runtime-selected-value-type",
		]);
		expect(codes(FILTER(chosen.members), selected(lookup))).toEqual([
			"runtime-selected-value-on-device",
		]);
		expect(
			codes(
				FILTER(chosen.members),
				selected(chosenCaseProperty(chosen.households, "household", "kind")),
			),
		).toEqual([]);
	});
});

describe("a value in place of a distance", () => {
	const center = term(literal("1 2"));
	it("takes a number for the radius and text or a single choice for the unit", () => {
		expect(
			codes(
				PREDICATE,
				within(prop("member", "home"), center, double(lookup), lookup),
			),
		).toEqual([]);
		expect(
			codes(PREDICATE, within(prop("member", "home"), center, lookup, "miles")),
		).toEqual(["distance-not-numeric"]);
		expect(
			codes(
				PREDICATE,
				within(prop("member", "home"), center, 5, double(lookup)),
			),
		).toEqual(["distance-unit-type"]);
	});
});

describe("a choice between clauses", () => {
	const choice = ifExpr(
		eq(term(sessionUser("role")), term(literal("supervisor"))),
		matchAll(),
		eq(member("age"), term(literal(5))),
	);
	it("is admitted where CommCare's search reads the slot", () => {
		expect(codes(PREDICATE, choice)).toEqual([]);
		expect(codes(FILTER(chosen.members), choice)).toEqual([]);
		expect(
			codes(
				PREDICATE,
				switchExpr(
					term(sessionUser("role")),
					[switchCase(literal("a"), matchAll())],
					eq(member("age"), term(literal(5))),
				),
			),
		).toEqual([]);
	});
	it("is refused in a list no search reads", () => {
		expect(
			codes(
				FILTER(chosen.villages),
				ifExpr(
					eq(term(sessionUser("role")), term(literal("supervisor"))),
					matchAll(),
					eq(term(prop("village", "region")), term(literal("north"))),
				),
			),
		).toEqual(["arm-unavailable"]);
	});
});

describe("the case chosen in an earlier menu", () => {
	const villageOfHousehold = eq(
		member("village_name"),
		chosenCaseProperty(chosen.households, "household", "village_name"),
	);
	it("is read where the list's entries choose it before the list", () => {
		expect(codes(FILTER(chosen.members), villageOfHousehold)).toEqual([]);
		expect(codes(PREDICATE, villageOfHousehold)).toEqual([]);
		expect(
			codes(
				FILTER(chosen.members),
				eq(term(literal("x")), chosenCase(chosen.villages)),
			),
		).toEqual([]);
		// A case-first form's menu holds its own module's choice too.
		expect(codes(DISPLAY, eq(member("age"), term(literal(3))))).toEqual([]);
		expect(codes(DISPLAY, villageOfHousehold)).toEqual([]);
	});
	it("refuses the list's own case, a later menu and a choice the entries keep apart", () => {
		expect(
			findings(
				FILTER(chosen.members),
				eq(term(literal("x")), chosenCase(chosen.members)),
			),
		).toMatchObject([
			{
				code: "datum-not-supplied",
				reason: "not-before",
				chosen: { carrier: "case-list", module: chosen.members },
			},
		]);
		expect(
			findings(
				FILTER(chosen.households),
				eq(
					term(prop("household", "village_name")),
					chosenCaseProperty(chosen.villages, "village", "region"),
				),
			),
		).toMatchObject([
			{
				code: "datum-not-supplied",
				reason: "differs",
				chosen: {
					carrier: "case-list",
					module: chosen.villages,
					otherModule: chosen.members,
				},
			},
		]);
		const parentless = searchDoc();
		parentless.modules[chosen.members].parentCaseModuleUuid = undefined;
		expect(findings(PREDICATE, villageOfHousehold, parentless)).toMatchObject([
			{
				code: "datum-not-supplied",
				reason: "not-before",
				chosen: { carrier: "search" },
			},
		]);
	});
	it("refuses a several-case menu's choice and a forms-first menu", () => {
		const several = searchDoc();
		several.modules[chosen.households] = {
			...several.modules[chosen.households],
			caseListConfig: {
				...caseListConfig([]),
				selection: { kind: "multiple", maximum: 3 },
			},
		};
		expect(
			findings(FILTER(chosen.members), villageOfHousehold, several),
		).toMatchObject([{ code: "datum-not-supplied", reason: "several-cases" }]);
		const formsFirst = searchDoc();
		formsFirst.forms[chosen.memberForm] = {
			...formsFirst.forms[chosen.memberForm],
			type: "registration",
		};
		expect(
			findings(
				DISPLAY,
				eq(term(literal("x")), chosenCase(chosen.households)),
				formsFirst,
			),
		).toMatchObject([
			{
				code: "datum-not-supplied",
				reason: "not-before",
				chosen: { carrier: "form-display-condition" },
			},
		]);
	});
	it("is typed by the menu's case type", () => {
		expect(
			codes(
				FILTER(chosen.members),
				eq(
					member("village_name"),
					chosenCaseProperty(chosen.households, "household", "nothing"),
				),
			),
		).toEqual(["unknown-property"]);
		expect(
			codes(
				FILTER(chosen.members),
				gt(
					chosenCaseProperty(chosen.households, "household", "visit_day"),
					term(literal("soon")),
				),
			),
		).toEqual(["ordered-values"]);
		expect(
			codes(
				FILTER(chosen.members),
				gt(
					chosenCaseProperty(chosen.households, "household", "visit_day"),
					dateCoerce(term(literal("2026-01-01"))),
				),
			),
		).toEqual([]);
	});
	it("is no read of a menu's display condition or a calculated column", () => {
		expect(
			codes(
				{
					entity: "module",
					uuid: chosen.members,
					slot: "module_display_condition",
				},
				eq(term(literal("x")), chosenCase(chosen.households)),
			),
		).toEqual(["case-data-unavailable"]);
	});
});

describe("reads held for import", () => {
	const anyHousehold: Expression = {
		kind: "project",
		of: {
			kind: "cases",
			source: "casedb",
			where: [eq(caseRowType, caseType("household"))],
		},
		value: { kind: "prop", caseType: "household", property: "village_name" },
	};
	it("are admitted only in a value the device works out for a search", () => {
		expect(codes(PREDICATE, eq(member("village_name"), anyHousehold))).toEqual(
			[],
		);
		expect(
			codes(FILTER(chosen.members), eq(member("village_name"), anyHousehold)),
		).toEqual(["arm-unavailable"]);
	});
});

describe("what both search slots refuse wherever the value sits", () => {
	it("refuses a computed date format and a number of a date in a value the device works out", () => {
		// Postgres compiles both slots, and the fold would hand it neither.
		for (const slot of [PREDICATE, FILTER(chosen.members)]) {
			expect(
				codes(
					slot,
					eq(
						member("village_name"),
						concat(formatDate(member("dob"), concat(lookup))),
					),
				),
			).toContain("format-date-pattern-not-fixed");
			expect(
				codes(
					slot,
					eq(
						member("age"),
						arith("+", double(member("dob")), term(literal(1))),
					),
				),
			).toContain("text-or-number-value");
		}
	});
});

describe("the values a device works out before the search runs", () => {
	const visited = (expression: Expression) => {
		const ctx = slotContext(searchDoc(), PREDICATE, new Map());
		if (ctx === undefined) throw new Error("The slot has no owner here.");
		const out: {
			kind: string;
			path: readonly (string | number)[];
			within: string;
		}[] = [];
		walkSearchRuntimeValues(expression, ctx, (value, _context, path, within) =>
			out.push({ kind: value.kind, path, within }),
		);
		return out;
	};
	it("include today, the worker's day, and leave HQ's own value functions", () => {
		expect(visited(gte(member("dob"), today()))).toEqual([
			{ kind: "today", path: ["right"], within: "server-value" },
		]);
		expect(visited(gte(member("seen"), now()))).toEqual([]);
	});
	it("include a choice's condition and a clause that reads no case", () => {
		expect(
			visited(
				ifExpr(
					eq(term(sessionUser("role")), term(literal("a"))),
					matchAll(),
					eq(member("age"), term(literal(5))),
				),
			),
		).toEqual([{ kind: "eq", path: ["if", "cond"], within: "query" }]);
	});
});
