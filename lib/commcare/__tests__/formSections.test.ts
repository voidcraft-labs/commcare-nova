/**
 * A section on the wire: a DATA group that is ALWAYS a field-list.
 *
 * The shape is the one CommCare pages on Android and in one-question-per-
 * screen Web Apps: `<group ref="/data/<id>" appearance="field-list">` over an
 * instance node of its own (Vellum's `tests/static/all_question_types.xml`
 * field-list group; HQ's `xform.py::_infer_vellum_type` reads the attribute
 * back as `FieldList`). A titled section carries a `<label>` through itext
 * like a group; an untitled one carries neither the label nor an itext entry,
 * and still carries the appearance, which is what makes it a page. A section
 * has no `relevant` by schema, so it emits no `<bind>` of its own.
 *
 * Groups INSIDE a section keep their own rule — labelled = field-list,
 * transparent = no attribute — so the section's page is the outer screen and
 * a nested labelled group is chrome on it, never a second page.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { proseText } from "@/lib/domain/prose";

function firstFormXml(doc: ReturnType<typeof buildDoc>): string {
	const attachments = expandDoc(doc)._attachments;
	const first = Object.values(attachments)[0];
	if (typeof first !== "string") {
		throw new Error("expected the first attachment to be the XForm XML");
	}
	return first;
}

function formXml(fields: FieldSpec[]): string {
	return firstFormXml(
		buildDoc({
			appName: "Sections",
			modules: [
				{ name: "M", forms: [{ name: "Visit", type: "survey", fields }] },
			],
		}),
	);
}

function text(id: string): FieldSpec {
	return f({ kind: "text", id, label: proseText(id) });
}

describe("sections on the wire", () => {
	it("emits a titled section as a labelled data group that is a field-list", () => {
		const xml = formXml([
			f({
				kind: "section",
				id: "intake",
				label: proseText("About you"),
				children: [text("name"), text("age")],
			}),
		]);
		expect(xml).toContain('<group ref="/data/intake" appearance="field-list">');
		expect(xml).toContain('<label ref="jr:itext(&apos;intake-label&apos;)"/>');
		expect(xml).toContain("<intake>");
		expect(xml).toContain('<input ref="/data/intake/name">');
		expect(xml).toContain('nodeset="/data/intake/name"');
		expect(xml).not.toContain('nodeset="/data/intake"');
		expect(validateXForm(xml, "Visit", "M")).toEqual([]);
	});

	it("emits an untitled section as a field-list with no label and no itext", () => {
		const xml = formXml([
			f({ kind: "section", id: "intake", children: [text("name")] }),
		]);
		expect(xml).toContain('<group ref="/data/intake" appearance="field-list">');
		expect(xml).not.toContain("intake-label");
		expect(xml).not.toContain(
			'<label ref="jr:itext(&apos;intake-label&apos;)"/>',
		);
		expect(xml).toContain("<intake>");
		expect(validateXForm(xml, "Visit", "M")).toEqual([]);
	});

	it("keeps a nested group's own rule: labelled is a field-list, transparent is not", () => {
		const xml = formXml([
			f({
				kind: "section",
				id: "intake",
				label: proseText("About you"),
				children: [
					f({
						kind: "group",
						id: "named",
						label: proseText("Contact"),
						children: [text("phone")],
					}),
					f({
						kind: "group",
						id: "plain",
						label: proseText(""),
						children: [text("note")],
					}),
				],
			}),
		]);
		expect(xml).toContain('<group ref="/data/intake" appearance="field-list">');
		expect(xml).toContain(
			'<group ref="/data/intake/named" appearance="field-list">',
		);
		expect(xml).toContain('<group ref="/data/intake/plain">');
		expect(xml).not.toContain(
			'<group ref="/data/intake/plain" appearance="field-list">',
		);
		expect(validateXForm(xml, "Visit", "M")).toEqual([]);
	});

	it("emits an empty section as an empty field-list group over its own node", () => {
		const xml = formXml([
			f({ kind: "section", id: "first", children: [text("name")] }),
			f({
				kind: "section",
				id: "empty",
				label: proseText("Later"),
				children: [],
			}),
		]);
		expect(xml).toContain('<group ref="/data/empty" appearance="field-list">');
		expect(xml).toContain("<empty/>");
		expect(validateXForm(xml, "Visit", "M")).toEqual([]);
	});

	it("pages a case-bearing form over section-nested paths and still installs", () => {
		const doc = buildDoc({
			appName: "Sections",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "section",
									id: "intake",
									label: proseText("About you"),
									children: [
										f({
											kind: "text",
											id: "name",
											label: proseText("Name"),
											caseWrite: { caseType: "patient", property: "case_name" },
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		expect(xml).toContain('<group ref="/data/intake" appearance="field-list">');
		expect(xml).toContain('nodeset="/data/intake/name"');
		expect(validateXForm(xml, "Register", "Patients")).toEqual([]);
	});
});
