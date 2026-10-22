import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	ancestorPath,
	anyRelationPath,
	arith,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	datetimeLiteral,
	eq,
	exists,
	gt,
	ifExpr,
	input,
	literal,
	match,
	now,
	prop,
	relationStep,
	sessionContext,
	sessionUserProperty,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/predicate/builders";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import { predicateSchema } from "@/lib/domain/predicate/types";
import { w } from "../builders";
import { toWire, type WireBuildContext } from "../fromExpression";
import {
	caseDbInstance,
	searchInputInstance,
	sessionInstance,
} from "../instances";
import { casePropertyStep } from "../rowScope";
import { serializeWire } from "../serialize";

const context: WireBuildContext = { target: "suite", types: {} };
const lower = (expression: Predicate | ValueExpression) =>
	toWire(expression, context);

// These observations belong to lowering: identity resolution, scalar admission,
// scope and operation choice. Grammar spelling and native answers have separate
// serializer tests and the independent Core evidence family.
describe("domain expressions become typed wire trees", () => {
	it("keeps literal bytes out of paths and resolves reserved case metadata", () => {
		expect(
			lower(eq(prop("patient", "case_id"), literal("instance('other')/#case"))),
		).toEqual(
			w.eq(w.context([w.attr("case_id")]), w.str("instance('other')/#case")),
		);
		expect(lower(term(literal(false)))).toEqual(w.str("false"));
		expect(lower(term(literal(null)))).toEqual(w.str(""));
	});

	it("keeps integer division's zero branch and signed remainder lowering", () => {
		expect(lower(arith("div", term(literal(-7)), term(literal(2))))).toEqual(
			w.call("if", [
				w.eq(w.num(2), w.num(0)),
				w.div(w.num(-7), w.num(2)),
				w.div(w.sub(w.num(-7), w.mod(w.num(-7), w.num(2))), w.num(2)),
			]),
		);
	});

	it("resolves identity bindings to their exact trees without parsing text", () => {
		const field = testUuid("field"),
			operation = testUuid("operation");
		const fieldTree = w.form(["repeat", "answer"]),
			operationTree = w.form([w.step("case"), w.attr("case_id")]);
		expect(
			toWire(
				{ kind: "term", term: { kind: "field", uuid: field } },
				{ ...context, bindings: { formFields: new Map([[field, fieldTree]]) } },
			),
		).toBe(fieldTree);
		expect(
			toWire(
				{ kind: "id-of", opUuid: operation },
				{
					...context,
					bindings: { operationIds: new Map([[operation, operationTree]]) },
				},
			),
		).toBe(operationTree);
	});

	it("uses current search names and preserves the contextual instance declaration", () => {
		const uuid = testUuid("search");
		const tree = toWire(term(input(uuid)), {
			...context,
			types: {
				knownInputs: [{ uuid, name: "current_name", data_type: "text" }],
				searchInputInstanceId: "search-input:custom",
			},
		});
		expect(tree).toEqual(
			w.instance(searchInputInstance("search-input:custom"), [
				w.step("input"),
				w.step("field", [
					w.eq(w.context([w.attr("name")]), w.str("current_name")),
				]),
			]),
		);
		expect([...serializeWire(tree, { target: "suite" }).instances]).toEqual([
			searchInputInstance("search-input:custom"),
		]);
	});

	it("narrows a graph-proven parent relation and holds its destination case type", () => {
		const tree = toWire(
			term(prop("patient", "district", anyRelationPath("parent", "household"))),
			{
				...context,
				types: {
					currentCaseType: "patient",
					caseTypes: [
						{ name: "patient", parent_type: "household", properties: [] },
						{ name: "household", properties: [] },
					],
				},
			},
		);
		expect(tree).toEqual(
			w.instance(caseDbInstance(), [
				w.step("casedb"),
				w.step("case", [
					w.and(
						w.eq(
							w.context([w.attr("case_id")]),
							w.current([w.step("index"), w.step("parent")]),
						),
						w.eq(w.context([w.attr("case_type")]), w.str("household")),
					),
				]),
				w.step("district"),
			]),
		);
	});

	it("counts children from the enclosing singleton ancestor, with no lexical current rebinding", () => {
		const tree = lower(
			ifExpr(
				exists(
					ancestorPath(relationStep("parent", "household")),
					gt(count(subcasePath("parent", "visit")), literal(0)),
				),
				term(literal("yes")),
				term(literal("no")),
			),
		);
		const expectedAnchor = w.instance(caseDbInstance(), [
			w.step("casedb"),
			w.step("case", [
				w.and(
					w.eq(
						w.context([w.attr("case_id")]),
						w.current([w.step("index"), w.step("parent")]),
					),
					w.eq(w.context([w.attr("case_type")]), w.str("household")),
				),
			]),
			w.attr("case_id"),
		]);
		expect(JSON.stringify(tree)).toContain(JSON.stringify(expectedAnchor));
		expect([...serializeWire(tree, { target: "suite" }).instances]).toEqual([
			caseDbInstance(),
		]);
	});

	it("keeps form-selected case bindings independent from candidate-row terms", () => {
		const selected = w.instance(sessionInstance(), [
			w.step("session"),
			w.step("data"),
			w.step("case_id"),
		]);
		const result = toWire(eq(prop("patient", "name"), literal("Sam")), {
			...context,
			bindings: {
				caseProperty: (property, _root, scope) =>
					scope === "root"
						? w.instance(caseDbInstance(), [
								w.step("casedb"),
								w.step("case", [
									w.eq(w.context([w.attr("case_id")]), selected),
								]),
								casePropertyStep(property.property),
							])
						: undefined,
			},
		});
		expect([...serializeWire(result, { target: "suite" }).instances]).toEqual([
			caseDbInstance(),
			sessionInstance(),
		]);
	});

	it("resolves inherited worker bindings and retains only their session dependency", () => {
		const uuid = testUuid("worker-property");
		const tree = toWire(term(sessionUserProperty(uuid)), {
			...context,
			types: { userPropertySlugs: new Map([[uuid, "region"]]) },
		});
		expect(tree).toEqual(
			w.instance(sessionInstance(), [
				w.step("session"),
				w.step("user"),
				w.step("data"),
				w.step("region"),
			]),
		);
		expect(lower(term(sessionContext("userid")))).toEqual(
			w.instance(sessionInstance(), [
				w.step("session"),
				w.step("context"),
				w.step("userid"),
			]),
		);
	});

	it("keeps date coercion and fractional day flooring as explicit operations", () => {
		expect(
			lower(
				dateAdd(
					dateCoerce(term(literal("1969-12-31"))),
					"hours",
					term(literal(-12)),
				),
			),
		).toEqual(
			w.call("date", [
				w.call("floor", [
					w.add(
						w.call("date", [w.str("1969-12-31")]),
						w.div(w.num(-12), w.num(24)),
					),
				]),
			]),
		);
	});
});

