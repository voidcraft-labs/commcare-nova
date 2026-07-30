import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	ProseProjectionError,
	type ProseTemplate,
	printProseTemplate,
	projectProseTemplate,
	proseTemplateText,
	resolveProseTemplate,
	type XPathPrintableDoc,
} from "@/lib/domain";

const FORM = testUuid("prose-form");
const FIELD = testUuid("prose-field");
const USER_PROPERTY = testUuid("prose-user-property");

function makeDoc(): XPathPrintableDoc {
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
	it("prints current friendly names while preserving UUID-backed storage", () => {
		const doc = makeDoc();
		expect(projectProseTemplate(TEMPLATE, doc)).toEqual({
			ok: true,
			text: "#form/first_name / #user/district / #user/commcare_project",
		});
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
