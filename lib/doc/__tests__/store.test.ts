import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * Minimal valid `BlueprintDoc` with no modules. Used for lifecycle tests
 * that only care about store mechanics (undo, loading flag) rather than
 * blueprint content.
 *
 * `load()` accepts the normalized shape directly.
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

	it("load() preserves every field of the input doc, including the app logo", () => {
		// `logo` is an optional top-level slot that lives outside the entity
		// maps — exactly the kind of field a hand-listed hydration drops. Load
		// a doc with every field set and assert the store reflects each one, so
		// the hydration can't silently lose a slot (it lost `logo` before).
		const store = createBlueprintDocStore();
		const doc: BlueprintDoc = {
			...makeEmptyDoc({ appName: "Loaded" }),
			connectType: "learn",
			logo: "asset-logo-id" as BlueprintDoc["logo"],
		};
		store.getState().load(doc);
		const state = store.getState();

		expect(state.logo).toBe("asset-logo-id");
		for (const key of Object.keys(doc) as (keyof BlueprintDoc)[]) {
			expect(state[key]).toEqual(doc[key]);
		}
	});

	it("load() does NOT populate the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc());
		expect(store.temporal.getState().pastStates).toHaveLength(0);
	});

	it("applyMany() captures a state change in the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "Before" }));
		store.getState().startTracking();
		store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
		expect(store.getState().appName).toBe("After");
		expect(store.temporal.getState().pastStates.length).toBeGreaterThan(0);
	});

	it("applyMany() batches multiple mutations into a single undo entry", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "A" }));
		store.getState().startTracking();
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
		store.getState().startTracking();
		store.getState().beginAgentWrite();
		store.getState().applyMany([{ kind: "setAppName", name: "During Agent" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(0);
		store.getState().endAgentWrite();
		store.getState().applyMany([{ kind: "setAppName", name: "After Agent" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(1);
	});

	it("startTracking() releases the birth pause once and drives depth to 0", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "A" }));
		// Before startTracking the store is paused (birth base) — edits invisible.
		store.getState().applyMany([{ kind: "setAppName", name: "B" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(0);
		// Release the birth pause → tracking live.
		store.getState().startTracking();
		store.getState().applyMany([{ kind: "setAppName", name: "C" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(1);
		// Idempotent — a second call doesn't unbalance the counter.
		store.getState().startTracking();
		store.getState().applyMany([{ kind: "setAppName", name: "D" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(2);
	});

	it("undo works after a fresh build: mount paused → run → startTracking (the [4] regression)", () => {
		// Simulate a FRESH BUILD: mount paused (no startTracking at mount), open
		// the agent bracket (beginRun), edit during the run, then close the bracket
		// (endRun) followed by startTracking() — the prod flow ChatContainer drives.
		// Without startTracking the birth pause never releases (depth stuck at 1),
		// so undo was permanently DEAD after a build until a page reload.
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "New" }));
		// No startTracking at mount — a fresh build generates first.
		store.getState().beginAgentWrite(); // beginRun
		store.getState().applyMany([{ kind: "setAppName", name: "Generated" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(0);
		store.getState().endAgentWrite(); // endRun closes the agent bracket
		// ChatContainer calls startTracking() after endRun — bracket already closed,
		// so it releases the birth pause immediately.
		store.getState().startTracking();
		// A subsequent human edit IS recorded — undo works, no page reload needed.
		store.getState().applyMany([{ kind: "setAppName", name: "HumanEdit" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(1);
		expect(store.temporal.getState().isTracking).toBe(true);
	});

	it("startTracking() DURING an open bracket defers the birth-pause release to the bracket close", () => {
		// The defensive deferral: if startTracking arrives while a suppression
		// bracket is open, the release must ride the bracket close (never unbalance
		// the depth counter).
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "New" }));
		store.getState().beginAgentWrite(); // bracket open
		store.getState().startTracking(); // deferred — bracket still open
		// Tracking is still paused while the bracket is open.
		expect(store.temporal.getState().isTracking).toBe(false);
		store.getState().applyMany([{ kind: "setAppName", name: "InBracket" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(0);
		store.getState().endAgentWrite(); // bracket closes → deferred release fires
		expect(store.temporal.getState().isTracking).toBe(true);
		store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
		expect(store.temporal.getState().pastStates).toHaveLength(1);
	});
});
