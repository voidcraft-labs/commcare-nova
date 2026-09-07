// Global-slot placeholders must be NEUTRAL: committing an unchosen seed
// may never change what the rule decides, because a global slot gates a
// whole surface (the Search action) the moment the placeholder commits.
// The registry's type-check invariants (validByConstruction,
// verbMenuBuildFuzz) prove seeds are well-typed; this suite proves their
// TRUTH: the axis a well-typed always-false placeholder still breaks.

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
import type { Predicate } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { evaluatePreviewSearchPredicate } from "@/lib/preview/engine/searchExpressionEvaluation";

const GLOBAL_CTX: PredicateEditContext = {
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "status", label: proseText("Status"), data_type: "text" },
			],
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

// Execute the production Preview evaluator. This proves Preview placeholder
// semantics; native CommCare acceptance is owned by the separate wire corpus.
const SESSION = previewSessionValues(
	previewAsMe({
		id: "worker-neutrality",
		name: "Amina Diallo",
		email: "amina@example.org",
	}),
);
function evalSeed(predicate: Predicate): boolean {
	return evaluatePreviewSearchPredicate(predicate, [], SESSION);
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
