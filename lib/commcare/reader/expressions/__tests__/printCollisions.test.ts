/**
 * Each row of `PRINT_COLLISIONS` holds two trees that print the same bytes
 * in a real slot, so the canonical tree hides no difference a runtime reads;
 * and `canonicalExpression` gives the row's canonical tree for the other.
 * `date-coerce` of a sum's floor is no such pair with `date-add`: the
 * emitter reads a `date()` operand that may hold date-and-time text through
 * the device's own date (`instant.ts::deviceInstantText`), and `date-add`
 * prints its sum bare, so the two print apart and the table holds no row
 * for them. Nor is a session value's own count guard built as an `if`
 * with the bare read, nor a table's rows guard built as an `if` (in the
 * plain or the handed-on shape) with the value read or the consumer it
 * guards: the emitter guards the read inside it again, so the two print
 * apart, and the `if` reads back as itself.
 *
 * The failures this holds: a row whose two trees print different bytes, a
 * row that does not rewrite to its canonical tree, and a slot the filter
 * projection simplifies printing otherwise with a boolean identity than
 * without, at each site that simplifies: the case list filter, a
 * lookup-backed select's row filter, a table lookup's `where`, the search
 * button's condition in HQ's JSON and in the suite, and a Search field's
 * condition.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { chosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import { slotContext } from "@/lib/domain/expression/context";
import type {
	Expression,
	SlotContextRef,
	Term,
} from "@/lib/domain/expression/types";
import type { CaseOperation } from "@/lib/domain/forms";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	advancedSearchInputDef,
	calculatedColumn,
	simpleSearchInputDef,
} from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import { moduleExpressionContexts } from "../../../expressionContext";
import { lookupWireNaming } from "../../../lookup/naming";
import { searchActionRelevant } from "../../../suite/case-list/shortDetail";
import { composeModuleXPathQueryEmission } from "../../../suite/case-search/moduleXPathQuery";
import { xpathQueryRequestValues } from "../../../suite/case-search/xpathQuery";
import { parseFormExpression } from "../../../xpath/expressionAst";
import { serializeWire } from "../../../xpath/wire/serialize";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import { canonicalExpression } from "../canonical";
import type { ExpressionReadEnv } from "../index";
import {
	lookupTypes,
	printSlot,
	readingScope,
	slotPrint,
} from "../readExpression";
import { fieldNamed, readEnv, registration } from "./expressionReadFixture";

const COLUMN = testUuid("collision-column");
const REGION = testUuid("collision-region");
const VILLAGE = testUuid("collision-village");
const TABLE = "01890000-0000-7000-8000-000000000201" as LookupTableId;
const NAME = "01890000-0000-7000-8000-000000000202" as LookupColumnId;
const WEIGHT = "01890000-0000-7000-8000-000000000203" as LookupColumnId;

function env(): ExpressionReadEnv {
	return readEnv({
		lookup: new Map([
			[
				TABLE,
				{
					id: TABLE,
					name: "Districts",
					tag: "districts",
					columns: [
						{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
						{
							id: WEIGHT,
							wireName: "weight",
							label: "Weight",
							dataType: "int",
						},
					],
				},
			],
		]) as ExpressionReadEnv["lookup"],
	});
}

const lit = (value: string | number): Expression => ({
	kind: "term",
	term: { kind: "literal", value },
});
const term = (one: Term): Expression => ({ kind: "term", term: one });
const prop = (property: string): Expression =>
	term({ kind: "prop", caseType: "patient", property });
const column = (columnId: LookupColumnId): Expression =>
	term({ kind: "table-column", tableId: TABLE, columnId });
const rowsOf = (columnId: LookupColumnId): Expression => ({
	kind: "project",
	of: { kind: "table-rows", tableId: TABLE, where: [] },
	value: { kind: "table-column", tableId: TABLE, columnId },
});
const withIdentity = (clause: Expression): Expression => ({
	kind: "and",
	clauses: [{ kind: "match-all" }, clause],
});

/** The advanced field's condition: the village is what was typed. */
const VILLAGE_IS_REGION: Expression = {
	kind: "when-input-present",
	input: { kind: "input", searchInputUuid: REGION },
	clause: {
		kind: "eq",
		left: prop("p"),
		right: term({ kind: "input", searchInputUuid: REGION }),
	},
};

/** A menu of patients with a calculated column and a search: an advanced
 *  field `region` whose condition is `predicate`, required on a condition,
 *  and a simple field `village`. Its form holds a lookup-backed select, two
 *  dates and times, a Hidden Value and a repeat. */
function doc(predicate: Expression = VILLAGE_IS_REGION): BlueprintDoc {
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
					searchInputs: [
						{
							...advancedSearchInputDef(
								REGION,
								"region",
								"Region",
								"text",
								predicate,
							),
							required: { when: { kind: "match-all" } },
						},
						simpleSearchInputDef(VILLAGE, "village", "Village", "text", "p"),
					],
				},
				caseSearchConfig: {},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "text", id: "q2", label: "Q2" }),
							f({ kind: "datetime", id: "start", label: "Start" }),
							f({ kind: "datetime", id: "end", label: "End" }),
							f({ kind: "hidden", id: "h" }),
							f({
								kind: "single_select",
								id: "pick",
								label: "Pick",
								optionsSource: {
									kind: "lookup",
									tableId: TABLE,
									valueColumnId: NAME,
									labelColumnId: NAME,
								},
							}),
							f({
								kind: "repeat",
								id: "r",
								label: "Rounds",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "text", id: "k", label: "Kind" }),
									f({ kind: "hidden", id: "d" }),
								],
							}),
						],
					},
				],
			},
		],
	});
}

/** `text` bound with no fold offered: the tree an author builds by writing
 *  the print's calls out. */
function plainBind(
	app: BlueprintDoc,
	ref: SlotContextRef,
	text: string,
): Expression {
	const scope = readingScope(
		app,
		registration(app, ref, text),
		env(),
		new Set(),
	);
	if (scope.reading === undefined) throw new Error("No reading hook.");
	const parsed = parseFormExpression(text, {
		...scope,
		reading: { ...scope.reading, fold: () => undefined },
	});
	if (!parsed.ok || parsed.expression === undefined)
		throw new Error(`The print does not bind: ${text}`);
	return parsed.expression;
}

function contextOf(app: BlueprintDoc, ref: SlotContextRef) {
	const context = slotContext(app, ref, lookupTypes(env()));
	if (context === undefined)
		throw new Error("The row's slot is not in the document.");
	return context;
}

