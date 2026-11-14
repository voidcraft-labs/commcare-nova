import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	ProseProjectionError,
	type ProseTemplate,
	printProseTemplate,
	projectProseTemplate,
	proseAtomParts,
	proseReferenceParts,
	proseTemplateText,
	type ReferenceNamesDoc,
	resolveProseTemplate,
} from "@/lib/domain";

const FORM = testUuid("prose-form");
const FIELD = testUuid("prose-field");
const USER_PROPERTY = testUuid("prose-user-property");

function makeDoc(): ReferenceNamesDoc {
	return {
		forms: { [FORM]: {} },
		fields: { [FIELD]: { id: "first_name" } },
		fieldOrder: { [FORM]: [FIELD] },
		userProperties: { [USER_PROPERTY]: { slug: "district" } },
	};
}

const TEMPLATE: ProseTemplate = {
	parts: [
		{ kind: "field-ref", uuid: FIELD },
		{ kind: "text", text: " / " },
		{ kind: "user-property-ref", userPropertyUuid: USER_PROPERTY },
		{ kind: "text", text: " / " },
		{ kind: "user-ref", property: "commcare_project" },
	],
};

describe("prose identity projection", () => {
	it("resolves current friendly names without rewriting the template", () => {
		const doc = makeDoc();
		const original = structuredClone(TEMPLATE);
		expect(projectProseTemplate(TEMPLATE, doc)).toEqual({
			ok: true,
			text: "#form/first_name / #user/district / #user/commcare_project",
		});
		doc.fields[FIELD] = { id: "given_name" };
		doc.userProperties = { [USER_PROPERTY]: { slug: "region" } };
		expect(projectProseTemplate(TEMPLATE, doc)).toEqual({
			ok: true,
			text: "#form/given_name / #user/region / #user/commcare_project",
		});
		expect(TEMPLATE).toEqual(original);
	});

	it("returns the authored text alone, spelling no reference at all", () => {
		// `proseTemplateText` is not a projection: a reference's spelling only
		// exists relative to a document, so this returns exactly what the author
		// typed and skips every reference part. That is stronger than the
		// context-free projector it replaced, which always emitted SOMETHING for
		// a reference and so had to invent repair text for the two arms it could
		// not resolve.
		const projected = proseTemplateText(TEMPLATE);
		expect(projected).toBe(" /  / ");
		expect(projected).not.toContain(FIELD);
		expect(projected).not.toContain(USER_PROPERTY);
		expect(projected).not.toContain("#form/");
		expect(projected).not.toContain("#user/");
	});

	it("shows repair text to people and fails closed for wire/runtime projection", () => {
		const doc = makeDoc();
		delete doc.fields[FIELD];
		delete doc.userProperties?.[USER_PROPERTY];

		const projected = projectProseTemplate(TEMPLATE, doc);
		expect(projected).toEqual({
			ok: false,
			text: "#form/[reference needs repair] / #user/[reference needs repair] / #user/commcare_project",
			unresolved: [
				{ kind: "field-ref", identity: FIELD },
				{ kind: "user-property-ref", identity: USER_PROPERTY },
			],
		});
		expect(projected.text).not.toContain(FIELD);
		expect(projected.text).not.toContain(USER_PROPERTY);
		expect(() => printProseTemplate(TEMPLATE, doc)).toThrow(
			ProseProjectionError,
		);
		expect(() => resolveProseTemplate(TEMPLATE, doc, String)).toThrow(
			ProseProjectionError,
		);
	});
});

describe("a calculated value in prose", () => {
	const VALUE_TEMPLATE: ProseTemplate = {
		parts: [
			{ kind: "text", text: "Due " },
			{
				kind: "value",
				expression: { kind: "term", term: { kind: "literal", value: 3 } },
			},
		],
	};

	it("prints through the caller's printer, and reads [calculated value] with none", () => {
		const doc = makeDoc();
		expect(projectProseTemplate(VALUE_TEMPLATE, doc)).toEqual({
			ok: true,
			text: "Due [calculated value]",
		});
		expect(
			printProseTemplate(VALUE_TEMPLATE, doc, { value: () => "today() + 3" }),
		).toBe("Due today() + 3");
		expect(() => printProseTemplate(VALUE_TEMPLATE, doc)).toThrow(
			ProseProjectionError,
		);
	});

	it("is no typed text and no reference part", () => {
		expect(proseTemplateText(VALUE_TEMPLATE)).toBe("Due ");
		expect(proseReferenceParts(VALUE_TEMPLATE)).toEqual([]);
		expect(proseAtomParts(VALUE_TEMPLATE)).toEqual([VALUE_TEMPLATE.parts[1]]);
	});

	it("hands every atom, a value among them, to a runtime evaluator", () => {
		const doc = makeDoc();
		const seen: string[] = [];
		expect(
			resolveProseTemplate(
				{
					parts: [
						{ kind: "field-ref", uuid: FIELD },
						{ kind: "text", text: ": " },
						...VALUE_TEMPLATE.parts.slice(1),
					],
				},
				doc,
				(part) => {
					seen.push(part.kind);
					return part.kind === "value" ? "3" : "Ana";
				},
			),
		).toBe("Ana: 3");
		expect(seen).toEqual(["field-ref", "value"]);
	});
});
