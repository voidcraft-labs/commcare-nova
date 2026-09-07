import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Field, Module } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { caseWriteGuidance } from "../caseWritePresentation";

const ordinary: Field = {
	kind: "text",
	id: "phone",
	uuid: testUuid("phone"),
	label: proseText("Phone"),
	caseWrite: { caseType: "patient", property: "phone" },
};
const multiple: Pick<Module, "caseType" | "caseListConfig"> = {
	caseType: "patient",
	caseListConfig: {
		searchInputs: [],
		columns: [],
		listColumnOrder: [],
		detailColumnOrder: [],
		selection: { kind: "multiple", maximum: 10 },
	},
};
const scope = { module: multiple, form: { type: "followup" as const } };
describe("actual case-write guidance projection", () => {
	it("explains blank writes in the selected primary-case scope", () => {
		expect(caseWriteGuidance(ordinary, scope, ordinary.caseWrite)).toEqual({
			writesEverySelectedCase: true,
			warning: false,
			help: "This question starts blank. Any answer someone enters updates this information on every selected case. Leaving it blank keeps each case's current value.",
		});
	});
	it("warns about a starting answer and a hidden calculation", () => {
		const expression = { parts: [{ kind: "text" as const, text: "'value'" }] };
		const withDefault = { ...ordinary, default_value: expression };
		const hidden: Field = {
			kind: "hidden",
			id: "computed",
			uuid: testUuid("computed"),
			calculate: expression,
		};
		for (const field of [withDefault, hidden]) {
			const guidance = caseWriteGuidance(field, scope, ordinary.caseWrite);
			expect(guidance.warning).toBe(true);
			expect(guidance.help).toContain("even if no one changes it");
		}
	});
	it("distinguishes capture link and attachment semantics", () => {
		const image: Field = {
			kind: "image",
			id: "photo",
			uuid: testUuid("photo"),
			label: proseText("Photo"),
		};
		const link = caseWriteGuidance(image, scope, {
			caseType: "patient",
			property: "photo",
			mode: "url",
		});
		const attachment = caseWriteGuidance(image, scope, {
			caseType: "patient",
			property: "photo",
			mode: "attachment",
		});
		expect(link.help).toContain("its stored link updates");
		expect(link.help).toContain("does not create that stored link");
		expect(attachment.help).toContain("does not create case attachments");
		expect(link.warning).toBe(true);
		expect(attachment.warning).toBe(true);
	});
	it("withholds several-case guidance outside a loading primary-case write", () => {
		for (const context of [
			null,
			{ ...scope, form: { type: "registration" as const } },
			{ ...scope, form: { type: "survey" as const } },
			{ ...scope, module: { caseType: "patient" } },
		])
			expect(caseWriteGuidance(ordinary, context, ordinary.caseWrite)).toEqual({
				writesEverySelectedCase: false,
				help: undefined,
				warning: false,
			});
		for (const current of [undefined, { caseType: "visit", property: "note" }])
			expect(caseWriteGuidance(ordinary, scope, current).help).toBeUndefined();
	});
});
