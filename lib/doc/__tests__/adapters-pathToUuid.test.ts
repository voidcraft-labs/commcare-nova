import { describe, expect, it } from "vitest";
import {
	resolveFormUuid,
	resolveModuleUuid,
	resolveQuestionUuid,
} from "@/lib/doc/adapters/pathToUuid";
import { toDoc } from "@/lib/doc/converter";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

function fixture(): AppBlueprint {
	return {
		app_name: "Test",
		connect_type: undefined,
		case_types: null,
		modules: [
			{
				name: "M0",
				forms: [
					{
						name: "F0",
						type: "survey",
						questions: [
							{
								uuid: "q-top-0000-0000-0000-000000000000",
								id: "name",
								type: "text",
								label: "Name",
							},
							{
								uuid: "q-grp-0000-0000-0000-000000000000",
								id: "grp",
								type: "group",
								label: "Grp",
								children: [
									{
										uuid: "q-inner-0000-0000-0000-000000000000",
										id: "inner",
										type: "text",
										label: "Inner",
									},
								],
							},
						],
					},
				],
			},
			{ name: "M1", forms: [] },
		],
	};
}

describe("resolveModuleUuid", () => {
	it("returns the module uuid at the given mIdx", () => {
		const doc = toDoc(fixture(), "app");
		const uuid = resolveModuleUuid(doc, 1);
		expect(uuid).toBe(doc.moduleOrder[1]);
	});

	it("returns undefined for out-of-range mIdx", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveModuleUuid(doc, 5)).toBeUndefined();
		expect(resolveModuleUuid(doc, -1)).toBeUndefined();
	});
});

describe("resolveFormUuid", () => {
	it("returns the form uuid at (mIdx, fIdx)", () => {
		const doc = toDoc(fixture(), "app");
		const modUuid = doc.moduleOrder[0];
		const formUuid = resolveFormUuid(doc, 0, 0);
		expect(formUuid).toBe(doc.formOrder[modUuid][0]);
	});

	it("returns undefined when module or form is missing", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveFormUuid(doc, 0, 5)).toBeUndefined();
		expect(resolveFormUuid(doc, 5, 0)).toBeUndefined();
	});
});

describe("resolveQuestionUuid", () => {
	it("resolves a top-level question by id", () => {
		const doc = toDoc(fixture(), "app");
		const uuid = resolveQuestionUuid(doc, 0, 0, "name");
		expect(uuid).toBe("q-top-0000-0000-0000-000000000000");
	});

	it("resolves a nested child via slash-delimited path", () => {
		const doc = toDoc(fixture(), "app");
		const uuid = resolveQuestionUuid(doc, 0, 0, "grp/inner");
		expect(uuid).toBe("q-inner-0000-0000-0000-000000000000");
	});

	it("returns undefined for an unknown id", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveQuestionUuid(doc, 0, 0, "grp/missing")).toBeUndefined();
	});

	it("returns undefined when form is missing", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveQuestionUuid(doc, 5, 0, "name")).toBeUndefined();
	});
});
