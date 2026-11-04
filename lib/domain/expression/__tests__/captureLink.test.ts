/**
 * A captured file reaches a case only as the link to it: `capture-link` stands
 * as the whole value a case change saves, and nowhere else. These hold the
 * checker's admission, its refusal of a bare capture answer (the file's name,
 * which means nothing once the form is gone), and the authoring text that
 * spells the term.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { projectFormExpression } from "@/lib/doc/expressionText";
import type { BlueprintDoc } from "@/lib/domain";
import { slotContext } from "../context";
import { checkExpression, scalarDataType } from "../typeChecker";
import type { Expression, ExpressionSlotRef, Term } from "../types";
import { expressionSchema } from "../types";

const ids = {
	module: testUuid("capture-link-module"),
	form: testUuid("capture-link-form"),
	operation: testUuid("capture-link-operation"),
	photo: testUuid("capture-link-photo"),
	note: testUuid("capture-link-note"),
	copy: testUuid("capture-link-copy"),
	visits: testUuid("capture-link-visits"),
	snapshot: testUuid("capture-link-snapshot"),
};

const term = (value: Term): Expression => ({ kind: "term", term: value });
const link = (field: string): Expression =>
	term({ kind: "capture-link", field: field as typeof ids.photo });
const read = (field: string): Expression =>
	term({ kind: "field", uuid: field as typeof ids.photo });

/** A follow-up form with a photo, a text question, a Hidden Value and a
 * repeat holding a second photo, whose one case change saves `value` to
 * `photo_link` on the condition `condition`. */
function docWith(value: Expression, condition?: Expression): BlueprintDoc {
	const doc = buildDoc({
		appName: "Capture links",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: ids.module,
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: ids.form,
						name: "Visit",
						type: "followup",
						fields: [
							{ uuid: ids.photo, id: "photo", kind: "image", label: "Photo" },
							{ uuid: ids.note, id: "note", kind: "text", label: "Note" },
							{ uuid: ids.copy, id: "copy", kind: "hidden" },
							{
								uuid: ids.visits,
								id: "visits",
								kind: "repeat",
								label: "Visits",
								children: [
									{
										uuid: ids.snapshot,
										id: "snapshot",
										kind: "image",
										label: "Snapshot",
									},
								],
							},
						],
					},
				],
			},
		],
	});
	return {
		...doc,
		forms: {
			...doc.forms,
			[ids.form]: {
				...doc.forms[ids.form],
				caseOperations: [
					{
						uuid: ids.operation,
						id: "save",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [
							{
								property: "photo_link",
								value,
								...(condition === undefined ? {} : { condition }),
							},
						],
					},
				],
			},
		},
	} as BlueprintDoc;
}

const writeValue: ExpressionSlotRef = {
	entity: "form",
	uuid: ids.form,
	slot: "case_operation_write_value",
	member: { operationUuid: ids.operation, property: "photo_link" },
};
const writeCondition: ExpressionSlotRef = {
	entity: "form",
	uuid: ids.form,
	slot: "case_operation_write_condition",
	member: { operationUuid: ids.operation, property: "photo_link" },
};
const hiddenCalculate: ExpressionSlotRef = {
	entity: "field",
	uuid: ids.copy,
	slot: "calculate",
};

function check(doc: BlueprintDoc, slot: ExpressionSlotRef, value: Expression) {
	const ctx = slotContext(doc, slot, new Map());
	if (ctx === undefined) throw new Error("The fixture has no such slot.");
	return checkExpression(value, ctx);
}
const reasons = (outcome: ReturnType<typeof check>) =>
	outcome.errors.map((error) => `${error.code}:${error.reason ?? ""}`);

