import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type LookupColumnId,
	type LookupOptionsSource,
	type LookupTableId,
	lookupOptionsSourceSchema,
} from "@/lib/domain";
import {
	carrierBlindPredicateSchema,
	carrierBlindTermSchema,
	carrierBlindValueExpressionSchema,
	checkPredicate,
	checkValueExpression,
	eq,
	isBlank,
	isNull,
	literal,
	matchAll,
	type Predicate,
	predicateSchema,
	simplifyForEmission,
	tableColumn,
	tableLookup,
	termSchema,
	valueExpressionSchema,
	walkExpressionTerms,
} from "@/lib/domain/predicate";

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const OTHER_TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ac" as LookupTableId;
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LABEL_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;
const MISSING_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890af" as LookupColumnId;

const columns = new Map([
	[VALUE_COLUMN, "int" as const],
	[LABEL_COLUMN, "text" as const],
]);

const context = {
	caseTypes: [],
	knownInputs: [],
	lookupTables: new Map([[TABLE, columns]]),
};

const rowScope = {
	...context,
	tableScope: { tableId: TABLE, columns },
};

describe("lookup carrier schemas", () => {
	it("parses stable table and column identities without dropping the filter", () => {
		const filter = eq(tableColumn(TABLE, LABEL_COLUMN), literal("Enabled"));
		const source: LookupOptionsSource = {
			kind: "lookup-table",
			tableId: TABLE,
			valueColumnId: VALUE_COLUMN,
			labelColumnId: LABEL_COLUMN,
			filter,
		};

		expect(lookupOptionsSourceSchema.parse(source)).toEqual(source);
		expect(termSchema.parse(tableColumn(TABLE, VALUE_COLUMN))).toEqual(
			tableColumn(TABLE, VALUE_COLUMN),
		);
		expect(
			valueExpressionSchema.parse(tableLookup(TABLE, VALUE_COLUMN, filter)),
		).toEqual(tableLookup(TABLE, VALUE_COLUMN, filter));
	});

	it("keeps every lookup-bearing recursive schema JSON-schema representable", () => {
		for (const schema of [
			lookupOptionsSourceSchema,
			termSchema,
			predicateSchema,
			valueExpressionSchema,
		]) {
			expect(() => z.toJSONSchema(schema)).not.toThrow();
		}
	});

	it("keeps the rolling family structurally carrier-blind at every depth", () => {
		const tableColumnPredicate = {
			kind: "not",
			clause: {
				kind: "eq",
				left: {
					kind: "if",
					cond: { kind: "match-all" },
					// biome-ignore lint/suspicious/noThenProperty: this is the canonical non-callable ValueExpression branch slot.
					then: { kind: "term", term: { kind: "literal", value: "safe" } },
					else: {
						kind: "term",
						term: {
							kind: "table-column",
							tableId: TABLE,
							columnId: VALUE_COLUMN,
						},
					},
				},
				right: { kind: "term", term: { kind: "literal", value: "safe" } },
			},
		};
		const tableLookupExpression = {
			kind: "coalesce",
			values: [
				{
					kind: "if",
					cond: { kind: "match-all" },
					// biome-ignore lint/suspicious/noThenProperty: this is the canonical non-callable ValueExpression branch slot.
					then: {
						kind: "table-lookup",
						tableId: TABLE,
						resultColumnId: VALUE_COLUMN,
						where: { kind: "match-all" },
					},
					else: { kind: "term", term: { kind: "literal", value: null } },
				},
			],
		};

		expect(predicateSchema.safeParse(tableColumnPredicate).success).toBe(true);
		expect(valueExpressionSchema.safeParse(tableLookupExpression).success).toBe(
			true,
		);
		expect(
			carrierBlindPredicateSchema.safeParse(tableColumnPredicate).success,
		).toBe(false);
		expect(
			carrierBlindValueExpressionSchema.safeParse(tableLookupExpression)
				.success,
		).toBe(false);
		expect(
			carrierBlindTermSchema.safeParse({
				kind: "table-column",
				tableId: TABLE,
				columnId: VALUE_COLUMN,
			}).success,
		).toBe(false);
	});

	it("omits dormant discriminators from the rolling JSON grammar", () => {
		for (const schema of [
			carrierBlindTermSchema,
			carrierBlindPredicateSchema,
			carrierBlindValueExpressionSchema,
		]) {
			const grammar = JSON.stringify(z.toJSONSchema(schema));
			expect(grammar).not.toContain("table-column");
			expect(grammar).not.toContain("table-lookup");
		}
	});
});