describe("every print collision prints one text and canonicalizes to its row's tree", () => {
	const app = doc();
	const moduleUuid = app.moduleOrder[0] as Uuid;
	const filter: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "case_list_filter",
	};
	const calculated: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "case_list_column_expression",
		member: { columnUuid: COLUMN },
	};
	const required: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "search_input_required_when",
		member: { searchInputUuid: REGION },
	};
	const searchButton: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "search_button_display_condition",
	};
	const ref = (
		id: string,
		slot: "calculate" | "relevant" | "default_value" | "lookup_options_source",
	): SlotContextRef =>
		({ entity: "field", uuid: fieldNamed(app, id), slot }) as SlotContextRef;
	const relevant = ref("q1", "relevant");
	const hCalculate = ref("h", "calculate");
	const field = (id: string, spelling?: "current" | "absolute"): Expression =>
		term({
			kind: "field",
			uuid: fieldNamed(app, id),
			...(spelling === undefined ? {} : { spelling }),
		});
	const q1Read = field("q1");
	const q1Is = (value: string): Expression => ({
		kind: "eq",
		left: q1Read,
		right: lit(value),
	});
	const villageAnswer = term({ kind: "input", searchInputUuid: VILLAGE });
	const username = term({ kind: "session-context", field: "username" });
	const usernameIsA: Expression = {
		kind: "eq",
		left: username,
		right: lit("a"),
	};
	const startBeforeEnd: Expression = {
		kind: "lt",
		left: field("start"),
		right: field("end"),
	};
	const seenAfter: Expression = {
		kind: "gt",
		left: prop("seen"),
		right: term({
			kind: "literal",
			value: "2026-01-01T00:00:00.000Z",
			data_type: "datetime",
		}),
	};
	const nameIsQ1: Expression = {
		kind: "eq",
		left: column(NAME),
		right: q1Read,
	};
	const districtOf = (where: Expression): Expression => ({
		kind: "table-lookup",
		tableId: TABLE,
		resultColumnId: NAME,
		where,
	});
	const rows: readonly {
		readonly id: string;
		readonly slot: SlotContextRef;
		readonly other: () => Expression;
		readonly canonical: Expression;
	}[] = [
		// A device alone reads the field's required condition; the case list
		// filter here is restated by the search, whose CSQL prints an `in`
		// in parentheses.
		{
			id: "membership",
			slot: required,
			other: () => ({
				kind: "or",
				clauses: [
					{ kind: "eq", left: villageAnswer, right: lit("a") },
					{ kind: "eq", left: villageAnswer, right: lit("b") },
				],
			}),
			canonical: {
				kind: "in",
				left: villageAnswer,
				values: [
					{ kind: "literal", value: "a" },
					{ kind: "literal", value: "b" },
				],
			},
		},
		{
			id: "membership",
			slot: required,
			other: () => ({
				kind: "or",
				clauses: [
					{ kind: "eq", left: villageAnswer, right: lit(1) },
					{ kind: "eq", left: villageAnswer, right: lit(2) },
				],
			}),
			canonical: {
				kind: "in",
				left: villageAnswer,
				values: [
					{ kind: "literal", value: 1 },
					{ kind: "literal", value: 2 },
				],
			},
		},
		{
			id: "range",
			slot: filter,
			other: () => ({
				kind: "and",
				clauses: [
					{ kind: "gte", left: prop("age"), right: lit(1) },
					{ kind: "lt", left: prop("age"), right: lit(5) },
				],
			}),
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
			slot: calculated,
			other: () => ({
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
			}),
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
			id: "switch",
			slot: calculated,
			other: () => ({
				kind: "if",
				cond: { kind: "eq", left: prop("age"), right: lit(1) },
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: lit("x"),
				else: {
					kind: "if",
					cond: { kind: "eq", left: prop("age"), right: lit(2) },
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					then: lit("y"),
					else: lit("z"),
				},
			}),
			canonical: {
				kind: "switch",
				on: prop("age"),
				cases: [
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					{ when: { kind: "literal", value: 1 }, then: lit("x") },
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					{ when: { kind: "literal", value: 2 }, then: lit("y") },
				],
				fallback: lit("z"),
			},
		},
		{
			id: "one-case-switch",
			slot: calculated,
			other: () => ({
				kind: "switch",
				on: prop("p"),
				cases: [
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					{ when: { kind: "literal", value: "a" }, then: lit("x") },
				],
				fallback: lit("z"),
			}),
			canonical: {
				kind: "if",
				cond: { kind: "eq", left: prop("p"), right: lit("a") },
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: lit("x"),
				else: lit("z"),
			},
		},
		{
			id: "null-literal",
			slot: calculated,
			other: () => ({
				kind: "if",
				cond: {
					kind: "eq",
					left: prop("p"),
					right: term({ kind: "literal", value: null }),
				},
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: lit("x"),
				else: lit("z"),
			}),
			canonical: {
				kind: "if",
				cond: { kind: "eq", left: prop("p"), right: lit("") },
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: lit("x"),
				else: lit("z"),
			},
		},
		{
			id: "blank",
			slot: relevant,
			other: () => ({
				kind: "eq",
				left: {
					kind: "call",
					fn: "string-length",
					args: [{ kind: "call", fn: "string", args: [q1Read] }],
				},
				right: lit(0),
			}),
			canonical: { kind: "is-blank", left: q1Read },
		},
		{
			id: "normalize-space",
			slot: relevant,
			other: () => ({
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
			}),
			canonical: {
				kind: "eq",
				left: { kind: "call", fn: "normalize-space", args: [q1Read] },
				right: lit("a"),
			},
		},
		{
			id: "field-spelling",
			slot: relevant,
			other: () => ({
				kind: "eq",
				left: field("q1", "absolute"),
				right: lit("a"),
			}),
			canonical: { kind: "eq", left: q1Read, right: lit("a") },
		},
		{
			id: "literal-type",
			slot: filter,
			other: () => ({
				kind: "gt",
				left: prop("dob"),
				right: lit("2000-01-01"),
			}),
			canonical: {
				kind: "gt",
				left: prop("dob"),
				right: term({
					kind: "literal",
					value: "2000-01-01",
					data_type: "date",
				}),
			},
		},
		{
			id: "junction-first-clause",
			slot: relevant,
			other: () => ({
				kind: "and",
				clauses: [{ kind: "and", clauses: [q1Is("a"), q1Is("b")] }, q1Is("c")],
			}),
			canonical: { kind: "and", clauses: [q1Is("a"), q1Is("b"), q1Is("c")] },
		},
		{
			id: "literal-pieces",
			slot: filter,
			other: () => ({
				kind: "eq",
				left: prop("p"),
				right: { kind: "concat", parts: [lit("#"), lit("case/x")] },
			}),
			canonical: { kind: "eq", left: prop("p"), right: lit("#case/x") },
		},
		{
			id: "quotient",
			slot: calculated,
			other: () => ({
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
			}),
			canonical: {
				kind: "arith",
				op: "quotient",
				left: prop("age"),
				right: lit(2),
			},
		},
		{
			// A list's filter is restated in its search's CSQL, which prints
			// the literal as written; a calculated column runs on the device
			// alone.
			id: "instant-literal",
			slot: calculated,
			other: () => ({
				kind: "gt",
				left: prop("seen"),
				right: term({
					kind: "literal",
					value: "2026-01-02T10:00:00+01:00",
					data_type: "datetime",
				}),
			}),
			canonical: {
				kind: "gt",
				left: prop("seen"),
				right: term({
					kind: "literal",
					value: "2026-01-02T09:00:00.000Z",
					data_type: "datetime",
				}),
			},
		},
		{
			// A switch's literal result, in a comparison of moments, prints as
			// the literal's own date, clock and offset.
			id: "instant-literal",
			slot: calculated,
			other: () => ({
				kind: "gt",
				left: {
					kind: "switch",
					on: prop("p"),
					cases: [
						{
							when: { kind: "literal", value: "a" },
							// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
							then: term({
								kind: "literal",
								value: "2026-01-02T10:00:00+01:00",
								data_type: "datetime",
							}),
						},
						{
							when: { kind: "literal", value: "b" },
							// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
							then: prop("seen"),
						},
					],
					fallback: prop("seen"),
				},
				right: prop("seen"),
			}),
			canonical: {
				kind: "gt",
				left: {
					kind: "switch",
					on: prop("p"),
					cases: [
						{
							when: { kind: "literal", value: "a" },
							// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
							then: term({
								kind: "literal",
								value: "2026-01-02T10:00:00.000+01:00",
								data_type: "datetime",
							}),
						},
						{
							when: { kind: "literal", value: "b" },
							// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
							then: prop("seen"),
						},
					],
					fallback: prop("seen"),
				},
				right: prop("seen"),
			},
		},
		{
			// A branch beside a date and time takes the literal typed.
			id: "coerced-instant-literal",
			slot: calculated,
			other: () => ({
				kind: "coalesce",
				values: [
					prop("seen"),
					{ kind: "datetime-coerce", value: lit("2026-01-01") },
				],
			}),
			canonical: {
				kind: "coalesce",
				values: [
					prop("seen"),
					term({
						kind: "literal",
						value: "2026-01-01T00:00:00.000Z",
						data_type: "datetime",
					}),
				],
			},
		},
		{
			// A column's whole value is read as text.
			id: "coerced-instant-literal",
			slot: calculated,
			other: () => ({ kind: "datetime-coerce", value: lit("2026-01-01") }),
			canonical: lit("2026-01-01T00:00:00.000Z"),
		},
		{
			// A typed literal as a column's whole value prints its text.
			id: "untyped-value-literal",
			slot: calculated,
			other: () =>
				term({
					kind: "literal",
					value: "2026-01-01T00:00:00Z",
					data_type: "datetime",
				}),
			canonical: lit("2026-01-01T00:00:00Z"),
		},
		{
			// Branches that are all literals have no branch beside them that
			// gives their type.
			id: "untyped-value-literal",
			slot: calculated,
			other: () => ({
				kind: "coalesce",
				values: [
					term({
						kind: "literal",
						value: "2026-01-01T00:00:00Z",
						data_type: "datetime",
					}),
					{ kind: "datetime-coerce", value: lit("2026-02-01") },
				],
			}),
			canonical: {
				kind: "coalesce",
				values: [lit("2026-01-01T00:00:00Z"), lit("2026-02-01T00:00:00.000Z")],
			},
		},
		{
			// A branch node inside one whose other branch is a date and time
			// keeps its literals typed.
			id: "untyped-value-literal",
			slot: calculated,
			other: () => ({
				kind: "coalesce",
				values: [
					prop("seen"),
					{
						kind: "coalesce",
						values: [
							term({
								kind: "literal",
								value: "2026-01-01T00:00:00Z",
								data_type: "datetime",
							}),
							{ kind: "datetime-coerce", value: lit("2026-02-01") },
						],
					},
				],
			}),
			canonical: {
				kind: "coalesce",
				values: [
					prop("seen"),
					{
						kind: "coalesce",
						values: [
							term({
								kind: "literal",
								value: "2026-01-01T00:00:00Z",
								data_type: "datetime",
							}),
							term({
								kind: "literal",
								value: "2026-02-01T00:00:00.000Z",
								data_type: "datetime",
							}),
						],
					},
				],
			},
		},
		{
			// A comparison of moments folds both to one count of microseconds,
			// and the reader gives the moment's canonical text.
			id: "coerced-instant-literal",
			slot: calculated,
			other: () => ({
				kind: "gt",
				left: prop("seen"),
				right: { kind: "datetime-coerce", value: lit("2026-01-01") },
			}),
			canonical: {
				kind: "gt",
				left: prop("seen"),
				right: term({
					kind: "literal",
					value: "2026-01-01T00:00:00.000Z",
					data_type: "datetime",
				}),
			},
		},
		{
			id: "default-current",
			slot: ref("q2", "default_value"),
			other: () => q1Read,
			canonical: field("q1", "current"),
		},
		{
			id: "row-predicate-current",
			slot: ref("d", "calculate"),
			other: () => ({
				kind: "count",
				via: {
					kind: "table-rows",
					tableId: TABLE,
					where: [{ kind: "eq", left: column(NAME), right: field("k") }],
				},
			}),
			canonical: {
				kind: "count",
				via: {
					kind: "table-rows",
					tableId: TABLE,
					where: [
						{ kind: "eq", left: column(NAME), right: field("k", "current") },
					],
				},
			},
		},
		{
			id: "consumer-in-branches",
			slot: hCalculate,
			other: () => ({
				kind: "call",
				fn: "sum",
				args: [
					{
						kind: "if",
						cond: q1Is("a"),
						// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
						then: rowsOf(WEIGHT),
						else: rowsOf(NAME),
					},
				],
			}),
			canonical: {
				kind: "if",
				cond: q1Is("a"),
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: { kind: "call", fn: "sum", args: [rowsOf(WEIGHT)] },
				else: { kind: "call", fn: "sum", args: [rowsOf(NAME)] },
			},
		},
		{
			id: "input-presence",
			slot: required,
			other: () => ({
				kind: "if",
				cond: { kind: "count", via: villageAnswer },
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: { kind: "eq", left: villageAnswer, right: lit("x") },
				else: { kind: "match-all" },
			}),
			canonical: {
				kind: "when-input-present",
				input: { kind: "input", searchInputUuid: VILLAGE },
				clause: { kind: "eq", left: villageAnswer, right: lit("x") },
			},
		},
		{
			id: "own-case",
			slot: relevant,
			other: () => ({
				kind: "gt",
				left: chosenCaseProperty(moduleUuid, "patient", "age"),
				right: lit(5),
			}),
			canonical: {
				kind: "gt",
				left: term({ kind: "form-case", caseType: "patient", property: "age" }),
				right: lit(5),
			},
		},
		{
			id: "worker-record",
			slot: relevant,
			other: () => ({
				kind: "eq",
				left: {
					kind: "project",
					of: {
						kind: "cases",
						source: "casedb",
						where: [
							{
								kind: "eq",
								left: term({ kind: "case-row-type" }),
								right: term({ kind: "case-type", caseType: "commcare-user" }),
							},
							{
								kind: "eq",
								left: term({
									kind: "prop",
									caseType: "commcare-user",
									property: "hq_user_id",
								}),
								right: term({ kind: "session-context", field: "userid" }),
							},
						],
					},
					value: { kind: "prop", caseType: "commcare-user", property: "role" },
				},
				right: lit("chw"),
			}),
			canonical: {
				kind: "eq",
				left: term({
					kind: "session-user",
					field: "role",
					source: "worker-record",
				}),
				right: lit("chw"),
			},
		},
		{
			id: "instant",
			slot: relevant,
			other: () =>
				plainBind(
					app,
					relevant,
					printSlot(app, relevant, startBeforeEnd, env()),
				),
			canonical: startBeforeEnd,
		},
		{
			id: "instant",
			slot: filter,
			other: () =>
				plainBind(app, filter, printSlot(app, filter, seenAfter, env())),
			canonical: seenAfter,
		},
		{
			id: "filter-identities",
			slot: filter,
			other: () =>
				withIdentity({ kind: "eq", left: prop("p"), right: lit("x") }),
			canonical: { kind: "eq", left: prop("p"), right: lit("x") },
		},
		{
			id: "filter-identities",
			slot: ref("pick", "lookup_options_source"),
			other: () => withIdentity(nameIsQ1),
			canonical: nameIsQ1,
		},
		{
			id: "filter-identities",
			slot: hCalculate,
			other: () => districtOf(withIdentity(nameIsQ1)),
			canonical: districtOf(nameIsQ1),
		},
		{
			id: "filter-identities",
			slot: searchButton,
			other: () => withIdentity(usernameIsA),
			canonical: usernameIsA,
		},
	];
	for (const row of rows)
		it(`${row.id} in ${row.slot.slot}`, () => {
			const readEnvironment = env();
			const other = row.other();
			expect(printSlot(app, row.slot, other, readEnvironment)).toBe(
				printSlot(app, row.slot, row.canonical, readEnvironment),
			);
			const context = contextOf(app, row.slot);
			expect(canonicalExpression(other, context)).toEqual(row.canonical);
			expect(canonicalExpression(row.canonical, context)).toEqual(
				row.canonical,
			);
		});

	it("membership leaves an `or` of equalities in a list filter the search restates, whose CSQL prints it without the parentheses of an `in`", () => {
		const either: Expression = {
			kind: "or",
			clauses: [
				{ kind: "eq", left: prop("p"), right: lit("a") },
				{ kind: "eq", left: prop("p"), right: lit("b") },
			],
		};
		expect(canonicalExpression(either, contextOf(app, filter))).toEqual(either);
	});

	it("quotient leaves an `if` whose remainder or divisor is another operand", () => {
		const age = prop("age");
		const quotientOf = (
			modLeft: Expression,
			modRight: Expression,
			divisor: Expression,
		): Expression => ({
			kind: "if",
			cond: { kind: "eq", left: lit(2), right: lit(0) },
			// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
			then: { kind: "arith", op: "div", left: age, right: lit(2) },
			else: {
				kind: "arith",
				op: "div",
				left: {
					kind: "arith",
					op: "-",
					left: age,
					right: { kind: "arith", op: "mod", left: modLeft, right: modRight },
				},
				right: divisor,
			},
		});
		const context = contextOf(app, calculated);
		const quotient = printSlot(
			app,
			calculated,
			{ kind: "arith", op: "quotient", left: age, right: lit(2) },
			env(),
		);
		for (const other of [
			quotientOf(age, lit(2), lit(3)),
			quotientOf(prop("p"), lit(2), lit(2)),
			quotientOf(age, lit(3), lit(2)),
		]) {
			expect(printSlot(app, calculated, other, env())).not.toBe(quotient);
			expect(canonicalExpression(other, context)).toEqual(other);
		}
	});

	it("literal-pieces leaves a `concat` of one part that prints around it, and takes one of a literal that prints as its own pieces", () => {
		const context = contextOf(app, filter);
		const of = (part: Expression): Expression => ({
			kind: "eq",
			left: prop("p"),
			right: { kind: "concat", parts: [part] },
		});
		const bare = (part: Expression): Expression => ({
			kind: "eq",
			left: prop("p"),
			right: part,
		});
		// A read, and a literal of one piece, print `concat(…)` around them.
		for (const part of [prop("q"), lit("abc")]) {
			expect(printSlot(app, filter, of(part), env())).not.toBe(
				printSlot(app, filter, bare(part), env()),
			);
			expect(canonicalExpression(of(part), context)).toEqual(of(part));
		}
		// A literal HQ's interpolation would read prints as the `concat` of its
		// pieces alone and inside one.
		const pieces = lit("#case/x");
		expect(printSlot(app, filter, of(pieces), env())).toBe(
			printSlot(app, filter, bare(pieces), env()),
		);
		expect(canonicalExpression(of(pieces), context)).toEqual(bare(pieces));
	});

	it("filter-identities in the search button's suite condition", () => {
		const expressions = moduleExpressionContexts(
			app,
			moduleUuid,
			lookupWireNaming([]),
		);
		const suite = (expression: Expression) =>
			serializeWire(searchActionRelevant(expression, expressions, undefined), {
				target: "suite",
			}).text;
		expect(suite(withIdentity(usernameIsA))).toBe(suite(usernameIsA));
		expect(
			canonicalExpression(
				withIdentity(usernameIsA),
				contextOf(app, searchButton),
			),
		).toEqual(usernameIsA);
	});

	it("filter-identities in a Search field's condition", () => {
		const searchRows = (predicate: Expression) => {
			const searchDoc = doc(predicate);
			const menu = searchDoc.moduleOrder[0] as Uuid;
			const config = searchDoc.modules[menu]?.caseListConfig;
			if (config === undefined) throw new Error("The menu has no case list.");
			return xpathQueryRequestValues(
				config,
				composeModuleXPathQueryEmission(searchDoc, menu, {
					searchInputInstanceId: "search-input:results",
				}),
			).map(
				(value) =>
					serializeWire(value, { target: "hq-json", interpolation: "none" })
						.text,
			);
		};
		expect(searchRows(withIdentity(VILLAGE_IS_REGION))).toEqual(
			searchRows(VILLAGE_IS_REGION),
		);
		expect(
			canonicalExpression(
				withIdentity(VILLAGE_IS_REGION),
				contextOf(app, {
					entity: "module",
					uuid: moduleUuid,
					slot: "search_input_predicate",
					member: { searchInputUuid: REGION },
				}),
			),
		).toEqual(VILLAGE_IS_REGION);
	});

	it("coerced-literal-type in a Search field's condition", () => {
		const searchRows = (predicate: Expression) => {
			const searchDoc = doc(predicate);
			const menu = searchDoc.moduleOrder[0] as Uuid;
			const config = searchDoc.modules[menu]?.caseListConfig;
			if (config === undefined) throw new Error("The menu has no case list.");
			return xpathQueryRequestValues(
				config,
				composeModuleXPathQueryEmission(searchDoc, menu, {
					searchInputInstanceId: "search-input:results",
				}),
			).map(
				(value) =>
					serializeWire(value, { target: "hq-json", interpolation: "none" })
						.text,
			);
		};
		const onDay = (dataType?: "date"): Expression => ({
			kind: "when-input-present",
			input: { kind: "input", searchInputUuid: REGION },
			clause: {
				kind: "eq",
				left: prop("dob"),
				right: {
					kind: "date-coerce",
					value: term({
						kind: "literal",
						value: "2024-02-28",
						...(dataType === undefined ? {} : { data_type: dataType }),
					}),
				},
			},
		});
		expect(searchRows(onDay())).toEqual(searchRows(onDay("date")));
		expect(
			canonicalExpression(
				onDay(),
				contextOf(app, {
					entity: "module",
					uuid: moduleUuid,
					slot: "search_input_predicate",
					member: { searchInputUuid: REGION },
				}),
			),
		).toEqual(onDay("date"));
	});
});

