import { describe, expect, it } from "vitest";
import type { CaseType } from "../blueprint";
import {
	caseRefAcceptMap,
	getModuleCaseTypes,
	reachableCaseTypes,
	toReachableIndex,
} from "../caseTypes";

const prop = (name: string) => ({ name, label: name });
const TYPES: CaseType[] = [
	{ name: "mother", properties: [prop("case_name"), prop("household_code")] },
	{
		name: "pregnancy",
		parent_type: "mother",
		properties: [prop("case_name"), prop("ga_weeks")],
	},
	{
		name: "visit",
		parent_type: "pregnancy",
		properties: [prop("visit_date")],
	},
];

describe("reachableCaseTypes — own + ancestors, depth = parent-index hops", () => {
	it("own type is depth 0, parent depth 1, grandparent depth 2", () => {
		const r = reachableCaseTypes("visit", TYPES);
		expect(r.map((t) => [t.name, t.depth])).toEqual([
			["visit", 0],
			["pregnancy", 1],
			["mother", 2],
		]);
	});

	it("carries each type's own properties (not flattened)", () => {
		const r = reachableCaseTypes("pregnancy", TYPES);
		const mother = r.find((t) => t.name === "mother");
		expect(mother?.properties.map((p) => p.name)).toContain("household_code");
		const preg = r.find((t) => t.name === "pregnancy");
		expect(preg?.properties.map((p) => p.name)).not.toContain("household_code");
	});

	it("excludes children (visit is unreachable upward from pregnancy)", () => {
		const r = reachableCaseTypes("pregnancy", TYPES);
		expect(r.map((t) => t.name)).not.toContain("visit");
	});

	it("returns [] for an undefined case type (survey form)", () => {
		expect(reachableCaseTypes(undefined, TYPES)).toEqual([]);
	});

	it("is cycle-guarded against a malformed parent_type loop", () => {
		const cyclic: CaseType[] = [
			{ name: "a", parent_type: "b", properties: [] },
			{ name: "b", parent_type: "a", properties: [] },
		];
		expect(reachableCaseTypes("a", cyclic).map((t) => t.name)).toEqual([
			"a",
			"b",
		]);
	});

	it("getModuleCaseTypes stays own + children (the write-target dual)", () => {
		// Sanity that the read helper hasn't disturbed the write helper.
		expect(getModuleCaseTypes("pregnancy", TYPES)).toEqual([
			"pregnancy",
			"visit",
		]);
	});
});

describe("toReachableIndex — seeds case_id on every type", () => {
	it("adds case_id (label 'case id') even though no record declares it", () => {
		const index = toReachableIndex(reachableCaseTypes("pregnancy", TYPES));
		expect(index.get("pregnancy")?.properties.get("case_id")).toEqual({
			label: "case id",
		});
		expect(index.get("mother")?.properties.get("case_id")).toEqual({
			label: "case id",
		});
		// Declared properties are preserved alongside the seed.
		expect(index.get("pregnancy")?.properties.has("ga_weeks")).toBe(true);
	});

	it("does not overwrite a declared case_id label", () => {
		const declared: CaseType[] = [
			{ name: "x", properties: [{ name: "case_id", label: "Custom" }] },
		];
		const index = toReachableIndex(reachableCaseTypes("x", declared));
		expect(index.get("x")?.properties.get("case_id")).toEqual({
			label: "Custom",
		});
	});
});

describe("caseRefAcceptMap — form-type narrowing", () => {
	it("narrows a registration form to the own type's case_id only", () => {
		const index = toReachableIndex(reachableCaseTypes("pregnancy", TYPES));
		const accept = caseRefAcceptMap(index, "registration");
		expect([...accept.keys()]).toEqual(["pregnancy"]);
		expect([...(accept.get("pregnancy") ?? [])]).toEqual(["case_id"]);
	});

	it("exposes every reachable type's full property set on followup", () => {
		const index = toReachableIndex(reachableCaseTypes("pregnancy", TYPES));
		const accept = caseRefAcceptMap(index, "followup");
		expect([...(accept.get("pregnancy") ?? [])].sort()).toEqual([
			"case_id",
			"case_name",
			"ga_weeks",
		]);
		expect([...(accept.get("mother") ?? [])].sort()).toEqual([
			"case_id",
			"case_name",
			"household_code",
		]);
	});

	it("exposes the same full property set on close (a followup superset)", () => {
		const index = toReachableIndex(reachableCaseTypes("pregnancy", TYPES));
		const accept = caseRefAcceptMap(index, "close");
		expect([...(accept.get("mother") ?? [])].sort()).toEqual([
			"case_id",
			"case_name",
			"household_code",
		]);
	});

	it("rejects every case ref on a survey form (loads no case)", () => {
		// A survey form's suite entry declares no `case_id` datum, so any
		// `#<type>/<prop>` resolves against an empty session datum — always
		// empty. The accept map is empty even when the module HAS a case type
		// (a survey sharing a case-typed module), so the validator / linter /
		// autocomplete all reject case refs on it.
		const index = toReachableIndex(reachableCaseTypes("pregnancy", TYPES));
		const accept = caseRefAcceptMap(index, "survey");
		expect(accept.size).toBe(0);
	});
});
