/**
 * A `jr:itext` read of a question's validation message names an entry the
 * XForm writes, or the gate refuses it at the read.
 *
 * The builder writes a validation message only where the question's bind
 * carries a constraint: its own validation condition, or the check of a case
 * name it supplies. A read of any other question's message would find no
 * entry, and Core answers it with `[itext:<id>]`
 * (commcare-core `FormDef.java::initEvalContext`), so the device would show a
 * placeholder while the document holds the message. Plausible failures: the
 * gate admitting that read (the device silently reads the placeholder), the
 * gate refusing a read of a message the form does write (the guarded name),
 * and Preview's text table holding an entry the XForm leaves out, or leaving
 * out one it writes. And one more: a read of a message the form does not hold
 * at all (another form's question, a question gone, a question with no
 * message) drawing this refusal beside the checker's own, with advice that
 * cannot clear it.
 */
import { type AnyNode, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Uuid } from "@/lib/domain";
import type { ItextUnit } from "@/lib/domain/expression/types";
import { previewFormText } from "@/lib/preview/engine/formText";
import { runValidation } from "../../validator/runner";
import { parseXml } from "../../xmlParse";
import { itextIdFor } from "../itextIds";
import { constraintCarryingQuestions } from "../validationMessage";

const FORM = testUuid("frm-register");
const NAME = testUuid("fld-name");
const PLAIN = testUuid("fld-plain");
const CHECKED = testUuid("fld-checked");
const ELSEWHERE = testUuid("fld-elsewhere");
const BARE = testUuid("fld-bare");
const GONE = testUuid("fld-gone");

const message = (field: Uuid): ItextUnit => ({
	field,
	role: "field-validation-message",
});
const read = (id: string, field: Uuid) =>
	f({
		kind: "hidden",
		id,
		calculate: { kind: "itext", unit: message(field) },
	});

/** A registration whose name question checks the name it supplies, a
 * question with a message and no condition, and one with both, each
 * message read by a Hidden Value; with `strayReads`, it also reads the
 * message of a question in another form, of a question with no message, and
 * of a question no form holds, and the other form's question has a message
 * and no condition. */
function fixture(strayReads = false) {
	return buildDoc({
		appName: "Households",
		caseTypes: [{ name: "household", properties: [] }],
		modules: [
			{
				uuid: "mod-households",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-register",
						name: "Register household",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: "fld-name",
								id: "name",
								label: "Name",
								validate_msg: "Write the household's name",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
							f({
								kind: "text",
								uuid: "fld-plain",
								id: "plain",
								label: "Plain",
								validate_msg: "Please check",
							}),
							f({
								kind: "text",
								uuid: "fld-checked",
								id: "checked",
								label: "Checked",
								validate: ". != 'x'",
								validate_msg: "Anything but x",
							}),
							read("read_name", NAME),
							read("read_plain", PLAIN),
							read("read_checked", CHECKED),
							...(strayReads
								? [
										f({
											kind: "text",
											uuid: "fld-bare",
											id: "bare",
											label: "Bare",
										}),
										read("read_elsewhere", ELSEWHERE),
										read("read_bare", BARE),
										read("read_gone", GONE),
									]
								: []),
						],
					},
					...(strayReads
						? [
								{
									uuid: "frm-survey",
									name: "Survey",
									type: "survey" as const,
									fields: [
										f({
											kind: "text",
											uuid: "fld-elsewhere",
											id: "elsewhere",
											label: "Elsewhere",
											validate_msg: "Please check",
										}),
									],
								},
							]
						: []),
				],
			},
		],
	});
}

/** Every itext id the form's source writes. */
function writtenItextIds(source: string): Set<string> {
	const ids = new Set<string>();
	const walk = (node: AnyNode, inItext: boolean) => {
		if (!isTag(node)) return;
		const inside = inItext || node.name === "itext";
		if (inside && node.name === "text" && node.attribs.id !== undefined)
			ids.add(node.attribs.id);
		for (const child of node.children) walk(child, inside);
	};
	for (const child of parseXml(source).children) walk(child, false);
	return ids;
}

function formSource(doc: ReturnType<typeof fixture>): string {
	const source = expandDoc(doc, { attachmentTarget: null })._attachments[
		`${DERIVED_WIRE_IDENTITY.formUniqueId(FORM)}.xml`
	];
	if (source === undefined) throw new Error("The form has no source.");
	return source;
}

describe("a read of a question's validation message", () => {
	it("is refused at the read where the form writes no message", () => {
		const doc = fixture();
		const refusals = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.details?.identity === "validation-message",
		);
		expect(
			refusals.map((error) => ({
				code: error.code,
				reader: error.location.fieldId,
				slot: error.location.field,
				question: error.details?.questionId,
			})),
		).toEqual([
			{
				code: "INVALID_REF",
				reader: "read_plain",
				slot: "calculate",
				question: "plain",
			},
		]);
	});

	it("is the checker's refusal alone where the form holds no such message", () => {
		const doc = fixture(true);
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
			.filter(
				(error) =>
					error.details?.identity === "validation-message" ||
					error.details?.identity === "wording",
			)
			.map((error) => ({
				identity: error.details?.identity,
				reader: error.location.fieldId,
			}));
		expect(
			findings.sort((a, b) => `${a.reader}`.localeCompare(`${b.reader}`)),
		).toEqual([
			{ identity: "wording", reader: "read_bare" },
			{ identity: "wording", reader: "read_elsewhere" },
			{ identity: "wording", reader: "read_gone" },
			{ identity: "validation-message", reader: "read_plain" },
		]);
	});

	it("names an entry the XForm writes wherever the gate admits it, and Preview holds the same entries", () => {
		const doc = fixture();
		expect([...constraintCarryingQuestions(doc, FORM)].sort()).toEqual(
			[NAME, CHECKED].sort(),
		);
		const written = writtenItextIds(formSource(doc));
		const preview = previewFormText(doc, FORM);
		for (const [field, text] of [
			[NAME, "Write the household's name"],
			[CHECKED, "Anything but x"],
		] as const) {
			const id = itextIdFor(doc, message(field));
			expect(id).toBeDefined();
			expect(written.has(id as string)).toBe(true);
			expect(preview.itext[id as string]).toBe(text);
		}
		const plain = itextIdFor(doc, message(PLAIN)) as string;
		expect(written.has(plain)).toBe(false);
		expect(Object.hasOwn(preview.itext, plain)).toBe(false);
		// Preview's table holds exactly the entries the form's source writes.
		expect(Object.keys(preview.itext).sort()).toEqual(
			[...written].filter((id) => !id.includes(";")).sort(),
		);
	});
});