describe("relation-type and relation-scope: a relation the catalog resolves prints typed, one related row a test", () => {
	// A patient's parent is a household, and its subcases are visits.
	const app = buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: "Village" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "p", label: "P" }],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "kind", label: "Kind" }],
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
						fields: [f({ kind: "text", id: "q1", label: "Q1" })],
					},
				],
			},
		],
	});
	const moduleUuid = app.moduleOrder[0] as Uuid;
	const filter: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "case_list_filter",
	};
	const calculated: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "case_list_column_expression",
		member: { columnUuid: COLUMN },
	};
	const village = (through?: string): Expression =>
		term({
			kind: "prop",
			caseType: "patient",
			property: "village",
			via: {
				kind: "ancestor",
				via: [
					{
						identifier: "parent",
						...(through === undefined ? {} : { throughCaseType: through }),
					},
				],
			},
		});
	const inVillage: Expression = {
		kind: "eq",
		left: term({ kind: "prop", caseType: "household", property: "village" }),
		right: lit("x"),
	};
	const cases: readonly {
		readonly name: string;
		readonly slot: SlotContextRef;
		readonly other: Expression;
		readonly canonical: Expression;
	}[] = [
		{
			name: "a parent's property read through an untyped step",
			slot: calculated,
			other: village(),
			canonical: village("household"),
		},
		{
			name: "a parent's presence over an untyped step",
			slot: filter,
			other: {
				kind: "exists",
				via: { kind: "ancestor", via: [{ identifier: "parent" }] },
				where: inVillage,
			},
			canonical: {
				kind: "exists",
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "household" }],
				},
				where: inVillage,
			},
		},
		{
			name: "a comparison of a parent's property, one related row's test",
			slot: filter,
			other: { kind: "eq", left: village("household"), right: lit("x") },
			canonical: {
				kind: "exists",
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "household" }],
				},
				where: inVillage,
			},
		},
		{
			name: "a count of subcases with no type",
			slot: calculated,
			other: { kind: "count", via: { kind: "subcase", identifier: "parent" } },
			canonical: {
				kind: "count",
				via: { kind: "subcase", identifier: "parent", ofCaseType: "visit" },
			},
		},
	];
	for (const one of cases)
		it(one.name, () => {
			const readEnvironment = env();
			expect(printSlot(app, one.slot, one.other, readEnvironment)).toBe(
				printSlot(app, one.slot, one.canonical, readEnvironment),
			);
			const context = contextOf(app, one.slot);
			expect(canonicalExpression(one.other, context)).toEqual(one.canonical);
			expect(canonicalExpression(one.canonical, context)).toEqual(
				one.canonical,
			);
		});
});

