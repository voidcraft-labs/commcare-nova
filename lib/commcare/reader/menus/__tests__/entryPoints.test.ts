/**
 * Deep links read back from Nova's emission: each of the three slots keeps
 * its id, a form's link that ignores display conditions keeps that, and an id
 * HQ's `slugify` would change, or one two links share, is refused. A menu's
 * and a case list's deep link whose frame opens with the case the app's first
 * menu shares is that row's finding at the menu.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { codesOf, formNamed, moduleNamed, readMenusOf } from "./menuReading";

function app(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: {},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
						],
					},
				],
			},
		],
	});
	return produce(doc, (draft) => {
		const [moduleUuid] = draft.moduleOrder;
		const module = draft.modules[moduleUuid as string];
		const formUuid = draft.formOrder[moduleUuid as string]?.[0];
		const form = draft.forms[formUuid as string];
		if (module === undefined || form === undefined)
			throw new Error("The fixture holds no menu.");
		module.entryPoint = { uuid: testUuid("ep-menu"), id: "patients" };
		module.caseListEntryPoint = {
			uuid: testUuid("ep-list"),
			id: "patient-list",
		};
		form.entryPoint = {
			uuid: testUuid("ep-form"),
			id: "visit",
			ignoreDisplayConditions: true,
		};
	});
}

/** Clients shows its one follow-up form on the app's first menu, so every frame through it
 *  opens with the patient that form chooses; Extra keeps its screen under it and lists visits,
 *  and its deep link in `slot` would open with that patient ahead of any command. */
async function sharedFirstMenuReading(
	slot: "entryPoint" | "caseListEntryPoint",
) {
	const doc = buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "visit",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: testUuid("shared-clients"),
					name: "Clients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
				{
					uuid: testUuid("shared-extra"),
					name: "Extra",
					caseType: "visit",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Check",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		},
		(draft) => {
			const extra = draft.modules[testUuid("shared-extra")];
			if (extra === undefined) throw new Error("The fixture holds no Extra.");
			extra.parentModuleUuid = testUuid("shared-clients");
			extra[slot] = { uuid: testUuid(`ep-${slot}`), id: "extra" };
		},
	);
	const reading = await readMenusOf(doc, (json) => {
		// The home selection and the nested visit keep distinct argument IDs after root alignment.
		json.modules[0] = { ...json.modules[0], put_in_root: true } as never;
	});
	return reading;
}

describe("deep links", () => {
	it("reads each slot with its id, and a form's link that ignores display conditions", async () => {
		const reading = await readMenusOf(app());
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		const module = moduleNamed(doc, "Patients");
		expect(module.entryPoint).toEqual({
			uuid: expect.any(String),
			id: "patients",
		});
		expect(module.caseListEntryPoint).toEqual({
			uuid: expect.any(String),
			id: "patient-list",
		});
		expect(formNamed(doc, "Visit").entryPoint).toEqual({
			uuid: expect.any(String),
			id: "visit",
			ignoreDisplayConditions: true,
		});
	});

	it("refuses an id that is no fixed point of HQ's slugify", async () => {
		const reading = await readMenusOf(app(), (json) => {
			json.modules[0] = {
				...json.modules[0],
				session_endpoint_id: "Patients List",
			} as never;
			(
				json.modules[0]?.forms[0] as Record<string, unknown>
			).session_endpoint_id = "visit__";
		});
		expect(codesOf(reading)).toEqual(
			expect.arrayContaining([
				"menus-and-case-lists/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed",
				"forms-and-case-writes/session-endpoint-id-not-a-slug-fixed-point-or-duplicated",
			]),
		);
	});

	it("refuses an id two links share once, at the last slot holding it, under the menus' entry where a menu holds it", async () => {
		const reading = await readMenusOf(app(), (json) => {
			(
				json.modules[0]?.forms[0] as Record<string, unknown>
			).session_endpoint_id = "patients";
		});
		expect(reading.findings.map((one) => [one.code, one.place.kind])).toEqual([
			[
				"menus-and-case-lists/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form",
				"form",
			],
		]);
		const lists = await readMenusOf(app(), (json) => {
			(json.modules[0] as Record<string, unknown>).session_endpoint_id =
				"patient-list";
		});
		expect(lists.findings.map((one) => [one.code, one.place.kind])).toEqual([
			[
				"menus-and-case-lists/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form",
				"menu",
			],
		]);
	});

	it("reads `respect_relevancy: false` with no deep link as nothing", async () => {
		const reading = await readMenusOf(app(), (json) => {
			const form = json.modules[0]?.forms[0] as Record<string, unknown>;
			form.session_endpoint_id = "";
			form.respect_relevancy = false;
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			formNamed(reading.doc as BlueprintDoc, "Visit").entryPoint,
		).toBeUndefined();
	});

	for (const slot of ["entryPoint", "caseListEntryPoint"] as const)
		it(`keeps a ${slot} with distinct first-menu patient and nested visit arguments`, async () => {
			const reading = await sharedFirstMenuReading(slot);
			expect(codesOf(reading)).toEqual([]);
			expect(moduleNamed(reading.doc as BlueprintDoc, "Extra")[slot]?.id).toBe(
				"extra",
			);
		});
});
