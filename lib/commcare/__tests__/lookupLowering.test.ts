import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { requireExpressionContext } from "@/lib/commcare/expressionContext";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { w } from "@/lib/commcare/xpath/wire/builders";
import {
	toWire,
	type WireTermBindings,
} from "@/lib/commcare/xpath/wire/fromExpression";
import { sessionInstance } from "@/lib/commcare/xpath/wire/instances";
import { caseById, casePropertyStep } from "@/lib/commcare/xpath/wire/rowScope";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr, WirePath } from "@/lib/commcare/xpath/wire/tree";
import { calculatedColumn } from "@/lib/domain";
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
} from "@/lib/domain/expression";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupRevision } from "@/lib/lookup/types";

// One hand-built table, tag "regions", with the four columns the
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

const MODULE = testUuid("lookup-lowering-module");
const FORM = testUuid("lookup-lowering-form");
const COLUMN = testUuid("lookup-lowering-column");
const OPERATION = testUuid("lookup-lowering-operation");

/** Each target uses the same complete declarations and the expression's
 * actual carrier: a Results calculation or an operation's saved value. */
function contextFor(
	expression: Parameters<typeof toWire>[0],
	target: "xform" | "suite",
) {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "village", label: "Village", data_type: "text" }],
			},
			{ name: "household", properties: [] },
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "outcome", label: "Outcome", data_type: "text" }],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					columns: [calculatedColumn(COLUMN, "Result", expression)],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
				},
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "answer" })],
					},
				],
			},
		],
	});
	doc.forms[FORM].caseOperations = [
		{
			uuid: OPERATION,
			id: "update_village",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [{ property: "village", value: expression }],
		},
	];
	return requireExpressionContext(
		doc,
		target === "suite"
			? {
					entity: "module",
					uuid: MODULE,
					slot: "case_list_column_expression",
					member: { columnUuid: COLUMN },
				}
			: {
					entity: "form",
					uuid: FORM,
					slot: "case_operation_write_value",
					member: { operationUuid: OPERATION, property: "village" },
				},
		naming,
	);
}

function lower(
	expression: Parameters<typeof toWire>[0],
	target: "xform" | "suite" = "suite",
	bindings: WireTermBindings = {},
): WireExpr {
	return toWire(expression, {
		target,
		types: contextFor(expression, target),
		bindings: { lookup: { naming, instanceScope: target }, ...bindings },
	});
}

function path(expression: WireExpr): WirePath {
	expect(expression.k).toBe("path");
	if (expression.k !== "path")
		throw new Error("The lookup did not produce a path.");
	return expression;
}

/** Inspect tree coordinates, without using the serializer as its own oracle. */
function nodes(expression: WireExpr): WireExpr[] {
	let children: readonly WireExpr[] = [];
	switch (expression.k) {
		case "cmp":
		case "arith":
			children = [expression.left, expression.right];
			break;
		case "and":
		case "or":
			children = expression.items;
			break;
		case "neg":
			children = [expression.value];
			break;
		case "call":
			children = expression.args;
			break;
		case "expansion":
			children = [expression.expr];
			break;
		case "path":
			children = expression.steps.flatMap((step) => step.predicates);
			break;
	}
	return [expression, ...children.flatMap(nodes)];
}

const sessionCaseId = w.instance(sessionInstance(), [
	w.step("session"),
	w.step("data"),
	w.step("case_id"),
]);