describe("relation-hops and relation-where-match-all: a device's presence test, hop by hop", () => {
	// A patient's parent is a household, whose parent is a village.
	const app = buildDoc({
		caseTypes: [
			{ name: "village", properties: [{ name: "zone", label: "Zone" }] },
			{
				name: "household",
				parent_type: "village",
				properties: [{ name: "size", label: "Size" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "p", label: "P" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [], searchInputs: [] },
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "q1", label: "Q1" })],
					},
				],
			},
		],
	});
	const moduleUuid = app.moduleOrder[0] as Uuid;
	const filter: SlotContextRef = {
		entity: "module",
		uuid: moduleUuid,
		slot: "case_list_filter",
	};
	const household = { identifier: "parent", throughCaseType: "household" };
	const village = { identifier: "parent", throughCaseType: "village" };
	const inZone: Expression = {
		kind: "eq",
		left: term({ kind: "prop", caseType: "village", property: "zone" }),
		right: lit("x"),
	};
	const cases: readonly {
		readonly name: string;
		readonly other: Expression;
		readonly canonical: Expression;
	}[] = [
		{
			name: "a walk of two hops is the presence nested hop by hop",
			other: {
				kind: "exists",
				via: { kind: "ancestor", via: [household, village] },
				where: inZone,
			},
			canonical: {
				kind: "exists",
				via: { kind: "ancestor", via: [household] },
				where: {
					kind: "exists",
					via: { kind: "ancestor", via: [village] },
					where: inZone,
				},
			},
		},
		{
			name: "a missing walk of two hops nests its presence",
			other: {
				kind: "missing",
				via: { kind: "ancestor", via: [household, village] },
			},
			canonical: {
				kind: "missing",
				via: { kind: "ancestor", via: [household] },
				where: { kind: "exists", via: { kind: "ancestor", via: [village] } },
			},
		},
		{
			name: "a presence whose candidates match all has no condition",
			other: {
				kind: "exists",
				via: { kind: "ancestor", via: [household] },
				where: { kind: "match-all" },
			},
			canonical: {
				kind: "exists",
				via: { kind: "ancestor", via: [household] },
			},
		},
	];
	for (const one of cases)
		it(one.name, () => {
			const readEnvironment = env();
			expect(printSlot(app, filter, one.other, readEnvironment)).toBe(
				printSlot(app, filter, one.canonical, readEnvironment),
			);
			const context = contextOf(app, filter);
			expect(canonicalExpression(one.other, context)).toEqual(one.canonical);
			expect(canonicalExpression(one.canonical, context)).toEqual(
				one.canonical,
			);
		});
});

