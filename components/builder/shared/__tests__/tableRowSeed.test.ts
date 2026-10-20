import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
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
import { editorExpressionContext } from "@/components/builder/shared/editorTypeContext";
import { expressionCardSchemas } from "@/components/builder/shared/expressionEditorSchemas";
import { defaultExpressionForSlot } from "@/components/builder/shared/primitives/ExpressionPicker";
import { lookupColumnIdSchema, lookupTableIdSchema } from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	checkExpression,
	eq,
	expressionSchema,
	literal,
	tableColumn,
	term,
} from "@/lib/domain/expression";

const TABLE = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ab");
const OTHER_TABLE = lookupTableIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ac",
);
const CODE = lookupColumnIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ad");
const NAME = lookupColumnIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ae");

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

const TABLE_ROW_CONTEXT: PredicateEditContext = expressionEditorFixture(
	"table-filter",
	{
		caseTypes: [],
		currentCaseType: "",
		knownInputs: [],
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
	},
).context;

describe("table-row comparison seeds", () => {
	it("starts from the active table's first column UUID with a type-correct literal", () => {
		const seed = firstComparisonDefault(TABLE_ROW_CONTEXT);
		expect(seed).toEqual(eq(tableColumn(TABLE, CODE), literal(0)));

		const verdict = checkExpression(
			seed,
			editorExpressionContext(TABLE_ROW_CONTEXT),
		);
		expect(verdict.errors.length === 0).toBe(true);
	});

	it("makes every offered condition's exact default schema-valid and checker-valid", () => {
		const typeContext = editorExpressionContext(TABLE_ROW_CONTEXT);
		const offered = predicateCardSchemaList.filter((schema) =>
			schema.applicable(TABLE_ROW_CONTEXT),
		);

		expect(offered.length).toBeGreaterThan(0);
		for (const schema of offered) {
			const seed = schema.defaultValue(TABLE_ROW_CONTEXT);
			expect(expressionSchema.safeParse(seed), schema.kind).toMatchObject({
				success: true,
			});
			expect(checkExpression(seed, typeContext), schema.kind).toMatchObject({
				errors: [],
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
			"Add a number or date data-table column first",
		);
	});

	it("admits the same table/column pair and rejects the same column UUID under another table", () => {
		const typeContext = editorExpressionContext(TABLE_ROW_CONTEXT);
		expect(
			checkExpression(eq(tableColumn(TABLE, CODE), literal(0)), typeContext)
				.errors.length === 0,
		).toBe(true);
		expect(
			checkExpression(
				eq(tableColumn(OTHER_TABLE, CODE), literal(0)),
				typeContext,
			).errors.length === 0,
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
