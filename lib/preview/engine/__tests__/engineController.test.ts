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
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Field, Uuid } from "@/lib/domain";
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
					patch: { relevant: "false()" },
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
});
