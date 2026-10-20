import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { chosenCase } from "@/lib/commcare/__tests__/csqlCompositionFixture";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { type ProsePart, proseText } from "@/lib/domain";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { caseRowsToFormPreloads } from "../caseDataBindingClient";
import { EngineController } from "../engineController";
import { searchCsqlReadsCaseDatabase } from "../searchCsqlRuntime";
import { caseDatabaseRequirements } from "../useCaseDatabaseSnapshot";

const MODULE_UUID = testUuid("source-module");
const PROPERTY_UUID = testUuid("prose-worker-property");
const NAME_UUID = testUuid("prose-answer");

describe("caseDatabaseRequirements", () => {
	it("loads the device's cases for a session datum valued over them", () => {
		// `usercase_id` is evaluated over casedb when the entry begins; without
		// the snapshot it reads blank where a device reads the worker's record.
		const readsDatum = (kind: "worker-record" | "selected-case") =>
			buildDoc({
				caseTypes: [{ name: "patient", properties: [] }],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Visit",
								type: "followup",
								postSubmit: "app_home",
								fields: [
									f({
										kind: "hidden",
										id: "datum",
										calculate: {
											kind: "term",
											term: {
												kind: "session-datum",
												datum:
													kind === "worker-record"
														? { kind }
														: { kind, module: testUuid("Patients") },
											},
										},
									}),
								],
							},
						],
					},
				],
			});
		expect(caseDatabaseRequirements(readsDatum("worker-record")).required).toBe(
			true,
		);
		expect(caseDatabaseRequirements(readsDatum("selected-case")).required).toBe(
			false,
		);
	});

	it("carries the worker's places only for an app whose forms read them", () => {
		const withCalculate = (calculate: Parameters<typeof f>[0]["calculate"]) =>
			buildDoc({
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								postSubmit: "app_home",
								fields: [f({ kind: "hidden", id: "read", calculate })],
							},
						],
					},
				],
			});
		const placeCount = withCalculate({
			kind: "count",
			via: { kind: "locations", where: [] },
		});
		expect(caseDatabaseRequirements(placeCount)).toMatchObject({
			required: true,
			places: true,
		});
		const caseCount = withCalculate({
			kind: "count",
			via: { kind: "cases", source: "casedb", where: [] },
		});
		expect(caseDatabaseRequirements(caseCount)).toMatchObject({
			required: true,
			places: false,
		});
	});

	it("captures the entry world for a static previous task without an authored casedb reference", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
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
			],
		});
		expect(caseDatabaseRequirements(doc)).toEqual({
			required: true,
			caseTypes: ["commcare-user", "patient"],
			places: false,
		});
		doc.forms[doc.formOrder[doc.moduleOrder[0]][0]].postSubmit = "app_home";
		expect(caseDatabaseRequirements(doc)).toEqual({
			required: false,
			caseTypes: [],
			places: false,
		});
	});
	it.each([
		{
			slot: "label",
			part: { kind: "case-ref", caseType: "patient", property: "case_name" },
			required: true,
		},
		{
			slot: "hint",
			part: { kind: "user-ref", property: "first_name" },
			required: true,
		},
		{
			slot: "option",
			part: { kind: "user-property-ref", userPropertyUuid: PROPERTY_UUID },
			required: true,
		},
		{
			slot: "label",
			part: {
				kind: "text",
				text: "Literal #patient/case_name and #user/first_name",
			},
			required: false,
		},
		{
			slot: "hint",
			part: { kind: "field-ref", uuid: NAME_UUID },
			required: false,
		},
	] satisfies { slot: string; part: ProsePart; required: boolean }[])(
		"loads only structural record references in prose: $slot $part.kind",
		({ slot, part, required }) => {
			const template = { parts: [part] };
			const doc = buildDoc({
				caseTypes: [{ name: "patient", properties: [] }],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Follow up",
								type: "followup",
								postSubmit: "app_home",
								fields: [
									f({
										uuid: NAME_UUID,
										id: "answer",
										kind: "text",
										label: "Answer",
									}),
									f({
										id: "choice",
										kind: "single_select",
										label: slot === "label" ? template : proseText("Choice"),
										...(slot === "hint" ? { hint: template } : {}),
										optionsSource: {
											kind: "inline",
											options: [
												{
													uuid: testUuid("prose-choice"),
													value: "yes",
													label:
														slot === "option" ? template : proseText("Yes"),
												},
												{
													uuid: testUuid("prose-other-choice"),
													value: "no",
													label: proseText("No"),
												},
											],
										},
									}),
								],
							},
						],
					},
				],
			});
			doc.userProperties = {
				[PROPERTY_UUID]: {
					uuid: PROPERTY_UUID,
					slug: "region",
					label: "Region",
				},
			};
			doc.userPropertyOrder = [PROPERTY_UUID];
			assertAdmittedPreviewDoc(doc);
			expect(caseDatabaseRequirements(doc)).toEqual({
				required,
				caseTypes: required ? ["commcare-user", "patient"] : [],
				places: false,
			});
		},
	);

	it("waits for the required snapshot and renders a prose-only selected record through the async controller", async () => {
		const formUuid = testUuid("prose-followup");
		const fieldUuid = testUuid("prose-context");
		const doc = buildDoc({
			caseTypes: [{ name: "repair", properties: [] }],
			modules: [
				{
					name: "Repairs",
					caseType: "repair",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Item" },
					]),
					forms: [
						{
							uuid: formUuid,
							name: "Repair",
							type: "followup",
							fields: [
								f({
									uuid: fieldUuid,
									id: "context",
									kind: "label",
									label: {
										parts: [
											{ kind: "text", text: "Repairing **" },
											{
												kind: "case-ref",
												caseType: "repair",
												property: "case_name",
											},
											{ kind: "text", text: "**." },
										],
									},
								}),
							],
						},
					],
				},
			],
		});
		assertAdmittedPreviewDoc(doc);
		const requirements = caseDatabaseRequirements(doc);
		if (!requirements.required) throw new Error("Prose did not request cases");
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		const ctrl = new EngineController(
			new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() }),
		);
		const row = {
			case_id: "repair-1",
			app_id: doc.appId,
			case_type: "repair",
			owner_id: "worker",
			status: "open",
			opened_on: null,
			modified_on: null,
			closed_on: null,
			case_name: "Kettle",
			external_id: null,
			parent_case_id: null,
			properties: {},
		} as const;
		try {
			ctrl.setDocStore(store);
			ctrl.setCaseDatabaseState({
				required: requirements.required,
				status: "loading",
			});
			// The record's name reads the device's cases through the entry's
			// session datum, so the entry opens with the record it was chosen for.
			await ctrl.activateFormAsync(
				formUuid,
				caseRowsToFormPreloads(row, [], [{ name: "repair", depth: 0 }]),
				undefined,
				undefined,
				{
					appId: doc.appId,
					boundCases: [{ caseId: row.case_id, caseName: row.case_name }],
					menuSelections: {},
				},
			);
			expect(ctrl.entryStore.getState().caseDatabaseWait).toEqual({
				formUuid,
				status: "loading",
			});
			ctrl.setCaseDatabaseState({
				required: true,
				status: "ready",
				snapshot: { rows: [row], indices: [] },
			});
			await ctrl.awaitSettled();
			expect(ctrl.store.getState()[fieldUuid]?.resolvedLabel).toBe(
				"Repairing **Kettle**.",
			);
			expect(ctrl.entryStore.getState().fault).toBeUndefined();
		} finally {
			ctrl.dispose();
			await ctrl.awaitSettled();
		}
	});
	it("loads casedb when a form references only a structural case hashtag", () => {
		const doc = buildDoc({
			appName: "Case hashtags",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "status",
							label: { parts: [{ kind: "text", text: "Status" }] },
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Follow up",
							type: "followup",
							fields: [
								{
									id: "copied_status",
									kind: "hidden",
									calculate: "#patient/status",
								},
							],
						},
					],
				},
			],
		});

		assertAdmittedPreviewDoc(doc);
		expect(caseDatabaseRequirements(doc)).toEqual({
			required: true,
			caseTypes: ["commcare-user", "patient"],
			places: false,
		});
	});

	it("loads casedb when only a post-submit carrier references it", () => {
		const doc = buildDoc({
			appName: "Links",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "source-module",
					name: "Source",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "source-form",
							name: "Source",
							type: "survey",
							formLinks: [
								{
									uuid: "source-link",
									condition: "count(instance('casedb')/casedb/case) > 0",
									target: { type: "module", moduleUuid: MODULE_UUID },
								},
								{
									uuid: "fallback-link",
									target: { type: "module", moduleUuid: MODULE_UUID },
								},
							],
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});

		assertAdmittedPreviewDoc(doc);
		expect(caseDatabaseRequirements(doc)).toEqual({
			required: true,
			caseTypes: ["commcare-user", "patient"],
			places: false,
		});
	});

	it("loads casedb for a case-bearing link without an explicit casedb expression", () => {
		const doc = buildDoc({
			appName: "Carried cases",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "source-module",
					name: "Source",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "source-form",
							name: "Source",
							type: "followup",
							formLinks: [
								{
									uuid: "source-link",
									target: { type: "module", moduleUuid: MODULE_UUID },
								},
							],
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});

		assertAdmittedPreviewDoc(doc);
		expect(caseDatabaseRequirements(doc)).toEqual({
			required: true,
			caseTypes: ["commcare-user", "patient"],
			places: false,
		});
	});

	it("does not load casedb for links in an all-survey app", () => {
		const doc = buildDoc({
			appName: "Survey links",
			modules: [
				{
					uuid: "source-module",
					name: "Source",
					forms: [
						{
							uuid: "source-form",
							name: "Source",
							type: "survey",
							formLinks: [
								{
									uuid: "source-link",
									target: { type: "module", moduleUuid: MODULE_UUID },
								},
							],
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});

		assertAdmittedPreviewDoc(doc);
		expect(caseDatabaseRequirements(doc)).toEqual({
			required: false,
			caseTypes: [],
			places: false,
		});
	});
});

describe("a search's device reads and the device's cases", () => {
	/** The chosen-case scenario with only the named search module, so no
	 * other module's forms decide whether the device's cases load. */
	const searchOnly = (name: string) => {
		const doc = chosenCase.doc();
		for (const mod of Object.values(doc.modules)) {
			if (mod.name === name) continue;
			delete doc.modules[mod.uuid];
		}
		doc.moduleOrder = doc.moduleOrder.filter((uuid) => uuid in doc.modules);
		for (const form of Object.values(doc.forms)) delete doc.forms[form.uuid];
		for (const field of Object.values(doc.fields))
			delete doc.fields[field.uuid];
		for (const mod of Object.values(doc.modules)) {
			doc.formOrder[mod.uuid] = [];
			mod.caseSearchConfig = {};
		}
		return doc;
	};

	it("loads them for a search whose device piece reads a chosen case's property", () => {
		const doc = searchOnly("Members by household and village");
		const [mod] = Object.values(doc.modules);
		if (mod?.caseListConfig === undefined) throw new Error("No case list.");
		expect(searchCsqlReadsCaseDatabase(doc, mod.caseListConfig)).toBe(true);
		expect(caseDatabaseRequirements(doc).required).toBe(true);
	});

	it("leaves them for a search that reads only the chosen case's id", () => {
		const doc = searchOnly("Members by household");
		const [mod] = Object.values(doc.modules);
		if (mod?.caseListConfig === undefined) throw new Error("No case list.");
		expect(searchCsqlReadsCaseDatabase(doc, mod.caseListConfig)).toBe(false);
		expect(caseDatabaseRequirements(doc).required).toBe(false);
	});
});
