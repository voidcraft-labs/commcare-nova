import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { evaluateForm } from "@/lib/preview/engine/evaluateForm";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import { previewAsMe } from "@/lib/preview/engine/identity";

it.each([false, true])(
	"follows a query that reads an answer, keeping each row's place and its answers (default: %s)",
	async (useDefault) => {
		const h = makeAuthoringHarness(
			{},
			namedFormFixture([
				{
					name: "Assets",
					caseType: "asset",
					forms: [{ name: "Check assets", type: "survey" }],
				},
			]),
		);
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
		await call("addFields", {
			moduleUuid: "Assets",
			formUuid: "Check assets",
			fields: [
				{
					kind: "text",
					id: "zone",
					label: "Zone",
					...(useDefault ? { default_value: "'north'" } : {}),
				},
				{
					kind: "repeat",
					id: "assets",
					label: "Assets",
					fieldUuid: "b7aba25c-8b1b-4882-bfe2-7bced9f36fe9",
					repeat: {
						mode: "query_bound",
						ids_query: useDefault
							? "instance('casedb')/casedb/case[@case_type = 'asset'][zone = #form/zone]/@case_id"
							: "instance('casedb')/casedb/case[@case_type = 'asset'][zone = 'north'][#form/zone != 'south']/@case_id",
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
		});
		await call("removeField", {
			moduleUuid: "Assets",
			formUuid: "Check assets",
			fieldUuid: "fixture_placeholder",
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
		const evaluate = (zones: string[]) =>
			evaluateForm(
				doc,
				{
					formUuid,
					answers: [
						{ path: "assets[1]/note", value: "Working" },
						...zones.map((value) => ({ path: "zone", value })),
					],
				},
				{
					device: webAppsDevice(),
					identity,
					cases,
					lookup: {
						projectRevision: "0",
						definitions: [],
						rowsByTable: new Map(),
					},
				},
			);
		/* The query reads an answer, so its rows follow it (the count
		 * placement): the south zone keeps the rows already made, and a row
		 * past the end of the new result leaves the form with its answer kept. */
		const shrunk = await evaluate(["south"]);
		expect(shrunk.valid).toBe(true);
		expect(shrunk.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "zone", value: "south" }),
				expect.objectContaining({ path: "assets", repeatCount: 2 }),
				expect.objectContaining({
					path: "assets[1]/note",
					participates: false,
					retainedValue: "Working",
				}),
				...(useDefault
					? [
							expect.objectContaining({
								path: "assets[0]/row_id",
								value: "tank",
							}),
							expect.objectContaining({
								path: "assets[0]/asset_name",
								value: "Tank",
							}),
						]
					: [
							expect.objectContaining({
								path: "assets[0]/row_id",
								participates: false,
							}),
						]),
			]),
		);
		/* Back in the north zone the rows hold the result again, and the
		 * second row's answer is where it was. */
		const restored = await evaluate(["south", "north"]);
		expect(restored.valid).toBe(true);
		expect(restored.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "assets", repeatCount: 2 }),
				expect.objectContaining({ path: "assets[0]/row_id", value: "pump" }),
				expect.objectContaining({
					path: "assets[0]/asset_name",
					value: "Pump",
				}),
				expect.objectContaining({ path: "assets[1]/row_id", value: "tap" }),
				expect.objectContaining({ path: "assets[1]/asset_name", value: "Tap" }),
				expect.objectContaining({ path: "assets[1]/note", value: "Working" }),
			]),
		);
	},
);
