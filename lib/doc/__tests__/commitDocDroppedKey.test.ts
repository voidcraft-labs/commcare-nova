/**
 * Dropped-key overlay regression — the zustand top-level setState MERGES the
 * immer-produced state over the previous one, so a key `delete`d on the draft
 * is silently resurrected from `prev`. `commitDoc` / `load` must blank a data
 * key their target no longer carries with an explicit `undefined` (which
 * survives the merge), or a reconciler reseed keeps a peer's DELETED value
 * displayed and the next autosave re-commits it server-side.
 */
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { assertAdmittedDoc } from "./admittedDoc";

const LOGO = testMediaAssetId("old-logo");
function doc(logo?: BlueprintDoc["logo"]): BlueprintDoc {
	const result = buildDoc({
		appId: "a",
		appName: "App",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "name" }],
					},
				],
			},
		],
	});
	if (logo !== undefined) result.logo = logo;
	assertAdmittedDoc(result);
	return result;
}

describe("dropped-key overlay (commitDoc / load)", () => {
	it("commitDoc blanks a key the target no longer carries", () => {
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc(LOGO)));
		expect(store.getState().logo).toBe(LOGO);
		// A reseed whose server-hydrated target lacks `logo` (a peer cleared it).
		store.getState().commitDoc(doc());
		expect(store.getState().logo).toBeUndefined();
	});

	it("load blanks a prior load's optional slot", () => {
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc(LOGO)));
		store.getState().load(toPersistableDoc(doc()));
		expect(store.getState().logo).toBeUndefined();
	});

	it("commitDoc inside a remote-apply bracket keeps the raised flag", () => {
		// The overlay must never blank the store's own bookkeeping: the flag is
		// raised for exactly the synchronous reseed window, and blanking it would
		// let the store subscriber bounce the server's write back out as a PUT.
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc(LOGO)));
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
