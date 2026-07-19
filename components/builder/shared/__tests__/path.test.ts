// components/builder/shared/__tests__/path.test.ts
//
// Path-encoding round-trips. Mirrors the walker shape in
// `lib/domain/predicate/typeChecker.ts` — the editor's path-build
// helpers must reproduce the walker's emitted paths exactly so the
// validity index lookups land on the right cards.

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ANY_TYPE,
	arith,
	coalesce,
	dateAdd,
	double,
	eq,
	ifExpr,
	literal,
	matchAll,
	now,
	prop,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/predicate";
import {
	appendKind,
	appendKindIndex,
	appendKindIndexSlot,
	appendKindSlot,
	appendSlot,
	appendSlotIndex,
	deserializePath,
	serializePath,
} from "../path";
import {
	locateRuleNode,
	nearestRuleLocation,
	type RuleNavigationContext,
	replaceRuleNodeAtPath,
} from "../ruleNavigation";

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "score", label: "Score", data_type: "decimal" },
			{ name: "dob", label: "Date of birth", data_type: "date" },
			{ name: "last_seen", label: "Last seen", data_type: "datetime" },
		],
	},
];

const NAVIGATION_CONTEXT: RuleNavigationContext = {
	caseTypes: CASE_TYPES,
	currentCaseType: "patient",
	knownInputs: [],
};

describe("path helpers — append shapes", () => {
	it("appendSlot pushes a slot name", () => {
		expect(appendSlot([], "left")).toEqual(["left"]);
		expect(appendSlot(["and", 0], "property")).toEqual(["and", 0, "property"]);
	});

	it("appendKindSlot pushes operator-kind + slot", () => {
		expect(appendKindSlot([], "not", "clause")).toEqual(["not", "clause"]);
	});

	it("appendKindIndex pushes operator-kind + array index", () => {
		expect(appendKindIndex([], "and", 1)).toEqual(["and", 1]);
	});

	it("appendSlotIndex pushes slot + array index for leaf operators", () => {
		expect(appendSlotIndex([], "values", 2)).toEqual(["values", 2]);
	});

	it("appendKind pushes only the operator-kind segment (no slot)", () => {
		// Used for operator-level errors emitted by the checker at
		// the kind boundary itself — `[..., "if"]` (branch type-
		// mismatch on `if`), `[..., "count"]` (count's "no current
		// case-type scope" error). Matches the checker's emission
		// path exactly without forcing a slot suffix.
		expect(appendKind([], "if")).toEqual(["if"]);
		expect(appendKind(["and", 0], "count")).toEqual(["and", 0, "count"]);
	});

	it("appendKindIndexSlot pushes kind + collection + index + slot", () => {
		// Mirrors the walker's `[...path, "switch", "cases", i, "then"]`
		// emission shape — used by `SwitchCard` for per-case sub-slot
		// paths.
		expect(appendKindIndexSlot([], "switch", "cases", 0, "when")).toEqual([
			"switch",
			"cases",
			0,
			"when",
		]);
		expect(
			appendKindIndexSlot(["and", 0], "switch", "cases", 2, "then"),
		).toEqual(["and", 0, "switch", "cases", 2, "then"]);
	});

	it("nested compositions reproduce the walker's path shape", () => {
		// Mirrors the walker's `[...path, "and", 0, "or", 1]`
		// pattern from `lib/domain/predicate/typeChecker.ts`.
		const inAnd = appendKindIndex([], "and", 0);
		const inOr = appendKindIndex(inAnd, "or", 1);
		const inComparison = appendSlot(inOr, "left");
		expect(inComparison).toEqual(["and", 0, "or", 1, "left"]);
	});
});

describe("path serialization — round-trip", () => {
	it("serializes and deserializes empty paths", () => {
		expect(serializePath([])).toBe("");
		expect(deserializePath("")).toEqual([]);
	});

	it("preserves segment types across round-trips", () => {
		const path = ["and", 0, "or", 1, "left"];
		const serialized = serializePath(path);
		expect(deserializePath(serialized)).toEqual(path);
	});

	it("serializes numeric and equal-string segments to the same key", () => {
		// `["values", 0]` and `["values", "0"]` collapse to the same
		// serialized form — `String(0) === "0"` and the join
		// produces identical bytes. This collapse is acceptable
		// because the editor only ever constructs paths with
		// numeric indices in array slots; the string form does not
		// arise in production code, and the validity-index lookup
		// would route an error attached to either to the same card.
		const numeric = serializePath(["values", 0]);
		const stringy = serializePath(["values", "0"]);
		expect(numeric).toBe(stringy);
		// Round-trip prefers the numeric reading.
		expect(deserializePath(numeric)).toEqual(["values", 0]);
	});
});

