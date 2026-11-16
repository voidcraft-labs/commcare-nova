/**
 * `formSourceTexts` against the emitted form: every authored text the HQ
 * source holds as plain text, outside `<itext>` and outside a formula, is an
 * entry, and every entry is text the source holds.
 *
 * Each document gives every authored text its own marker, so a text node or
 * an attribute holding a marker names the text it came from: the form's name,
 * the Connect texts, a label, a hint, a help text, a choice's label and value,
 * a group's label, and a validation message both plain and composed with a
 * reference. A message attribute is read as a formula only where it parses as
 * one, so a message written there as words is seen. A choice's
 * value is the one other plain text the source holds, and its own grammar
 * refuses one CommCare HQ reads as an instance
 * (`lib/domain/selectOptionValue.ts`, `instance-read`), so it is listed here
 * and not an entry. Plausible failures: the
 * emitter writing an authored text at a new place outside itext (the defect
 * returning where the rule does not look), and an entry the emitter no
 * longer writes.
 */
import { type AnyNode, isTag, isText } from "domhandler";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type ConnectConfig,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { runValidation } from "../../validator/runner";
import { parseXml } from "../../xmlParse";
import { isParseableXPath } from "../pathExpression";
import { formSourceTexts } from "../sourceTexts";

/** Attributes whose value is a formula or a generated reference. */
const FORMULA_ATTRIBUTES = new Set([
	"nodeset",
	"ref",
	"calculate",
	"relevant",
	"constraint",
	"required",
	"readonly",
	"value",
	"event",
	"jr:count",
]);

/**
 * Attributes that hold a message: a formula where Nova writes one (an itext
 * read, or a composed validation message), and plain text where a writer puts
 * the message's words there instead.
 */
const MESSAGE_ATTRIBUTES = new Set(["jr:constraintMsg", "jr:requiredMsg"]);

const MARKER = /zq[0-9]+zq/g;

/** Marker `n`, a token no other text of the document holds. */
const m = (n: number) => `zq${n}zq`;

/**
 * Every marker the source holds as plain text: in a text node outside
 * `<itext>`, or in an attribute that holds no formula.
 */
function plainMarkers(source: string): Set<string> {
	const found = new Set<string>();
	const read = (value: string) => {
		for (const match of value.matchAll(MARKER)) found.add(match[0]);
	};
	const walk = (node: AnyNode) => {
		if (isText(node)) {
			read(node.data);
			return;
		}
		if (!isTag(node)) return;
		if (node.name === "itext") return;
		for (const [name, value] of Object.entries(node.attribs)) {
			if (FORMULA_ATTRIBUTES.has(name) || name.startsWith("vellum:")) continue;
			if (MESSAGE_ATTRIBUTES.has(name) && isParseableXPath(value)) continue;
			read(value);
		}
		for (const child of node.children) walk(child);
	};
	for (const child of parseXml(source).children) walk(child);
	return found;
}

function sourceOf(doc: BlueprintDoc, formUuid: Uuid): string {
	const source = expandDoc(doc, { attachmentTarget: null })._attachments[
		`${DERIVED_WIRE_IDENTITY.formUniqueId(formUuid)}.xml`
	];
	if (source === undefined) throw new Error("The form has no source.");
	return source;
}

/** Every marker the source holds anywhere, itext and formulas included. */
function sourceMarkers(source: string): Set<string> {
	return new Set(Array.from(source.matchAll(MARKER), (match) => match[0]));
}

/** The markers `markedForm` gives a form from `first`, with its Connect and
 *  choice-value markers. */
function givenMarkers(first: number, rest: readonly number[]): Set<string> {
	return new Set(
		[...Array.from({ length: 10 }, (_, n) => first + n), ...rest].map(m),
	);
}

/** The markers of `formSourceTexts`, each once. */
function entryMarkers(doc: BlueprintDoc, formUuid: Uuid): Set<string> {
	const found = new Set<string>();
	for (const { text } of formSourceTexts(doc, formUuid))
		for (const match of text.matchAll(MARKER)) found.add(match[0]);
	return found;
}

