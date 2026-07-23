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
import {
	asUuid,
	type BlueprintDoc,
	type LookupOptionsSource,
} from "@/lib/domain";
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
	const rows = decomposeBlueprint(persistable).map((row) => ({
		...row,
		// PostgreSQL jsonb owns entity-row storage. Exercise the same plain-JSON
		// boundary rather than handing assembleBlueprint the original references.
		data: JSON.parse(JSON.stringify(row.data)),
	}));
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

	it("preserves a dormant lookup-backed select through entity-row hydration", () => {
		const moduleUuid = asUuid("10000000-0000-4000-8000-000000000001");
		const formUuid = asUuid("20000000-0000-4000-8000-000000000001");
		const fieldUuid = asUuid("30000000-0000-4000-8000-000000000001");
		const tableId = "018f3e8a-7b2c-7def-8abc-1234567890ab";
		const valueColumnId = "018f3e8a-7b2c-7def-8abc-1234567890ad";
		const labelColumnId = "018f3e8a-7b2c-7def-8abc-1234567890ae";
		const optionsSource = {
			kind: "lookup-table",
			tableId,
			valueColumnId,
			labelColumnId,
			filter: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "table-column", tableId, columnId: valueColumnId },
				},
				right: {
					kind: "table-lookup",
					tableId,
					resultColumnId: labelColumnId,
					where: { kind: "match-all" },
				},
			},
		} as LookupOptionsSource;
		const doc: BlueprintDoc = {
			...emptyDoc("rt-app-lookup"),
			modules: {
				[moduleUuid]: {
					uuid: moduleUuid,
					id: "visits",
					name: "Visits",
					order: "a0",
				},
			},
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "visit",
					name: "Visit",
					type: "survey",
					order: "a0",
				},
			},
			fields: {
				[fieldUuid]: {
					uuid: fieldUuid,
					id: "status",
					kind: "single_select",
					label: "Status",
					order: "a0",
					options: [
						{ value: "active", label: "Active" },
						{ value: "closed", label: "Closed" },
					],
					optionsSource,
				},
			},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [fieldUuid] },
			fieldParent: { [fieldUuid]: formUuid },
		};

		const assembled = roundTrip(doc);
		expect(assembled.fields[fieldUuid]).toMatchObject({ optionsSource });
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
