import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
/**
 * Atomic structural creation — `createForm` / `createModule` land an
 * entity TOGETHER with what makes it sound and complete, in one gated
 * batch. This is what makes the completeness ratchet livable on a
 * complete app: before these shapes, nothing could create a form
 * (EMPTY_FORM rejected the lone addForm) or a case-managing module
 * (NO_FORMS_OR_CASE_LIST; MISSING_CASE_LIST_COLUMNS) — every
 * structural-creation path was a dead end. The tests pin both
 * directions: the atomic call commits on a complete app, and the
 * under-specified call is rejected with findings the SAME call can
 * satisfy.
 */

import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { AdmittedMutationStages } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain";
import type { CanonicalMutationHost } from "../../workspace/canonicalHost";
import { CanonicalMutationWorkspace } from "../../workspace/canonicalWorkspace";
import type { ToolInvocationContext } from "../../workspace/types";
import { addFieldsTool } from "../addFields";
import { createFormInputSchema, createFormTool } from "../createForm";
import { createModuleInputSchema, createModuleTool } from "../createModule";
import { updateFormTool } from "../updateForm";

function makeHarness(initialDoc: BlueprintDoc) {
	// Every persisted doc must survive the SAME Zod gate the next load
	// runs (`appDocSchema` parses the stored blueprint through
	// `blueprintDocSchema`'s sub-schemas). Parsing here means a tool that
	// commits a Zod-unreadable doc — e.g. a raw string parked in an
	// AST-typed slot — fails its test at the commit, not in production on
	// the app's next load.
	const recordMutations = vi
		.fn()
		.mockImplementation(async (prepared: PreparedMutationCandidate) => {
			blueprintDocSchema.parse(toPersistableDoc(prepared.nextDoc));
			return { events: [], committedDoc: prepared.nextDoc };
		});
	// The guarded writer returns `{ events, committedDoc }` per stage; the parse
	// check stays and the final stage's doc rides back as the committed doc.
	const recordMutationStages = vi
		.fn()
		.mockImplementation(
			async (
				prepared: PreparedMutationCandidate,
				_stages: AdmittedMutationStages,
			) => {
				blueprintDocSchema.parse(toPersistableDoc(prepared.nextDoc));
				return { events: [], committedDoc: prepared.nextDoc };
			},
		);
	const host: CanonicalMutationHost = {
		appId: "app-1",
		projectId: "project-1",
		userId: "user-1",
		runId: "run-1",
		recordMutations,
		recordMutationStages,
		conversionImpact: async () => ({
			totalWithValue: 0,
			uncastable: 0,
			alreadyHeld: 0,
			samples: [],
		}),
	};
	const workspace = new CanonicalMutationWorkspace({ host, initialDoc });
	return {
		recordMutations,
		runTool<T>(
			tool: { execute(input: never, ctx: ToolInvocationContext): Promise<T> },
			input: unknown,
		): Promise<T> {
			return workspace.invoke({
				toolName: "test-tool",
				execute: (ctx) => tool.execute(input as never, ctx),
			});
		},
		currentDoc: () => workspace.currentSnapshot().doc,
	};
}

/** A COMPLETE app: one patient module, registration form, case list. */
function completeDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
			/* Recorded ahead of its module — the generateSchema-first flow:
			 * createModule references a case type by name and rejects one the
			 * catalog doesn't carry. */
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Household name") },
					{ name: "head_of_household", label: proseText("Head of household") },
				],
			},
		],
	});
}

function moduleAddress(doc: BlueprintDoc) {
	return { moduleUuid: doc.moduleOrder[0] };
}

function formAddress(doc: BlueprintDoc) {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid]?.[0];
	if (!formUuid) throw new Error("Fixture must contain a form");
	return { moduleUuid, formUuid };
}

describe("field assembly — whole-call admission", () => {
	it("addFields rejects the complete batch when one field cannot be assembled", async () => {
		const doc = completeDoc();
		const harness = makeHarness(doc);
		const before = Object.keys(doc.fields);
		const out = await harness.runTool(addFieldsTool, {
			...formAddress(doc),
			fields: [
				{
					kind: "text",
					id: "visit_note",
					label: proseText("Visit note"),
				} as never,
				{
					kind: "single_select",
					id: "catchment_site_code",
					label: proseText("Catchment site"),
				} as never,
			],
		});

		expect("error" in out.result && out.result.error).toContain(
			"catchment_site_code",
		);
		expect(out.mutations).toEqual([]);
		expect(harness.recordMutations).not.toHaveBeenCalled();
		expect(Object.keys(harness.currentDoc().fields)).toEqual(before);
	});
});

