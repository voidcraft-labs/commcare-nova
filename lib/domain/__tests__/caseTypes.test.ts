import { describe, expect, it } from "vitest";
import { proseText } from "@/lib/domain/prose";
import type { CaseType } from "../blueprint";
import {
	caseDataTypeForFieldKind,
	caseRefAcceptMap,
	getModuleCaseTypes,
	reachableCaseTypes,
	toReachableIndex,
} from "../caseTypes";
import type { FieldKind } from "../fields";
import type { XPathPrintableDoc } from "../xpath/print";

/** These fixtures label every property with literal prose, so an empty
 *  document resolves everything they reference (nothing). */
const EMPTY_DOC: XPathPrintableDoc = { fields: {}, forms: {}, fieldOrder: {} };
const prop = (name: string) => ({ name, label: proseText(name) });
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
		// Direct children are write targets; grandparents and grandchildren are not.
		expect(getModuleCaseTypes("pregnancy", TYPES)).toEqual([
			"pregnancy",
			"visit",
		]);
		expect(getModuleCaseTypes("mother", TYPES)).toEqual([
			"mother",
			"pregnancy",
		]);
		expect(getModuleCaseTypes(undefined, TYPES)).toEqual([]);
	});
});

describe("toReachableIndex — preserves authored catalog labels", () => {
	it("does not overwrite a declared case_id label", () => {
		const declared: CaseType[] = [
			{
				name: "x",
				properties: [{ name: "case_id", label: proseText("Custom") }],
			},
		];
		const index = toReachableIndex(
			reachableCaseTypes("x", declared),
			EMPTY_DOC,
		);
		expect(index.get("x")?.properties.get("case_id")).toEqual({
			label: "Custom",
		});
	});
});

describe("caseRefAcceptMap — form-type narrowing", () => {
	it("narrows a registration form to the own type's case_id only", () => {
		const index = toReachableIndex(
			reachableCaseTypes("pregnancy", TYPES),
			EMPTY_DOC,
		);
		const accept = caseRefAcceptMap(index, "registration");
		expect([...accept.keys()]).toEqual(["pregnancy"]);
		expect([...(accept.get("pregnancy") ?? [])]).toEqual(["case_id"]);
	});

	it.each(["followup", "close"] as const)(
		"exposes existing system and declared properties on %s",
		(formType) => {
			const index = toReachableIndex(
				reachableCaseTypes("pregnancy", TYPES),
				EMPTY_DOC,
			);
			for (const scope of ["form", "session"] as const) {
				const accept = caseRefAcceptMap(index, formType, scope);
				for (const name of ["pregnancy", "mother"]) {
					const properties = accept.get(name);
					expect(properties?.size).toBe(8);
					for (const property of [
						"case_id",
						"case_name",
						"date_opened",
						"last_modified",
						"owner_id",
						"status",
						"external_id",
					])
						expect(properties?.has(property)).toBe(true);
					expect(properties?.has("modified_by")).toBe(false);
				}
				expect(accept.get("pregnancy")?.has("ga_weeks")).toBe(true);
				expect(accept.get("pregnancy")?.has("household_code")).toBe(false);
			}
		},
	);
	it("makes the created record readable after submission, but surveys remain case-free", () => {
		const index = toReachableIndex(
			reachableCaseTypes("pregnancy", TYPES),
			EMPTY_DOC,
		);
		expect(
			caseRefAcceptMap(index, "registration", "session")
				.get("pregnancy")
				?.has("owner_id"),
		).toBe(true);
		expect(caseRefAcceptMap(index, "survey", "session")).toEqual(new Map());
	});

	it("rejects every case ref on a survey form (loads no case)", () => {
		// A survey form's suite entry declares no `case_id` datum, so any
		// `#<type>/<prop>` resolves against an empty session datum — always
		// empty. The accept map is empty even when the module HAS a case type
		// (a survey sharing a case-typed module), so the validator / linter /
		// autocomplete all reject case refs on it.
		const index = toReachableIndex(
			reachableCaseTypes("pregnancy", TYPES),
			EMPTY_DOC,
		);
		const accept = caseRefAcceptMap(index, "survey");
		expect(accept.size).toBe(0);
	});
});

describe("caseDataTypeForFieldKind — defensive default arm", () => {
	it("returns undefined for an unknown kind off an untyped boundary, never the raw string", () => {
		// A corrupted persisted doc / historical replay can carry a kind
		// outside the union. The defensive arm must report "no pinned data
		// type" (undefined) — returning the raw kind string would launder
		// it into the catalog as a data_type outside the
		// CasePropertyDataType union (ensureCatalogProperty guards on
		// `!== undefined` only).
		expect(caseDataTypeForFieldKind("bogus" as FieldKind)).toBeUndefined();
	});
});
