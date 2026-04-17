/**
 * Tests for the pure toDocMutations mapper.
 *
 * Verifies that every stream event type produces the correct sequence of
 * doc mutations — without any store, signal grid, or side effects involved.
 */

import { assert, describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, type BlueprintDoc, type Mutation } from "@/lib/doc/types";
import type { BlueprintForm, CaseType } from "@/lib/schemas/blueprint";
import { toDocMutations } from "../mutationMapper";

const APP_ID = "test-app-id";

// ── Fixture helpers ────────────────────────────────────────────────────

/** Minimal empty doc — no modules, no forms, no fields. */
function emptyDoc(): BlueprintDoc {
	return buildDoc({ appId: APP_ID, appName: "Test" });
}

/**
 * Build a doc with one module containing zero forms.
 * The module uuid is deterministic.
 */
function buildDocWithOneModule(): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "One Module",
		modules: [
			{
				uuid: "mod-uuid-1",
				name: "Registration Module",
				caseType: "patient",
			},
		],
	});
}

/**
 * Build a doc with one module and one form.
 */
function buildDocWithOneModuleOneForm(): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "One Form",
		modules: [
			{
				uuid: "mod-uuid-1",
				name: "Registration Module",
				caseType: "patient",
				forms: [
					{
						uuid: "form-uuid-1",
						name: "Register Patient",
						type: "registration",
						fields: [
							f({
								uuid: "q-uuid-1",
								kind: "text",
								id: "case_name",
								label: "Patient Name",
							}),
						],
					},
				],
			},
		],
	});
}

/**
 * Same as buildDocWithOneModuleOneForm but stamps a `purpose` on the form
 * entity, simulating what the scaffold step does. Domain `Form` carries
 * `purpose` directly, so it's set via the spec.
 */
function buildDocWithPurpose(): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "One Form",
		modules: [
			{
				uuid: "mod-uuid-1",
				name: "Registration Module",
				caseType: "patient",
				forms: [
					{
						uuid: "form-uuid-1",
						name: "Register Patient",
						type: "registration",
						purpose: "Collect patient demographics",
						fields: [
							f({
								uuid: "q-uuid-1",
								kind: "text",
								id: "case_name",
								label: "Patient Name",
							}),
						],
					},
				],
			},
		],
	});
}