describe("lookup wire coordinates", () => {
	it.each(["xform", "suite"] as const)(
		"declares the exact fixture identity in %s",
		(target) => {
			const wire = lower(tableLookup(REGIONS, NAME, matchAll()), target);
			const printed = serializeWire(
				wire,
				target === "xform" ? { target, constraint: false } : { target },
			);
			expect([...printed.instances]).toEqual([
				{
					id: target === "xform" ? "regions" : "item-list:regions",
					src: "jr://fixture/item-list:regions",
				},
			]);
			expect(path(wire).steps).toEqual([
				w.step("regions_list"),
				w.step("regions", [w.num(1)]),
				w.step("name"),
			]);
		},
	);

	it("keeps the first matching row after a row-relative column filter", () => {
		const wire = lower(
			tableLookup(
				REGIONS,
				NAME,
				eq(tableColumn(REGIONS, VALUE), literal("north")),
			),
		);
		expect(path(wire).steps[1].predicates).toEqual([
			w.eq(w.context([w.step("value")]), w.str("north")),
			w.num(1),
		]);
	});

	it("preserves a match-none filter before selecting the first row", () => {
		expect(
			path(lower(tableLookup(REGIONS, NAME, matchNone()))).steps[1].predicates,
		).toEqual([w.call("false"), w.num(1)]);
	});

	it("keeps the session read absolute within a fixture-row condition", () => {
		const wire = lower(
			tableLookup(
				REGIONS,
				NAME,
				eq(tableColumn(REGIONS, VALUE), sessionUser("region")),
			),
		);
		expect(nodes(wire)).toContainEqual(
			w.instance(sessionInstance(), [
				w.step("session"),
				w.step("user"),
				w.step("data"),
				w.step("region"),
			]),
		);
	});

	it("anchors a case-list self read on its original case, outside the fixture row", () => {
		const wire = lower(
			eq(
				tableLookup(
					REGIONS,
					NAME,
					eq(tableColumn(REGIONS, VALUE), prop("patient", "village")),
				),
				literal("North"),
			),
		);
		expect(nodes(wire)).toContainEqual(w.current([w.step("village")]));
		expect(nodes(wire)).not.toContainEqual(w.context([w.step("village")]));
	});

	it("changes from the fixture row to the candidate case for a nested relation", () => {
		const wire = lower(
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
		);
		expect(nodes(wire)).toContainEqual(w.current([w.step("village")]));
		expect(nodes(wire)).toContainEqual(w.context([w.step("outcome")]));
		expect(nodes(wire)).not.toContainEqual(w.current([w.step("outcome")]));
		expect(nodes(wire)).toContainEqual(w.current([w.attr("case_id")]));
	});

	it("keeps a form operation's selected-case binding over the fixture-row anchor", () => {
		const selectedVillage = w.append(caseById(sessionCaseId, "casedb"), [
			casePropertyStep("village"),
		]);
		const wire = lower(
			tableLookup(
				REGIONS,
				NAME,
				eq(tableColumn(REGIONS, VALUE), prop("patient", "village")),
			),
			"xform",
			{
				caseProperty: (property, root, scope) =>
					scope === "root" && property.caseType === "patient"
						? w.append(caseById(sessionCaseId, root), [
								casePropertyStep(property.property),
							])
						: undefined,
			},
		);
		expect(nodes(wire)).toContainEqual(selectedVillage);
		expect(nodes(wire)).not.toContainEqual(w.current([w.step("village")]));
	});

	it("anchors an ancestor count on the case outside the fixture-row context", () => {
		const wire = lower(
			tableLookup(
				REGIONS,
				NAME,
				eq(
					count(ancestorPath(relationStep("parent", "household"))),
					literal(1),
				),
			),
		);
		expect(nodes(wire)).toContainEqual(
			w.append(caseById(w.current([w.attr("case_id")]), "casedb"), [
				w.step("index"),
				w.step("parent"),
			]),
		);
	});

	it("anchors form presence and self reads on the selected session case", () => {
		const wire = lower(
			tableLookup(
				REGIONS,
				NAME,
				and(
					eq(tableColumn(REGIONS, VALUE), prop("patient", "village")),
					exists(subcasePath("parent", "visit")),
				),
			),
			"xform",
			{ rootCaseIdWireExpr: sessionCaseId },
		);
		expect(nodes(wire)).toContainEqual(sessionCaseId);
		expect(nodes(wire)).toContainEqual(
			w.append(caseById(sessionCaseId, "casedb"), [w.step("village")]),
		);
		expect(nodes(wire)).not.toContainEqual(w.current([w.attr("case_id")]));
	});
});

describe("lookup wire admission backstops", () => {
	it("refuses a lookup without its Project naming catalog", () => {
		const expression = tableLookup(REGIONS, NAME, matchAll());
		expect(() =>
			toWire(expression, {
				target: "suite",
				types: contextFor(expression, "suite"),
			}),
		).toThrow(/lookup naming catalog/i);
	});
	it("refuses a column without a fixture-row scope", () => {
		expect(() =>
			lower(eq(tableColumn(REGIONS, VALUE), literal("north"))),
		).toThrow(/fixture-row scope/i);
	});
	it("refuses a column belonging to another table", () => {
		expect(() =>
			lower(
				tableLookup(
					REGIONS,
					NAME,
					eq(tableColumn(OTHER_TABLE, VALUE), literal("x")),
				),
			),
		).toThrow(/inside the row scope/i);
	});
});
