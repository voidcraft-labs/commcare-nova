import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	anyRelationPath,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/predicate";
import {
	ancestorRemovalConsequence,
	ancestorStepContexts,
	availableCaseTypesForSingleRelation,
	changeKind,
	customRelationPath,
	rebuildValidAncestorPath,
	relationChangeLosesStructure,
	relationKindHasAutomaticPath,
	relationKindIsAvailable,
	withAncestorStep,
	withoutAncestorStep,
} from "../relationPathModel";

const catalog = [
	{ name: "household" },
	{ name: "patient", parent_type: "household" },
	{ name: "visit", parent_type: "patient" },
	{ name: "lab_result", parent_type: "patient" },
];

describe("relation path editor model", () => {
	it("binds each ancestor position to the previous destination and preserves explicit custom targets", () => {
		expect(
			ancestorStepContexts(
				[relationStep("parent", "patient"), relationStep("host", "household")],
				"visit",
				catalog,
			),
		).toEqual([
			{
				originCaseType: "visit",
				parentCaseType: "patient",
				qualifierIsValid: true,
			},
			{
				originCaseType: "patient",
				parentCaseType: "household",
				qualifierIsValid: true,
			},
		]);
		expect(
			ancestorStepContexts(
				[relationStep("host", "missing"), relationStep("parent")],
				"visit",
				catalog,
			),
		).toEqual([
			{
				originCaseType: "visit",
				parentCaseType: undefined,
				qualifierIsValid: false,
			},
			{ originCaseType: "", parentCaseType: undefined, qualifierIsValid: true },
		]);
	});
	it("repairs stale canonical hints while leaving saved connection names and unqualified steps intact", () => {
		const path = ancestorPath(
			relationStep("parent", "patient"),
			relationStep("parent", "household"),
		);
		const next = withoutAncestorStep(path, 0, "visit", catalog);
		expect(next).toEqual(ancestorPath(relationStep("parent", "patient")));
		if (next === undefined) throw new Error("Expected repaired path");
		expect(ancestorRemovalConsequence(path, 0, next)).toBe(
			"A remaining connection will lead to Patient instead of Household",
		);
		expect(path.via[1].throughCaseType).toBe("household");
		const custom = ancestorPath(
			relationStep("guardian", "patient"),
			relationStep("host", "household"),
		);
		const customNext = withoutAncestorStep(custom, 0, "visit", catalog);
		expect(customNext).toEqual(ancestorPath(relationStep("host", "household")));
		if (customNext === undefined) throw new Error("Expected custom path");
		expect(ancestorRemovalConsequence(custom, 0, customNext)).toBeNull();
		expect(
			rebuildValidAncestorPath([relationStep("parent")], "visit", catalog),
		).toEqual(ancestorPath(relationStep("parent")));
	});
	it("refuses rebuilding beyond the known graph or without a declared custom destination", () => {
		expect(
			rebuildValidAncestorPath([relationStep("parent")], "household", catalog),
		).toBeUndefined();
		expect(
			rebuildValidAncestorPath(
				[relationStep("host", "missing")],
				"visit",
				catalog,
			),
		).toBeUndefined();
	});
	it("changes one step without replacing adjacent authored structure", () => {
		const path = ancestorPath(
			relationStep("parent", "patient"),
			relationStep("host", "household"),
		);
		const next = withAncestorStep(path, 1, relationStep("guardian", "patient"));
		expect(next.via[0]).toBe(path.via[0]);
		expect(next).toEqual(
			ancestorPath(
				relationStep("parent", "patient"),
				relationStep("guardian", "patient"),
			),
		);
	});
	it("limits canonical destinations to graph neighbors but allows declared custom destinations", () => {
		expect(
			availableCaseTypesForSingleRelation(
				"subcase",
				"parent",
				"patient",
				catalog,
			).map((x) => x.name),
		).toEqual(["visit", "lab_result"]);
		expect(
			availableCaseTypesForSingleRelation(
				"any-relation",
				"parent",
				"patient",
				catalog,
			).map((x) => x.name),
		).toEqual(["household", "visit", "lab_result"]);
		expect(
			availableCaseTypesForSingleRelation("subcase", "host", "visit", catalog),
		).toEqual(catalog);
	});
	it("keeps custom direction entry available at graph leaves and distinguishes automatic candidates", () => {
		expect(relationKindIsAvailable("subcase", catalog, false)).toBe(true);
		expect(relationKindHasAutomaticPath("subcase", "visit", catalog)).toBe(
			false,
		);
		expect(relationKindIsAvailable("self", catalog, false)).toBe(false);
		expect(relationKindIsAvailable("ancestor", [], true)).toBe(false);
		expect(customRelationPath("subcase", "guardian", "household")).toEqual(
			subcasePath("guardian", "household"),
		);
	});
	it("uses an explicit child destination so adding another child never changes the saved target", () => {
		expect(
			changeKind(
				ancestorPath(relationStep("parent", "household")),
				"subcase",
				"patient",
				catalog,
			),
		).toEqual(subcasePath("parent", "visit"));
	});
	it.each(["subcase", "any-relation"] as const)(
		"preserves a custom %s target outside the canonical graph when switching direction",
		(kind) => {
			const current =
				kind === "subcase"
					? subcasePath("host", "household")
					: anyRelationPath("host", "household");
			const target = kind === "subcase" ? "any-relation" : "subcase";
			expect(changeKind(current, target, "visit", catalog)).toEqual(
				target === "subcase"
					? subcasePath("host", "household")
					: anyRelationPath("host", "household"),
			);
			expect(
				relationChangeLosesStructure(current, target, "visit", catalog),
			).toBe(false);
		},
	);
	it("requires confirmation when a canonical either-direction parent becomes a child", () => {
		const current = anyRelationPath("parent", "household");
		expect(
			relationChangeLosesStructure(current, "subcase", "patient", catalog),
		).toBe(true);
		expect(changeKind(current, "subcase", "patient", catalog)).toEqual(
			subcasePath("parent", "visit"),
		);
		expect(
			relationChangeLosesStructure(
				anyRelationPath("parent", "visit"),
				"subcase",
				"patient",
				catalog,
			),
		).toBe(false);
	});
	it("recognizes structural loss and same-kind identity without altering input", () => {
		const path = ancestorPath(
			relationStep("guardian", "patient"),
			relationStep("host", "household"),
		);
		expect(changeKind(path, "ancestor", "visit", catalog)).toBe(path);
		expect(relationChangeLosesStructure(path, "self", "visit", catalog)).toBe(
			true,
		);
		expect(
			relationChangeLosesStructure(path, "subcase", "visit", catalog),
		).toBe(true);
		expect(changeKind(path, "self", "visit", catalog)).toEqual(selfPath());
		expect(
			relationChangeLosesStructure(selfPath(), "ancestor", "visit", catalog),
		).toBe(false);
	});
});