/** Build a doc with two modules, each with one form. */
function buildDocWithTwoModules(): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "Two Modules",
		modules: [
			{
				uuid: "mod-uuid-1",
				name: "Module A",
				caseType: "patient",
				forms: [
					{
						uuid: "form-uuid-1",
						name: "Form A",
						type: "registration",
					},
				],
			},
			{
				uuid: "mod-uuid-2",
				name: "Module B",
				caseType: "visit",
				forms: [
					{
						uuid: "form-uuid-2",
						name: "Form B",
						type: "followup",
					},
				],
			},
		],
	});
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
	//
	// Form-content events decompose into a fine-grained mutation sequence:
	//   1. `updateForm` — form-entity metadata patch (never carries `purpose`
	//      so the scaffold-stamped value survives `Object.assign`).
	//   2. `removeField × N` — one per existing top-level child; the reducer
	//      cascades each into its descendants.
	//   3. `addField × M` — one per incoming wire question, in top-down tree
	//      order so container parents land before their children.

	/**
	 * Build a doc with one module and one form that has no fields.
	 * Used by scenarios that need to assert "pure add, zero removes".
	 */
	function buildDocWithOneModuleOneFormEmpty(): BlueprintDoc {
		return buildDoc({
			appId: APP_ID,
			appName: "Empty Form",
			modules: [
				{
					uuid: "mod-uuid-1",
					name: "Registration Module",
					caseType: "patient",
					forms: [
						{
							uuid: "form-uuid-1",
							name: "Register Patient",
							type: "registration",
						},
					],
				},
			],
		});
	}

	describe("data-form-done", () => {
		it("empty existing form → decomposes into updateForm + addField × N (no removes)", () => {
			const doc = buildDocWithOneModuleOneFormEmpty();
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

			// 1 updateForm + 0 removeField + 2 addField = 3
			expect(mutations).toHaveLength(3);

			// (1) First mutation is `updateForm` targeting the doc's form uuid
			//     with name + type transferred from the wire payload.
			const updateForm = mutations[0];
			assert(updateForm.kind === "updateForm");
			expect(updateForm.uuid).toBe(formUuid);
			expect(updateForm.patch.name).toBe("Register Patient");
			expect(updateForm.patch.type).toBe("registration");

			// (2) Remaining mutations are adds in array order. Empty doc means
			//     zero removeFields between updateForm and the adds.
			const addField1 = mutations[1];
			assert(addField1.kind === "addField");
			expect(addField1.parentUuid).toBe(formUuid);
			expect(addField1.index).toBe(0);
			expect(addField1.field.uuid).toBe(asUuid("new-q-1"));
			expect(addField1.field.id).toBe("patient_name");

			const addField2 = mutations[2];
			assert(addField2.kind === "addField");
			expect(addField2.parentUuid).toBe(formUuid);
			expect(addField2.index).toBe(1);
			expect(addField2.field.uuid).toBe(asUuid("new-q-2"));
			expect(addField2.field.id).toBe("patient_age");
		});

		it("populated existing form → wipes existing fields then installs incoming", () => {
			// Fixture has two existing top-level fields; incoming has one new
			// field with a different uuid, so we should see:
			//   updateForm + removeField × 2 + addField × 1 = 4
			const doc = buildDoc({
				appId: APP_ID,
				appName: "Populated Form",
				modules: [
					{
						uuid: "mod-uuid-1",
						name: "Registration",
						caseType: "patient",
						forms: [
							{
								uuid: "form-uuid-1",
								name: "Register Patient",
								type: "registration",
								fields: [
									f({
										uuid: "existing-q-1",
										kind: "text",
										id: "first_name",
										label: "First Name",
									}),
									f({
										uuid: "existing-q-2",
										kind: "text",
										id: "last_name",
										label: "Last Name",
									}),
								],
							},
						],
					},
				],
			});
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];

			const incomingForm: BlueprintForm = {
				uuid: "ignored",
				name: "Register Patient",
				type: "registration",
				questions: [
					{
						uuid: "new-q-1",
						id: "full_name",
						type: "text",
						label: "Full Name",
					},
				],
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			expect(mutations).toHaveLength(4);

			// (1) updateForm
			assert(mutations[0].kind === "updateForm");
			expect(mutations[0].uuid).toBe(formUuid);

			// (2) removeField × 2, targeting the existing uuids in fieldOrder
			//     order (top-down).
			assert(mutations[1].kind === "removeField");
			expect(mutations[1].uuid).toBe(asUuid("existing-q-1"));
			assert(mutations[2].kind === "removeField");
			expect(mutations[2].uuid).toBe(asUuid("existing-q-2"));

			// (3) addField for the new field, referencing the incoming uuid.
			assert(mutations[3].kind === "addField");
			expect(mutations[3].parentUuid).toBe(formUuid);
			expect(mutations[3].index).toBe(0);
			expect(mutations[3].field.uuid).toBe(asUuid("new-q-1"));
			expect(mutations[3].field.id).toBe("full_name");
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

		it("omits `purpose` from the updateForm patch so the existing value survives", () => {
			// When the reducer applies `Object.assign(form, patch)`, a `purpose`
			// key set to `undefined` would CLEAR the stored purpose. The patch
			// must not carry the key at all — verified by in-operator here.
			const doc = buildDocWithPurpose();

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

			const updateForm = mutations[0];
			assert(updateForm.kind === "updateForm");
			// Key must be absent, not just undefined: using `in` catches a
			// `{ purpose: undefined }` spread that a type cast would hide.
			expect("purpose" in updateForm.patch).toBe(false);
		});

		it("nested group → parent addField precedes child adds with correct parentUuid", () => {
			const doc = buildDocWithOneModuleOneFormEmpty();
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
						],
					},
				],
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			// updateForm + addField(group) + addField(child) = 3.
			expect(mutations).toHaveLength(3);

			assert(mutations[0].kind === "updateForm");

			// Group is added under the form before the child is added under
			// the group — this is the ordering invariant the addField reducer
			// relies on to pre-seed the group's fieldOrder slot.
			const groupAdd = mutations[1];
			assert(groupAdd.kind === "addField");
			expect(groupAdd.parentUuid).toBe(formUuid);
			expect(groupAdd.field.uuid).toBe(asUuid("group-uuid"));
			expect(groupAdd.field.kind).toBe("group");

			const childAdd = mutations[2];
			assert(childAdd.kind === "addField");
			expect(childAdd.parentUuid).toBe(asUuid("group-uuid"));
			expect(childAdd.field.uuid).toBe(asUuid("child-q-1"));
			expect(childAdd.index).toBe(0);
		});

		it("wire→domain field renames transfer correctly in addField payloads", () => {
			const doc = buildDocWithOneModuleOneFormEmpty();

			const incomingForm: BlueprintForm = {
				uuid: "ignored",
				name: "Renames",
				type: "registration",
				questions: [
					{
						uuid: "q-1",
						id: "patient_age",
						type: "text",
						label: "Age",
						case_property_on: "foo",
						validation: "1+1",
						validation_msg: "bad",
					},
				],
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			// mutations[0] is updateForm, mutations[1] is the addField.
			expect(mutations).toHaveLength(2);
			const add = mutations[1];
			assert(add.kind === "addField");
			const field = add.field as Record<string, unknown>;
			expect(field.kind).toBe("text");
			expect(field.case_property).toBe("foo");
			expect(field.validate).toBe("1+1");
			expect(field.validate_msg).toBe("bad");
			// The wire keys must NOT leak into the domain Field.
			expect("type" in field).toBe(false);
			expect("case_property_on" in field).toBe(false);
			expect("validation" in field).toBe(false);
			expect("validation_msg" in field).toBe(false);
		});

		it("form.close_condition maps to closeCondition in the updateForm patch", () => {
			const doc = buildDocWithOneModuleOneFormEmpty();

			const incomingForm: BlueprintForm = {
				uuid: "ignored",
				name: "Closer",
				type: "close",
				questions: [],
				close_condition: {
					question: "status",
					answer: "done",
					operator: "=",
				},
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			const updateForm = mutations[0];
			assert(updateForm.kind === "updateForm");
			expect(updateForm.patch.closeCondition).toEqual({
				field: "status",
				answer: "done",
				operator: "=",
			});
		});

		it("missing close_condition produces `closeCondition: undefined` in the patch", () => {
			// Explicit `undefined` (not absent) so the reducer's Object.assign
			// clears any previously-stored closeCondition.
			const doc = buildDocWithOneModuleOneFormEmpty();

			const incomingForm: BlueprintForm = {
				uuid: "ignored",
				name: "Plain",
				type: "registration",
				questions: [],
			};

			const mutations = toDocMutations(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				doc,
			);

			const updateForm = mutations[0];
			assert(updateForm.kind === "updateForm");
			// The key must be present (so assign clears stored value) AND
			// its value must be undefined.
			expect("closeCondition" in updateForm.patch).toBe(true);
			expect(updateForm.patch.closeCondition).toBeUndefined();
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
			// updateForm + addField = 2 (no fields to remove on the fixture)
			expect(mutations).toHaveLength(2);
			const updateForm = mutations[0];
			assert(updateForm.kind === "updateForm");
			expect(updateForm.uuid).toBe(formUuid);
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
