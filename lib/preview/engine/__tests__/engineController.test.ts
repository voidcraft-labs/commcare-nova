/**
 * EngineController tests — verifies the controller correctly subscribes
 * to the BlueprintDoc store for per-field reactivity, structural changes,
 * and form activation.
 *
 * Fixtures are built directly in the normalized `PersistableDoc` shape.
 * The doc store's `load()` accepts this shape and rebuilds `fieldParent`
 * on load.
 */
import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { CaseType, Field, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { DEFAULT_RUNTIME_STATE, EngineController } from "../engineController";

// ── Fixtures ───────────────────────────────────────────────────────────

const MODULE_UUID = asUuid("module-1-uuid");
const FORM_UUID = asUuid("form-1-uuid");
const Q1_UUID = asUuid("aaaaaaaa-0001-0001-0001-000000000001");
const Q2_UUID = asUuid("aaaaaaaa-0002-0002-0002-000000000002");

/** Build a minimal survey doc with the given fields attached to a single form. */
function makeDoc(
	fields: Record<string, Field> = {
		[Q1_UUID]: { uuid: Q1_UUID, id: "name", kind: "text", label: "Name" },
		[Q2_UUID]: { uuid: Q2_UUID, id: "age", kind: "int", label: "Age" },
	},
	fieldOrder: Record<string, Uuid[]> = {
		[FORM_UUID]: [Q1_UUID, Q2_UUID],
	},
): PersistableDoc {
	return {
		appId: "test-app",
		appName: "Test App",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "module-1",
				name: "Module 1",
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "form-1",
				name: "Form 1",
				type: "survey",
			},
		},
		fields,
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder,
	};
}

/** Create a doc store loaded with the given doc. Undo tracking is resumed
 *  so mutations create live state changes. */
