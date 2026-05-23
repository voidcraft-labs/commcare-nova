// State-model coverage for the case-search panel's cross-binding
// seed. The panel routes `searchInputs` writes through
// `caseListConfig.searchInputs` (one source-of-truth across both
// workspaces); when the module's `caseListConfig` slot is undefined,
// the panel still needs to emit a config whose schema-required
// `columns` array is present. `nextCaseListConfigFromSearchInputs`
// encapsulates that seed.

import { describe, expect, it } from "vitest";
import { nextCaseListConfigFromSearchInputs } from "@/components/builder/case-search-config/CaseSearchConfigPanel";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	caseListConfigSchema,
	plainColumn,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";

const COL_UUID = asUuid("00000000-0000-0000-0000-000000000201");
const INPUT_A = asUuid("00000000-0000-0000-0000-000000000301");
const INPUT_B = asUuid("00000000-0000-0000-0000-000000000302");

describe("nextCaseListConfigFromSearchInputs — undefined current", () => {
	it("seeds an empty columns array on first edit", () => {
		const next = nextCaseListConfigFromSearchInputs(undefined, []);
		expect(next.columns).toEqual([]);
		expect(next.searchInputs).toEqual([]);
	});

	it("threads the supplied searchInputs into the seeded config", () => {
		const input: SearchInputDef = simpleSearchInputDef(
			INPUT_A,
			"q",
			"Q",
			"text",
			"name",
		);
		const next = nextCaseListConfigFromSearchInputs(undefined, [input]);
		expect(next.searchInputs).toEqual([input]);
		expect(next.columns).toEqual([]);
	});

	it("emits a schema-valid CaseListConfig on first edit", () => {
		const next = nextCaseListConfigFromSearchInputs(undefined, [
			simpleSearchInputDef(INPUT_A, "q", "Q", "text", "name"),
		]);
		expect(() => caseListConfigSchema.parse(next)).not.toThrow();
	});
});

describe("nextCaseListConfigFromSearchInputs — defined current", () => {
	it("preserves existing columns and filter when overwriting searchInputs", () => {
		const before: CaseListConfig = {
			columns: [plainColumn(COL_UUID, "name", "Name")],
			searchInputs: [
				simpleSearchInputDef(INPUT_A, "old", "Old", "text", "name"),
			],
			filter: matchAll(),
		};
		const newInputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_B, "new", "New", "text", "age"),
		];
		const next = nextCaseListConfigFromSearchInputs(before, newInputs);

		expect(next.columns).toEqual(before.columns);
		expect(next.filter).toEqual(matchAll());
		expect(next.searchInputs).toEqual(newInputs);
	});

	it("does not mutate the input config", () => {
		const before: CaseListConfig = {
			columns: [plainColumn(COL_UUID, "name", "Name")],
			searchInputs: [],
		};
		const beforeSnapshot = JSON.parse(JSON.stringify(before)) as CaseListConfig;
		nextCaseListConfigFromSearchInputs(before, [
			simpleSearchInputDef(INPUT_A, "q", "Q", "text", "name"),
		]);
		expect(before).toEqual(beforeSnapshot);
	});

	it("copies the searchInputs array (callers can mutate the input list without leaking into the seeded config)", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_A, "q", "Q", "text", "name"),
		];
		const next = nextCaseListConfigFromSearchInputs(undefined, inputs);
		expect(next.searchInputs).not.toBe(inputs);
		expect(next.searchInputs).toEqual(inputs);
	});
});
