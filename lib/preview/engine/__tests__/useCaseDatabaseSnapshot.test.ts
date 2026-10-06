import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { type ProsePart, proseText } from "@/lib/domain";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { caseRowsToFormPreloads } from "../caseDataBindingClient";
import { EngineController } from "../engineController";
import { caseDatabaseRequirements } from "../useCaseDatabaseSnapshot";

const MODULE_UUID = testUuid("source-module");
const PROPERTY_UUID = testUuid("prose-worker-property");
const NAME_UUID = testUuid("prose-answer");

describe("caseDatabaseRequirements", () => {
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
		});
		doc.forms[doc.formOrder[doc.moduleOrder[0]][0]].postSubmit = "app_home";
		expect(caseDatabaseRequirements(doc)).toEqual({
			required: false,
			caseTypes: [],
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
			await ctrl.activateFormAsync(
				formUuid,
				caseRowsToFormPreloads(row, [], [{ name: "repair", depth: 0 }]),
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
		});
	});
});
