// Round-trip fidelity for the entity-row projection — the invariant the
// commit gate, the validator, and the fold check all stand on:
// `assemble(decompose(doc)) ≡ doc`, including the reducer's key-per-parent
// shape (`formOrder[m]` exists EMPTY for a formless module; `fieldOrder[f]`
// for a fieldless form and a childless group/repeat container), which
// decompose can't carry as rows and assemble must re-seed.

import { describe, expect, it } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import {
	caseListModuleMutations,
	surveyModuleMutations,
} from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/domain";
import {
	assembleBlueprint,
	blueprintScalars,
	decomposeBlueprint,
	diffBlueprints,
} from "../blueprintRows";

function emptyDoc(appId: string): BlueprintDoc {
	return {
		appId,
		appName: "Round Trip",
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

function roundTrip(doc: BlueprintDoc) {
	const persistable = toPersistableDoc(doc);
	const rows = decomposeBlueprint(persistable);
	return assembleBlueprint(doc.appId, blueprintScalars(persistable), rows);
}

describe("blueprint entity-row round trip", () => {
	it("reproduces a case-list-only module (formless — empty formOrder key survives)", () => {
		const doc = emptyDoc("rt-app-1");
		applyMutations(
			doc,
			caseListModuleMutations(doc, { caseType: "patient" }).mutations,
		);
		const assembled = roundTrip(doc);
		expect(assembled).toEqual(toPersistableDoc(doc));
		// The load-bearing shape detail: the formless module still carries its
		// (empty) membership key, exactly as the reducer left it.
		const moduleUuid = doc.moduleOrder[0];
		expect(assembled.formOrder[moduleUuid]).toEqual([]);
	});

	it("reproduces a survey module (module → form → field chain)", () => {
		const doc = emptyDoc("rt-app-2");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const assembled = roundTrip(doc);
		expect(assembled).toEqual(toPersistableDoc(doc));
	});

	it("diff of an unchanged doc is empty", () => {
		const doc = emptyDoc("rt-app-3");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const persistable = toPersistableDoc(doc);
		const { upserts, deletedUuids } = diffBlueprints(persistable, persistable);
		expect(upserts).toEqual([]);
		expect(deletedUuids).toEqual([]);
	});

	it("diff is key-order-insensitive (a jsonb round-trip's reorder is not dirty)", () => {
		const doc = emptyDoc("rt-app-4");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const persistable = toPersistableDoc(doc);
		// Simulate jsonb normalization: rebuild with reversed key order.
		const reordered = JSON.parse(
			JSON.stringify(persistable, (_k, v) =>
				v !== null && typeof v === "object" && !Array.isArray(v)
					? Object.fromEntries(Object.entries(v).reverse())
					: v,
			),
		);
		const { upserts, deletedUuids } = diffBlueprints(reordered, persistable);
		expect(upserts).toEqual([]);
		expect(deletedUuids).toEqual([]);
	});

	it("refuses to persist a doc whose form record is missing from every membership array", () => {
		const doc = emptyDoc("rt-app-5");
		applyMutations(doc, surveyModuleMutations(doc).mutations);
		const persistable = toPersistableDoc(doc);
		const broken = structuredClone(persistable);
		broken.formOrder = Object.fromEntries(
			Object.entries(broken.formOrder).map(([k]) => [k, []]),
		);
		expect(() => decomposeBlueprint(broken)).toThrow(/refusing to persist/);
	});
});
