/**
 * EngineController tests — verifies the controller correctly subscribes
 * to the BlueprintDoc store for per-question reactivity, structural
 * changes, and form activation.
 */
import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { DEFAULT_RUNTIME_STATE, EngineController } from "../engineController";

// ── Fixtures ───────────────────────────────────────────────────────────

const Q1_UUID = "aaaaaaaa-0001-0001-0001-000000000001";
const Q2_UUID = "aaaaaaaa-0002-0002-0002-000000000002";

/** Minimal survey blueprint with two text questions in one form. */
function makeBlueprint(
	questions: AppBlueprint["modules"][0]["forms"][0]["questions"] = [
		{ uuid: Q1_UUID, id: "name", type: "text", label: "Name" },
		{ uuid: Q2_UUID, id: "age", type: "int", label: "Age" },
	],
): AppBlueprint {
	return {
		app_name: "Test App",
		case_types: null,
		modules: [
			{
				name: "Module 1",
				forms: [{ name: "Form 1", type: "survey", questions }],
			},
		],
	};
}

/** Create a doc store loaded with the given blueprint. Undo tracking
 *  is resumed so mutations create live state changes. */
function createLoadedStore(bp: AppBlueprint = makeBlueprint()) {
	const store = createBlueprintDocStore();
	store.getState().load(bp, "test-app");
	store.temporal.getState().resume();
	return store;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("EngineController", () => {
	describe("activateForm", () => {
		it("resolves module and form indices to the correct form", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(0, 0);

			/* Runtime store should have entries for both questions */
			const runtime = ctrl.store.getState();
			expect(runtime[Q1_UUID]).toBeDefined();
			expect(runtime[Q2_UUID]).toBeDefined();
			expect(runtime[Q1_UUID].visible).toBe(true);
			expect(runtime[Q2_UUID].visible).toBe(true);
		});

		it("returns early for out-of-range module index", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(99, 0);

			/* Runtime store should be empty — no form was activated */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});

		it("returns early for out-of-range form index", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(0, 99);

			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});

		it("returns early when no doc store is installed", () => {
			const ctrl = new EngineController();
			ctrl.activateForm(0, 0);
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});
	});

	describe("per-question subscription", () => {
		it("fires on question label update via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(0, 0);

			/* Mutate the question's relevant expression to hide it */
			store.getState().apply({
				kind: "updateQuestion",
				uuid: asUuid(Q1_UUID),
				patch: { relevant: "false()" },
			});

			/* Zustand's subscribeWithSelector fires synchronously on the
			 * next microtask — flush with a short wait. */
			await new Promise((r) => setTimeout(r, 10));

			const state = ctrl.store.getState()[Q1_UUID];
			expect(state).toBeDefined();
			/* The question should now be hidden because relevant = "false()" */
			expect(state.visible).toBe(false);
		});
	});

	describe("structural subscription", () => {
		it("detects question addition via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(0, 0);

			/* Initial state should have 2 questions */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(2);

			/* Find the form uuid to use as parent for the new question */
			const docState = store.getState();
			const moduleUuid = docState.moduleOrder[0];
			const formUuid = docState.formOrder[moduleUuid][0];

			const newUuid = "bbbbbbbb-0003-0003-0003-000000000003";
			store.getState().apply({
				kind: "addQuestion",
				parentUuid: formUuid,
				question: {
					uuid: asUuid(newUuid),
					id: "new_q",
					type: "text",
					label: "New Question",
				},
			});

			await new Promise((r) => setTimeout(r, 10));

			/* The new question should appear in the runtime store */
			const runtime = ctrl.store.getState();
			expect(runtime[newUuid]).toBeDefined();
			expect(runtime[newUuid].visible).toBe(true);
		});

		it("detects question removal via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(0, 0);

			/* Remove the first question */
			store.getState().apply({
				kind: "removeQuestion",
				uuid: asUuid(Q1_UUID),
			});

			await new Promise((r) => setTimeout(r, 10));

			/* The removed question should revert to the frozen default state */
			const runtime = ctrl.store.getState();
			expect(runtime[Q1_UUID]).toBe(DEFAULT_RUNTIME_STATE);
		});
	});

	describe("deactivate", () => {
		it("clears runtime store and subscriptions", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(0, 0);

			/* Verify we have state */
			expect(Object.keys(ctrl.store.getState()).length).toBeGreaterThan(0);

			ctrl.deactivate();

			/* Runtime store should be empty after deactivation */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});
	});

	describe("public actions", () => {
		it("onValueChange updates runtime state for a question", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(0, 0);

			ctrl.onValueChange(Q1_UUID, "Alice");
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("Alice");
		});

		it("getPath returns the XForm path for a UUID", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(0, 0);

			expect(ctrl.getPath(Q1_UUID)).toBe("/data/name");
			expect(ctrl.getPath(Q2_UUID)).toBe("/data/age");
		});
	});
});
