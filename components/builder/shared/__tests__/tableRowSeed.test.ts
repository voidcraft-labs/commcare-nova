import { describe, expect, it } from "vitest";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import {
	firstConditionSeed,
	hasConditionSeed,
} from "@/components/builder/shared/conditionSeed";
import {
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
	predicateUnavailableReason,
} from "@/components/builder/shared/editorSchemas";
import { buildEditorTypeContext } from "@/components/builder/shared/editorTypeContext";
import { expressionCardSchemas } from "@/components/builder/shared/expressionEditorSchemas";
import { defaultExpressionForSlot } from "@/components/builder/shared/primitives/ExpressionPicker";
import type { LookupColumnId, LookupTableId } from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	checkPredicate,
	eq,
	literal,
	predicateSchema,
	tableColumn,
	term,
} from "@/lib/domain/predicate";

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const OTHER_TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ac" as LookupTableId;
const CODE = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const NAME = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;

const COLUMNS = [
	{
		id: CODE,
		wireName: "code",
		label: "Code",
		dataType: "int" as const,
	},
	{
		id: NAME,
		wireName: "name",
		label: "Name",
		dataType: "text" as const,
	},
] as const;

const TABLE_ROW_CONTEXT: PredicateEditContext = {
	caseTypes: [],
	currentCaseType: "",
	knownInputs: [],
	caseDataScope: "table-row",
	lookupTables: [
		{
			id: TABLE,
			name: "Facilities",
			columns: COLUMNS,
		},
	],
	tableScope: {
		tableId: TABLE,
		columns: COLUMNS,
	},
};

describe("table-row comparison seeds", () => {
	it("starts from the active table's first column UUID with a type-correct literal", () => {
		const seed = firstComparisonDefault(TABLE_ROW_CONTEXT);
		expect(seed).toEqual(eq(tableColumn(TABLE, CODE), literal(0)));

		const verdict = checkPredicate(
			seed,
			buildEditorTypeContext(TABLE_ROW_CONTEXT),
		);
		expect(verdict.ok).toBe(true);
	});

	it("makes every offered condition's exact default schema-valid and checker-valid", () => {
		const typeContext = buildEditorTypeContext(TABLE_ROW_CONTEXT);
		const offered = predicateCardSchemaList.filter((schema) =>
			schema.applicable(TABLE_ROW_CONTEXT),
		);

		expect(offered.map((schema) => schema.kind)).toEqual([
			"eq",
			"neq",
			"lt",
			"lte",
			"gt",
			"gte",
			"in",
			"between",
			"is-blank",
			"match-all",
			"match-none",
			"and",
			"or",
			"not",
		]);
		for (const schema of offered) {
			const seed = schema.defaultValue(TABLE_ROW_CONTEXT);
			expect(predicateSchema.safeParse(seed), schema.kind).toMatchObject({
				success: true,
			});
			expect(checkPredicate(seed, typeContext), schema.kind).toMatchObject({
				ok: true,
			});
		}
	});

	it("keeps property- and relation-only conditions unavailable in a table row", () => {
		for (const kind of [
			"match",
			"multi-select-contains",
			"within-distance",
			"exists",
			"missing",
		] as const) {
			expect(predicateCardSchemas[kind].applicable(TABLE_ROW_CONTEXT)).toBe(
				false,
			);
			expect(predicateUnavailableReason(kind, TABLE_ROW_CONTEXT)).toBe(
				"This condition requires case information and isn't available in a data-table row rule",
			);
		}
	});

	it("seeds membership, range, and blank checks from the active column UUID", () => {
		expect(predicateCardSchemas.in.defaultValue(TABLE_ROW_CONTEXT)).toEqual({
			kind: "in",
			left: term(tableColumn(TABLE, CODE)),
			values: [literal(0)],
		});
		expect(
			predicateCardSchemas.between.defaultValue(TABLE_ROW_CONTEXT),
		).toEqual({
			kind: "between",
			left: term(tableColumn(TABLE, CODE)),
			lower: term(literal(0)),
			upper: term(literal(0)),
			lowerInclusive: true,
			upperInclusive: true,
		});
		expect(
			predicateCardSchemas["is-blank"].defaultValue(TABLE_ROW_CONTEXT),
		).toEqual({
			kind: "is-blank",
			left: term(tableColumn(TABLE, CODE)),
		});
	});

	it("seeds a subject term from an admitted active-table column", () => {
		expect(
			defaultExpressionForSlot(
				expressionCardSchemas.term,
				TABLE_ROW_CONTEXT,
				ANY_CONSTRAINT,
				"subject",
			),
		).toEqual(term(tableColumn(TABLE, CODE)));
	});

	it("explains when the active table has no ordered column", () => {
		const textOnly: PredicateEditContext = {
			...TABLE_ROW_CONTEXT,
			lookupTables: [
				{
					id: TABLE,
					name: "Facilities",
					columns: [COLUMNS[1]],
				},
			],
			tableScope: { tableId: TABLE, columns: [COLUMNS[1]] },
		};

		expect(predicateCardSchemas.between.applicable(textOnly)).toBe(false);
		expect(predicateUnavailableReason("between", textOnly)).toBe(
			"Add a number, date, or time data-table column first",
		);
	});

	it("admits the same table/column pair and rejects the same column UUID under another table", () => {
		const typeContext = buildEditorTypeContext(TABLE_ROW_CONTEXT);
		expect(
			checkPredicate(eq(tableColumn(TABLE, CODE), literal(0)), typeContext).ok,
		).toBe(true);
		expect(
			checkPredicate(
				eq(tableColumn(OTHER_TABLE, CODE), literal(0)),
				typeContext,
			).ok,
		).toBe(false);
	});

	it("makes the gesture unavailable when the active table has no columns", () => {
		const empty: PredicateEditContext = {
			...TABLE_ROW_CONTEXT,
			lookupTables: [{ id: TABLE, name: "Empty", columns: [] }],
			tableScope: { tableId: TABLE, columns: [] },
		};

		expect(predicateCardSchemas.eq.applicable(empty)).toBe(false);
		expect(predicateUnavailableReason("eq", empty)).toBe(
			"Add a data-table column first",
		);
		expect(hasConditionSeed(empty)).toBe(false);
		expect(firstConditionSeed(empty)).toBeUndefined();
		expect(() => firstComparisonDefault(empty)).toThrow(
			"requires one admitted active-table column",
		);
	});
});
