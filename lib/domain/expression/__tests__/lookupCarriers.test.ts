import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type LookupOptionsSource,
	lookupColumnIdSchema,
	lookupOptionsSourceSchema,
	lookupTableIdSchema,
} from "@/lib/domain";
import {
	conditionSchema,
	type Expression,
	eq,
	isBlank,
	literal,
	matchAll,
	simplifyForEmission,
	tableColumn,
	tableLookup,
	termSchema,
	valueSchema,
	walkExpressionTerms,
} from "@/lib/domain/expression";

import { recordQueryContext } from "../context";
import { inferRecordQuery, typeOf } from "../typeChecker";

type QueryInput = Parameters<typeof recordQueryContext>[0];
function checkCondition(expression: Expression, input: QueryInput) {
	const outcome = inferRecordQuery(
		expression,
		recordQueryContext(input),
		"condition",
	);
	return {
		ok: outcome.errors.length === 0,
		...(outcome.errors.length === 0 ? {} : { errors: outcome.errors }),
	};
}
function checkValue(expression: Expression, input: QueryInput) {
	const outcome = inferRecordQuery(expression, recordQueryContext(input));
	return {
		ok: outcome.errors.length === 0,
		...(outcome.errors.length === 0 ? {} : { errors: outcome.errors }),
	};
}

const TABLE = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ab");
const OTHER_TABLE = lookupTableIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ac",
);
const VALUE_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const LABEL_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ae",
);
const MISSING_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890af",
);

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
	lookupTableId: TABLE,
};

describe("lookup carrier schemas", () => {
	it("parses stable table and column identities without dropping the filter", () => {
		const filter = eq(tableColumn(TABLE, LABEL_COLUMN), literal("Enabled"));
		const source: LookupOptionsSource = {
			kind: "lookup",
			tableId: TABLE,
			valueColumnId: VALUE_COLUMN,
			labelColumnId: LABEL_COLUMN,
			filter,
		};

		expect(lookupOptionsSourceSchema.parse(source)).toEqual(source);
		expect(termSchema.parse(tableColumn(TABLE, VALUE_COLUMN))).toEqual(
			tableColumn(TABLE, VALUE_COLUMN),
		);
		expect(valueSchema.parse(tableLookup(TABLE, VALUE_COLUMN, filter))).toEqual(
			tableLookup(TABLE, VALUE_COLUMN, filter),
		);
	});

	it("rejects lookup table and column slugs from stored expression leaves", () => {
		expect(
			termSchema.safeParse({
				kind: "table-column",
				tableId: "households",
				columnId: VALUE_COLUMN,
			}).success,
		).toBe(false);
		expect(
			valueSchema.safeParse({
				kind: "table-lookup",
				tableId: "households",
				resultColumnId: VALUE_COLUMN,
				where: { kind: "match-all" },
			}).success,
		).toBe(false);
	});

	it("executes converted recursive schemas against lookup payloads", () => {
		const filter = eq(tableColumn(TABLE, LABEL_COLUMN), literal("Enabled"));
		const source = {
			kind: "lookup",
			tableId: TABLE,
			valueColumnId: VALUE_COLUMN,
			labelColumnId: LABEL_COLUMN,
			filter,
		};
		for (const [schema, valid] of [
			[lookupOptionsSourceSchema, source],
			[termSchema, tableColumn(TABLE, VALUE_COLUMN)],
			[conditionSchema, filter],
			[valueSchema, tableLookup(TABLE, VALUE_COLUMN, filter)],
		] as const) {
			const ajv = new Ajv2020({ strict: false });
			addFormats(ajv);
			const validate = ajv.compile(z.toJSONSchema(schema));
			expect(schema.parse(valid)).toStrictEqual(valid);
			expect(validate(valid)).toBe(true);
			expect(validate({ ...valid, unknown: true })).toBe(false);
		}
	});
	it("refuses a column slug beside a valid table identity", () => {
		expect(
			termSchema.safeParse({
				kind: "table-column",
				tableId: TABLE,
				columnId: "district",
			}).success,
		).toBe(false);
		expect(
			valueSchema.safeParse({
				kind: "table-lookup",
				tableId: TABLE,
				resultColumnId: "district",
				where: matchAll(),
			}).success,
		).toBe(false);
	});
});

describe("lookup carrier type checking", () => {
	it("resolves a result column and same-table filter columns", () => {
		const expression = tableLookup(
			TABLE,
			VALUE_COLUMN,
			eq(tableColumn(TABLE, LABEL_COLUMN), literal("Enabled")),
		);

		expect(typeOf(expression, recordQueryContext(context))?.data).toBe("int");
		expect(checkValue(expression, context)).toEqual({
			ok: true,
		});
	});

	it("rejects unavailable result columns and out-of-scope table columns", () => {
		const missing = checkValue(
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

		const outside = checkCondition(
			eq(tableColumn(TABLE, VALUE_COLUMN), literal(1)),
			context,
		);
		expect(outside.ok).toBe(false);
		if (!outside.ok) {
			expect(outside.errors.map((error) => error.code)).toContain(
				"lookup-table-scope",
			);
		}

		const otherTable = checkCondition(
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

	it("allows is-blank for a table column", () => {
		expect(
			checkCondition(isBlank(tableColumn(TABLE, LABEL_COLUMN)), rowScope),
		).toEqual({ ok: true });
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
		const result = checkValue(nested, context);

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
		const unsimplifiedWhere: Expression = {
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