describe("capture-link in the checker", () => {
	it("is admitted as the whole value a case change saves, and is text", () => {
		const outcome = check(
			docWith(link(ids.photo)),
			writeValue,
			link(ids.photo),
		);
		expect(outcome.errors).toEqual([]);
		expect(scalarDataType(outcome.type?.data)).toBe("text");
	});

	it("is refused in a write's condition", () => {
		const condition: Expression = { kind: "is-blank", left: link(ids.photo) };
		const outcome = check(
			docWith(link(ids.photo), condition),
			writeCondition,
			condition,
		);
		expect(reasons(outcome)).toEqual(["arm-unavailable:capture-link-slot"]);
		expect(outcome.errors[0]?.message).toBe(
			"capture-link works only as the whole value a case change saves.",
		);
	});

	it("is refused as a Hidden Value's calculation", () => {
		const outcome = check(
			docWith(link(ids.photo)),
			hiddenCalculate,
			link(ids.photo),
		);
		expect(reasons(outcome)).toEqual(["arm-unavailable:capture-link-slot"]);
	});

	it("is refused inside a calculation the case change saves", () => {
		const value: Expression = {
			kind: "concat",
			parts: [link(ids.photo), term({ kind: "literal", value: "!" })],
		};
		const outcome = check(docWith(value), writeValue, value);
		expect(reasons(outcome)).toEqual(["arm-unavailable:capture-link-slot"]);
		expect(outcome.errors[0]?.path).toEqual(["parts", 0]);
	});

	it("is refused over a question that captures no file", () => {
		const outcome = check(docWith(link(ids.note)), writeValue, link(ids.note));
		expect(reasons(outcome)).toEqual(["arm-unavailable:capture-link-field"]);
		expect(outcome.errors[0]?.message).toBe(
			"capture-link reads a question that captures a file, and note doesn't.",
		);
	});

	it("gives one link per entry for a capture in a repeat the change is outside of", () => {
		const outcome = check(
			docWith(link(ids.snapshot)),
			writeValue,
			link(ids.snapshot),
		);
		expect(reasons(outcome)).toEqual(["many-values:repeat"]);
	});

	it("refuses saving a capture's bare answer, the file's name, and offers the link", () => {
		const outcome = check(
			docWith(read(ids.photo)),
			writeValue,
			read(ids.photo),
		);
		expect(reasons(outcome)).toEqual(["expected-value:capture-answer"]);
		expect(outcome.errors[0]?.message).toBe(
			"A captured file reaches a case as a link to it. You can save capture-link(#form/photo) instead.",
		);
	});

	it("leaves a bare read of an ordinary question admitted", () => {
		const outcome = check(docWith(read(ids.note)), writeValue, read(ids.note));
		expect(outcome.errors).toEqual([]);
	});
});

describe("capture-link in form text", () => {
	const doc = docWith(link(ids.photo));
	const parse = (source: string) =>
		parseFormExpression(source, { doc, slot: writeValue, lookup: new Map() });

	it("parses capture-link(#form/photo) to the term and prints it back", () => {
		const parsed = parse("capture-link(#form/photo)");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.expression).toEqual(link(ids.photo));
		expect(
			parsed.expression === undefined ||
				expressionSchema.safeParse(parsed.expression).success,
		).toBe(true);
		if (parsed.expression === undefined) throw new Error("Nothing parsed.");
		const printed = projectFormExpression(
			doc,
			writeValue,
			parsed.expression,
			new Map(),
		);
		expect(printed.unresolved).toEqual([]);
		expect(printed.text).toBe("capture-link(#form/photo)");
	});

	it("reads the question's absolute path as the same question", () => {
		const parsed = parse("capture-link(/data/photo)");
		expect(parsed.ok && parsed.expression).toEqual(link(ids.photo));
	});

	it("refuses an argument that names no question", () => {
		const parsed = parse("capture-link('photo')");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.issues.map((issue) => issue.code)).toEqual([
			"capture-link-not-a-question",
		]);
	});

	it("refuses a call without exactly one argument", () => {
		const parsed = parse("capture-link()");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.issues.map((issue) => issue.code)).toEqual(["arity"]);
	});
});