describe("own-case-id: the session value a registration's case comes in", () => {
	const app = buildDoc({
		caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [], searchInputs: [] },
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({ kind: "text", id: "case_name", label: "Name" }),
							f({ kind: "hidden", id: "h" }),
						],
					},
				],
			},
		],
	});
	const calculate = {
		entity: "field",
		uuid: fieldNamed(app, "h"),
		slot: "calculate",
	} as SlotContextRef;
	it("prints as the read of the new case's id and canonicalizes to it", () => {
		const minted = term({ kind: "session-datum", datum: { kind: "new-case" } });
		const ownId = term({
			kind: "form-case",
			caseType: "patient",
			property: "case_id",
		});
		const readEnvironment = env();
		expect(printSlot(app, calculate, minted, readEnvironment)).toBe(
			printSlot(app, calculate, ownId, readEnvironment),
		);
		const context = contextOf(app, calculate);
		expect(canonicalExpression(minted, context)).toEqual(ownId);
		expect(canonicalExpression(ownId, context)).toEqual(ownId);
	});
});

describe("choice-literal, case-type-literal, field-spelling, selection-per-value and membership-in-disjunction: choices and case types named as text, a read the case operations bind, and a device's selection and membership tests", () => {
	const built = buildDoc({
		caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [], searchInputs: [] },
				forms: [
					{
						name: "Discharge",
						type: "close",
						fields: [
							f({
								kind: "single_select",
								id: "flag",
								label: "Flag",
								options: [
									{ value: "yes", label: "Yes" },
									{ value: "no", label: "No" },
								],
							}),
							f({
								kind: "multi_select",
								id: "tags",
								label: "Tags",
								options: [
									{ value: "a", label: "A" },
									{ value: "b", label: "B" },
								],
							}),
							f({ kind: "text", id: "note", label: "Note" }),
							f({
								kind: "repeat",
								id: "rounds",
								label: "Rounds",
								repeat_mode: "user_controlled",
								children: [
									f({
										kind: "single_select",
										id: "departed",
										label: "Departed",
										options: [
											{ value: "yes", label: "Yes" },
											{ value: "no", label: "No" },
										],
									}),
								],
							}),
						],
						closeCondition: "#form/flag = 'yes'",
					},
				],
			},
		],
	});
	const formUuid = built.formOrder[built.moduleOrder[0] as Uuid]?.[0] as Uuid;
	// The own close kept in a Save to Case block of its own, which the case
	// operation emitter prints with every question bound to its path.
	const app: BlueprintDoc = {
		...built,
		forms: {
			...built.forms,
			[formUuid]: {
				...(built.forms[formUuid] as BlueprintDoc["forms"][Uuid]),
				ownClosePlacement: {
					kind: "save-to-case",
					path: ["nova_operations", "nova_condition_close", "nova_close"],
				},
			},
		},
	};
	const uuidOf = (id: string) => fieldNamed(app, id);
	const optionOf = (id: string, value: string): Uuid => {
		const field = app.fields[uuidOf(id)] as {
			optionsSource?: {
				kind: string;
				options?: { uuid: Uuid; value: string }[];
			};
		};
		const option = field.optionsSource?.options?.find(
			(one) => one.value === value,
		);
		if (option === undefined) throw new Error(`No choice ${value} on ${id}.`);
		return option.uuid;
	};
	const read = (id: string, spelling?: "relative" | "absolute"): Expression =>
		term({
			kind: "field",
			uuid: uuidOf(id),
			...(spelling === undefined ? {} : { spelling }),
		});
	const choice = (id: string, ...values: string[]): Expression =>
		term({
			kind: "choice",
			field: uuidOf(id),
			options: values.map((value) => optionOf(id, value)) as [Uuid, ...Uuid[]],
		});
	const relevant: SlotContextRef = {
		entity: "field",
		uuid: uuidOf("note"),
		slot: "relevant",
	};
	const flagDefault: SlotContextRef = {
		entity: "field",
		uuid: uuidOf("flag"),
		slot: "default_value",
	};
	const close: SlotContextRef = {
		entity: "form",
		uuid: formUuid,
		slot: "form_close_condition",
	};
	/** `selected(#form/tags, '<value>')`, the choice named. */
	const selects = (
		value: string,
	): Extract<Expression, { kind: "multi-select-contains" }> => ({
		kind: "multi-select-contains",
		property: read("tags"),
		values: [
			{
				kind: "choice",
				field: uuidOf("tags"),
				options: [optionOf("tags", value)],
			},
		],
		quantifier: "any",
	});
	const text = (value: string) => ({ kind: "literal", value }) as const;
	/** The menu's case list filter, which no search restates. */
	const filter: SlotContextRef = {
		entity: "module",
		uuid: app.moduleOrder[0] as Uuid,
		slot: "case_list_filter",
	};
	const ownType: Expression = {
		kind: "eq",
		left: term({ kind: "case-row-type" }),
		right: term({ kind: "case-type", caseType: "patient" }),
	};
	const departedYes = (spelling?: "relative"): Expression => ({
		kind: "gt",
		left: {
			kind: "count",
			via: term({
				kind: "field",
				uuid: uuidOf("departed"),
				filters: [
					{
						step: { kind: "field", uuid: uuidOf("departed") },
						where: [
							{
								kind: "eq",
								left: read("departed", spelling),
								right: choice("departed", "yes"),
							},
						],
					},
				],
			}),
		},
		right: lit(0),
	});
	const cases: readonly {
		readonly name: string;
		readonly slot: SlotContextRef;
		readonly other: Expression;
		readonly canonical: Expression;
	}[] = [
		{
			name: "a single select compared with its choice's value",
			slot: relevant,
			other: { kind: "eq", left: read("flag"), right: lit("yes") },
			canonical: {
				kind: "eq",
				left: read("flag"),
				right: choice("flag", "yes"),
			},
		},
		{
			name: "a multiple select compared with its choices' values",
			slot: relevant,
			other: { kind: "neq", left: lit("a b"), right: read("tags") },
			canonical: {
				kind: "neq",
				left: choice("tags", "a", "b"),
				right: read("tags"),
			},
		},
		{
			name: "a choice tested by selected",
			slot: relevant,
			other: {
				kind: "multi-select-contains",
				property: read("tags"),
				values: [{ kind: "literal", value: "b" }],
				quantifier: "any",
			},
			canonical: {
				kind: "multi-select-contains",
				property: read("tags"),
				values: [
					{
						kind: "choice",
						field: uuidOf("tags"),
						options: [optionOf("tags", "b")],
					},
				],
				quantifier: "any",
			},
		},
		{
			name: "several choices tested by selected, any of them",
			slot: relevant,
			other: {
				kind: "multi-select-contains",
				property: read("tags"),
				values: [
					{ kind: "literal", value: "a" },
					{ kind: "literal", value: "b" },
				],
				quantifier: "any",
			},
			canonical: {
				kind: "or",
				clauses: [selects("a"), selects("b")],
			},
		},
		{
			name: "several choices tested by selected, all of them",
			slot: relevant,
			other: {
				kind: "multi-select-contains",
				property: read("tags"),
				values: [
					{ kind: "literal", value: "a" },
					{ kind: "literal", value: "b" },
				],
				quantifier: "all",
			},
			canonical: {
				kind: "and",
				clauses: [selects("a"), selects("b")],
			},
		},
		{
			name: "one choice tested by selected, all of it",
			slot: relevant,
			other: { ...selects("b"), quantifier: "all" },
			canonical: selects("b"),
		},
		{
			name: "a membership in an `or`, whose equalities join it",
			slot: filter,
			other: {
				kind: "or",
				clauses: [
					{ kind: "eq", left: prop("p"), right: lit("x") },
					{ kind: "in", left: prop("p"), values: [text("y"), text("z")] },
				],
			},
			canonical: {
				kind: "in",
				left: prop("p"),
				values: [text("x"), text("y"), text("z")],
			},
		},
		{
			name: "a membership in an `or` beside another test",
			slot: filter,
			other: {
				kind: "or",
				clauses: [
					{ kind: "in", left: prop("p"), values: [text("x"), text("y")] },
					ownType,
				],
			},
			canonical: {
				kind: "or",
				clauses: [
					{ kind: "eq", left: prop("p"), right: lit("x") },
					{ kind: "eq", left: prop("p"), right: lit("y") },
					ownType,
				],
			},
		},
		{
			name: "a select's starting value",
			slot: flagDefault,
			other: lit("no"),
			canonical: choice("flag", "no"),
		},
		{
			name: "the form's own close compared with a choice's value",
			slot: close,
			other: { kind: "eq", left: read("flag"), right: lit("yes") },
			canonical: {
				kind: "eq",
				left: read("flag"),
				right: choice("flag", "yes"),
			},
		},
		{
			name: "a text compared with the case's own type",
			slot: {
				entity: "module",
				uuid: app.moduleOrder[0] as Uuid,
				slot: "case_list_filter",
			},
			other: {
				kind: "eq",
				left: term({ kind: "case-row-type" }),
				right: lit("patient"),
			},
			canonical: {
				kind: "eq",
				left: term({ kind: "case-row-type" }),
				right: term({ kind: "case-type", caseType: "patient" }),
			},
		},
		{
			name: "a read in a repeat's filter the case operations bind, spelled relative",
			slot: close,
			other: departedYes("relative"),
			canonical: departedYes(),
		},
	];
	for (const one of cases)
		it(one.name, () => {
			const readEnvironment = env();
			expect(printSlot(app, one.slot, one.other, readEnvironment)).toBe(
				printSlot(app, one.slot, one.canonical, readEnvironment),
			);
			const context = contextOf(app, one.slot);
			const print = slotPrint(app, one.slot, readEnvironment);
			expect(canonicalExpression(one.other, context, print)).toEqual(
				one.canonical,
			);
			expect(canonicalExpression(one.canonical, context, print)).toEqual(
				one.canonical,
			);
		});

	it("keeps a relative read where the close prints from no block, which prints it apart", () => {
		const plain = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: { columns: [], searchInputs: [] },
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "repeat",
									id: "rounds",
									label: "Rounds",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "single_select",
											id: "departed",
											label: "Departed",
											options: [{ value: "yes", label: "Yes" }],
										}),
									],
								}),
								f({ kind: "text", id: "note", label: "Note" }),
							],
						},
					],
				},
			],
		});
		const departed = fieldNamed(plain, "departed");
		const option = (
			plain.fields[departed] as {
				optionsSource?: { options?: { uuid: Uuid }[] };
			}
		).optionsSource?.options?.[0]?.uuid as Uuid;
		const counted = (spelling?: "relative"): Expression => ({
			kind: "gt",
			left: {
				kind: "count",
				via: term({
					kind: "field",
					uuid: departed,
					filters: [
						{
							step: { kind: "field", uuid: departed },
							where: [
								{
									kind: "eq",
									left: term({
										kind: "field",
										uuid: departed,
										...(spelling === undefined ? {} : { spelling }),
									}),
									right: term({
										kind: "choice",
										field: departed,
										options: [option],
									}),
								},
							],
						},
					],
				}),
			},
			right: lit(0),
		});
		const noteRelevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(plain, "note"),
			slot: "relevant",
		};
		const readEnvironment = env();
		expect(slotPrint(plain, noteRelevant, readEnvironment)).toEqual({});
		expect(
			printSlot(plain, noteRelevant, counted("relative"), readEnvironment),
		).not.toBe(printSlot(plain, noteRelevant, counted(), readEnvironment));
		const context = contextOf(plain, noteRelevant);
		expect(canonicalExpression(counted("relative"), context)).toEqual(
			counted("relative"),
		);
	});

	it("leaves a text no choice holds, and one spelled apart from the choices' print", () => {
		const context = contextOf(app, relevant);
		for (const other of [
			{ kind: "eq", left: read("flag"), right: lit("maybe") },
			{ kind: "eq", left: read("tags"), right: lit("a  b") },
		] as const satisfies readonly Expression[])
			expect(canonicalExpression(other, context)).toEqual(other);
	});
});

