/**
 * Tests for the pure toDocMutations mapper.
 *
 * Verifies that every stream event type produces the correct sequence of
 * doc mutations — without any store, signal grid, or side effects involved.
 */

import { assert, describe, expect, it } from "vitest";
import { toDoc } from "@/lib/doc/converter";
import { asUuid, type BlueprintDoc, type Mutation } from "@/lib/doc/types";
import type { BlueprintForm, CaseType } from "@/lib/schemas/blueprint";
import { toDocMutations } from "../mutationMapper";

const APP_ID = "test-app-id";

// ── Fixture helpers ────────────────────────────────────────────────────

/** Minimal empty doc — no modules, no forms, no questions. */
function emptyDoc(): BlueprintDoc {
	return toDoc({ app_name: "Test", modules: [], case_types: null }, APP_ID);
}

/**
 * Build a doc with one module containing zero forms.
 * The module uuid is deterministic (derived from the blueprint).
 */
function buildDocWithOneModule(): BlueprintDoc {
	return toDoc(
		{
			app_name: "One Module",
			modules: [
				{
					uuid: "mod-uuid-1",
					name: "Registration Module",
					case_type: "patient",
					forms: [],
				},
			],
			case_types: null,
		},
		APP_ID,
	);
}

/**
 * Build a doc with one module and one form.
 * The form has a purpose set (simulates scaffold-created form).
 */
function buildDocWithOneModuleOneForm(): BlueprintDoc {
	return toDoc(
		{
			app_name: "One Form",
			modules: [
				{
					uuid: "mod-uuid-1",
					name: "Registration Module",
					case_type: "patient",
					forms: [
						{
							uuid: "form-uuid-1",
							name: "Register Patient",
							type: "registration",
							questions: [
								{
									uuid: "q-uuid-1",
									id: "case_name",
									type: "text",
									label: "Patient Name",
								},
							],
						},
					],
				},
			],
			case_types: null,
		},
		APP_ID,
	);
}

/**
 * Same as buildDocWithOneModuleOneForm but manually sets a purpose on
 * the form entity, simulating what the scaffold step does.
 */
function buildDocWithPurpose(): BlueprintDoc {
	const doc = buildDocWithOneModuleOneForm();
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	doc.forms[formUuid] = {
		...doc.forms[formUuid],
		purpose: "Collect patient demographics",
	};
	return doc;
}

/** Build a doc with two modules, each with one form. */
function buildDocWithTwoModules(): BlueprintDoc {
	return toDoc(
		{
			app_name: "Two Modules",
			modules: [
				{
					uuid: "mod-uuid-1",
					name: "Module A",
					case_type: "patient",
					forms: [
						{
							uuid: "form-uuid-1",
							name: "Form A",
							type: "registration",
							questions: [],
						},
					],
				},
				{
					uuid: "mod-uuid-2",
					name: "Module B",
					case_type: "visit",
					forms: [
						{
							uuid: "form-uuid-2",
							name: "Form B",
							type: "followup",
							questions: [],
						},
					],
				},
			],
			case_types: null,
		},
		APP_ID,
	);
}

// ── data-schema ────────────────────────────────────────────────────────

