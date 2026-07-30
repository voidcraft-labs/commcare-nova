import { describe, expect, it } from "vitest";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
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

describe("the command queue is current when the write is announced", () => {
	// `useAutoSave` subscribes to the store and dispatches the save SYNCHRONOUSLY
	// from the write that changed the document, so the queue has to already hold
	// the command by then. A queue filled after the `set()` leaves every save one
	// edit behind — the first edit's PUT sees an empty queue and sends nothing,
	// its command riding out later on the back of a SECOND edit — and a lone
	// edit, the last one before the author stops typing, never goes out at all.
	function subscriberSeesQueue(
		write: (store: ReturnType<typeof createBlueprintDocStore>) => void,
	): number {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc());
		store.getState().startTracking();
		let seen = -1;
		const unsubscribe = store.subscribe(() => {
			if (seen === -1) seen = store.getState().peekCommands().length;
		});
		write(store);
		unsubscribe();
		return seen;
	}

	it("applyMany records before it notifies", () => {
		expect(
			subscriberSeesQueue((store) => {
				store.getState().applyMany([{ kind: "setAppName", name: "Renamed" }]);
			}),
		).toBe(1);
	});

	it("commitDoc records before it notifies", () => {
		expect(
			subscriberSeesQueue((store) => {
				const next = {
					...store.getState(),
					appName: "Renamed",
				} as BlueprintDoc;
				store
					.getState()
					.commitDoc(
						next,
						admitMutationBatch([{ kind: "setAppName", name: "Renamed" }]),
					);
			}),
		).toBe(1);
	});
});

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
			formOrder: { [modUuid]: [] },
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

	it("bounds the history, dropping the oldest step", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "n0" }));
		store.getState().startTracking();
		// One past the cap, so exactly the first step falls off.
		for (let i = 1; i <= 101; i++) {
			store.getState().applyMany([{ kind: "setAppName", name: `n${i}` }]);
		}
		for (let i = 0; i < 100; i++) store.getState().undo();
		// Back to the first RETAINED step's starting point, not to `n0`.
		expect(store.getState().appName).toBe("n1");
		expect(store.getState().canUndo).toBe(false);
	});

	it("an inbound frame's overlay leaves the history flags alone", () => {
		// `overlayDoc` blanks every DOC key the incoming document does not carry,
		// and an incoming document never carries bookkeeping. A bookkeeping field
		// missing from `isDocDataKey` therefore reads as `undefined` the moment a
		// peer's edit or the author's own echo arrives — the toolbar's Undo goes
		// dead while the history behind it is intact.
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "Base" }));
		store.getState().startTracking();
		store.getState().applyMany([{ kind: "setAppName", name: "Mine" }]);
		expect(store.getState().canUndo).toBe(true);

		// The reconciler folding a frame: a suppressed whole-document commit.
		store.getState().beginRemoteApply();
		store.getState().commitDoc({
			...store.getState(),
			appName: "Peer",
		} as BlueprintDoc);
		store.getState().endRemoteApply();

		expect(store.getState().appName).toBe("Peer");
		expect(store.getState().canUndo).toBe(true);
		expect(store.getState().canRedo).toBe(false);
	});

	it("load() is not a step the author can take back", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc());
		expect(store.getState().canUndo).toBe(false);
	});

	it("applyMany() records a step, and undo returns the prior value", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "Before" }));
		store.getState().startTracking();
		store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
		expect(store.getState().appName).toBe("After");
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).toBe("Before");
		expect(store.getState().canUndo).toBe(false);
		expect(store.getState().canRedo).toBe(true);
		store.getState().redo();
		expect(store.getState().appName).toBe("After");
	});

	it("applyMany() batches multiple mutations into ONE step", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "A" }));
		store.getState().startTracking();
		store.getState().applyMany([
			{ kind: "setAppName", name: "B" },
			{ kind: "setConnectType", connectType: "learn" },
		]);
		expect(store.getState().appName).toBe("B");
		expect(store.getState().connectType).toBe("learn");
		// One undo takes back the whole batch, and there is nothing behind it.
		store.getState().undo();
		expect(store.getState().appName).toBe("A");
		expect(store.getState().connectType).toBe(null);
		expect(store.getState().canUndo).toBe(false);
	});

	it("an agent run is one step, however many writes it streams", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "A" }));
		store.getState().startTracking();
		store.getState().beginAgentWrite();
		store.getState().applyMany([{ kind: "setAppName", name: "During Agent" }]);
		expect(store.getState().canUndo).toBe(false);
		store.getState().endAgentWrite();
		store.getState().applyMany([{ kind: "setAppName", name: "After Agent" }]);
		// Undo takes back the author's edit, not the run's.
		store.getState().undo();
		expect(store.getState().appName).toBe("During Agent");
		expect(store.getState().canUndo).toBe(false);
	});

	it("startTracking() releases the birth pause once", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "A" }));
		// Before startTracking the store is paused (birth base) — no step recorded.
		store.getState().applyMany([{ kind: "setAppName", name: "B" }]);
		expect(store.getState().canUndo).toBe(false);
		store.getState().startTracking();
		store.getState().applyMany([{ kind: "setAppName", name: "C" }]);
		// Idempotent — a second call doesn't unbalance the counter.
		store.getState().startTracking();
		store.getState().applyMany([{ kind: "setAppName", name: "D" }]);
		// Both post-release edits are their own step; the pre-release one is not.
		store.getState().undo();
		expect(store.getState().appName).toBe("C");
		store.getState().undo();
		expect(store.getState().appName).toBe("B");
		expect(store.getState().canUndo).toBe(false);
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
		expect(store.getState().canUndo).toBe(false);
		store.getState().endAgentWrite(); // endRun closes the agent bracket
		// ChatContainer calls startTracking() after endRun — bracket already closed,
		// so it releases the birth pause immediately.
		store.getState().startTracking();
		// A subsequent human edit IS recorded — undo works, no page reload needed.
		store.getState().applyMany([{ kind: "setAppName", name: "HumanEdit" }]);
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).toBe("Generated");
	});

	it("startTracking() DURING an open bracket defers the birth-pause release to the bracket close", () => {
		// The defensive deferral: if startTracking arrives while a suppression
		// bracket is open, the release must ride the bracket close (never unbalance
		// the depth counter).
		const store = createBlueprintDocStore();
		store.getState().load(makeEmptyDoc({ appName: "New" }));
		store.getState().beginAgentWrite(); // bracket open
		store.getState().startTracking(); // deferred — bracket still open
		store.getState().applyMany([{ kind: "setAppName", name: "InBracket" }]);
		expect(store.getState().canUndo).toBe(false);
		store.getState().endAgentWrite(); // bracket closes → deferred release fires
		store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).toBe("InBracket");
	});
});