describe("stored-instant-literal: a case write of a date and time", () => {
	const SEEN = testUuid("collision-stamp-seen");
	const WHEN = testUuid("collision-stamp-when");
	const FORM = testUuid("collision-stamps");
	const nameOf: Expression = term({ kind: "field", uuid: SEEN });
	const create = (id: string, value: Expression): CaseOperation =>
		({
			uuid: testUuid(`collision-stamp-${id}`),
			id,
			action: "create",
			caseType: "patient",
			target: { kind: "new" },
			name: nameOf,
			writes: [{ property: "visited_at", value }],
		}) as CaseOperation;
	const moment = (value: string): Expression =>
		term({ kind: "literal", value, data_type: "datetime" });
	/** A follow-up whose blocks create patients, the property a date and
	 *  time, with `operations` after its own arm. */
	function stamps(operations: CaseOperation[]): BlueprintDoc {
		return buildDoc(
			{
				caseTypes: [
					{
						name: "patient",
						properties: [
							{
								name: "visited_at",
								label: "Visited at",
								data_type: "datetime",
							},
						],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								uuid: "collision-stamps",
								name: "Stamps",
								type: "followup",
								fields: [
									f({ kind: "text", id: "seen", uuid: SEEN }),
									f({ kind: "datetime", id: "when", uuid: WHEN }),
								],
							},
						],
					},
				],
			},
			(built) => {
				const form = built.forms[FORM];
				built.forms[FORM] = {
					...form,
					caseOperations: [...(form?.caseOperations ?? []), ...operations],
				} as never;
			},
		);
	}
	const authored = moment("2026-03-04T10:06:07+05:00");
	const canonical = moment("2026-03-04T05:06:07.000Z");

	it("prints one moment's spellings as the text CommCare HQ stores, and canonicalizes to its UTC text", () => {
		const app = stamps([create("lit", authored)]);
		const slot: SlotContextRef = {
			entity: "form",
			uuid: FORM,
			slot: "case_operation_write_value",
			member: {
				operationUuid: testUuid("collision-stamp-lit"),
				property: "visited_at",
			},
		};
		const readEnvironment = env();
		const printed = printSlot(app, slot, authored, readEnvironment);
		expect(printed).toBe(printSlot(app, slot, canonical, readEnvironment));
		expect(
			printSlot(
				app,
				slot,
				moment("2026-03-04T05:06:07.000000Z"),
				readEnvironment,
			),
		).toBe(printed);
		const context = contextOf(app, slot);
		expect(canonicalExpression(authored, context)).toEqual(canonical);
		expect(canonicalExpression(canonical, context)).toEqual(canonical);
	});

	for (const beside of [false, true])
		it(`reads Nova's export of the literal back to its canonical moment${beside ? ", beside a question's answer saved to the same property" : ""}`, async () => {
			const operations = [create("lit", authored)];
			if (beside)
				operations.push(create("answer", term({ kind: "field", uuid: WHEN })));
			const outcome = readHqApp(
				await inputFor(exportedBody(stamps(operations))),
			);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			const written = Object.values(outcome.draft.doc.forms)
				.flatMap((form) => form.caseOperations ?? [])
				.find((operation) => operation.id === "lit");
			expect(written?.writes?.[0]?.value).toEqual(canonical);
		});
});

