// lib/doc/__tests__/modulePatchMutations.test.ts
//
// The generic module-patch planner's caseSearchConfig key semantics:
// omission keeps, `null` clears, and a PRESENT-but-`undefined` key is
// OMISSION — never a clear. `undefined` cannot round-trip JSON (the SSE
// wire and the persisted jsonb both drop it), so honoring it as a clear
// would delete the module's whole Search configuration in memory from a
// spread-built no-change caller while the clear never replicates.

import { describe, expect, it } from "vitest";
import { modulePatchMutations } from "@/lib/doc/modulePatchMutations";
import { asUuid, type Module } from "@/lib/domain";

const MODULE_UUID = asUuid("00000000-0000-4000-8000-0000000000aa");

// The planner reads only `uuid` and `caseSearchConfig`; a minimal shape
// keeps the test on the planner's contract instead of a doc fixture.
const mod: Module = {
	uuid: MODULE_UUID,
	id: "clients",
	name: "Clients",
	caseSearchConfig: { searchScreenTitle: "Find a client" },
};

describe("modulePatchMutations — caseSearchConfig key semantics", () => {
	it("treats a present-but-undefined key as omitted, keeping the Search config", () => {
		expect(
			modulePatchMutations(mod, {
				name: "Renamed",
				caseSearchConfig: undefined,
			}),
		).toEqual([
			{ kind: "updateModule", uuid: MODULE_UUID, patch: { name: "Renamed" } },
		]);
	});

	it("emits nothing for an undefined key with no other change", () => {
		expect(modulePatchMutations(mod, { caseSearchConfig: undefined })).toEqual(
			[],
		);
	});

	it("clears the whole Search config only on an explicit null", () => {
		expect(modulePatchMutations(mod, { caseSearchConfig: null })).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE_UUID,
				patch: { caseSearchConfig: null },
			},
		]);
	});
});