describe("lookup carrier type checking", () => {
	it("resolves a result column and same-table filter columns", () => {
		const expression = tableLookup(
			TABLE,
			VALUE_COLUMN,
			eq(tableColumn(TABLE, LABEL_COLUMN), literal("Enabled")),
		);

		expect(checkValueExpression(expression, context, "int")).toEqual({
			ok: true,
		});
	});

	it("rejects unavailable result columns and out-of-scope table columns", () => {
		const missing = checkValueExpression(
			tableLookup(TABLE, MISSING_COLUMN, matchAll()),
			context,
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "unknown-lookup-column",
						path: ["table-lookup", "resultColumnId"],
					}),
				]),
			);
		}

		const outside = checkPredicate(
			eq(tableColumn(TABLE, VALUE_COLUMN), literal(1)),
			context,
		);
		expect(outside.ok).toBe(false);
		if (!outside.ok) {
			expect(outside.errors.map((error) => error.code)).toContain(
				"lookup-table-scope",
			);
		}

		const otherTable = checkPredicate(
			eq(tableColumn(OTHER_TABLE, VALUE_COLUMN), literal(1)),
			rowScope,
		);
		expect(otherTable.ok).toBe(false);
		if (!otherTable.ok) {
			expect(otherTable.errors.map((error) => error.code)).toContain(
				"lookup-table-scope",
			);
		}
	});

	it("allows is-blank but rejects is-null for a table column", () => {
		expect(
			checkPredicate(isBlank(tableColumn(TABLE, LABEL_COLUMN)), rowScope),
		).toEqual({ ok: true });

		const strictAbsence = checkPredicate(
			isNull(tableColumn(TABLE, LABEL_COLUMN)),
			rowScope,
		);
		expect(strictAbsence.ok).toBe(false);
		if (!strictAbsence.ok) {
			expect(strictAbsence.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "runtime-value",
						path: ["left"],
					}),
				]),
			);
		}
	});

	it("rejects a nested table lookup while a lookup row is in scope", () => {
		const nested = tableLookup(
			TABLE,
			VALUE_COLUMN,
			eq(
				tableColumn(TABLE, LABEL_COLUMN),
				tableLookup(TABLE, LABEL_COLUMN, matchAll()),
			),
		);
		const result = checkValueExpression(nested, context);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "lookup-table-scope",
						path: ["table-lookup", "where", "right", "table-lookup"],
					}),
				]),
			);
		}
	});
});

describe("lookup carrier structural walks", () => {
	it("walks table-column terms inside a table lookup", () => {
		const expression = tableLookup(
			TABLE,
			VALUE_COLUMN,
			eq(tableColumn(TABLE, LABEL_COLUMN), literal("Enabled")),
		);
		const kinds: string[] = [];

		walkExpressionTerms(expression, (value) => kinds.push(value.kind));

		expect(kinds).toEqual(["table-column", "literal"]);
	});

	it("simplifies the table lookup's nested predicate", () => {
		const comparison = eq(tableColumn(TABLE, LABEL_COLUMN), literal("Enabled"));
		const unsimplifiedWhere: Predicate = {
			kind: "and",
			clauses: [matchAll(), comparison],
		};
		const predicate = eq(
			tableLookup(TABLE, VALUE_COLUMN, unsimplifiedWhere),
			literal(1),
		);

		const simplified = simplifyForEmission(predicate);
		expect(simplified.kind).toBe("eq");
		if (simplified.kind !== "eq" || simplified.left.kind !== "table-lookup") {
			throw new Error("fixture: expected a table lookup comparison");
		}
		expect(simplified.left.where).toEqual(comparison);
	});
});
