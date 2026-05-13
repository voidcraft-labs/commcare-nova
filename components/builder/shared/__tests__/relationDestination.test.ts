// components/builder/shared/__tests__/relationDestination.test.ts
//
// Coverage for the shared destination-case-type resolver. Pins the
// per-arm walk semantics against the type checker's
// `checkRelationPath` shape so any future divergence between the
// editor's destination resolution and the validation pass shows up
// here.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	anyRelationPath,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/predicate";
import {
	type RelationDestinationCaseType,
	resolveRelationDestination,
} from "../relationDestination";

const HOUSEHOLD: RelationDestinationCaseType = { name: "household" };
const PATIENT: RelationDestinationCaseType = {
	name: "patient",
	parent_type: "household",
};
const VISIT: RelationDestinationCaseType = {
	name: "visit",
	parent_type: "patient",
};
const SIBLING_VISIT: RelationDestinationCaseType = {
	name: "sibling_visit",
	parent_type: "patient",
};
const CASE_TYPES = [HOUSEHOLD, PATIENT, VISIT, SIBLING_VISIT];

describe("resolveRelationDestination", () => {
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
		// patient → household → (no parent) — three-hop walk is
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

	it("resolves subcase walks to the first matching child case type", () => {
		// `subcase("parent")` from `patient` matches both `visit` and
		// `sibling_visit`; without `ofCaseType`, the first match wins.
		// The editor's inline error surfaces the disambiguation
		// requirement via the type checker.
		expect(
			resolveRelationDestination(subcasePath("parent"), "patient", CASE_TYPES),
		).toBe("visit");
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

	it("treats any-relation walks the same as subcase for destination resolution", () => {
		expect(
			resolveRelationDestination(
				anyRelationPath("parent"),
				"patient",
				CASE_TYPES,
			),
		).toBe("visit");
		expect(
			resolveRelationDestination(
				anyRelationPath("parent", "sibling_visit"),
				"patient",
				CASE_TYPES,
			),
		).toBe("sibling_visit");
	});

	it("returns undefined when no case type points back at the origin", () => {
		// `household` has no children pointing at it via `parent_type`
		// — `subcase` / `any-relation` walks from a leaf case type
		// resolve to undefined.
		expect(
			resolveRelationDestination(subcasePath("parent"), "visit", CASE_TYPES),
		).toBeUndefined();
	});
});
