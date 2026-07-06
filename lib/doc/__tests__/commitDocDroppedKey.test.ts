/**
 * Dropped-key overlay regression — the zustand top-level setState MERGES the
 * immer-produced state over the previous one, so a key `delete`d on the draft
 * is silently resurrected from `prev`. `commitDoc` / `load` must blank a data
 * key their target no longer carries with an explicit `undefined` (which
 * survives the merge), or a reconciler reseed keeps a peer's DELETED value
 * displayed and the next autosave re-commits it server-side.
 */
import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";

const doc = (logo?: string): BlueprintDoc =>
	({
		appId: "a",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
		...(logo !== undefined && { logo }),
	}) as unknown as BlueprintDoc;

describe("dropped-key overlay (commitDoc / load)", () => {
	it("commitDoc blanks a key the target no longer carries", () => {
		const store = createBlueprintDocStore();
		store.getState().load(doc("STALE_ASSET"));
		expect((store.getState() as { logo?: string }).logo).toBe("STALE_ASSET");
		// A reseed whose server-hydrated target lacks `logo` (a peer cleared it).
		store.getState().commitDoc(doc());
		expect((store.getState() as { logo?: string }).logo).toBeUndefined();
	});

	it("load blanks a prior load's optional slot", () => {
		const store = createBlueprintDocStore();
		store.getState().load(doc("STALE_ASSET"));
		store.getState().load(doc());
		expect((store.getState() as { logo?: string }).logo).toBeUndefined();
	});

	it("commitDoc inside a remote-apply bracket keeps the raised flag", () => {
		// The overlay must never blank the store's own bookkeeping: the flag is
		// raised for exactly the synchronous reseed window, and blanking it would
		// let the store subscriber bounce the server's write back out as a PUT.
		const store = createBlueprintDocStore();
		store.getState().load(doc("X"));
		store.getState().beginRemoteApply();
		try {
			store.getState().commitDoc(doc());
			expect(store.getState().remoteFrameApplyInProgress).toBe(true);
		} finally {
			store.getState().endRemoteApply();
		}
		expect(store.getState().remoteFrameApplyInProgress).toBe(false);
	});
});