describe("toDocMutations", () => {
	describe("data-schema", () => {
		it("returns setCaseTypes mutation", () => {
			const caseTypes: CaseType[] = [
				{
					name: "patient",
					properties: [{ name: "first_name", label: "First Name" }],
				},
			];
			const mutations = toDocMutations(
				"data-schema",
				{ caseTypes },
				emptyDoc(),
			);

			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toEqual({
				kind: "setCaseTypes",
				caseTypes,
			});
		});
	});

	// ── data-scaffold ──────────────────────────────────────────────────

	describe("data-scaffold", () => {
		it("returns correct count of mutations (setAppName + setConnectType + addModule + addForm per module/form)", () => {
			const scaffold = {
				app_name: "Health App",
				description: "A health monitoring app",
				connect_type: "learn" as const,
				modules: [
					{
						name: "Registration",
						case_type: "patient",
						case_list_only: false,
						purpose: "Register patients",
						forms: [
							{
								name: "Register",
								type: "registration" as const,
								purpose: "Register a new patient",
								formDesign: "Name, age, gender",
							},
							{
								name: "Follow Up",
								type: "followup" as const,
								purpose: "Follow up on patient",
								formDesign: "Visit notes",
							},
						],
					},
				],
			};

			const mutations = toDocMutations("data-scaffold", scaffold, emptyDoc());

			// setAppName(1) + setConnectType(1) + addModule(1) + addForm(2) = 5
			expect(mutations).toHaveLength(5);

			expect(mutations[0]).toMatchObject({
				kind: "setAppName",
				name: "Health App",
			});
			expect(mutations[1]).toMatchObject({
				kind: "setConnectType",
				connectType: "learn",
			});
			expect(mutations[2]).toMatchObject({ kind: "addModule" });
			expect(mutations[3]).toMatchObject({ kind: "addForm" });
			expect(mutations[4]).toMatchObject({ kind: "addForm" });

			// addForm mutations reference the parent module's UUID
			const moduleUuid = (
				mutations[2] as Extract<Mutation, { kind: "addModule" }>
			).module.uuid;
			expect(
				(mutations[3] as Extract<Mutation, { kind: "addForm" }>).moduleUuid,
			).toBe(moduleUuid);
			expect(
				(mutations[4] as Extract<Mutation, { kind: "addForm" }>).moduleUuid,
			).toBe(moduleUuid);
		});

		it("skips setConnectType when connect_type is empty string", () => {
			const scaffold = {
				app_name: "Standard App",
				description: "A standard app",
				connect_type: "" as const,
				modules: [
					{
						name: "Surveys",
						case_type: null,
						case_list_only: false,
						purpose: "Survey module",
						forms: [
							{
								name: "Intake",
								type: "survey" as const,
								purpose: "Collect intake data",
								formDesign: "Basic questions",
							},
						],
					},
				],
			};

			const mutations = toDocMutations("data-scaffold", scaffold, emptyDoc());

			// setAppName(1) + addModule(1) + addForm(1) = 3 (no setConnectType)
			expect(mutations).toHaveLength(3);
			const kinds = mutations.map((m) => m.kind);
			expect(kinds).not.toContain("setConnectType");
		});

		it("with empty modules returns just setAppName", () => {
			const scaffold = {
				app_name: "Empty App",
				description: "Nothing here",
				connect_type: "" as const,
				modules: [],
			};

			const mutations = toDocMutations("data-scaffold", scaffold, emptyDoc());

			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toEqual({ kind: "setAppName", name: "Empty App" });
		});

		it("mints unique UUIDs for each module and form", () => {
			const scaffold = {
				app_name: "Multi Module",
				description: "Two modules",
				connect_type: "" as const,
				modules: [
					{
						name: "Mod A",
						case_type: "a",
						case_list_only: false,
						purpose: "Module A",
						forms: [
							{
								name: "Form A1",
								type: "registration" as const,
								purpose: "A1",
								formDesign: "",
							},
						],
					},
					{
						name: "Mod B",
						case_type: "b",
						case_list_only: false,
						purpose: "Module B",
						forms: [
							{
								name: "Form B1",
								type: "registration" as const,
								purpose: "B1",
								formDesign: "",
							},
						],
					},
				],
			};

			const mutations = toDocMutations("data-scaffold", scaffold, emptyDoc());

			const addModules = mutations.filter(
				(m): m is Extract<Mutation, { kind: "addModule" }> =>
					m.kind === "addModule",
			);
			const addForms = mutations.filter(
				(m): m is Extract<Mutation, { kind: "addForm" }> =>
					m.kind === "addForm",
			);

			// All UUIDs should be distinct
			const allUuids = [
				...addModules.map((m) => m.module.uuid),
				...addForms.map((m) => m.form.uuid),
			];
			expect(new Set(allUuids).size).toBe(allUuids.length);
		});

		it("maps scaffold module fields correctly", () => {
			const scaffold = {
				app_name: "Field Test",
				description: "Testing field mapping",
				connect_type: "" as const,
				modules: [
					{
						name: "Case List Only",
						case_type: "ref_data",
						case_list_only: true,
						purpose: "Reference data viewer",
						forms: [],
					},
				],
			};

			const mutations = toDocMutations("data-scaffold", scaffold, emptyDoc());
			const addModule = mutations.find(
				(m): m is Extract<Mutation, { kind: "addModule" }> =>
					m.kind === "addModule",
			);
			assert(addModule);

			expect(addModule.module.name).toBe("Case List Only");
			expect(addModule.module.caseType).toBe("ref_data");
			expect(addModule.module.caseListOnly).toBe(true);
			expect(addModule.module.purpose).toBe("Reference data viewer");
			expect(addModule.module.caseListColumns).toBeUndefined();
			expect(addModule.module.caseDetailColumns).toBeUndefined();
		});

		it("maps scaffold form fields correctly including post_submit", () => {
			const scaffold = {
				app_name: "Form Fields",
				description: "Test form fields",
				connect_type: "" as const,
				modules: [
					{
						name: "Mod",
						case_type: "patient",
						case_list_only: false,
						purpose: "Module",
						forms: [
							{
								name: "Follow Up",
								type: "followup" as const,
								purpose: "Visit form",
								formDesign: "",
								post_submit: "module" as const,
							},
						],
					},
				],
			};

			const mutations = toDocMutations("data-scaffold", scaffold, emptyDoc());
			const addForm = mutations.find(
				(m): m is Extract<Mutation, { kind: "addForm" }> =>
					m.kind === "addForm",
			);
			assert(addForm);

			expect(addForm.form.name).toBe("Follow Up");
			expect(addForm.form.type).toBe("followup");
			expect(addForm.form.purpose).toBe("Visit form");
			expect(addForm.form.postSubmit).toBe("module");
			expect(addForm.form.closeCondition).toBeUndefined();
			expect(addForm.form.connect).toBeUndefined();
			expect(addForm.form.formLinks).toBeUndefined();
		});

		it("converts null case_type to undefined", () => {
			const scaffold = {
				app_name: "Null Case",
				description: "Survey module",
				connect_type: "" as const,
				modules: [
					{
						name: "Survey Mod",
						case_type: null,
						case_list_only: false,
						purpose: "Surveys",
						forms: [],
					},
				],
			};

			const mutations = toDocMutations("data-scaffold", scaffold, emptyDoc());
			const addModule = mutations.find(
				(m): m is Extract<Mutation, { kind: "addModule" }> =>
					m.kind === "addModule",
			);
			assert(addModule);
			expect(addModule.module.caseType).toBeUndefined();
		});
	});

	// ── data-module-done ───────────────────────────────────────────────

	describe("data-module-done", () => {
		it("returns updateModule with correct UUID from index", () => {
			const doc = buildDocWithOneModule();
			const moduleUuid = doc.moduleOrder[0];
			const caseListColumns = [
				{ field: "name", header: "Name" },
				{ field: "age", header: "Age" },
			];

			const mutations = toDocMutations(
				"data-module-done",
				{ moduleIndex: 0, caseListColumns },
				doc,
			);

			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toEqual({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListColumns },
			});
		});

		it("with out-of-bounds index returns empty array", () => {
			const doc = buildDocWithOneModule();

			const mutations = toDocMutations(
				"data-module-done",
				{ moduleIndex: 5, caseListColumns: [{ field: "x", header: "X" }] },
				doc,
			);

			expect(mutations).toEqual([]);
		});

		it("with null caseListColumns returns updateModule with undefined", () => {
			const doc = buildDocWithOneModule();
			const moduleUuid = doc.moduleOrder[0];

			const mutations = toDocMutations(
				"data-module-done",
				{ moduleIndex: 0, caseListColumns: null },
				doc,
			);

			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toEqual({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListColumns: undefined },
			});
		});

		it("targets the correct module in a multi-module doc", () => {
			const doc = buildDocWithTwoModules();
			const secondModuleUuid = doc.moduleOrder[1];
			const columns = [{ field: "visit_date", header: "Date" }];

			const mutations = toDocMutations(
				"data-module-done",
				{ moduleIndex: 1, caseListColumns: columns },
				doc,
			);

			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toEqual({
				kind: "updateModule",
				uuid: secondModuleUuid,
				patch: { caseListColumns: columns },
			});
		});
	});

	// ── data-form-done / data-form-fixed / data-form-updated ──────────

	describe("data-form-done", () => {
		it("returns replaceForm mutation with decomposed form + flattened questions", () => {
			const doc = buildDocWithOneModuleOneForm();
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];

			const incomingForm: BlueprintForm = {
				uuid: "ignored-uuid",
				name: "Register Patient",
				type: "registration",
				questions: [
					{
						uuid: "new-q-1",
						id: "patient_name",
						type: "text",
						label: "Patient Name",
					},
					{
						uuid: "new-q-2",
						id: "patient_age",
						type: "int",
						label: "Age",
					},
				],
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			expect(mutations).toHaveLength(1);
			const m = mutations[0];
			assert(m.kind === "replaceForm");

			// The form UUID should be the doc's existing UUID, not the incoming one
			expect(m.uuid).toBe(formUuid);
			expect(m.form.uuid).toBe(formUuid);
			expect(m.form.name).toBe("Register Patient");
			expect(m.form.type).toBe("registration");

			// Questions should be flattened
			expect(m.fields).toHaveLength(2);
			expect(m.fields[0].id).toBe("patient_name");
			expect(m.fields[1].id).toBe("patient_age");

			// questionOrder should map formUuid to the two question UUIDs
			expect(m.fieldOrder[formUuid]).toHaveLength(2);
		});

		it("with out-of-bounds module index returns empty array", () => {
			const doc = buildDocWithOneModuleOneForm();
			const form: BlueprintForm = {
				uuid: "x",
				name: "X",
				type: "survey",
				questions: [],
			};

			expect(
				toDocMutations(
					"data-form-done",
					{ moduleIndex: 99, formIndex: 0, form },
					doc,
				),
			).toEqual([]);
		});

		it("with out-of-bounds form index returns empty array", () => {
			const doc = buildDocWithOneModuleOneForm();
			const form: BlueprintForm = {
				uuid: "x",
				name: "X",
				type: "survey",
				questions: [],
			};

			expect(
				toDocMutations(
					"data-form-done",
					{ moduleIndex: 0, formIndex: 99, form },
					doc,
				),
			).toEqual([]);
		});

		it("preserves existing form's purpose", () => {
			const doc = buildDocWithPurpose();

			// Incoming form has no purpose (BlueprintForm doesn't carry it)
			const incomingForm: BlueprintForm = {
				uuid: "ignored",
				name: "Updated Register",
				type: "registration",
				questions: [],
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			expect(mutations).toHaveLength(1);
			const m = mutations[0];
			assert(m.kind === "replaceForm");
			expect(m.form.purpose).toBe("Collect patient demographics");
		});

		it("handles nested group/repeat questions", () => {
			const doc = buildDocWithOneModuleOneForm();
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];

			const incomingForm: BlueprintForm = {
				uuid: "ignored",
				name: "Nested Form",
				type: "registration",
				questions: [
					{
						uuid: "group-uuid",
						id: "demographics",
						type: "group",
						label: "Demographics",
						children: [
							{
								uuid: "child-q-1",
								id: "first_name",
								type: "text",
								label: "First Name",
							},
							{
								uuid: "child-q-2",
								id: "last_name",
								type: "text",
								label: "Last Name",
							},
						],
					},
				],
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			expect(mutations).toHaveLength(1);
			const m = mutations[0];
			assert(m.kind === "replaceForm");

			// 3 total questions: 1 group + 2 children
			expect(m.fields).toHaveLength(3);

			// Form-level ordering has the group
			expect(m.fieldOrder[formUuid]).toHaveLength(1);
			expect(m.fieldOrder[formUuid][0]).toBe(asUuid("group-uuid"));

			// Group-level ordering has the children
			expect(m.fieldOrder[asUuid("group-uuid")]).toHaveLength(2);
		});
	});

	describe("data-form-done (multi-module)", () => {
		it("targets the correct module+form in a multi-module doc", () => {
			const doc = buildDocWithTwoModules();
			const moduleUuid = doc.moduleOrder[1];
			const formUuid = doc.formOrder[moduleUuid][0];
			const form: BlueprintForm = {
				uuid: "ignored",
				name: "Updated B",
				type: "followup",
				questions: [
					{ uuid: "qb", id: "visit_date", type: "date", label: "Date" },
				],
			};
			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 1, formIndex: 0, form },
				doc,
			);
			expect(mutations).toHaveLength(1);
			const m = mutations[0];
			assert(m.kind === "replaceForm");
			expect(m.uuid).toBe(formUuid);
		});
	});

	describe("data-form-fixed", () => {
		it("produces identical results to data-form-done", () => {
			const doc = buildDocWithOneModuleOneForm();
			const form: BlueprintForm = {
				uuid: "ignored",
				name: "Fixed Form",
				type: "registration",
				questions: [{ uuid: "q1", id: "name", type: "text", label: "Name" }],
			};

			const doneResult = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form },
				doc,
			);
			const fixedResult = toDocMutations(
				"data-form-fixed",
				{ moduleIndex: 0, formIndex: 0, form },
				doc,
			);

			expect(fixedResult).toEqual(doneResult);
		});
	});

	describe("data-form-updated", () => {
		it("produces identical results to data-form-done", () => {
			const doc = buildDocWithOneModuleOneForm();
			const form: BlueprintForm = {
				uuid: "ignored",
				name: "Updated Form",
				type: "registration",
				questions: [{ uuid: "q1", id: "name", type: "text", label: "Name" }],
			};

			const doneResult = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form },
				doc,
			);
			const updatedResult = toDocMutations(
				"data-form-updated",
				{ moduleIndex: 0, formIndex: 0, form },
				doc,
			);

			expect(updatedResult).toEqual(doneResult);
		});
	});

	// ── Unknown event type ─────────────────────────────────────────────

	describe("unknown event type", () => {
		it("returns empty array", () => {
			expect(toDocMutations("data-partial", {}, emptyDoc())).toEqual([]);
			expect(toDocMutations("status", { stage: "forms" }, emptyDoc())).toEqual(
				[],
			);
			expect(toDocMutations("anything", {}, emptyDoc())).toEqual([]);
		});
	});
});
