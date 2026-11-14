/**
 * Every form-logic function Nova stores (`types.ts::CALL_FUNCTIONS`), read
 * back from Nova's own export. The failures this holds: a function whose
 * print the reader leaves unbound, binds to another tree, or binds without
 * the claim of its own surface entry; a function added to the vocabulary
 * with no reading here; and a record slot that takes a function call, which
 * the reader would then have to read back there too.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import {
	CALL_FUNCTIONS,
	type CallFunction,
	type Expression,
} from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { FUNCTION_REGISTRY } from "@/lib/domain/expressionFunctions";
import { calculatedColumn } from "@/lib/domain/modules";
import { fieldNamed } from "./expressionReadFixture";
import { judgeReadBack, readEmission } from "./readBackCorpus";

/** One Hidden Value's calculation per function, over typed questions. Typed
 *  as a record of every function, so a function added to the vocabulary
 *  fails to compile here until it is read back. */
const CALLS: Readonly<Record<CallFunction, string>> = {
	abs: "abs(#form/x)",
	acos: "acos(#form/x)",
	asin: "asin(#form/x)",
	atan: "atan(#form/x)",
	atan2: "atan2(#form/x, #form/n)",
	boolean: "boolean(#form/t)",
	"boolean-from-string": "boolean-from-string(#form/t)",
	ceiling: "ceiling(#form/x)",
	checklist: "checklist(1, 2, #form/t = 'a', #form/u = 'b')",
	checksum: "checksum('verhoeff', #form/t)",
	"closest-point-on-polygon": "closest-point-on-polygon(#form/g, #form/t)",
	cond: "cond(#form/n > 1, #form/t, #form/n > 0, #form/u, 'none')",
	contains: "contains(#form/t, 'a')",
	cos: "cos(#form/x)",
	"count-selected": "count-selected(#form/ms)",
	"decrypt-string": "decrypt-string(#form/t, #form/u, 'AES')",
	depend: "depend(#form/t, #form/u)",
	distance: "distance(#form/g, #form/g2)",
	"distinct-values": "distinct-values(#form/r/rt)",
	"encrypt-string": "encrypt-string(#form/t, #form/u, 'AES')",
	"ends-with": "ends-with(#form/t, 'a')",
	exp: "exp(#form/x)",
	floor: "floor(#form/x)",
	"format-date-for-calendar": "format-date-for-calendar(#form/day, 'nepali')",
	"id-compress": "id-compress(#form/n, 'ABC', 'DEF', 'GHJ', 3)",
	"index-of": "index-of(#form/r/rt, #form/t)",
	int: "int(#form/x)",
	"is-point-inside-polygon": "is-point-inside-polygon(#form/g, #form/t)",
	join: "join(' ', #form/r/rt)",
	"join-chunked": "join-chunked('-', 3, #form/t)",
	"json-property": "json-property(#form/t, 'name')",
	log: "log(#form/x)",
	log10: "log10(#form/x)",
	"lower-case": "lower-case(#form/t)",
	max: "max(#form/r/rn)",
	min: "min(#form/n, #form/x)",
	"normalize-space": "normalize-space(#form/t)",
	number: "number(#form/t)",
	pi: "pi()",
	position: "position(#form/r)",
	pow: "pow(#form/x, 2)",
	random: "random()",
	replace: "replace(#form/t, 'a', 'b')",
	round: "round(#form/x)",
	"selected-at": "selected-at(#form/ms, 0)",
	sin: "sin(#form/x)",
	sleep: "sleep(1, #form/t)",
	sort: "sort(#form/t)",
	"sort-by": "sort-by(#form/t, #form/u)",
	sqrt: "sqrt(#form/x)",
	string: "string(#form/n)",
	"string-length": "string-length(#form/t)",
	substr: "substr(#form/t, 1, 2)",
	"substring-after": "substring-after(#form/t, '-')",
	"substring-before": "substring-before(#form/t, '-')",
	sum: "sum(#form/r/rn)",
	tan: "tan(#form/x)",
	translate: "translate(#form/t, 'abc', 'ABC')",
	"upper-case": "upper-case(#form/t)",
	uuid: "uuid()",
	"weighted-checklist":
		"weighted-checklist(1, 2, #form/t = 'a', 1, #form/u = 'b', 1)",
};

/** Functions Nova prints through a lowering rather than as a call of their
 *  own name (`functionCapabilities.ts::JAVAROSA_LOWERED_FUNCTIONS`): their
 *  export carries no use of the function's own surface entry. */
const LOWERED: ReadonlySet<CallFunction> = new Set(["normalize-space"]);

const hiddenId = (fn: CallFunction) => `h_${fn.replaceAll("-", "_")}`;

function callsDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({ kind: "text", id: "t", label: "T" }),
							f({ kind: "text", id: "u", label: "U" }),
							f({ kind: "int", id: "n", label: "N" }),
							f({ kind: "decimal", id: "x", label: "X" }),
							f({ kind: "date", id: "day", label: "Day" }),
							f({ kind: "geopoint", id: "g", label: "G" }),
							f({ kind: "geopoint", id: "g2", label: "G2" }),
							f({
								kind: "multi_select",
								id: "ms",
								label: "Tags",
								options: [
									{ value: "a", label: "A" },
									{ value: "b", label: "B" },
								],
							}),
							f({
								kind: "repeat",
								id: "r",
								label: "Rows",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "int", id: "rn", label: "Row number" }),
									f({ kind: "text", id: "rt", label: "Row text" }),
								],
							} as FieldSpec),
							...CALL_FUNCTIONS.map((fn) =>
								f({ kind: "hidden", id: hiddenId(fn), calculate: CALLS[fn] }),
							),
						],
					},
				],
			},
		],
	});
}

/** Whether `tree` calls `fn` anywhere. */
function calls(tree: Expression | undefined, fn: CallFunction): boolean {
	let found = false;
	if (tree !== undefined)
		walkExpressionNodes(tree, (node) => {
			if (node.kind === "call" && node.fn === fn) found = true;
		});
	return found;
}

describe("every form-logic function, read back from Nova's own export", () => {
	it("reads each Hidden Value's call to the tree it stores, claiming the function's entry", async () => {
		const doc = callsDoc();
		const calculateOf = (fn: CallFunction) =>
			(doc.fields[fieldNamed(doc, hiddenId(fn))] as { calculate?: Expression })
				.calculate;
		// The text above is the call itself, not another arm the parser
		// reads it as.
		for (const fn of CALL_FUNCTIONS)
			expect(calls(calculateOf(fn), fn), fn).toBe(true);
		// The form's profile admits every one of them.
		for (const fn of CALL_FUNCTIONS) {
			const uuid = fieldNamed(doc, hiddenId(fn));
			const context = slotContext(
				doc,
				{ entity: "field", uuid, slot: "calculate" },
				new Map(),
			);
			const calculate = calculateOf(fn);
			if (context === undefined || calculate === undefined)
				throw new Error(`The Hidden Value of ${fn} has no calculation.`);
			expect(checkExpression(calculate, context).errors, fn).toEqual([]);
		}

		const reading = await readEmission(doc, recordDialectRoundTrip);
		expect(reading.closed.findings).toEqual([]);
		expect(reading.closed.defects).toEqual([]);
		const judged = judgeReadBack(doc, reading);
		for (const fn of CALL_FUNCTIONS) {
			const uuid = fieldNamed(doc, hiddenId(fn));
			const one = judged.find(
				(slot) =>
					slot.stored.ref.entity === "field" &&
					slot.stored.ref.uuid === uuid &&
					slot.stored.ref.slot === "calculate",
			);
			expect(one?.verdict, fn).toEqual({ kind: "same" });
			const counted =
				reading.closed.claims.counts[`expressions-and-data/${fn}`] ?? 0;
			if (LOWERED.has(fn)) expect(counted, fn).toBe(0);
			else expect(counted, fn).toBeGreaterThan(0);
		}
	});
});

describe("a function call in a record slot", () => {
	// No record slot takes a call: a case list's calculated column, a filter
	// or a Search field's condition each print through the record rule set,
	// which has no function call. The reader therefore reads a call back only
	// in form logic.
	it("is refused in a case list's calculated column, for every function", () => {
		const column = testUuid("calls-column");
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							calculatedColumn(column, "Shown", {
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
		const context = slotContext(
			doc,
			{
				entity: "module",
				uuid: doc.moduleOrder[0] as never,
				slot: "case_list_column_expression",
				member: { columnUuid: column },
			},
			new Map(),
		);
		if (context === undefined) throw new Error("The column has no slot.");
		for (const fn of CALL_FUNCTIONS) {
			// As many arguments as the function takes at least, so the call
			// itself is what the slot refuses.
			const arity = FUNCTION_REGISTRY.get(fn)?.minArgs ?? 0;
			const call: Expression = {
				kind: "call",
				fn,
				args: Array.from({ length: arity }, () => ({
					kind: "term",
					term: { kind: "prop", caseType: "patient", property: "p" },
				})),
			};
			expect(
				checkExpression(call, context).errors.some(
					(error) =>
						error.code === "arm-unavailable" && error.reason === "call",
				),
				fn,
			).toBe(true);
		}
	});
});
