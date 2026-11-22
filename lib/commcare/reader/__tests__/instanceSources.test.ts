import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireTable } from "../../lookup/__tests__/lookupWireCorpus";
import { readHqApp } from "../index";
import { exportedBody, inputFor } from "./novaExport";

const currentAge = {
	kind: "term",
	term: { kind: "form-case", caseType: "patient", property: "age" },
} as const;

const clinics = wireTable("clinics", [{ name: "name", type: "text" }]);
const lookup = {
	definitions: new Map([[clinics.id, clinics]]),
	table: (tag: string) =>
		tag === clinics.tag
			? {
					tableId: clinics.id,
					column: (wire: string) =>
						clinics.columns.find((column) => column.wireName === wire)?.id,
				}
			: undefined,
};

const visit = buildDoc({
	caseTypes: [
		{
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		},
	],
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({ kind: "hidden", id: "current_age", calculate: currentAge }),
						f({ kind: "text", id: "note", label: "Note" }),
					],
				},
			],
		},
	],
});

async function readAge(declaration: string, argumentsText: string) {
	const xml = (source: string) =>
		source
			.replace(
				'<instance src="jr://instance/casedb" id="casedb"/>',
				declaration,
			)
			.replace("instance(&apos;casedb&apos;)", `instance(${argumentsText})`);
	return readHqApp(await inputFor(exportedBody(visit, { xml }), { lookup }));
}

describe("reading a grouped instance ID in an HQ form", () => {
	it.each([
		[
			"chosen cases",
			'<instance id="casedb" src="jr://instance/selected-entities/selected_cases"/>',
			"(('casedb'))",
		],
		[
			"lookup fixture",
			'<instance id="casedb" src="jr://fixture/item-list:clinics"/>',
			"(('casedb'))",
		],
		[
			"unknown source",
			'<instance id="casedb" src="jr://unrecognized/source"/>',
			"(('casedb'))",
		],
		[
			"inline root",
			'<instance id="casedb"><choices/></instance>',
			"(('casedb'))",
		],
		["missing declaration", "", "(('casedb'))"],
		[
			"extra argument",
			'<instance id="casedb" src="jr://instance/casedb"/>',
			"(('casedb')), 'extra'",
		],
	])(
		"refuses a case property read from %s",
		async (_label, declaration, args) => {
			const outcome = await readAge(declaration, args);
			expect(outcome.kind).toBe("account");
			expect(outcome.defects).toEqual([]);
		},
	);

	it.each(["casedb", "held_cases"])(
		"reads and republishes the declared case database under %s",
		async (id) => {
			const outcome = await readAge(
				`<instance id="${id}" src="jr://instance/casedb"/>`,
				`(('${id}'))`,
			);
			expect(outcome.kind).toBe("read");
			if (outcome.kind !== "read")
				throw new Error("the source form was refused");
			const field = Object.values(outcome.draft.doc.fields).find(
				(one) => one.id === "current_age",
			);
			expect(field).toMatchObject({ kind: "hidden", calculate: currentAge });
			const again = await readHqApp(
				await inputFor(exportedBody(outcome.draft.doc)),
			);
			expect(again.kind).toBe("read");
			if (again.kind === "read")
				expect(
					Object.values(again.draft.doc.fields).find(
						(one) => one.id === "current_age",
					),
				).toMatchObject({ kind: "hidden", calculate: currentAge });
		},
	);
});
