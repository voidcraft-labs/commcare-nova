import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

describe("createBlueprintDocStore", () => {
	it("starts with an empty doc", () => {
		const store = createBlueprintDocStore();
		const doc = store.getState();
		expect(doc.appName).toBe("");
		expect(doc.moduleOrder).toEqual([]);
	});

	it("load() hydrates the doc from a blueprint", () => {
		const store = createBlueprintDocStore();
		const bp: AppBlueprint = {
			app_name: "Loaded",
			connect_type: undefined,
			modules: [{ name: "Mod", forms: [] }],
			case_types: null,
		};
		store.getState().load(bp, "app-1");
		const doc = store.getState();
		expect(doc.appName).toBe("Loaded");
		expect(doc.appId).toBe("app-1");
		expect(doc.moduleOrder).toHaveLength(1);
	});

	it("load() does NOT populate the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "Loaded",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		expect(store.temporal.getState().pastStates).toHaveLength(0);
	});

	it("apply() captures a state change in the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "Before",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		store.temporal.getState().resume();
		store.getState().apply({ kind: "setAppName", name: "After" });
		expect(store.getState().appName).toBe("After");
		expect(store.temporal.getState().pastStates.length).toBeGreaterThan(0);
	});

	it("applyMany() batches multiple mutations into a single undo entry", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "A",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		store.temporal.getState().resume();
		store.getState().applyMany([
			{ kind: "setAppName", name: "B" },
			{ kind: "setConnectType", connectType: "learn" },
		]);
		expect(store.getState().appName).toBe("B");
		expect(store.getState().connectType).toBe("learn");
		// Exactly one undo entry was added.
		expect(store.temporal.getState().pastStates).toHaveLength(1);
	});

	it("beginAgentWrite()/endAgentWrite() pause and resume undo tracking", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "A",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		store.temporal.getState().resume();
		store.getState().beginAgentWrite();
		store.getState().apply({ kind: "setAppName", name: "During Agent" });
		expect(store.temporal.getState().pastStates).toHaveLength(0);
		store.getState().endAgentWrite();
		store.getState().apply({ kind: "setAppName", name: "After Agent" });
		expect(store.temporal.getState().pastStates).toHaveLength(1);
	});
});
