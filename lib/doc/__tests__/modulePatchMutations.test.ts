// lib/doc/__tests__/modulePatchMutations.test.ts
//
// The authoring planner lowers snapshot-like builder intent to the one strict
// mutation dialect. Omission keeps; an explicitly present null/undefined clears
// by emitting the JSON-stable null teardown payload.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { modulePatchMutations } from "@/lib/doc/modulePatchMutations";
import type { Module } from "@/lib/domain";

const MODULE_UUID = testUuid("00000000-0000-4000-8000-0000000000aa");

// The planner reads only `uuid` and `caseSearchConfig`; a minimal shape
// keeps the test on the planner's contract instead of a doc fixture.
const mod: Module = {
	uuid: MODULE_UUID,
	id: "clients",
	name: "Clients",
	caseSearchConfig: { searchScreenTitle: "Find a client" },
};

describe("modulePatchMutations — caseSearchConfig key semantics", () => {
	it("lowers a rename and an explicit undefined Search clear separately", () => {
		expect(
			modulePatchMutations(mod, {
				name: "Renamed",
				caseSearchConfig: undefined,
			}),
		).toEqual([
			{
				kind: "renameModule",
				uuid: MODULE_UUID,
				newId: "Renamed",
			},
			{
				kind: "updateModule",
				uuid: MODULE_UUID,
				patch: { caseSearchConfig: null },
			},
		]);
	});

	it("lowers an explicit undefined key to the direct null teardown", () => {
		expect(modulePatchMutations(mod, { caseSearchConfig: undefined })).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE_UUID,
				patch: { caseSearchConfig: null },
			},
		]);
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
