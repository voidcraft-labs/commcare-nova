// Global-slot placeholders must be NEUTRAL: committing an unchosen seed
// may never change what the rule decides, because a global slot gates a
// whole surface (the Search action) the moment the placeholder commits.
// The registry's type-check invariants (validByConstruction,
// verbMenuBuildFuzz) prove seeds are well-typed; this suite proves their
// TRUTH — the axis a well-typed always-false placeholder still breaks.

import { describe, expect, it } from "vitest";
import {
	firstComparisonDefault,
	globalPlaceholder,
	wrapSiblingDefault,
} from "@/components/builder/shared/cards/comparisonSeed";
import {
	andDefault,
	notDefault,
	orDefault,
} from "@/components/builder/shared/cards/LogicalGroupCard";
import { firstConditionSeed } from "@/components/builder/shared/conditionSeed";
import {
	type PredicateEditContext,
	predicateCardSchemas,
} from "@/components/builder/shared/editorSchemas";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";

const GLOBAL_CTX: PredicateEditContext = {
	caseTypes: [
		{
			name: "patient",
			properties: [{ name: "status", label: "Status", data_type: "text" }],
		},
	],
	currentCaseType: "patient",
	knownInputs: [],
	caseDataScope: "global",
};

const HOLD_FALSE_CTX: PredicateEditContext = {
	...GLOBAL_CTX,
	globalPlaceholderHolds: false,
};

// Deliberately partial evaluator: it understands exactly the shapes the
// global seed factories may produce (session values, literals, equality
// comparisons, and the logical wrappers) and THROWS on anything else, so
// a new global seed shape fails here until this suite learns its truth.
function evalValue(value: ValueExpression): string {
	if (value.kind !== "term") {
		throw new Error(`unexpected seed value kind: ${value.kind}`);
	}
	const t = value.term;
	if (t.kind === "session-context") return "smoke-username";
	if (t.kind === "literal") return String(t.value ?? "");
	throw new Error(`unexpected seed term kind: ${t.kind}`);
}

function evalSeed(p: Predicate): boolean {
	switch (p.kind) {
		case "eq":
			return evalValue(p.left) === evalValue(p.right);
		case "neq":
			return evalValue(p.left) !== evalValue(p.right);
		case "and":
			return p.clauses.every(evalSeed);
		case "or":
			return p.clauses.some(evalSeed);
		case "not":
			return !evalSeed(p.clause);
		case "match-all":
			return true;
		case "match-none":
			return false;
		default:
			throw new Error(`unexpected seed predicate kind: ${p.kind}`);
	}
}

describe("global placeholders hold the truth value their destination needs", () => {
	it("the root/panel first seed holds true, so adding a condition never hides the surface", () => {
		expect(evalSeed(firstComparisonDefault(GLOBAL_CTX))).toBe(true);
		const seeded = firstConditionSeed(GLOBAL_CTX);
		expect(seeded).toBeDefined();
		if (seeded !== undefined) expect(evalSeed(seeded)).toBe(true);
	});

	it("an 'any' group's added clause holds false, so the group's meaning is unchanged", () => {
		expect(evalSeed(firstComparisonDefault(HOLD_FALSE_CTX))).toBe(false);
	});

	it("globalPlaceholder is truth-exact in both polarities", () => {
		expect(evalSeed(globalPlaceholder(true))).toBe(true);
		expect(evalSeed(globalPlaceholder(false))).toBe(false);
	});

	it("wrap siblings are neutral for their combinator: and(p, true) and or(p, false) keep p", () => {
		expect(evalSeed(wrapSiblingDefault("and", GLOBAL_CTX))).toBe(true);
		expect(evalSeed(wrapSiblingDefault("or", GLOBAL_CTX))).toBe(false);
	});

	it("fresh structural defaults evaluate to the destination's polarity", () => {
		// Root / "all"-group destination: the structure must hold.
		expect(evalSeed(andDefault(GLOBAL_CTX))).toBe(true);
		expect(evalSeed(orDefault(GLOBAL_CTX))).toBe(true);
		expect(evalSeed(notDefault(GLOBAL_CTX))).toBe(true);
		// "any"-group destination: the structure must not hold.
		expect(evalSeed(andDefault(HOLD_FALSE_CTX))).toBe(false);
		expect(evalSeed(orDefault(HOLD_FALSE_CTX))).toBe(false);
		expect(evalSeed(notDefault(HOLD_FALSE_CTX))).toBe(false);
	});

	it("the registry routes to the same neutral factories", () => {
		expect(evalSeed(predicateCardSchemas.and.defaultValue(GLOBAL_CTX))).toBe(
			true,
		);
		expect(evalSeed(predicateCardSchemas.or.defaultValue(GLOBAL_CTX))).toBe(
			true,
		);
		expect(evalSeed(predicateCardSchemas.not.defaultValue(GLOBAL_CTX))).toBe(
			true,
		);
		expect(
			evalSeed(predicateCardSchemas.not.defaultValue(HOLD_FALSE_CTX)),
		).toBe(false);
	});
});
