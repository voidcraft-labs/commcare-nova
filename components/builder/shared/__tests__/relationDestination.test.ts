import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/expression";
import { resolveRelationDestination } from "../relationDestination";

const HOUSEHOLD: CaseType = { name: "household", properties: [] };
const PATIENT: CaseType = {
	name: "patient",
	properties: [],
	parent_type: "household",
};
const VISIT: CaseType = {
	name: "visit",
	properties: [],
	parent_type: "patient",
};
const SIBLING_VISIT: CaseType = {
	name: "sibling_visit",
	properties: [],
	parent_type: "patient",
};
const CASE_TYPES = [HOUSEHOLD, PATIENT, VISIT, SIBLING_VISIT];

describe("resolveRelationDestination", () => {
	it("refuses an ancestor qualifier that disagrees with the owning relationship", () => {
		expect(
			resolveRelationDestination(
				ancestorPath(relationStep("parent", "visit")),
				"patient",
				CASE_TYPES,
			),
		).toBeUndefined();
	});

	it("returns the origin for `self`", () => {
		expect(resolveRelationDestination(selfPath(), "patient", CASE_TYPES)).toBe(
			"patient",
		);
	});

	it("walks ancestor chains via parent_type", () => {
		// patient → household via single hop.
		expect(
			resolveRelationDestination(
				ancestorPath(relationStep("parent")),
				"patient",
				CASE_TYPES,
			),
		).toBe("household");
		// visit → household via two hops.
		expect(
			resolveRelationDestination(
				ancestorPath(relationStep("parent"), relationStep("parent")),
				"visit",
				CASE_TYPES,
			),
		).toBe("household");
	});

	it("returns undefined when the ancestor walk runs off the schema", () => {
		// patient → household → (no parent): three-hop walk is
		// structurally unresolvable.
		expect(
			resolveRelationDestination(
				ancestorPath(
					relationStep("parent"),
					relationStep("parent"),
					relationStep("parent"),
				),
				"patient",
				CASE_TYPES,
			),
		).toBeUndefined();
	});

	it("refuses an ambiguous subcase walk", () => {
		expect(
			resolveRelationDestination(subcasePath("parent"), "patient", CASE_TYPES),
		).toBeUndefined();
	});

	it("respects ofCaseType when set on a subcase walk", () => {
		expect(
			resolveRelationDestination(
				subcasePath("parent", "sibling_visit"),
				"patient",
				CASE_TYPES,
			),
		).toBe("sibling_visit");
	});

	it("resolves any-relation across the parent-and-children union", () => {
		expect(
			resolveRelationDestination(
				anyRelationPath("parent"),
				"patient",
				CASE_TYPES,
			),
		).toBeUndefined();
		expect(
			resolveRelationDestination(
				anyRelationPath("parent", "household"),
				"patient",
				CASE_TYPES,
			),
		).toBe("household");
		expect(
			resolveRelationDestination(
				anyRelationPath("parent", "sibling_visit"),
				"patient",
				CASE_TYPES,
			),
		).toBe("sibling_visit");
	});

	it("returns undefined for a child walk from a leaf but finds its parent in either direction", () => {
		expect(
			resolveRelationDestination(subcasePath("parent"), "visit", CASE_TYPES),
		).toBeUndefined();
		expect(
			resolveRelationDestination(
				anyRelationPath("parent"),
				"visit",
				CASE_TYPES,
			),
		).toBe("patient");
	});

	it("requires an explicit declared target for custom indexes", () => {
		expect(
			resolveRelationDestination(
				ancestorPath(relationStep("guardian_link")),
				"patient",
				CASE_TYPES,
			),
		).toBeUndefined();
		expect(
			resolveRelationDestination(
				ancestorPath(relationStep("guardian_link", "household")),
				"patient",
				CASE_TYPES,
			),
		).toBe("household");
	});
});

it("does not infer custom destinations from the canonical graph", () => {
	for (const via of [
		subcasePath("host"),
		anyRelationPath("host"),
		ancestorPath(relationStep("host", "missing")),
		subcasePath("host", "missing"),
		anyRelationPath("host", "missing"),
	]) {
		expect(
			resolveRelationDestination(via, "patient", CASE_TYPES),
		).toBeUndefined();
	}
	expect(
		resolveRelationDestination(
			subcasePath("host", "household"),
			"visit",
			CASE_TYPES,
		),
	).toBe("household");
});