describe("csql-parenthesized-join and selection-per-value: a Search field's condition", () => {
	const PICKED = testUuid("collision-csql-picked");
	const tags = (caseType: string) =>
		({ kind: "prop", caseType, property: "tags" }) as const;
	const village = prop("village");
	const value = (text: string) => ({ kind: "literal", value: text }) as const;
	const selects = (
		values: readonly string[],
		quantifier: "any" | "all" = "any",
		caseType = "patient",
	): Expression => ({
		kind: "multi-select-contains",
		property: tags(caseType),
		values: values.map(value) as [
			ReturnType<typeof value>,
			...ReturnType<typeof value>[],
		],
		quantifier,
	});
	const villageIs = (text: string): Expression => ({
		kind: "eq",
		left: village,
		right: lit(text),
	});
	const whenPicked = (clause: Expression): Expression => ({
		kind: "when-input-present",
		input: { kind: "input", searchInputUuid: PICKED },
		clause,
	});
	const visits = (where: Expression): Expression => ({
		kind: "exists",
		via: { kind: "subcase", identifier: "parent", ofCaseType: "visit" },
		where,
	});
	/** Patients, each with visits, searched by an advanced field `picked`
	 *  whose condition is `predicate`. */
	function searched(predicate: Expression): BlueprintDoc {
		return buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "tags", label: "Tags", data_type: "multi_select" },
						{ name: "village", label: "Village", data_type: "text" },
					],
				},
				{
					name: "visit",
					parent_type: "patient",
					properties: [
						{ name: "tags", label: "Tags", data_type: "multi_select" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [],
						searchInputs: [
							advancedSearchInputDef(
								PICKED,
								"picked",
								"Picked",
								"text",
								predicate,
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
	}
	function rows(predicate: Expression): string[] {
		const app = searched(predicate);
		const menu = app.moduleOrder[0] as Uuid;
		const config = app.modules[menu]?.caseListConfig;
		if (config === undefined) throw new Error("The menu has no case list.");
		return xpathQueryRequestValues(
			config,
			composeModuleXPathQueryEmission(app, menu, {
				searchInputInstanceId: "search-input:results",
			}),
		).map(
			(wire) =>
				serializeWire(wire, { target: "hq-json", interpolation: "none" }).text,
		);
	}
	function conditionContext(predicate: Expression) {
		const app = searched(predicate);
		return contextOf(app, {
			entity: "module",
			uuid: app.moduleOrder[0] as Uuid,
			slot: "search_input_predicate",
			member: { searchInputUuid: PICKED },
		});
	}
	const pairs: readonly {
		readonly name: string;
		readonly other: Expression;
		readonly canonical: Expression;
	}[] = [
		{
			name: "an `or` of one-value tests in an `and`, as the selection",
			other: whenPicked({
				kind: "and",
				clauses: [
					villageIs("north"),
					{ kind: "or", clauses: [selects(["a"]), selects(["b"])] },
				],
			}),
			canonical: whenPicked({
				kind: "and",
				clauses: [villageIs("north"), selects(["a", "b"])],
			}),
		},
		{
			name: "an `or` of equalities in an `and`, as the membership",
			other: whenPicked({
				kind: "and",
				clauses: [
					selects(["a"]),
					{ kind: "or", clauses: [villageIs("north"), villageIs("south")] },
				],
			}),
			canonical: whenPicked({
				kind: "and",
				clauses: [
					selects(["a"]),
					{
						kind: "in",
						left: village,
						values: [value("north"), value("south")],
					},
				],
			}),
		},
		{
			name: "one fixed value tested for all, as tested for any",
			other: whenPicked(selects(["a"], "all")),
			canonical: whenPicked(selects(["a"])),
		},
	];
	for (const pair of pairs)
		it(pair.name, () => {
			expect(rows(pair.other)).toEqual(rows(pair.canonical));
			const context = conditionContext(pair.canonical);
			expect(canonicalExpression(pair.other, context)).toEqual(pair.canonical);
			expect(canonicalExpression(pair.canonical, context)).toEqual(
				pair.canonical,
			);
		});

	it("leaves a join CSQL prints apart from the selection and the membership: a row of its own, a presence's whole clause, a related case's condition", () => {
		const apart: readonly (readonly [Expression, Expression])[] = [
			[
				whenPicked({ kind: "or", clauses: [selects(["a"]), selects(["b"])] }),
				whenPicked(selects(["a", "b"])),
			],
			[
				{
					kind: "and",
					clauses: [
						villageIs("east"),
						{ kind: "or", clauses: [selects(["a"]), selects(["b"])] },
					],
				},
				{ kind: "and", clauses: [villageIs("east"), selects(["a", "b"])] },
			],
			[
				visits({
					kind: "or",
					clauses: [
						selects(["a"], "any", "visit"),
						selects(["b"], "any", "visit"),
					],
				}),
				visits(selects(["a", "b"], "any", "visit")),
			],
			[
				whenPicked({
					kind: "or",
					clauses: [villageIs("north"), villageIs("south")],
				}),
				whenPicked({
					kind: "in",
					left: village,
					values: [value("north"), value("south")],
				}),
			],
		];
		for (const [bare, joined] of apart) {
			expect(rows(bare)).not.toEqual(rows(joined));
			const context = conditionContext(bare);
			expect(canonicalExpression(bare, context)).toEqual(bare);
			expect(canonicalExpression(joined, context)).toEqual(joined);
		}
	});
});

describe("a worker field read by name beside a worker property of its slug", () => {
	const ROLE = testUuid("collision-worker-role");
	const app: BlueprintDoc = {
		...doc(),
		userProperties: {
			[ROLE]: { uuid: ROLE, slug: "role", label: "Role" },
		},
		userPropertyOrder: [ROLE],
	} as BlueprintDoc;
	const moduleUuid = app.moduleOrder[0] as Uuid;
	const slots: readonly SlotContextRef[] = [
		{
			entity: "field",
			uuid: fieldNamed(app, "q1"),
			slot: "relevant",
		} as SlotContextRef,
		{ entity: "module", uuid: moduleUuid, slot: "case_list_filter" },
	];
	for (const slot of slots)
		for (const source of [undefined, "worker-record"] as const)
			it(`prints and canonicalizes as the property's read in ${slot.slot}${source === undefined ? "" : `, from the ${source}`}`, () => {
				const provenance = source === undefined ? {} : { source };
				const read = (one: Term): Expression => ({
					kind: "eq",
					left: term(one),
					right: lit("chw"),
				});
				const byName = read({
					kind: "session-user",
					field: "role",
					...provenance,
				});
				const canonical = read({
					kind: "session-user-property",
					userPropertyUuid: ROLE,
					...provenance,
				});
				const readEnvironment = env();
				expect(printSlot(app, slot, byName, readEnvironment)).toBe(
					printSlot(app, slot, canonical, readEnvironment),
				);
				const context = contextOf(app, slot);
				expect(canonicalExpression(byName, context)).toEqual(canonical);
				expect(canonicalExpression(canonical, context)).toEqual(canonical);
				// A name no property holds stays the name-backed read.
				const unheld = read({ kind: "session-user", field: "district" });
				expect(canonicalExpression(unheld, context)).toEqual(unheld);
			});
});

describe("untyped-row-standard-property: a standard property of a case database row no type test types", () => {
	// A follow-up form of patients holding a repeat over the case database, and
	// a question whose display condition counts case database rows.
	const app = buildDoc({
		caseTypes: [
			{ name: "patient", properties: [{ name: "village", label: "Village" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [], searchInputs: [] },
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({
								kind: "repeat",
								id: "visits",
								label: "Visits",
								repeat_mode: "query_bound",
								data_source: {
									ids_query: {
										kind: "project",
										of: { kind: "cases", source: "casedb", where: [] },
										value: { kind: "prop", property: "case_id" },
									},
								},
								children: [f({ kind: "text", id: "note", label: "Note" })],
							}),
						],
					},
				],
			},
		],
	});
	const idsQuery = {
		entity: "field",
		uuid: fieldNamed(app, "visits"),
		slot: "ids_query",
	} as SlotContextRef;
	const relevant = {
		entity: "field",
		uuid: fieldNamed(app, "q1"),
		slot: "relevant",
	} as SlotContextRef;
	const read = (property: string, caseType?: string): Term => ({
		kind: "prop",
		property,
		...(caseType === undefined ? {} : { caseType }),
	});
	const named = (caseType?: string): Expression => ({
		kind: "eq",
		left: term(read("case_name", caseType)),
		right: lit("open"),
	});
	const isPatient: Expression = {
		kind: "eq",
		left: term({ kind: "case-row-type" }),
		right: term({ kind: "case-type", caseType: "patient" }),
	};
	const project = (
		where: readonly Expression[],
		caseType?: string,
	): Expression => ({
		kind: "project",
		of: { kind: "cases", source: "casedb", where: [...where] },
		value: read("case_id", caseType),
	});
	const counted = (where: readonly Expression[]): Expression => ({
		kind: "gt",
		left: {
			kind: "count",
			via: { kind: "cases", source: "casedb", where: [...where] },
		} as Expression,
		right: lit(0),
	});
	const cases: readonly {
		readonly name: string;
		readonly slot: SlotContextRef;
		readonly other: Expression;
		readonly canonical: Expression;
	}[] = [
		{
			name: "a query repeat's rows and value, read naming the type",
			slot: idsQuery,
			other: project([named("patient")], "patient"),
			canonical: project([named()]),
		},
		{
			name: "a count of rows whose condition reads the name naming the type",
			slot: relevant,
			other: counted([named("patient")]),
			canonical: counted([named()]),
		},
	];
	for (const one of cases)
		it(one.name, () => {
			const readEnvironment = env();
			expect(printSlot(app, one.slot, one.other, readEnvironment)).toBe(
				printSlot(app, one.slot, one.canonical, readEnvironment),
			);
			const context = contextOf(app, one.slot);
			expect(canonicalExpression(one.other, context)).toEqual(one.canonical);
			expect(canonicalExpression(one.canonical, context)).toEqual(
				one.canonical,
			);
		});

	it("leaves a read of a row a type test types, and a property the case types declare", () => {
		const context = contextOf(app, idsQuery);
		const typed = project([isPatient, named("patient")], "patient");
		expect(canonicalExpression(typed, context)).toEqual(typed);
		const declared: Expression = project([
			{
				kind: "eq",
				left: term(read("village", "patient")),
				right: lit("north"),
			},
		]);
		expect(canonicalExpression(declared, context)).toEqual(declared);
	});
});