describe("createForm — atomic form + fields", () => {
	it("rejects the complete form when one requested field cannot be assembled", async () => {
		const doc = completeDoc();
		const harness = makeHarness(doc);
		const before = doc.formOrder[moduleAddress(doc).moduleUuid]?.length;
		const out = await harness.runTool(createFormTool, {
			...moduleAddress(doc),
			name: "Referral",
			type: "followup",
			fields: [
				{
					kind: "text",
					id: "referral_note",
					label: proseText("Referral note"),
				} as never,
				{
					kind: "single_select",
					id: "commune_code",
					label: proseText("Commune"),
				} as never,
			],
		});

		expect("error" in out.result && out.result.error).toContain("commune_code");
		expect(out.mutations).toEqual([]);
		expect(harness.recordMutations).not.toHaveBeenCalled();
		expect(
			harness.currentDoc().formOrder[moduleAddress(doc).moduleUuid]?.length,
		).toBe(before);
	});

	it("grows a COMPLETE app: a followup form lands with its fields in one batch", async () => {
		const doc = completeDoc();
		const harness = makeHarness(doc);
		const formUuid = testUuid("receipt-followup-form");
		const notesUuid = testUuid("receipt-followup-notes");
		const statusUuid = testUuid("receipt-followup-status");
		const optionUuids = [
			testUuid("receipt-followup-status-open"),
			testUuid("receipt-followup-status-done"),
		];
		const out = await harness.runTool(createFormTool, {
			...moduleAddress(doc),
			formUuid,
			name: "Follow up",
			type: "followup",
			fields: [
				{
					fieldUuid: notesUuid,
					kind: "text",
					id: "visit_notes",
					label: proseText("Visit notes"),
					caseWrite: { caseType: "patient", property: "visit_notes" },
				} as never,
				{
					fieldUuid: statusUuid,
					kind: "single_select",
					id: "visit_status",
					label: proseText("Visit status"),
					optionsSource: {
						kind: "inline",
						options: [
							{
								optionUuid: optionUuids[0],
								value: "open",
								label: proseText("Open"),
							},
							{
								optionUuid: optionUuids[1],
								value: "done",
								label: proseText("Done"),
							},
						],
					},
				} as never,
			],
		});

		expect("message" in out.result).toBe(true);
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		// One batch: addForm + its addField(s) — no transitional empty form
		// ever exists on any surface.
		const kinds = out.mutations.map((m) => m.kind);
		expect(kinds[0]).toBe("addForm");
		expect(kinds).toContain("addField");
		if (!("formUuid" in out.result)) throw new Error("expected success");
		expect(out.result.formUuid).toBe(formUuid);
		expect(out.result.fields).toEqual([
			{ uuid: notesUuid, id: "visit_notes", options: [] },
			{
				uuid: statusUuid,
				id: "visit_status",
				options: [
					{ uuid: optionUuids[0], value: "open" },
					{ uuid: optionUuids[1], value: "done" },
				],
			},
		]);
	});

	it("rejects a registration form missing its case_name writer with guidance THIS call can satisfy", async () => {
		const doc = completeDoc();
		const harness = makeHarness(doc);
		const out = await harness.runTool(createFormTool, {
			...moduleAddress(doc),
			name: "Enroll",
			type: "registration",
			fields: [
				{
					kind: "text",
					id: "village",
					label: proseText("Village"),
					caseWrite: { caseType: "patient", property: "village" },
				} as never,
			],
		});

		expect("error" in out.result && out.result.error).toContain("case_name");
		expect(out.mutations).toEqual([]);
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("nests fields under a group created in the same call", async () => {
		const doc = completeDoc();
		const harness = makeHarness(doc);
		const vitalsUuid = testUuid("same-call-vitals");
		const out = await harness.runTool(createFormTool, {
			...moduleAddress(doc),
			name: "Assessment",
			type: "followup",
			fields: [
				{
					fieldUuid: vitalsUuid,
					kind: "group",
					id: "vitals",
					label: proseText("Vitals"),
				} as never,
				{
					kind: "decimal",
					id: "temperature",
					label: proseText("Temperature"),
					parentUuid: vitalsUuid,
				} as never,
			],
		});

		expect("message" in out.result).toBe(true);
		const addFields = out.mutations.filter(
			(m): m is Extract<typeof m, { kind: "addField" }> =>
				m.kind === "addField",
		);
		const group = addFields.find((m) => m.field.id === "vitals");
		const child = addFields.find((m) => m.field.id === "temperature");
		expect(group).toBeDefined();
		expect(child?.parentUuid).toBe(group?.field.uuid);
	});
});

describe("createModule — atomic module + forms + case list", () => {
	it("rejects the complete module when one nested field cannot be assembled", async () => {
		const doc = completeDoc();
		const harness = makeHarness(doc);
		const out = await harness.runTool(createModuleTool, {
			name: "Households",
			case_type: "household",
			forms: [
				{
					name: "Register household",
					type: "registration",
					fields: [
						{
							kind: "text",
							id: "case_name",
							label: proseText("Household name"),
							caseWrite: {
								caseType: "household",
								property: "case_name",
							},
						} as never,
						{
							kind: "single_select",
							id: "catchment_site_code",
							label: proseText("Catchment site"),
							caseWrite: {
								caseType: "household",
								property: "catchment_site_code",
							},
						} as never,
					],
				},
			],
			case_list_columns: [
				{
					kind: "plain",
					field: "case_name",
					header: "Name",
				} as never,
			],
		});

		expect("error" in out.result && out.result.error).toContain(
			"catchment_site_code",
		);
		expect(out.mutations).toEqual([]);
		expect(harness.recordMutations).not.toHaveBeenCalled();
		expect(harness.currentDoc().moduleOrder).toEqual(doc.moduleOrder);
	});

	it("grows a COMPLETE app: a case-managing module lands with forms and columns in one batch", async () => {
		const harness = makeHarness(completeDoc());
		const moduleUuid = testUuid("receipt-household-module");
		const formUuid = testUuid("receipt-household-form");
		const nameUuid = testUuid("receipt-household-name");
		const headUuid = testUuid("receipt-household-head");
		const kindUuid = testUuid("receipt-household-kind");
		const optionUuids = [
			testUuid("receipt-household-kind-rural"),
			testUuid("receipt-household-kind-urban"),
		];
		const columnUuid = testUuid("receipt-household-column");
		const out = await harness.runTool(createModuleTool, {
			moduleUuid,
			name: "Households",
			case_type: "household",
			forms: [
				{
					formUuid,
					name: "Register household",
					type: "registration",
					fields: [
						{
							fieldUuid: nameUuid,
							kind: "text",
							id: "case_name",
							label: proseText("Household name"),
							caseWrite: {
								caseType: "household",
								property: "case_name",
							},
						} as never,
						{
							fieldUuid: headUuid,
							kind: "text",
							id: "head_of_household",
							label: proseText("Head of household"),
							caseWrite: {
								caseType: "household",
								property: "head_of_household",
							},
						} as never,
						{
							fieldUuid: kindUuid,
							kind: "single_select",
							id: "household_kind",
							label: proseText("Household kind"),
							optionsSource: {
								kind: "inline",
								options: [
									{
										optionUuid: optionUuids[0],
										value: "rural",
										label: proseText("Rural"),
									},
									{
										optionUuid: optionUuids[1],
										value: "urban",
										label: proseText("Urban"),
									},
								],
							},
						} as never,
					],
				},
			],
			case_list_columns: [
				{
					columnUuid,
					kind: "plain",
					field: "case_name",
					header: "Name",
				} as never,
			],
		});

		expect("message" in out.result).toBe(true);
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		const kinds = out.mutations.map((m) => m.kind);
		expect(kinds[0]).toBe("addModule");
		expect(kinds).toContain("addForm");
		expect(kinds).toContain("addField");
		// The case-list columns ride the addModule entity itself.
		const addModule = out.mutations.find(
			(m): m is Extract<typeof m, { kind: "addModule" }> =>
				m.kind === "addModule",
		);
		expect(addModule?.module.caseListConfig?.columns).toHaveLength(1);
		if (!("moduleUuid" in out.result)) throw new Error("expected success");
		expect(out.result).toMatchObject({
			moduleUuid,
			forms: [
				{
					uuid: formUuid,
					name: "Register household",
					fields: [
						{ uuid: nameUuid, id: "case_name", options: [] },
						{ uuid: headUuid, id: "head_of_household", options: [] },
						{
							uuid: kindUuid,
							id: "household_kind",
							options: [
								{ uuid: optionUuids[0], value: "rural" },
								{ uuid: optionUuids[1], value: "urban" },
							],
						},
					],
				},
			],
			columns: [{ uuid: columnUuid }],
		});
	});

	it("rejects a case-typed module with no forms (forms belong in this call)", async () => {
		{
			const harness = makeHarness(completeDoc());
			const out = await harness.runTool(createModuleTool, {
				name: "Households",
				case_type: "household",
			});
			expect("error" in out.result && out.result.error).toContain("forms");
			expect(harness.recordMutations).not.toHaveBeenCalled();
		}
	});

	it("rejects a case-managing module without case-list columns on a complete app", async () => {
		const harness = makeHarness(completeDoc());
		const out = await harness.runTool(createModuleTool, {
			name: "Households",
			case_type: "household",
			forms: [
				{
					name: "Register household",
					type: "registration",
					fields: [
						{
							kind: "text",
							id: "case_name",
							label: proseText("Household name"),
							caseWrite: {
								caseType: "household",
								property: "case_name",
							},
						} as never,
						{
							kind: "text",
							id: "head_of_household",
							label: proseText("Head of household"),
							caseWrite: {
								caseType: "household",
								property: "head_of_household",
							},
						} as never,
					],
				},
			],
		});

		expect("error" in out.result && out.result.error).toContain(
			"visible Results field",
		);
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("still creates a plain (case-less) survey module the simple way", async () => {
		const harness = makeHarness(completeDoc());
		const out = await harness.runTool(createModuleTool, {
			name: "Feedback",
			forms: [
				{
					name: "Feedback survey",
					type: "survey",
					fields: [
						{
							kind: "text",
							id: "comments",
							label: proseText("Comments"),
						} as never,
					],
				},
			],
		});
		expect("message" in out.result).toBe(true);
	});

	it("rejects a field/option UUID collision across separate born forms", async () => {
		const harness = makeHarness(completeDoc());
		const repeatedOptionUuid = testUuid("cross-form-option-collision");
		const select = (id: string, suffix: string) =>
			({
				kind: "single_select",
				id,
				label: proseText(id),
				optionsSource: {
					kind: "inline",
					options: [
						{
							optionUuid: repeatedOptionUuid,
							value: `yes_${suffix}`,
							label: proseText("Yes"),
						},
						{
							value: `no_${suffix}`,
							label: proseText("No"),
						},
					],
				},
			}) as never;
		const out = await harness.runTool(createModuleTool, {
			name: "Colliding surveys",
			forms: [
				{
					name: "First",
					type: "survey",
					fields: [select("first_answer", "first")],
				},
				{
					name: "Second",
					type: "survey",
					fields: [select("second_answer", "second")],
				},
			],
		});

		expect("error" in out.result && out.result.error).toContain(
			repeatedOptionUuid,
		);
		expect(out.mutations).toEqual([]);
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});
});

// ── Atomic creation on complete Connect apps ─────────────────────────

/** A COMPLETE Connect learn app: its only form participates (carries the
 *  app's only learn block), so clearing that block is the last-participant
 *  case. */
function completeConnectDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Training",
		connectType: "learn",
		modules: [
			{
				name: "Lessons",
				caseType: "trainee",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Enroll trainee",
						type: "registration",
						connect: {
							learn_module: {
								id: "enroll_module",
								name: "Enrollment",
								description: "Sign-up basics",
								time_estimate: 10,
							},
						},
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "trainee", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "trainee", property: "village" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "trainee",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
			/* Pre-recorded types for the creations below — the
			 * generateSchema-first flow: createModule references a case type
			 * by name and rejects one the catalog doesn't carry. */
			...["quiz_case", "assessment_case", "refresher", "seller"].map(
				(name) => ({
					name,
					properties: [{ name: "case_name", label: proseText("Name") }],
				}),
			),
		],
	});
}

describe("atomic creation on a complete Connect app", () => {
	it("createForm rejects a Connect block so participation has one owner", () => {
		const doc = completeConnectDoc();
		const parsed = createFormInputSchema.safeParse({
			...moduleAddress(doc),
			name: "Lesson two",
			type: "followup",
			fields: [
				{
					kind: "text",
					id: "lesson_notes",
					label: proseText("Notes"),
					caseWrite: { caseType: "trainee", property: "lesson_notes" },
				} as never,
			],
			connect: {
				learn_module: {
					id: "lesson_two",
					name: "Lesson two",
					description: "Follow-up content",
					time_estimate: 20,
				},
			},
		});
		expect(parsed.success).toBe(false);
	});

	it("createForm WITHOUT a connect block commits — the form is auxiliary, not malformed", async () => {
		/* A connect block marks participation; omitting it keeps the form
		 * out of Connect, which Connect's per-form ingestion scan handles
		 * by simply not finding a block there. The app keeps its existing
		 * participating form, so the participation floor holds. */
		const doc = completeConnectDoc();
		const harness = makeHarness(doc);
		const out = await harness.runTool(createFormTool, {
			...moduleAddress(doc),
			name: "Reference sheet",
			type: "followup",
			fields: [
				{
					kind: "text",
					id: "lesson_notes",
					label: proseText("Notes"),
					caseWrite: { caseType: "trainee", property: "lesson_notes" },
				} as never,
			],
		});

		expect("message" in out.result, JSON.stringify(out.result)).toBe(true);
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		const addForm = out.mutations.find(
			(m): m is Extract<typeof m, { kind: "addForm" }> => m.kind === "addForm",
		);
		expect(addForm?.form.connect).toBeUndefined();
		expect(
			runValidation(harness.currentDoc(), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});

	it("routes whole-block removal to the app-wide Connect target owner", async () => {
		/* updateForm refines the config of an existing participant. Changing
		 * participation is a complete-set command even when this is the only
		 * participating form. */
		const doc = completeConnectDoc();
		const harness = makeHarness(doc);
		const out = await harness.runTool(updateFormTool, {
			...formAddress(doc),
			connect: null,
		});

		const error = "error" in out.result ? out.result.error : "";
		expect(error).toContain("configureConnect/configure_connect");
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("routes participant removal to the app-wide owner while an auxiliary form remains", async () => {
		const doc = completeConnectDoc();
		const harness = makeHarness(doc);
		const grown = await harness.runTool(createFormTool, {
			...moduleAddress(doc),
			name: "Lesson two",
			type: "followup",
			fields: [
				{
					kind: "text",
					id: "lesson_notes",
					label: proseText("Notes"),
					caseWrite: { caseType: "trainee", property: "lesson_notes" },
				} as never,
			],
		});
		expect("message" in grown.result).toBe(true);

		const out = await harness.runTool(updateFormTool, {
			...formAddress(harness.currentDoc()),
			connect: null,
		});

		expect(out.result).toEqual({
			error: expect.stringContaining("configureConnect/configure_connect"),
		});
		expect(out.mutations).toEqual([]);
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		expect(
			runValidation(harness.currentDoc(), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});

	it("derives a newly-added section id from the same-call target form name", async () => {
		const doc = completeConnectDoc();
		const address = formAddress(doc);
		const harness = makeHarness(doc);
		const out = await harness.runTool(updateFormTool, {
			...address,
			name: "Final quiz",
			connect: {
				assessment: {
					user_score: xp("100"),
				},
			},
		});

		expect(out.result).not.toHaveProperty("error");
		expect(harness.currentDoc().forms[address.formUuid]?.name).toBe(
			"Final quiz",
		);
		expect(harness.currentDoc().forms[address.formUuid]?.connect).toMatchObject(
			{
				learn_module: { id: "enroll_module" },
				assessment: { id: "lessons_final_quiz" },
			},
		);
	});

	it("createModule rejects nested Connect blocks so participation has one owner", () => {
		const parsed = createModuleInputSchema.safeParse({
			name: "Assessments",
			case_type: "assessment_case",
			forms: [
				{
					name: "Register assessment",
					type: "registration",
					fields: [
						{
							kind: "text",
							id: "case_name",
							label: proseText("Assessment name"),
							caseWrite: {
								caseType: "assessment_case",
								property: "case_name",
							},
						},
					],
					connect: {
						learn_module: {
							name: "Assessment intro",
							description: "How scoring works",
							time_estimate: 5,
						},
					},
				},
			],
			case_list_columns: [
				{ kind: "plain", field: "case_name", header: "Name" },
			],
		});
		expect(parsed.success).toBe(false);
	});
});

// ── Connect participation has one owner ─────────────────────────────

describe("creation tools leave Connect participation to configureConnect", () => {
	it("rejects Connect at both creation schema boundaries", () => {
		expect(
			createFormInputSchema.safeParse({
				moduleUuid: testUuid("creation-connect-module"),
				name: "New participant",
				type: "survey",
				fields: [{ kind: "text", id: "note", label: proseText("Note") }],
				connect: {
					learn_module: {
						name: "Lesson",
						description: "Lesson",
						time_estimate: 5,
					},
				},
			}).success,
		).toBe(false);
		expect(
			createModuleInputSchema.safeParse({
				name: "New module",
				forms: [
					{
						name: "New participant",
						type: "survey",
						fields: [{ kind: "text", id: "note", label: proseText("Note") }],
						connect: {
							learn_module: {
								name: "Lesson",
								description: "Lesson",
								time_estimate: 5,
							},
						},
					},
				],
			}).success,
		).toBe(false);
	});
});
