// scripts/__tests__/normalizeLegacyBlueprint.test.ts
//
// The cutover's legacy projection: each rule is a lossless narrowing to what
// today's readers consume, so the normalized doc must (a) strict-parse, (b)
// survive the entity-row round trip, and (c) leave everything the rules
// don't name byte-identical. Fixtures mirror the four real prod shapes the
// pre-cutover scan surfaced (vestigial v0 case-list keys, merge-orphaned
// module records, mode-mismatched repeat slots, label-less case properties).

import { describe, expect, it } from "vitest";
import {
	assembleBlueprint,
	blueprintScalars,
	decomposeBlueprint,
} from "@/lib/db/blueprintRows";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { surveyModuleMutations } from "@/lib/doc/scaffolds";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain";
import {
	normalizationSummary,
	normalizeLegacyBlueprint,
} from "../lib/normalizeLegacyBlueprint";

function baseDoc(appId: string): BlueprintDoc {
	const doc: BlueprintDoc = {
		appId,
		appName: "Legacy",
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
	applyMutations(doc, surveyModuleMutations(doc).mutations);
	return doc;
}

/** The doc as the cutover sees it: persistable, loosely typed for legacy
 *  shape injection. */
interface LooseDoc {
	modules: Record<string, Record<string, unknown>>;
	forms: Record<string, Record<string, unknown>>;
	fields: Record<string, Record<string, unknown>>;
	moduleOrder: string[];
	formOrder: Record<string, string[]>;
	fieldOrder: Record<string, string[]>;
	caseTypes: unknown;
}

function loose(doc: BlueprintDoc): LooseDoc {
	return structuredClone(toPersistableDoc(doc)) as unknown as LooseDoc;
}

function normalized(raw: LooseDoc) {
	const { doc, report } = normalizeLegacyBlueprint(
		raw as unknown as PersistableDoc,
	);
	return { doc: doc as unknown as LooseDoc, report };
}

/** The invariant every rule must uphold: strict parse + row round trip. */
function expectLoadable(doc: LooseDoc) {
	const persistable = blueprintDocSchema.parse(doc);
	const reassembled = assembleBlueprint(
		persistable.appId,
		blueprintScalars(persistable),
		decomposeBlueprint(persistable),
	);
	expect(reassembled).toEqual(persistable);
}

describe("normalizeLegacyBlueprint", () => {
	it("is a no-op (and reports nothing) on a modern doc", () => {
		const raw = loose(baseDoc("norm-0"));
		const { doc, report } = normalized(raw);
		expect(normalizationSummary(report)).toBeNull();
		expect(doc).toEqual(raw);
		expectLoadable(doc);
	});

	it("strips vestigial v0 case-list keys from module records", () => {
		const raw = loose(baseDoc("norm-1"));
		const moduleUuid = raw.moduleOrder[0];
		raw.modules[moduleUuid].caseListColumns = [{ field: "name" }];
		raw.modules[moduleUuid].caseDetailColumns = [];
		const { doc, report } = normalized(raw);
		expect(report.strippedCaseListKeys).toBe(1);
		expect(doc.modules[moduleUuid].caseListColumns).toBeUndefined();
		expect(doc.modules[moduleUuid].caseDetailColumns).toBeUndefined();
		expectLoadable(doc);
	});

	it("prunes an orphan module's whole subtree but keeps recordless orphan fields", () => {
		const raw = loose(baseDoc("norm-2"));
		// A merge-leftover module with a form, a group, and a nested field —
		// none reachable from moduleOrder.
		raw.modules["11111111-1111-4111-8111-111111111111"] = {
			name: "Ghost",
			icon: "home",
		};
		raw.formOrder["11111111-1111-4111-8111-111111111111"] = [
			"22222222-2222-4222-8222-222222222222",
		];
		raw.forms["22222222-2222-4222-8222-222222222222"] = {
			name: "Ghost Form",
			form_type: "survey",
		};
		raw.fieldOrder["22222222-2222-4222-8222-222222222222"] = [
			"33333333-3333-4333-8333-333333333333",
		];
		raw.fields["33333333-3333-4333-8333-333333333333"] = {
			uuid: "33333333-3333-4333-8333-333333333333",
			id: "ghost_group",
			kind: "group",
			label: "Ghost Group",
		};
		raw.fieldOrder["33333333-3333-4333-8333-333333333333"] = [
			"44444444-4444-4444-8444-444444444444",
		];
		raw.fields["44444444-4444-4444-8444-444444444444"] = {
			uuid: "44444444-4444-4444-8444-444444444444",
			id: "ghost_q",
			kind: "text",
			label: "Ghost Q",
		};
		// A pre-existing orphan FIELD (in no membership array): decompose
		// preserves these by design, so normalization must not touch it.
		raw.fields["55555555-5555-4555-8555-555555555555"] = {
			uuid: "55555555-5555-4555-8555-555555555555",
			id: "kept_orphan",
			kind: "text",
			label: "Kept",
		};
		const { doc, report } = normalized(raw);
		expect(report.prunedModules).toBe(1);
		expect(report.prunedForms).toBe(1);
		expect(report.prunedFields).toBe(2);
		const d = doc;
		expect(d.modules["11111111-1111-4111-8111-111111111111"]).toBeUndefined();
		expect(d.forms["22222222-2222-4222-8222-222222222222"]).toBeUndefined();
		expect(d.fields["33333333-3333-4333-8333-333333333333"]).toBeUndefined();
		expect(d.fields["44444444-4444-4444-8444-444444444444"]).toBeUndefined();
		expect(
			d.fieldOrder["22222222-2222-4222-8222-222222222222"],
		).toBeUndefined();
		expect(
			d.fieldOrder["33333333-3333-4333-8333-333333333333"],
		).toBeUndefined();
		expect(d.fields["55555555-5555-4555-8555-555555555555"]).toBeDefined();
		expectLoadable(doc);
	});

	it("prunes dangling membership refs, and forms stranded under a recordless module", () => {
		const raw = loose(baseDoc("norm-2b"));
		// A moduleOrder entry + formOrder key with NO module record — its listed
		// form record renders nowhere today and must prune with the key.
		raw.moduleOrder.push("77777777-7777-4777-8777-777777777777");
		raw.formOrder["77777777-7777-4777-8777-777777777777"] = [
			"88888888-8888-4888-8888-888888888888",
		];
		raw.forms["88888888-8888-4888-8888-888888888888"] = {
			name: "Stranded Form",
			form_type: "survey",
		};
		raw.fieldOrder["88888888-8888-4888-8888-888888888888"] = [];
		// A dangling field entry (no record) inside a surviving form.
		const formUuid = Object.keys(raw.forms).find(
			(u) => u !== "88888888-8888-4888-8888-888888888888",
		) as string;
		raw.fieldOrder[formUuid].push("99999999-9999-4999-8999-999999999999");
		const { doc, report } = normalized(raw);
		// Dangling: the moduleOrder entry, its formOrder key, the field entry.
		expect(report.prunedDanglingRefs).toBe(3);
		expect(report.prunedForms).toBe(1);
		const d = doc;
		expect(d.moduleOrder).not.toContain("77777777-7777-4777-8777-777777777777");
		expect(d.formOrder["77777777-7777-4777-8777-777777777777"]).toBeUndefined();
		expect(d.forms["88888888-8888-4888-8888-888888888888"]).toBeUndefined();
		expect(d.fieldOrder[formUuid]).not.toContain(
			"99999999-9999-4999-8999-999999999999",
		);
		expectLoadable(doc);
	});

	it("narrows repeat fields to their mode's slots", () => {
		const raw = loose(baseDoc("norm-3"));
		const formUuid = Object.keys(raw.forms)[0];
		raw.fieldOrder[formUuid].push("66666666-6666-4666-8666-666666666666");
		raw.fields["66666666-6666-4666-8666-666666666666"] = {
			uuid: "66666666-6666-4666-8666-666666666666",
			id: "top_brands_repeat",
			kind: "repeat",
			label: "Top brands",
			repeat_mode: "user_controlled",
			// The prod drift: a count on a user-controlled repeat.
			repeat_count: { parts: [{ kind: "text", text: "3" }] },
		};
		// A repeat is a container — the reducer shape carries its key even empty.
		raw.fieldOrder["66666666-6666-4666-8666-666666666666"] = [];
		const { doc, report } = normalized(raw);
		expect(report.narrowedRepeats).toBe(1);
		expect(
			doc.fields["66666666-6666-4666-8666-666666666666"].repeat_count,
		).toBeUndefined();
		expectLoadable(doc);
	});

	it("seeds absent case-property labels from the property name", () => {
		const raw = loose(baseDoc("norm-4"));
		raw.caseTypes = [
			{
				name: "site",
				properties: [
					{ name: "case_name", data_type: "text" },
					{ name: "site_gps", data_type: "geopoint" },
				],
			},
		];
		const { doc, report } = normalized(raw);
		expect(report.seededPropertyLabels).toBe(2);
		const caseTypes = doc.caseTypes as Array<{
			properties: Array<Record<string, unknown>>;
		}>;
		expect(caseTypes[0].properties[0].label).toBe("case_name");
		expect(caseTypes[0].properties[1].label).toBe("site_gps");
		expectLoadable(doc);
	});
});
