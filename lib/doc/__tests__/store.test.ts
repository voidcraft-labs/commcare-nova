import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * Minimal valid `BlueprintDoc` with no modules. Used for lifecycle tests
 * that only care about store mechanics (undo, loading flag) rather than
 * blueprint content.
 *
 * `load()` now accepts the normalized shape directly — no `AppBlueprint`
 * conversion is performed by the store.
 */
function makeEmptyDoc(
	opts: { appId?: string; appName?: string } = {},
): BlueprintDoc {
	return {
		appId: opts.appId ?? "app-1",
		appName: opts.appName ?? "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("createBlueprintDocStore", () => {
	it("starts with an empty doc", () => {
		const store = createBlueprintDocStore();
		const doc = store.getState();
		expect(doc.appName).toBe("");
		expect(doc.moduleOrder).toEqual([]);
	});

	it("load() hydrates the doc from a normalized BlueprintDoc", () => {
		const store = createBlueprintDocStore();
		// The module uuid is typed as a branded Uuid — use `as` casts on these
		// test fixtures rather than importing asUuid (which adds noise). The
		// branded type is enforced at the type level; the runtime value is a plain
		// string, so the cast is safe in tests.
		type Uuid = BlueprintDoc["moduleOrder"][number];
		const modUuid = "module-1-uuid" as Uuid;
		const doc: BlueprintDoc = {
			appId: "app-1",
			appName: "Loaded",
			connectType: null,
			caseTypes: null,
			modules: {
				[modUuid]: { uuid: modUuid, id: "mod", name: "Mod" },
			},
			forms: {},
			fields: {},
			moduleOrder: [modUuid],
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
		};
		store.getState().load(doc);
		const state = store.getState();
		expect(state.appName).toBe("Loaded");
		expect(state.appId).toBe("app-1");
		expect(state.moduleOrder).toHaveLength(1);
	});

	it("load() does NOT populate the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc());
		expect(store.temporal.getState().pastStates).toHaveLength(0);
	});

	it("apply() captures a state change in the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "Before" }));
		store.temporal.getState().resume();
		store.getState().apply({ kind: "setAppName", name: "After" });
		expect(store.getState().appName).toBe("After");
		expect(store.temporal.getState().pastStates.length).toBeGreaterThan(0);
	});

	it("applyMany() batches multiple mutations into a single undo entry", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "A" }));
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
		store.getState().load(makeEmptyDoc({ appName: "A" }));
		store.temporal.getState().resume();
		store.getState().beginAgentWrite();
		store.getState().apply({ kind: "setAppName", name: "During Agent" });
		expect(store.temporal.getState().pastStates).toHaveLength(0);
		store.getState().endAgentWrite();
		store.getState().apply({ kind: "setAppName", name: "After Agent" });
		expect(store.temporal.getState().pastStates).toHaveLength(1);
	});
});
