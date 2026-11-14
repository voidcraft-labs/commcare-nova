/**
 * Each row of `PRINT_COLLISIONS` holds two trees that print the same bytes
 * in a real slot, so the canonical tree hides no difference a runtime reads;
 * and `canonicalExpression` gives the row's canonical tree for the other.
 * `date-coerce` of a sum's floor is no such pair with `date-add`: the
 * emitter reads a `date()` operand that may hold date-and-time text through
 * the device's own date (`instant.ts::deviceInstantText`), and `date-add`
 * prints its sum bare, so the two print apart and the table holds no row
 * for them. Nor is a session value's own count guard built as an `if`
 * with the bare read: the emitter guards the read inside it again, so the
 * two print apart.
 *
 * The failures this holds: a row whose two trees print different bytes, a
 * row that does not rewrite to its canonical tree, and a slot the filter
 * projection simplifies printing otherwise with a boolean identity than
 * without.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { calculatedColumn } from "@/lib/domain/modules";
import { canonicalExpression } from "../canonical";
import { printSlot } from "../readExpression";
import { fieldNamed, readEnv } from "./expressionReadFixture";

const COLUMN = testUuid("collision-column");

function doc() {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "dob", label: "Date of birth", data_type: "date" },
					{ name: "p", label: "P" },
					{ name: "seen", label: "Seen", data_type: "datetime" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						calculatedColumn(COLUMN, "Calc", {
							kind: "term",
							term: { kind: "literal", value: "" },
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "text", id: "q2", label: "Q2" }),
						],
					},
				],
			},
		],
	});
}

const lit = (value: string | number): Expression => ({
	kind: "term",
	term: { kind: "literal", value },
});
const prop = (property: string): Expression => ({
	kind: "term",
	term: { kind: "prop", caseType: "patient", property },
});

describe("every print collision prints one text and canonicalizes to its row's tree", () => {
	const app = doc();
	const moduleUuid = app.moduleOrder[0] as (typeof app.moduleOrder)[number];
	const filter: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "case_list_filter",
	};
	const column: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "case_list_column_expression",
		member: { columnUuid: COLUMN },
	};
	const q1 = fieldNamed(app, "q1");
	const relevant: SlotContextRef = {
		entity: "field",
		uuid: q1,
		slot: "relevant",
	};
	const q1Read: Expression = {
		kind: "term",
		term: { kind: "field", uuid: q1 },
	};
	const q2Default: SlotContextRef = {
		entity: "field",
		uuid: fieldNamed(app, "q2"),
		slot: "default_value",
	};
	const q1Is = (value: string): Expression => ({
		kind: "eq",
		left: q1Read,
		right: lit(value),
	});
	const rows: readonly {
		readonly id: string;
		readonly slot: SlotContextRef;
		readonly other: Expression;
		readonly canonical: Expression;
	}[] = [
		{
			id: "membership",
			slot: filter,
			other: {
				kind: "or",
				clauses: [
					{ kind: "eq", left: prop("p"), right: lit("a") },
					{ kind: "eq", left: prop("p"), right: lit("b") },
				],
			},
			canonical: {
				kind: "in",
				left: prop("p"),
				values: [
					{ kind: "literal", value: "a" },
					{ kind: "literal", value: "b" },
				],
			},
		},
		{
			id: "range",
			slot: filter,
			other: {
				kind: "and",
				clauses: [
					{ kind: "gte", left: prop("age"), right: lit(1) },
					{ kind: "lt", left: prop("age"), right: lit(5) },
				],
			},
			canonical: {
				kind: "between",
				left: prop("age"),
				lower: lit(1),
				upper: lit(5),
				lowerInclusive: true,
				upperInclusive: false,
			},
		},
		{
			id: "switch",
			slot: column,
			other: {
				kind: "if",
				cond: { kind: "eq", left: prop("p"), right: lit("a") },
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: lit("x"),
				else: {
					kind: "if",
					cond: { kind: "eq", left: prop("p"), right: lit("b") },
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					then: lit("y"),
					else: lit("z"),
				},
			},
			canonical: {
				kind: "switch",
				on: prop("p"),
				cases: [
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					{ when: { kind: "literal", value: "a" }, then: lit("x") },
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					{ when: { kind: "literal", value: "b" }, then: lit("y") },
				],
				fallback: lit("z"),
			},
		},
		{
			id: "blank",
			slot: relevant,
			other: {
				kind: "eq",
				left: {
					kind: "call",
					fn: "string-length",
					args: [{ kind: "call", fn: "string", args: [q1Read] }],
				},
				right: lit(0),
			},
			canonical: { kind: "is-blank", left: q1Read },
		},
		{
			id: "normalize-space",
			slot: relevant,
			other: {
				kind: "eq",
				left: {
					kind: "call",
					fn: "replace",
					args: [
						{
							kind: "call",
							fn: "replace",
							args: [q1Read, lit("[ \\t\\r\\n]+"), lit(" ")],
						},
						lit("^ | $"),
						lit(""),
					],
				},
				right: lit("a"),
			},
			canonical: {
				kind: "eq",
				left: { kind: "call", fn: "normalize-space", args: [q1Read] },
				right: lit("a"),
			},
		},
		{
			id: "field-spelling",
			slot: relevant,
			other: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "field", uuid: q1, spelling: "absolute" },
				},
				right: lit("a"),
			},
			canonical: { kind: "eq", left: q1Read, right: lit("a") },
		},
		{
			id: "filter-identities",
			slot: filter,
			other: {
				kind: "and",
				clauses: [
					{ kind: "match-all" },
					{ kind: "eq", left: prop("p"), right: lit("x") },
				],
			},
			canonical: { kind: "eq", left: prop("p"), right: lit("x") },
		},
		{
			id: "literal-type",
			slot: filter,
			other: { kind: "gt", left: prop("dob"), right: lit("2000-01-01") },
			canonical: {
				kind: "gt",
				left: prop("dob"),
				right: {
					kind: "term",
					term: { kind: "literal", value: "2000-01-01", data_type: "date" },
				},
			},
		},
		{
			id: "junction-first-clause",
			slot: relevant,
			other: {
				kind: "and",
				clauses: [{ kind: "and", clauses: [q1Is("a"), q1Is("b")] }, q1Is("c")],
			},
			canonical: { kind: "and", clauses: [q1Is("a"), q1Is("b"), q1Is("c")] },
		},
		{
			id: "literal-pieces",
			slot: filter,
			other: {
				kind: "eq",
				left: prop("p"),
				right: { kind: "concat", parts: [lit("#"), lit("case/x")] },
			},
			canonical: { kind: "eq", left: prop("p"), right: lit("#case/x") },
		},
		{
			id: "quotient",
			slot: column,
			other: {
				kind: "if",
				cond: { kind: "eq", left: lit(2), right: lit(0) },
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: { kind: "arith", op: "div", left: prop("age"), right: lit(2) },
				else: {
					kind: "arith",
					op: "div",
					left: {
						kind: "arith",
						op: "-",
						left: prop("age"),
						right: {
							kind: "arith",
							op: "mod",
							left: prop("age"),
							right: lit(2),
						},
					},
					right: lit(2),
				},
			},
			canonical: {
				kind: "arith",
				op: "quotient",
				left: prop("age"),
				right: lit(2),
			},
		},
		{
			id: "instant-literal",
			slot: filter,
			other: {
				kind: "gt",
				left: prop("seen"),
				right: {
					kind: "term",
					term: {
						kind: "literal",
						value: "2026-01-02T10:00:00+01:00",
						data_type: "datetime",
					},
				},
			},
			canonical: {
				kind: "gt",
				left: prop("seen"),
				right: {
					kind: "term",
					term: {
						kind: "literal",
						value: "2026-01-02T09:00:00.000Z",
						data_type: "datetime",
					},
				},
			},
		},
		{
			id: "default-current",
			slot: q2Default,
			other: q1Read,
			canonical: {
				kind: "term",
				term: { kind: "field", uuid: q1, spelling: "current" },
			},
		},
	];
	for (const row of rows)
		it(row.id, () => {
			const env = readEnv();
			expect(printSlot(app, row.slot, row.other, env)).toBe(
				printSlot(app, row.slot, row.canonical, env),
			);
			const context = slotContext(app, row.slot, new Map());
			if (context === undefined)
				throw new Error("The row's slot is not in the document.");
			expect(canonicalExpression(row.other, context)).toEqual(row.canonical);
			expect(canonicalExpression(row.canonical, context)).toEqual(
				row.canonical,
			);
		});
});