describe("mixed rule navigation", () => {
	const innermost = term(prop("patient", "score"));
	const untouchedInnerFallback = term(literal(0));
	const innerFallbacks = coalesce(innermost, untouchedInnerFallback);
	const untouchedMathRight = term(literal(1));
	const calculation = arith("+", double(innerFallbacks), untouchedMathRight);
	const untouchedOuterFallback = term(literal(2));
	const chosenValue = coalesce(calculation, untouchedOuterFallback);
	const untouchedElse = term(literal(3));
	const conditional = ifExpr(matchAll(), chosenValue, untouchedElse);
	const untouchedSubject = term(prop("patient", "score"));
	const root = eq(untouchedSubject, conditional);
	const deepPath = [
		"right",
		"if",
		"then",
		"values",
		0,
		"left",
		"value",
		"values",
		0,
	] as const;

	it("locates and replaces a six-level mixed subtree without rebuilding siblings", () => {
		const location = locateRuleNode(root, deepPath, NAVIGATION_CONTEXT);
		expect(location?.node).toEqual({
			family: "expression",
			value: innermost,
		});
		expect(location?.trail).toHaveLength(7);

		const replacement = term(literal(99));
		const next = replaceRuleNodeAtPath(root, deepPath, {
			family: "expression",
			value: replacement,
		});
		const replaced = locateRuleNode(next, deepPath, NAVIGATION_CONTEXT);
		expect(replaced?.node).toEqual({
			family: "expression",
			value: replacement,
		});

		// Only path ancestors are rebuilt. Every untouched branch keeps object
		// identity, which is the round-trip contract for authored subtrees.
		expect(next.kind).toBe("eq");
		if (next.kind !== "eq") return;
		expect(next.left).toBe(untouchedSubject);
		const nextConditional = next.right;
		expect(nextConditional.kind).toBe("if");
		if (nextConditional.kind !== "if") return;
		expect(nextConditional.else).toBe(untouchedElse);
		const nextChosenValue = nextConditional.then;
		expect(nextChosenValue.kind).toBe("coalesce");
		if (nextChosenValue.kind !== "coalesce") return;
		expect(nextChosenValue.values[1]).toBe(untouchedOuterFallback);
		const nextCalculation = nextChosenValue.values[0];
		expect(nextCalculation.kind).toBe("arith");
		if (nextCalculation.kind !== "arith") return;
		expect(nextCalculation.right).toBe(untouchedMathRight);
		expect(nextCalculation.left.kind).toBe("double");
		if (nextCalculation.left.kind !== "double") return;
		expect(nextCalculation.left.value.kind).toBe("coalesce");
		if (nextCalculation.left.value.kind !== "coalesce") return;
		expect(nextCalculation.left.value.values[1]).toBe(untouchedInnerFallback);
	});

	it("recovers focus to the nearest surviving mixed ancestor", () => {
		const replacement = term(literal(7));
		const shallower = replaceRuleNodeAtPath(root, ["right"], {
			family: "expression",
			value: replacement,
		});
		const recovered = nearestRuleLocation(
			shallower,
			deepPath,
			NAVIGATION_CONTEXT,
		);
		expect(recovered.path).toEqual(["right"]);
		expect(recovered.node).toEqual({
			family: "expression",
			value: replacement,
		});
	});
});

describe("focused expression constraints mirror inline branch rules", () => {
	function concreteAccepts(
		path: readonly (string | number)[],
		root: ReturnType<typeof eq>,
	) {
		const location = locateRuleNode(root, path, NAVIGATION_CONTEXT);
		expect(location?.node.family).toBe("expression");
		expect(location?.constraint.accepts).not.toBe("any");
		if (location === undefined || location.constraint.accepts === "any") {
			throw new Error("Expected a narrowed expression constraint");
		}
		return location.constraint.accepts;
	}

	it("narrows if, coalesce, and switch branches by their saved siblings", () => {
		const conditional = eq(
			prop("patient", "score"),
			ifExpr(matchAll(), term(literal(1)), term(literal(2))),
		);
		const ifThen = concreteAccepts(["right", "if", "then"], conditional);
		expect(ifThen).toEqual(new Set(["int", "decimal", ANY_TYPE]));

		const fallbacks = eq(
			prop("patient", "score"),
			coalesce(term(literal(1)), term(literal(2))),
		);
		const coalesceFirst = concreteAccepts(["right", "values", 0], fallbacks);
		expect(coalesceFirst).toEqual(new Set(["int", "decimal", ANY_TYPE]));

		const switched = eq(
			prop("patient", "score"),
			switchExpr(
				term(literal("risk")),
				[switchCase(literal("high"), term(literal(1)))],
				term(literal(1.5)),
			),
		);
		const switchThen = concreteAccepts(
			["right", "switch", "cases", 0, "then"],
			switched,
		);
		const switchFallback = concreteAccepts(
			["right", "switch", "fallback"],
			switched,
		);
		expect(switchThen).toEqual(new Set(["int", "decimal", ANY_TYPE]));
		expect(switchFallback).toEqual(new Set(["int", "decimal", ANY_TYPE]));
	});

	it("narrows date-add's starting value to the parent's exact temporal type", () => {
		const dateRoot = eq(
			prop("patient", "dob"),
			dateAdd(today(), "days", term(literal(1))),
		);
		const dateAccepts = concreteAccepts(["right", "date"], dateRoot);
		expect(dateAccepts.has("date")).toBe(true);
		expect(dateAccepts.has("datetime")).toBe(false);

		const datetimeRoot = eq(
			prop("patient", "last_seen"),
			dateAdd(now(), "hours", term(literal(1))),
		);
		const datetimeAccepts = concreteAccepts(["right", "date"], datetimeRoot);
		expect(datetimeAccepts.has("datetime")).toBe(true);
		expect(datetimeAccepts.has("date")).toBe(false);
	});
});
