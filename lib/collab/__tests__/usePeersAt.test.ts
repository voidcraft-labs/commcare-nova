/**
 * usePeersAt state-model tests — the pure target-extraction + grouping the
 * canvas markers consume, plus the follow-recovery behavior. No DOM, no React;
 * the hook is a thin wrapper over these pure functions (`peerTarget`,
 * `groupPeersByEntity`) and `recoverLocation`.
 */

import { describe, expect, it } from "vitest";
import { hashColor, type Peer } from "@/lib/collab/presence";
import { groupPeersByEntity, peerTarget } from "@/lib/collab/usePeersAt";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import { recoverLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

const MOD = asUuid("mod-1");
const FORM = asUuid("form-1");
const FIELD = asUuid("field-1");

/** A peer at a given location; identity + color derive from `userId`. */
function peer(userId: string, location: Location): Peer {
	return {
		userId,
		sessionId: `${userId}-tab`,
		name: userId,
		image: null,
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

// ── Follow recovery ───────────────────────────────────────────────────────

/** A minimal doc holding just the entity maps `recoverLocation` reads — it
 *  only checks entity PRESENCE, so the values are placeholder shells (cast
 *  through `unknown`; a full `Module`/`Form`/`Field` would just be noise). */
function docWith(entities: {
	modules?: Uuid[];
	forms?: Uuid[];
	fields?: Uuid[];
}): Pick<BlueprintDoc, "modules" | "forms" | "fields"> {
	const present = (uuids: Uuid[] | undefined) =>
		Object.fromEntries((uuids ?? []).map((u) => [u, { uuid: u }]));
	return {
		modules: present(entities.modules),
		forms: present(entities.forms),
		fields: present(entities.fields),
	} as unknown as Pick<BlueprintDoc, "modules" | "forms" | "fields">;
}

describe("recoverLocation — follow lands on the nearest valid ancestor", () => {
	it("follows a live peer to its exact field", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD,
			formUuid: FORM,
			selectedUuid: FIELD,
		};
		const doc = docWith({ modules: [MOD], forms: [FORM], fields: [FIELD] });
		// Every ref resolves — the exact location is returned by identity.
		expect(recoverLocation(loc, doc)).toBe(loc);
	});

	it("drops a deleted field selection, landing on the form", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD,
			formUuid: FORM,
			selectedUuid: FIELD,
		};
		// Field gone, form + module still present.
		const doc = docWith({ modules: [MOD], forms: [FORM] });
		expect(recoverLocation(loc, doc)).toEqual({
			kind: "form",
			moduleUuid: MOD,
			formUuid: FORM,
		});
	});

	it("falls back to the module when the peer's form was deleted", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD,
			formUuid: FORM,
			selectedUuid: FIELD,
		};
		const doc = docWith({ modules: [MOD] });
		expect(recoverLocation(loc, doc)).toEqual({
			kind: "module",
			moduleUuid: MOD,
		});
	});

	it("falls back to home when the peer's whole module was deleted", () => {
		const loc: Location = { kind: "module", moduleUuid: MOD };
		expect(recoverLocation(loc, docWith({}))).toEqual({ kind: "home" });
	});
});