/** A form whose every authored text holds its own marker, from `first`. */
function markedForm(
	uuid: string,
	first: number,
	connect: ConnectConfig,
	choiceValue: string,
) {
	return {
		uuid,
		name: `Form ${m(first)}`,
		type: "survey" as const,
		connect,
		fields: [
			{
				kind: "text" as const,
				uuid: `${uuid}-notes`,
				id: "notes",
				label: proseText(`Notes ${m(first + 1)}`),
				hint: proseText(`Hint ${m(first + 2)}`),
				help: proseText(`Help ${m(first + 3)}`),
				validate: ". != 'x'",
				validate_msg: proseText(`Check ${m(first + 6)}`),
			},
			{
				kind: "single_select" as const,
				id: "stage",
				label: proseText(`Stage ${m(first + 4)}`),
				options: [{ value: choiceValue, label: `Open ${m(first + 5)}` }],
			},
			{
				kind: "group" as const,
				id: "details",
				label: proseText(`Details ${m(first + 7)}`),
				children: [
					{
						kind: "text" as const,
						id: "remark",
						label: proseText(`Remark ${m(first + 8)}`),
						validate: ". != 'x'",
						/* A reference composes the message in the constraint
						 * formula (`constraintMessage.ts`). */
						validate_msg: {
							parts: [
								{ kind: "text" as const, text: `Seen ${m(first + 9)} ` },
								{ kind: "field-ref" as const, uuid: testUuid(`${uuid}-notes`) },
							],
						},
					},
				],
			},
		],
	};
}

describe("formSourceTexts", () => {
	it("is every plain text a learn form's source holds, but its choice values", () => {
		const doc = buildDoc({
			appName: "Source texts",
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						markedForm(
							"source-texts-learn",
							10,
							{
								learn_module: {
									id: "lesson",
									name: `Lesson ${m(20)}`,
									description: `About ${m(21)}`,
									time_estimate: 5,
								},
								assessment: { id: "quiz" },
							},
							m(30),
						),
					],
				},
			],
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const form = testUuid("source-texts-learn");
		expect(formSourceTexts(doc, form).map(({ site }) => site)).toEqual([
			"form-name",
			"learn-module-name",
			"learn-module-description",
		]);
		const entries = entryMarkers(doc, form);
		expect(entries).toEqual(new Set([m(10), m(20), m(21)]));
		const source = sourceOf(doc, form);
		expect(sourceMarkers(source)).toEqual(givenMarkers(10, [20, 21, 30]));
		expect(plainMarkers(source)).toEqual(new Set([...entries, m(30)]));
	});

	it("is every plain text a deliver form's source holds, its deliver unit's and its task's", () => {
		const doc = buildDoc({
			appName: "Source texts",
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						markedForm(
							"source-texts-deliver",
							40,
							{ deliver_unit: { id: "visit_unit", name: `Visit ${m(50)}` } },
							m(51),
						),
						markedForm(
							"source-texts-task",
							60,
							{
								task: {
									id: "follow_up",
									name: `Follow up ${m(70)}`,
									description: `Call back ${m(71)}`,
								},
							},
							m(72),
						),
					],
				},
			],
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const deliver = testUuid("source-texts-deliver");
		const task = testUuid("source-texts-task");
		expect(formSourceTexts(doc, deliver).map(({ site }) => site)).toEqual([
			"form-name",
			"deliver-unit-name",
		]);
		expect(formSourceTexts(doc, task).map(({ site }) => site)).toEqual([
			"form-name",
			"task-name",
			"task-description",
		]);
		expect(sourceMarkers(sourceOf(doc, deliver))).toEqual(
			givenMarkers(40, [50, 51]),
		);
		expect(plainMarkers(sourceOf(doc, deliver))).toEqual(
			new Set([...entryMarkers(doc, deliver), m(51)]),
		);
		expect(sourceMarkers(sourceOf(doc, task))).toEqual(
			givenMarkers(60, [70, 71, 72]),
		);
		expect(plainMarkers(sourceOf(doc, task))).toEqual(
			new Set([...entryMarkers(doc, task), m(72)]),
		);
	});

	it("names the form by its name in the default language", () => {
		const doc = buildDoc({
			appName: "Source texts",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							uuid: "source-texts-survey",
							name: "Practice",
							type: "survey",
							fields: [
								{ kind: "text", id: "notes", label: proseText("Notes") },
							],
						},
					],
				},
			],
		});
		expect(formSourceTexts(doc, testUuid("source-texts-survey"))).toEqual([
			{ site: "form-name", text: "Practice" },
		]);
	});
});