function createLoadedStore(doc: PersistableDoc = makeDoc()) {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.temporal.getState().resume();
	return store;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("EngineController", () => {
	describe("activateForm", () => {
		it("initializes runtime state for every field in the form", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(FORM_UUID);

			/* Runtime store should have entries for both fields */
			const runtime = ctrl.store.getState();
			expect(runtime[Q1_UUID]).toBeDefined();
			expect(runtime[Q2_UUID]).toBeDefined();
			expect(runtime[Q1_UUID].visible).toBe(true);
			expect(runtime[Q2_UUID].visible).toBe(true);
		});

		it("returns early for an unknown form uuid", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(asUuid("does-not-exist"));

			/* Runtime store should be empty — no form was activated */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});

		it("returns early when the form is not referenced by any module", () => {
			/* Orphan case: the form entity exists but no module lists it in
			 * `formOrder`. `findModuleForForm` returns undefined and the
			 * controller bails before touching the engine — no case-type
			 * context, no activation. */
			const orphanDoc = makeDoc();
			orphanDoc.formOrder = { [MODULE_UUID]: [] };
			const store = createBlueprintDocStore();
			store.getState().load(orphanDoc);
			store.temporal.getState().resume();

			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});

		it("returns early when no doc store is installed", () => {
			const ctrl = new EngineController();
			ctrl.activateForm(FORM_UUID);
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});
	});

	describe("per-field subscription", () => {
		it("fires on field relevant update via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Mutate the field's relevant expression to hide it */
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: Q1_UUID,
					targetKind: "text",
					patch: { relevant: xp("false()") },
				},
			]);

			/* Zustand's subscribeWithSelector fires synchronously on the
			 * next microtask — flush with a short wait. */
			await new Promise((r) => setTimeout(r, 10));

			const state = ctrl.store.getState()[Q1_UUID];
			expect(state).toBeDefined();
			/* The field should now be hidden because relevant = "false()" */
			expect(state.visible).toBe(false);
		});
	});

	describe("structural subscription", () => {
		it("detects field addition via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Initial state should have 2 fields */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(2);

			const newUuid = asUuid("bbbbbbbb-0003-0003-0003-000000000003");
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						uuid: newUuid,
						id: "new_q",
						kind: "text",
						label: "New Field",
					},
				},
			]);

			await new Promise((r) => setTimeout(r, 10));

			/* The new field should appear in the runtime store */
			const runtime = ctrl.store.getState();
			expect(runtime[newUuid]).toBeDefined();
			expect(runtime[newUuid].visible).toBe(true);
		});

		it("detects field removal via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Remove the first field */
			store.getState().applyMany([
				{
					kind: "removeField",
					uuid: Q1_UUID,
				},
			]);

			await new Promise((r) => setTimeout(r, 10));

			/* The removed field should revert to the frozen default state */
			const runtime = ctrl.store.getState();
			expect(runtime[Q1_UUID]).toBe(DEFAULT_RUNTIME_STATE);
		});
	});

	describe("kind change (remote retype)", () => {
		it("re-initializes the value on a same-id retype — no stale value resurfaces", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* A user (or a peer) typed into the text field before the retype. */
			ctrl.onValueChange(Q1_UUID, "typed answer");
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("typed answer");

			/* A remote `convertField` retypes the field (uuid + id preserved).
			 * The stale text value is meaningless under the new kind. */
			store
				.getState()
				.applyMany([{ kind: "convertField", uuid: Q1_UUID, toKind: "secret" }]);

			await new Promise((r) => setTimeout(r, 10));

			/* The value is dropped and the field re-seeds empty — a same-id
			 * retype must not leave the old answer in place. */
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("");
		});

		it("re-applies the new field's default value on retype", async () => {
			const groupUuid = asUuid("dddddddd-0001-0001-0001-000000000001");
			const doc = makeDoc(
				{
					[groupUuid]: {
						uuid: groupUuid,
						id: "container",
						kind: "group",
						label: "Container",
					},
				},
				{ [FORM_UUID]: [groupUuid] },
			);
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* group → repeat is a valid convert target; the retype must not throw
			 * and the container's state re-inits at the new kind. */
			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: groupUuid, toKind: "repeat" },
				]);

			await new Promise((r) => setTimeout(r, 10));

			/* A repeat carries a `repeatCount` — its presence proves the field
			 * was re-seeded under the new kind rather than left as a group. */
			expect(ctrl.store.getState()[groupUuid].repeatCount).toBe(1);
		});

		it("preserves answered child values across a group→repeat conversion (re-path, not drop)", async () => {
			const groupUuid = asUuid("dddddddd-0002-0002-0002-000000000001");
			const childAUuid = asUuid("dddddddd-0002-0002-0002-000000000002");
			const childBUuid = asUuid("dddddddd-0002-0002-0002-000000000003");
			const doc = makeDoc(
				{
					[groupUuid]: {
						uuid: groupUuid,
						id: "container",
						kind: "group",
						label: "Container",
					},
					[childAUuid]: {
						uuid: childAUuid,
						id: "child_a",
						kind: "text",
						label: "Child A",
					},
					[childBUuid]: {
						uuid: childBUuid,
						id: "child_b",
						kind: "text",
						label: "Child B",
					},
				},
				{
					[FORM_UUID]: [groupUuid],
					[groupUuid]: [childAUuid, childBUuid],
				},
			);
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Both children answered while the container is still a group
			 * (child paths `/data/container/child_*`). */
			ctrl.onValueChange(childAUuid, "answer A");
			ctrl.onValueChange(childBUuid, "answer B");
			expect(ctrl.getPath(childAUuid)).toBe("/data/container/child_a");

			/* A peer converts the group to a repeat — the child paths gain the
			 * `[0]` template segment. The in-progress answers must survive. */
			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: groupUuid, toKind: "repeat" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			/* Children re-pathed to the reindexed repeat template, values intact. */
			expect(ctrl.getPath(childAUuid)).toBe("/data/container[0]/child_a");
			expect(ctrl.store.getState()[childAUuid].value).toBe("answer A");
			expect(ctrl.store.getState()[childBUuid].value).toBe("answer B");
		});

		it("preserves answered child values across a repeat→group conversion", async () => {
			const repeatUuid = asUuid("dddddddd-0003-0003-0003-000000000001");
			const childUuid = asUuid("dddddddd-0003-0003-0003-000000000002");
			const doc = makeDoc(
				{
					[repeatUuid]: {
						uuid: repeatUuid,
						id: "container",
						kind: "repeat",
						label: "Container",
						repeat_mode: "user_controlled",
					},
					[childUuid]: {
						uuid: childUuid,
						id: "child",
						kind: "text",
						label: "Child",
					},
				},
				{
					[FORM_UUID]: [repeatUuid],
					[repeatUuid]: [childUuid],
				},
			);
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Child answered while the container is a repeat (template `[0]`). */
			ctrl.onValueChange(childUuid, "answer");
			expect(ctrl.getPath(childUuid)).toBe("/data/container[0]/child");

			/* Convert the repeat back to a group — the `[0]` segment drops. */
			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: repeatUuid, toKind: "group" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.getPath(childUuid)).toBe("/data/container/child");
			expect(ctrl.store.getState()[childUuid].value).toBe("answer");
		});

		it("a converted group→repeat's child value reaches computeSubmissionMutation at the reindexed path", async () => {
			/* A registration form whose primary case type is `patient`. The group
			 * holds a case-property child; after group→repeat the child's value
			 * must survive the re-path so the submission mutation carries it (not
			 * an empty reindexed path). `note` writes the module's OWN case type,
			 * so it stays in the primary's `properties` — the walk reads it at the
			 * reindexed `/data/container[0]/note`, proving submit sees the value. */
			const patientCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "note", label: "Note", data_type: "text" },
				],
			};
			const moduleUuid = asUuid("eeeeeeee-0001-0001-0001-000000000001");
			const formUuid = asUuid("eeeeeeee-0002-0002-0002-000000000001");
			const nameUuid = asUuid("eeeeeeee-0003-0003-0003-000000000001");
			const groupUuid = asUuid("eeeeeeee-0004-0004-0004-000000000001");
			const noteUuid = asUuid("eeeeeeee-0005-0005-0005-000000000001");
			const doc: PersistableDoc = {
				appId: "test-app",
				appName: "Test App",
				connectType: null,
				caseTypes: [patientCaseType],
				modules: {
					[moduleUuid]: {
						uuid: moduleUuid,
						id: "patients",
						name: "Patients",
						caseType: "patient",
					},
				},
				forms: {
					[formUuid]: {
						uuid: formUuid,
						id: "register",
						name: "Register",
						type: "registration",
					},
				},
				fields: {
					[nameUuid]: {
						uuid: nameUuid,
						id: "case_name",
						kind: "text",
						label: "Name",
						case_property_on: "patient",
					},
					[groupUuid]: {
						uuid: groupUuid,
						id: "container",
						kind: "group",
						label: "Container",
					},
					[noteUuid]: {
						uuid: noteUuid,
						id: "note",
						kind: "text",
						label: "Note",
						case_property_on: "patient",
					},
				},
				moduleOrder: [moduleUuid],
				formOrder: { [moduleUuid]: [formUuid] },
				fieldOrder: {
					[formUuid]: [nameUuid, groupUuid],
					[groupUuid]: [noteUuid],
				},
			};
			const store = createBlueprintDocStore();
			store.getState().load(doc);
			store.temporal.getState().resume();

			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(formUuid);

			ctrl.onValueChange(nameUuid, "Alice");
			ctrl.onValueChange(noteUuid, "in-progress note");

			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: groupUuid, toKind: "repeat" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			/* The child value survived the re-path — the walk reads it at the
			 * reindexed `/data/container[0]/note`. `note` targets the module's own
			 * case type, so it lands in the primary's `properties` (the child-case
			 * fan-out is only for fields writing a DIFFERENT case type); the point
			 * is the value is present, not dropped. */
			const mutation = ctrl.computeSubmissionMutation({
				caseTypes: [patientCaseType],
			});
			expect(mutation.kind).toBe("registration");
			if (mutation.kind === "registration") {
				expect(mutation.primary.properties.note).toBe("in-progress note");
				expect(mutation.primary.caseName).toBe("Alice");
			}
		});
	});

	describe("field removal drops the value", () => {
		it("clears the value on remote delete, and a re-add seeds empty", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Someone typed an answer, then the field is removed remotely. */
			ctrl.onValueChange(Q1_UUID, "answer before delete");
			store.getState().applyMany([{ kind: "removeField", uuid: Q1_UUID }]);
			await new Promise((r) => setTimeout(r, 10));
			expect(ctrl.store.getState()[Q1_UUID]).toBe(DEFAULT_RUNTIME_STATE);

			/* Re-adding a field at the SAME id/path must start empty — the delete
			 * dropped the DataInstance value, so `addFieldState` seeds `""`
			 * rather than resurrecting the pre-delete answer. */
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						uuid: Q1_UUID,
						id: "name",
						kind: "text",
						label: "Name",
					},
				},
			]);
			await new Promise((r) => setTimeout(r, 10));
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("");
		});
	});

	describe("deactivate", () => {
		it("clears runtime store and subscriptions", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Verify we have state */
			expect(Object.keys(ctrl.store.getState()).length).toBeGreaterThan(0);

			ctrl.deactivate();

			/* Runtime store should be empty after deactivation */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});
	});

	describe("public actions", () => {
		it("onValueChange updates runtime state for a field", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.onValueChange(Q1_UUID, "Alice");
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("Alice");
		});

		it("getPath returns the XForm path for a UUID", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			expect(ctrl.getPath(Q1_UUID)).toBe("/data/name");
			expect(ctrl.getPath(Q2_UUID)).toBe("/data/age");
		});
	});

	describe("repeat-instance runtime state", () => {
		const repeatUuid = asUuid("eeeeeeee-0001-0001-0001-000000000001");
		const nameUuid = asUuid("eeeeeeee-0001-0001-0001-000000000002");

		function repeatDoc(): PersistableDoc {
			return makeDoc(
				{
					[repeatUuid]: {
						uuid: repeatUuid,
						id: "orders",
						kind: "repeat",
						label: "Orders",
						repeat_mode: "user_controlled",
					},
					[nameUuid]: {
						uuid: nameUuid,
						id: "name",
						kind: "text",
						label: "Name",
					},
				},
				{
					[FORM_UUID]: [repeatUuid],
					[repeatUuid]: [nameUuid],
				},
			);
		}

		it("activation writes path-keyed entries for repeat children", () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			const runtime = ctrl.store.getState();
			// Template `[0]` children carry BOTH keys: the uuid (edit-mode
			// rows) and the concrete path (interactive instance rows).
			expect(runtime[nameUuid]).toBeDefined();
			expect(runtime["/data/orders[0]/name"]).toBeDefined();
		});

		it("setValueAt keeps instances independent in the runtime store", () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[0]/name", "Hydrangea");
			ctrl.setValueAt("/data/orders[1]/name", "Aspirin");

			const runtime = ctrl.store.getState();
			expect(runtime["/data/orders[0]/name"].value).toBe("Hydrangea");
			expect(runtime["/data/orders[1]/name"].value).toBe("Aspirin");
			// The uuid key tracks the `[0]` template slot.
			expect(runtime[nameUuid].value).toBe("Hydrangea");
		});

		it("addRepeat syncs the new instance's states; removeRepeat unplugs them", () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.addRepeat(repeatUuid);
			const afterAdd = ctrl.store.getState();
			expect(afterAdd[repeatUuid].repeatCount).toBe(2);
			expect(afterAdd["/data/orders[1]/name"]).toBeDefined();
			expect(afterAdd["/data/orders[1]/name"].value).toBe("");

			ctrl.removeRepeat(repeatUuid, 1);
			const afterRemove = ctrl.store.getState();
			expect(afterRemove[repeatUuid].repeatCount).toBe(1);
			// The removed instance's entry is unplugged to the engine's frozen
			// empty default (`path: ""`), so stale subscribers render nothing.
			expect(afterRemove["/data/orders[1]/name"].path).toBe("");
			expect(afterRemove["/data/orders[1]/name"].value).toBe("");
		});

		it("a field added inside a repeat reaches every live instance", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);

			const doseUuid = asUuid("eeeeeeee-0002-0002-0002-000000000001");
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: repeatUuid,
					field: { uuid: doseUuid, id: "dose", kind: "text", label: "Dose" },
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.store.getState()["/data/orders[1]/dose"]).toBeDefined();
			ctrl.setValueAt("/data/orders[1]/dose", "5mg");
			expect(ctrl.store.getState()["/data/orders[1]/dose"].value).toBe("5mg");
		});

		it("renaming a repeat-child field carries every instance's value", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[0]/name", "Hydrangea");
			ctrl.setValueAt("/data/orders[1]/name", "Aspirin");

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: nameUuid,
					targetKind: "text",
					patch: { id: "medication" },
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			const runtime = ctrl.store.getState();
			expect(runtime["/data/orders[0]/medication"].value).toBe("Hydrangea");
			expect(runtime["/data/orders[1]/medication"].value).toBe("Aspirin");
			expect(runtime["/data/orders[1]/name"].path).toBe("");
		});

		it("renaming the repeat container keeps its instances and values", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[1]/name", "Aspirin");

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: repeatUuid,
					targetKind: "repeat",
					patch: { id: "meds" },
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.getRepeatCount(repeatUuid)).toBe(2);
			expect(ctrl.store.getState()["/data/meds[1]/name"].value).toBe("Aspirin");
		});

		it("a retype clears every instance's stale value", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[1]/name", "abc");

			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: nameUuid, toKind: "secret" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.store.getState()["/data/orders[1]/name"].value).toBe("");
		});

		it("removing a repeat-child field leaves no phantom state blocking submit", async () => {
			const doc = repeatDoc();
			doc.fields[nameUuid] = {
				...doc.fields[nameUuid],
				required: xp("true()"),
			} as Field;
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);

			// Both instances empty + required — submit blocked.
			expect(ctrl.validateAll()).toBe(false);

			store.getState().applyMany([{ kind: "removeField", uuid: nameUuid }]);
			await new Promise((r) => setTimeout(r, 10));

			// The field is gone from every instance — nothing left to fail.
			expect(ctrl.validateAll()).toBe(true);
		});

		it("an expression edit recomputes every live instance", async () => {
			const tagUuid = asUuid("eeeeeeee-0003-0003-0003-000000000001");
			const doc = repeatDoc();
			doc.fields[tagUuid] = {
				uuid: tagUuid,
				id: "tag",
				kind: "hidden",
				calculate: xp("'A'"),
			} as Field;
			doc.fieldOrder[repeatUuid] = [nameUuid, tagUuid];
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			expect(ctrl.store.getState()["/data/orders[1]/tag"].value).toBe("A");

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: tagUuid,
					targetKind: "hidden",
					patch: { calculate: xp("'B'") },
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.store.getState()["/data/orders[0]/tag"].value).toBe("B");
			expect(ctrl.store.getState()["/data/orders[1]/tag"].value).toBe("B");
		});

		it("per-instance values reach the submission walk", () => {
			const patientCaseType: CaseType = {
				name: "patient",
				properties: [{ name: "case_name", label: "Name", data_type: "text" }],
			};
			const doc = repeatDoc();
			const nameField = doc.fields[nameUuid];
			doc.fields[nameUuid] = {
				...nameField,
				id: "case_name",
				case_property_on: "medication_order",
			} as Field;
			doc.fieldOrder[repeatUuid] = [nameUuid];
			doc.forms[FORM_UUID] = {
				...doc.forms[FORM_UUID],
				type: "registration",
			};
			doc.modules[MODULE_UUID] = {
				...doc.modules[MODULE_UUID],
				caseType: "patient",
			};
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[0]/case_name", "Hydrangea");
			ctrl.setValueAt("/data/orders[1]/case_name", "Aspirin");

			const mutation = ctrl.computeSubmissionMutation({
				caseTypes: [patientCaseType],
			});
			expect(mutation).toMatchObject({
				kind: "registration",
				children: [
					{ caseType: "medication_order", caseName: "Hydrangea" },
					{ caseType: "medication_order", caseName: "Aspirin" },
				],
			});
		});
	});

	describe("computeSubmissionMutation", () => {
		const patientCaseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
			],
		};

		it("throws when no engine is active", () => {
			const ctrl = new EngineController();
			expect(() =>
				ctrl.computeSubmissionMutation({ caseTypes: [patientCaseType] }),
			).toThrow(/controller has no active engine/);
		});

		it("delegates to the engine and returns the typed mutation", () => {
			// Build a registration-form fixture against a `patient` module.
			const moduleUuid = asUuid("module-2-uuid");
			const formUuid = asUuid("form-2-uuid");
			const nameUuid = asUuid("cccccccc-0001-0001-0001-000000000001");
			const ageUuid = asUuid("cccccccc-0002-0002-0002-000000000002");
			const doc: PersistableDoc = {
				appId: "test-app",
				appName: "Test App",
				connectType: null,
				caseTypes: [patientCaseType],
				modules: {
					[moduleUuid]: {
						uuid: moduleUuid,
						id: "patients",
						name: "Patients",
						caseType: "patient",
					},
				},
				forms: {
					[formUuid]: {
						uuid: formUuid,
						id: "register",
						name: "Register",
						type: "registration",
					},
				},
				fields: {
					[nameUuid]: {
						uuid: nameUuid,
						id: "case_name",
						kind: "text",
						label: "Name",
						case_property_on: "patient",
					},
					[ageUuid]: {
						uuid: ageUuid,
						id: "age",
						kind: "int",
						label: "Age",
						case_property_on: "patient",
					},
				},
				moduleOrder: [moduleUuid],
				formOrder: { [moduleUuid]: [formUuid] },
				fieldOrder: { [formUuid]: [nameUuid, ageUuid] },
			};
			const store = createBlueprintDocStore();
			store.getState().load(doc);
			store.temporal.getState().resume();

			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(formUuid);

			ctrl.onValueChange(nameUuid, "Alice");
			ctrl.onValueChange(ageUuid, "30");

			const mutation = ctrl.computeSubmissionMutation({
				caseTypes: [patientCaseType],
			});
			expect(mutation).toEqual({
				kind: "registration",
				primary: {
					caseType: "patient",
					caseName: "Alice",
					properties: { age: 30 },
				},
				children: [],
			});
		});
	});
});
