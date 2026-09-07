/**
 * usePeersAt state-model tests — the pure target-extraction + grouping the
 * canvas markers consume. No DOM, no React;
 * the hook is a thin wrapper over these pure functions (`peerTarget`,
 * `groupPeersByEntity`).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { hashColor, type Peer } from "@/lib/collab/presence";
import { groupPeersByEntity, peerTarget } from "@/lib/collab/usePeersAt";
import type { Location } from "@/lib/routing/types";

const MOD = testUuid("mod-1");
const FORM = testUuid("form-1");
const FIELD = testUuid("field-1");

/** A peer at a given location; identity + color derive from `userId`. */
function peer(userId: string, location: Location): Peer {
	return {
		userId,
		sessionId: `${userId}-tab`,
		name: userId,
		image: null,
		email: "",
		color: hashColor(userId).id,
		location,
		updatedAt: 0,
		peerColor: hashColor(userId),
	};
}

describe("peerTarget — most-specific entity per Location kind", () => {
	it("home → null (roster-only, no marker)", () => {
		expect(peerTarget({ kind: "home" })).toBeNull();
	});

	it("module → the module", () => {
		expect(peerTarget({ kind: "module", moduleUuid: MOD })).toEqual({
			kind: "module",
			uuid: MOD,
		});
	});

	it("cases → the module (the caseId is case data, not an entity)", () => {
		expect(
			peerTarget({ kind: "cases", moduleUuid: MOD, caseId: "c-99" }),
		).toEqual({ kind: "module", uuid: MOD });
	});

	it("search-config → the module", () => {
		expect(peerTarget({ kind: "search-config", moduleUuid: MOD })).toEqual({
			kind: "module",
			uuid: MOD,
		});
	});

	it("detail-config → the module", () => {
		expect(peerTarget({ kind: "detail-config", moduleUuid: MOD })).toEqual({
			kind: "module",
			uuid: MOD,
		});
	});

	it("form without selection → the form", () => {
		expect(
			peerTarget({ kind: "form", moduleUuid: MOD, formUuid: FORM }),
		).toEqual({ kind: "form", uuid: FORM });
	});

	it("form WITH a selected field → the FIELD (most specific, not the form)", () => {
		expect(
			peerTarget({
				kind: "form",
				moduleUuid: MOD,
				formUuid: FORM,
				selectedUuid: FIELD,
			}),
		).toEqual({ kind: "field", uuid: FIELD });
	});
});

describe("groupPeersByEntity", () => {
	it("buckets each peer under its ONE most-specific entity (not per ancestor)", () => {
		const peers = [
			peer("a", { kind: "module", moduleUuid: MOD }),
			peer("b", { kind: "form", moduleUuid: MOD, formUuid: FORM }),
			peer("c", {
				kind: "form",
				moduleUuid: MOD,
				formUuid: FORM,
				selectedUuid: FIELD,
			}),
		];
		const { byEntity } = groupPeersByEntity(peers);
		// Peer c is on the field only — the module + form buckets don't gain it.
		expect(byEntity.get(MOD)?.map((p) => p.userId)).toEqual(["a"]);
		expect(byEntity.get(FORM)?.map((p) => p.userId)).toEqual(["b"]);
		expect(byEntity.get(FIELD)?.map((p) => p.userId)).toEqual(["c"]);
	});

	it("collects multiple peers on the same entity", () => {
		const peers = [
			peer("a", { kind: "module", moduleUuid: MOD }),
			peer("b", { kind: "cases", moduleUuid: MOD }),
		];
		const { byEntity } = groupPeersByEntity(peers);
		expect(
			byEntity
				.get(MOD)
				?.map((p) => p.userId)
				.sort(),
		).toEqual(["a", "b"]);
	});

	it("omits a home peer entirely (no bucket)", () => {
		const { byEntity } = groupPeersByEntity([peer("a", { kind: "home" })]);
		expect(byEntity.size).toBe(0);
	});

	it("editingByEntity holds only peers whose selection IS that field", () => {
		const peers = [
			peer("editor", {
				kind: "form",
				moduleUuid: MOD,
				formUuid: FORM,
				selectedUuid: FIELD,
			}),
			peer("browser", { kind: "form", moduleUuid: MOD, formUuid: FORM }),
		];
		const { editingByEntity } = groupPeersByEntity(peers);
		expect(editingByEntity.get(FIELD)?.map((p) => p.userId)).toEqual([
			"editor",
		]);
		// The form-only browser lands in no editing bucket.
		expect(editingByEntity.get(FORM)).toBeUndefined();
	});
});
