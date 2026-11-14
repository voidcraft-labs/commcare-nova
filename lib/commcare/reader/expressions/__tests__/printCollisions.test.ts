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
import { canonicalExpression } from "../canonical";
import type { ExpressionReadEnv } from "../index";
import { lookupTypes, printSlot, readingScope } from "../readExpression";
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
		{
			id: "membership",
			slot: filter,
			other: () => ({
				kind: "or",
				clauses: [
					{ kind: "eq", left: prop("p"), right: lit("a") },
					{ kind: "eq", left: prop("p"), right: lit("b") },
				],
			}),
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
			id: "membership",
			slot: filter,
			other: () => ({
				kind: "or",
				clauses: [
					{ kind: "eq", left: prop("age"), right: lit(1) },
					{ kind: "eq", left: prop("age"), right: lit(2) },
				],
			}),
			canonical: {
				kind: "in",
				left: prop("age"),
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
			id: "instant-literal",
			slot: filter,
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
});