describe("wire lowering preserves the prior defensive refusals", () => {
	it.each(["months", "years"] as const)(
		"refuses calendar-relative %s arithmetic",
		(interval) => {
			expect(() => lower(dateAdd(today(), interval, term(literal(1))))).toThrow(
				/calendar-relative date-add interval/i,
			);
		},
	);
	it.each([
		["now", now()],
		["datetime-coerce", datetimeCoerce(term(literal("2020-01-01T12:00:00")))],
		["typed datetime literal", term(datetimeLiteral("2020-01-01T12:00:00"))],
		["nested date-add", dateAdd(now(), "days", term(literal(1)))],
		["null-neutral coalesce", coalesce(now(), term(literal(null)))],
		[
			"null-neutral conditional",
			ifExpr(eq(literal(1), literal(1)), now(), term(literal(null))),
		],
		[
			"null-neutral switch",
			switchExpr(
				term(literal("x")),
				[switchCase(literal("x"), now())],
				term(literal(null)),
			),
		],
	] as const)(
		"refuses a %s datetime base before losing its time",
		(_label, base) => {
			expect(() => lower(dateAdd(base, "days", term(literal(1))))).toThrow(
				/structurally datetime-typed base.*discard the time-of-day/s,
			);
		},
	);
	it.each([
		term(prop("patient", "visit_date", subcasePath("parent", "visit"))),
		concat(
			term(literal("Status: ")),
			term(prop("patient", "status", anyRelationPath("parent", "visit"))),
		),
	])("refuses a multi-valued scalar read", (expression) => {
		expect(() => lower(expression)).toThrow(/several values.*scalar/i);
	});
	it("refuses a child count below a multi-case candidate scope", () => {
		const expression = ifExpr(
			exists(
				subcasePath("parent", "visit"),
				gt(count(subcasePath("parent", "followup")), literal(0)),
			),
			term(literal("yes")),
			term(literal("no")),
		);
		expect(() => lower(expression)).toThrow(
			/child-case count is nested under a relation scope that CommCare Core cannot name/i,
		);
	});
	it("refuses a worker identity without a current saved-name binding", () => {
		expect(() => lower(term(sessionUserProperty(testUuid("missing"))))).toThrow(
			/worker-information property.*has no current saved-name binding/i,
		);
	});
	it.each(["fuzzy", "phonetic", "fuzzy-date"] as const)(
		"refuses server-only match mode %s",
		(mode) => {
			expect(() =>
				lower(match(prop("patient", "full_name"), "alice", mode)),
			).toThrow(/does not register/);
		},
	);
	it("refuses an unbounded between that bypassed the schema", () => {
		const bypassed = {
			kind: "between" as const,
			left: term(prop("patient", "age")),
			lowerInclusive: true,
			upperInclusive: true,
		};
		expect(predicateSchema.safeParse(bypassed).success).toBe(false);
		expect(() => lower(bypassed)).toThrow(/between/);
	});
});
