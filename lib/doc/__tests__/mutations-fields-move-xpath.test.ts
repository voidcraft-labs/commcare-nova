import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

// Fixed UUIDs for all entities in the fixture.
const MOD = asUuid("module-1-uuid");
const FORM = asUuid("form-1-uuid");
const GRP1 = asUuid("g1-0000-0000-0000-000000000000");
const GRP2 = asUuid("g2-0000-0000-0000-000000000000");
const SRC = asUuid("src-0000-0000-0000-000000000000");
const REF = asUuid("ref-0000-0000-0000-000000000000");

/**
 * Build a normalized `BlueprintDoc` fixture for XPath-rewrite tests.
 *
 * Structure:
 *   M → F → grp1 { source }
 *           grp2 {}
 *           ref (calculate references /data/grp1/source)
 *
 * Moving `source` from grp1 into grp2 should update ref's calculate XPath.
 */
function fixture(): BlueprintDoc {
	return {
		appId: "app",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD]: { uuid: MOD, id: "m", name: "M" },
		},
		forms: {
			[FORM]: { uuid: FORM, id: "f", name: "F", type: "survey" },
		},
		fields: {
			[GRP1]: {
				uuid: GRP1,
				id: "grp1",
				kind: "group",
				label: "G1",
			} as BlueprintDoc["fields"][typeof GRP1],
			[GRP2]: {
				uuid: GRP2,
				id: "grp2",
				kind: "group",
				label: "G2",
			} as BlueprintDoc["fields"][typeof GRP2],
			[SRC]: {
				uuid: SRC,
				id: "source",
				kind: "text",
				label: "Source",
			} as BlueprintDoc["fields"][typeof SRC],
			[REF]: {
				uuid: REF,
				id: "ref",
				kind: "text",
				label: "Ref",
				calculate: "/data/grp1/source + 1",
			} as BlueprintDoc["fields"][typeof REF],
		},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: {
			[FORM]: [GRP1, GRP2, REF],
			[GRP1]: [SRC],
			[GRP2]: [],
		},
		fieldParent: {},
	};
}

describe("moveField + path rewrite", () => {
	it("rewrites absolute-path references when a field moves across groups", () => {
		const store = createBlueprintDocStore();
		store.getState().load(fixture());

		store.getState().apply({
			kind: "moveField",
			uuid: SRC,
			toParentUuid: GRP2,
			toIndex: 0,
		});

		const ref = store.getState().fields[REF];
		expect(ref?.calculate).toBe("/data/grp2/source + 1");
	});
});
