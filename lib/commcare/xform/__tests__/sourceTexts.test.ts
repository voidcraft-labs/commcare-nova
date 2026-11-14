/**
 * `formSourceTexts` against the emitted form: every authored text the HQ
 * source holds as plain text, outside `<itext>` and outside a formula, is an
 * entry, and every entry is text the source holds.
 *
 * Each document gives every authored text its own marker, so a text node or
 * an attribute holding a marker names the text it came from. A choice's
 * value is the one other plain text the source holds, and it can hold no
 * quote mark, so it is listed here and not an entry. Plausible failures: the
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
	"jr:constraintMsg",
	"jr:requiredMsg",
]);

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
		for (const [name, value] of Object.entries(node.attribs))
			if (!FORMULA_ATTRIBUTES.has(name) && !name.startsWith("vellum:"))
				read(value);
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
				id: "notes",
				label: proseText(`Notes ${m(first + 1)}`),
				hint: proseText(`Hint ${m(first + 2)}`),
				help: proseText(`Help ${m(first + 3)}`),
			},
			{
				kind: "single_select" as const,
				id: "stage",
				label: proseText(`Stage ${m(first + 4)}`),
				options: [{ value: choiceValue, label: `Open ${m(first + 5)}` }],
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
		expect(plainMarkers(sourceOf(doc, form))).toEqual(
			new Set([...entries, m(30)]),
		);
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
		expect(plainMarkers(sourceOf(doc, deliver))).toEqual(
			new Set([...entryMarkers(doc, deliver), m(51)]),
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
