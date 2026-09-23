import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { evaluateForm } from "@/lib/preview/engine/evaluateForm";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import { previewAsMe } from "@/lib/preview/engine/identity";

it("authors retained query-row identities and reads each record without rebuilding membership after answers change", async () => {
	const h = makeAuthoringHarness();
	const call = async (name: string, input: unknown) => {
		const result = await h.call(name, input);
		expect(result).not.toHaveProperty("error");
		return result;
	};
	await call("generateSchema", {
		caseTypes: [
			{
				name: "asset",
				properties: [{ name: "zone", label: "Zone", data_type: "text" }],
			},
		],
	});
	await call("createModule", {
		name: "Assets",
		case_type: "asset",
		forms: [
			{
				name: "Check assets",
				type: "survey",
				fields: [
					{ kind: "text", id: "zone", label: "Zone" },
					{
						kind: "repeat",
						id: "assets",
						label: "Assets",
						fieldUuid: "b7aba25c-8b1b-4882-bfe2-7bced9f36fe9",
						repeat: {
							mode: "query_bound",
							ids_query:
								"instance('casedb')/casedb/case[@case_type = 'asset'][zone = 'north'][#form/zone != 'south']/@case_id",
						},
					},
					{
						kind: "hidden",
						parentUuid: "b7aba25c-8b1b-4882-bfe2-7bced9f36fe9",
						id: "row_id",
						calculate: "current()/../@id",
					},
					{
						kind: "hidden",
						parentUuid: "b7aba25c-8b1b-4882-bfe2-7bced9f36fe9",
						id: "asset_name",
						calculate:
							"instance('casedb')/casedb/case[@case_id = current()/../@id]/case_name",
					},
					{
						kind: "text",
						parentUuid: "b7aba25c-8b1b-4882-bfe2-7bced9f36fe9",
						id: "note",
						label: "Condition of {{asset_name}}",
					},
				],
			},
		],
	});
	const doc = h.currentDoc();
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Check assets",
	)?.uuid;
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (!formUuid || !identity) throw new Error("Missing form or identity.");
	const cases = evaluationScenarioCases(doc, identity.ownerId, {
		records: [
			{
				id: "pump",
				caseType: "asset",
				name: "Pump",
				properties: { zone: "north" },
			},
			{
				id: "tap",
				caseType: "asset",
				name: "Tap",
				properties: { zone: "north" },
			},
			{
				id: "tank",
				caseType: "asset",
				name: "Tank",
				properties: { zone: "south" },
			},
		],
	});
	const result = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [
				{ path: "zone", value: "south" },
				{ path: "assets[1]/note", value: "Working" },
			],
		},
		{
			identity,
			cases,
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		},
	);
	expect(result.valid).toBe(true);
	expect(result.fields).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ path: "zone", value: "south" }),
			expect.objectContaining({ path: "assets", repeatCount: 2 }),
			expect.objectContaining({ path: "assets[0]/row_id", value: "pump" }),
			expect.objectContaining({ path: "assets[0]/asset_name", value: "Pump" }),
			expect.objectContaining({ path: "assets[1]/row_id", value: "tap" }),
			expect.objectContaining({ path: "assets[1]/asset_name", value: "Tap" }),
			expect.objectContaining({ path: "assets[1]/note", value: "Working" }),
		]),
	);
});
