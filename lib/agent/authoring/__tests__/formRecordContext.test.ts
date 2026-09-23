import { expect, it } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { evaluateForm } from "@/lib/preview/engine/evaluateForm";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import { previewAsMe } from "@/lib/preview/engine/identity";

it("uses the form's published ancestor reference to validate against the selected record's actual parent", async () => {
	const h = makeAuthoringHarness();
	const call = async (name: string, input: unknown) => {
		const result = await h.call(name, input);
		expect(result).not.toHaveProperty("error");
		return result;
	};
	await call("generateSchema", {
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "limit", label: "Limit", data_type: "int" }],
			},
			{ name: "visit", parent_type: "household", properties: [] },
		],
	});
	await call("createModule", {
		name: "Visits",
		case_type: "visit",
		forms: [
			{
				name: "Record visit",
				type: "followup",
				fields: [{ kind: "int", id: "amount", label: "Amount" }],
			},
			{
				name: "Register",
				type: "registration",
				recordName: "#form/name",
				fields: [{ kind: "text", id: "name", label: "Name" }],
			},
			{
				name: "Visit survey",
				type: "survey",
				fields: [{ kind: "text", id: "note", label: "Note" }],
			},
		],
	});
	const read = z
		.object({
			recordContext: z.object({
				selectedCaseType: z.string().nullable(),
				readableRecords: z.array(
					z.object({
						caseType: z.string(),
						ancestorDepth: z.number(),
						propertyReference: z.string(),
						identityReference: z.string(),
					}),
				),
			}),
		})
		.parse(await call("getForm", { formUuid: "Record visit" }));
	const parent = read.recordContext.readableRecords.find(
		(row) => row.caseType === "household",
	);
	if (!parent) throw new Error("The form did not expose its parent read.");
	expect(parent.ancestorDepth).toBe(1);
	await call("editField", {
		formUuid: "Record visit",
		fieldUuid: "amount",
		updates: {
			validate: {
				expr: `#form/amount <= ${parent.propertyReference.replace("/property", "/limit")}`,
				msg: "Above the household limit",
			},
		},
	});
	await call("addFields", {
		formUuid: "Record visit",
		fields: [
			{
				kind: "hidden",
				id: "household_id",
				calculate: parent.identityReference,
			},
		],
	});
	const doc = h.currentDoc();
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Record visit",
	)?.uuid;
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (!formUuid || !identity) throw new Error("Missing form or identity.");
	const cases = evaluationScenarioCases(doc, identity.ownerId, {
		records: [
			{ id: "home", caseType: "household", properties: { limit: 7 } },
			{ id: "other-home", caseType: "household", properties: { limit: 100 } },
			{ id: "visit", caseType: "visit", parentId: "home" },
		],
	});
	for (const [value, valid] of [
		["8", false],
		["7", true],
	] as const) {
		const result = await evaluateForm(
			doc,
			{ formUuid, caseIds: ["visit"], answers: [{ path: "amount", value }] },
			{
				identity,
				cases,
				lookup: {
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				},
			},
		);
		expect(result.valid).toBe(valid);
		expect(result.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "household_id", value: "home" }),
			]),
		);
	}
	for (const formUuid of ["Register", "Visit survey"]) {
		expect(await call("getForm", { formUuid })).toMatchObject({
			recordContext: { selectedCaseType: null, readableRecords: [] },
		});
	}
	await call("createModule", {
		name: "Bulk visits",
		case_type: "visit",
		forms: [
			{
				name: "Bulk note",
				type: "followup",
				fields: [{ kind: "text", id: "note", label: "Note" }],
			},
		],
	});
	await call("configureCaseSelection", {
		moduleUuid: "Bulk visits",
		selection: { kind: "multiple", maximum: 3 },
	});
	expect(await call("getForm", { formUuid: "Bulk note" })).toMatchObject({
		recordContext: { selectedCaseType: null, readableRecords: [] },
	});
});
