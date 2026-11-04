/**
 * Step `blank-comparisons` (part 09 §7.12): a comparison of an answer with
 * the blank text `''` that the head refuses, because it types the answer as
 * a number, date, time or location, becomes the blank test a device runs
 * the same way.
 *
 * The plausible failures: a rewrite of a comparison the head already
 * admits, or of an answer that can hold a yes/no (a false answer equals
 * `''` on a device, where its text is not blank); a rewrite that loses the
 * operand order or the inequality; one that leaves the gate's refusal; and a
 * second run that changes the document again.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { blankComparisonsStep } from "../steps/blankComparisons";

const uuid = (name: string) => testUuid(`blank-comparisons-${name}`);
const ctx = { lookupContext: LOOKUP_CONTEXT_UNAVAILABLE };

function doc(fields: FieldSpec[]): BlueprintDoc {
	return buildDoc({
		appName: "Blank comparisons",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "score", label: "Score", data_type: "int" },
					{ name: "seen", label: "Seen", data_type: "date" },
					{ name: "level", label: "Level", data_type: "int" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({ uuid: uuid("a"), kind: "int", id: "a", label: "A" }),
							...fields,
						],
					},
				],
			},
		],
	});
}

const hidden = (name: string, calculate: string, property: string) =>
	f({
		uuid: uuid(name),
		kind: "hidden",
		id: name,
		calculate,
		caseWrite: { caseType: "patient", property },
	});
const shown = (name: string, relevant: string) =>
	f({ uuid: uuid(name), kind: "text", id: name, label: name, relevant });
const read = (name: string) =>
	({ kind: "term", term: { kind: "field", uuid: uuid(name) } }) as const;
const codes = (built: BlueprintDoc) =>
	runValidation(built, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => error.code);

const blank = { kind: "term", term: { kind: "literal", value: "" } } as const;

/** The registration's own arm with each named write given `condition`. */
function withWriteConditions(
	built: BlueprintDoc,
	conditions: Readonly<Record<string, Expression>>,
): BlueprintDoc {
	const [formUuid] = built.formOrder[built.moduleOrder[0]] ?? [];
	const form = formUuid === undefined ? undefined : built.forms[formUuid];
	const own = form?.caseOperations?.find((op) => op.action === "own");
	if (form === undefined || own === undefined)
		throw new Error("The registration holds no own arm.");
	for (const write of own.writes ?? []) {
		const condition = conditions[write.property];
		if (condition !== undefined) write.condition = condition;
	}
	return built;
}

describe("blank-comparisons", () => {
	it("writes a number's and a date's refused comparison with blank as a blank test, in either order", () => {
		const before = withWriteConditions(
			doc([
				hidden("total", "if(#form/a > 0, int(#form/a), '')", "score"),
				hidden("day", "today()", "seen"),
				// Form logic compares as a device does and admits this one.
				shown("note", "#form/total != ''"),
			]),
			{
				score: { kind: "neq", left: read("total"), right: blank },
				seen: {
					kind: "or",
					clauses: [
						{ kind: "eq", left: blank, right: read("day") },
						{ kind: "eq", left: read("a"), right: blank },
					],
				},
			},
		);
		expect(codes(before)).toEqual([
			"CASE_OPERATION_EXPRESSION_TYPE",
			"CASE_OPERATION_EXPRESSION_TYPE",
		]);
		const result = blankComparisonsStep(before, ctx);
		expect(result.blockers).toEqual([]);
		expect(result.notice).toEqual([]);
		const after = result.doc;
		const own = (built: BlueprintDoc) =>
			Object.values(built.forms)[0]?.caseOperations?.find(
				(op) => op.action === "own",
			);
		const condition = (built: BlueprintDoc, property: string) =>
			own(built)?.writes?.find((write) => write.property === property)
				?.condition;
		expect(condition(after, "score")).toEqual({
			kind: "not",
			clause: { kind: "is-blank", left: read("total") },
		});
		expect(condition(after, "seen")).toEqual({
			kind: "or",
			clauses: [
				{ kind: "is-blank", left: read("day") },
				{ kind: "is-blank", left: read("a") },
			],
		});
		expect(after.fields[uuid("note")]).toEqual(before.fields[uuid("note")]);
		expect(codes(after)).toEqual([]);
		const [formUuid] = Object.keys(before.forms);
		expect(result.changes).toEqual([
			{
				step: "blank-comparisons",
				kind: "blank-test-written",
				entityUuid: formUuid,
				detail: { comparisons: 3 },
			},
		]);
		// The step leaves the document it was given as it was.
		expect(condition(before, "score")).toMatchObject({ kind: "neq" });
		// A second run finds nothing to write.
		const again = blankComparisonsStep(after, ctx);
		expect(again.changes).toEqual([]);
		expect(again.doc).toBe(after);
	});

	it("leaves an answer that can hold a yes/no, whose false a device reads as equal to blank", () => {
		const before = withWriteConditions(
			doc([
				hidden("passed", "#form/a > 3", "score"),
				hidden("copied", "#form/passed", "level"),
			]),
			{
				score: { kind: "neq", left: read("passed"), right: blank },
				level: { kind: "neq", left: read("copied"), right: blank },
			},
		);
		// The head types both as their properties, so it refuses both.
		expect(codes(before)).toEqual([
			"CASE_OPERATION_EXPRESSION_TYPE",
			"CASE_OPERATION_EXPRESSION_TYPE",
		]);
		const result = blankComparisonsStep(before, ctx);
		expect(result.changes).toEqual([]);
		expect(result.doc).toBe(before);
	});

	it("leaves a comparison the head already admits", () => {
		const before = withWriteConditions(
			doc([
				f({
					uuid: uuid("words"),
					kind: "text",
					id: "words",
					label: "Words",
					caseWrite: { caseType: "patient", property: "words" },
				}),
			]),
			{ words: { kind: "neq", left: read("words"), right: blank } },
		);
		expect(codes(before)).toEqual([]);
		const result = blankComparisonsStep(before, ctx);
		expect(result.changes).toEqual([]);
		expect(result.doc).toBe(before);
	});
});
