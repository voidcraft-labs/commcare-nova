import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	formFixture,
	ids,
} from "@/lib/domain/expression/__tests__/formFixture";
import {
	eq,
	literal,
	tableColumn,
	tableLookup,
} from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import {
	type Expression,
	expressionSchema,
} from "@/lib/domain/expression/types";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { evaluateCommit } from "../gate";

const TABLE = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ab");
const COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const LOOKUPS = new Map([[TABLE, new Map([[COLUMN, "text" as const]])]]);
const FILTER = eq(tableColumn(TABLE, COLUMN), literal("active"));

describe("instance reads awaiting their complete emission boundary", () => {
	it.each<{ reason: string; expression: Expression }>([
		{
			reason: "selected-cases",
			expression: { kind: "selected-cases", module: ids.module },
		},
		{
			reason: "cases",
			expression: { kind: "cases", source: "search-results", where: [] },
		},
		{
			reason: "itext",
			expression: {
				kind: "itext",
				unit: { field: ids.text, role: "field-label" },
			},
		},
		{
			reason: "choice-name",
			expression: {
				kind: "choice-name",
				field: ids.choice,
				value: { kind: "term", term: { kind: "literal", value: "yes" } },
			},
		},
		{
			reason: "table-rows",
			expression: {
				kind: "count",
				via: { kind: "table-rows", tableId: TABLE, where: [] },
			},
		},
		{
			reason: "table-lookup",
			expression: tableLookup(TABLE, COLUMN, FILTER),
		},
		{
			reason: "locations",
			expression: {
				kind: "project",
				of: { kind: "locations", where: [] },
				value: {
					kind: "location-field",
					field: { property: testUuid("unavailable-place-property") },
				},
			},
		},
		{
			reason: "table-column",
			expression: { kind: "term", term: tableColumn(TABLE, COLUMN) },
		},
		{
			reason: "location-level",
			expression: {
				kind: "term",
				term: {
					kind: "location-level",
					levelUuid: testUuid("unavailable-place-level"),
				},
			},
		},
	])(
		"refuses $reason in a saved form slot before export",
		({ expression, reason }) => {
			expect(expressionSchema.safeParse(expression).success).toBe(true);
			const doc = formFixture();
			const field = doc.fields[ids.hidden];
			if (field.kind !== "hidden")
				throw new Error("The calculated fixture is missing.");
			field.calculate = expression;
			const candidate = structuredClone(doc);
			const ctx = slotContext(
				candidate,
				{ entity: "field", uuid: ids.hidden, slot: "calculate" },
				LOOKUPS,
			);
			if (ctx === undefined) throw new Error("The calculated slot is missing.");
			expect(checkExpression(expression, ctx).errors).toContainEqual(
				expect.objectContaining({ code: "arm-unavailable", reason }),
			);
			expect(
				evaluateCommit({
					nextDoc: candidate,
					lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
				}).ok,
			).toBe(false);
		},
	);
	it("keeps the existing record lookup and form lookup-choice filter", () => {
		const doc = formFixture();
		const choice = doc.fields[ids.choice];
		if (choice.kind !== "single_select")
			throw new Error("The choice fixture is missing.");
		choice.optionsSource = {
			kind: "lookup",
			tableId: TABLE,
			valueColumnId: COLUMN,
			labelColumnId: COLUMN,
			filter: FILTER,
		};
		const choiceCtx = slotContext(
			doc,
			{ entity: "field", uuid: ids.choice, slot: "lookup_options_source" },
			LOOKUPS,
		);
		const recordCtx = slotContext(
			doc,
			{ entity: "module", uuid: ids.module, slot: "case_list_filter" },
			LOOKUPS,
		);
		if (choiceCtx === undefined || recordCtx === undefined)
			throw new Error("The existing record slots are missing.");
		expect(checkExpression(FILTER, choiceCtx).errors).toEqual([]);
		expect(
			checkExpression(
				eq(tableLookup(TABLE, COLUMN, FILTER), literal("active")),
				recordCtx,
			).errors,
		).toEqual([]);
	});
});
