// components/builder/shared/__tests__/selectedCaseScope.test.ts
//
// The `"selected-case"` scope's valid-by-construction proof.
//
// A form's display condition on a case-first module runs on the case
// list, where CommCare has exactly one case and no way to reach its
// relatives: `lib/commcare/validator/rules/displayConditions.ts`
// rejects a related read, a count, and a presence test there. So the
// editor must not OFFER any of those: an author who can build one has
// found a commit-gate rejection, not a feature.
//
// These assert the offered-set, the seeds, and the admission oracle's
// input predicate: the three places a related read could enter.

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	count,
	literal,
	predicateReadsRelatedCaseData,
	prop,
	relationStep,
	selfPath,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { firstConditionSeed } from "../conditionSeed";
import {
	type CaseDataScope,
	caseDataInScope,
	caseDataScopeAdmission,
	NEVER_MATCH_UNAVAILABLE_REASON,
	neverMatchInScope,
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateUnavailableReason,
	relatedCaseDataInScope,
} from "../editorSchemas";

const MOTHER: CaseType = {
	name: "mother",
	properties: [
		{ name: "status", label: proseText("Status"), data_type: "text" },
	],
};
const CHILD: CaseType = {
	name: "child",
	parent_type: "mother",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};
const EMPTY: CaseType = { name: "empty", properties: [] };

function ctx(
	caseDataScope: CaseDataScope,
	caseTypes: readonly CaseType[] = [MOTHER, CHILD],
	currentCaseType = "mother",
): PredicateEditContext {
	return { caseTypes, currentCaseType, knownInputs: [], caseDataScope };
}

/** A navigation display condition: no rule that can never match. */
function displayConditionCtx(
	caseDataScope: CaseDataScope,
): PredicateEditContext {
	return { ...ctx(caseDataScope), allowsNeverMatch: false };
}

describe("scope predicates", () => {
	it("keeps the chosen case's own data in scope but not its relatives", () => {
		expect(caseDataInScope(ctx("selected-case"))).toBe(true);
		expect(relatedCaseDataInScope(ctx("selected-case"))).toBe(false);
		expect(relatedCaseDataInScope(ctx("per-case"))).toBe(true);
		expect(caseDataInScope(ctx("global"))).toBe(false);
		expect(relatedCaseDataInScope(ctx("global"))).toBe(false);
	});
});

describe("offered predicate kinds", () => {
	const relationBearing = new Set(["exists", "missing"]);

	it("offers relation presence per-case and withholds it for a selected case", () => {
		for (const schema of predicateCardSchemaList) {
			if (!relationBearing.has(schema.kind)) continue;
			expect(schema.applicable(ctx("per-case"))).toBe(true);
			expect(schema.applicable(ctx("selected-case"))).toBe(false);
			expect(schema.applicable(ctx("global"))).toBe(false);
		}
	});

	it("still offers own-property conditions for a selected case", () => {
		const comparison = predicateCardSchemaList.find((s) => s.kind === "eq");
		expect(comparison?.applicable(ctx("selected-case"))).toBe(true);
	});

	it("explains the withheld relation kinds in the scope's own words", () => {
		const reason = predicateUnavailableReason("exists", ctx("selected-case"));
		expect(reason).toContain("already-chosen case");
		expect(predicateUnavailableReason("exists", ctx("per-case"))).toContain(
			"parent or child",
		);
	});

	it("never seeds a relation for a selected case, even with nothing to compare", () => {
		expect(
			firstConditionSeed(ctx("selected-case", [EMPTY], "empty")),
		).toBeUndefined();
		// The ordinary per-case scope still falls back to a relation seed
		// when it has one, so the change is scoped to the new axis.
		const related: CaseType = { name: "empty", properties: [] };
		const child: CaseType = {
			name: "kid",
			parent_type: "empty",
			properties: [],
		};
		expect(
			firstConditionSeed(ctx("per-case", [related, child], "empty")),
		).toBeDefined();
	});

	it("seeds an own-property comparison for a selected case that has one", () => {
		const seed = firstConditionSeed(ctx("selected-case"));
		expect(seed).toBeDefined();
		expect(seed && predicateReadsRelatedCaseData(seed)).toBe(false);
	});
});

describe("scope admission at the editor boundary", () => {
	it("refuses related counts and property reads for the selected case but permits own reads", () => {
		const related = term(
			prop("child", "status", ancestorPath(relationStep("parent"))),
		);
		const countChildren = count(subcasePath("parent", "child"));
		for (const value of [related, countChildren]) {
			expect(caseDataScopeAdmission("selected-case", value)).toMatchObject({
				admitted: false,
			});
			expect(caseDataScopeAdmission("per-case", value)).toEqual({
				admitted: true,
			});
		}
		for (const value of [
			term(prop("mother", "status")),
			term(prop("mother", "status", selfPath())),
		]) {
			expect(caseDataScopeAdmission("selected-case", value)).toEqual({
				admitted: true,
			});
			expect(caseDataScopeAdmission("global", value)).toMatchObject({
				admitted: false,
			});
		}
		expect(caseDataScopeAdmission("global", term(literal("constant")))).toEqual(
			{ admitted: true },
		);
	});
});

// `match-none` is legitimate authored data in a DIFFERENT carrier: an
// accepted-shape `{ excludedOwnerIds, searchButtonDisplayCondition:
// match-none }` projection is behavior-inert with zero inputs but stays
// valid authored data and must remain editable (`lib/domain/CLAUDE.md`).
// A display condition is the one carrier where "never" means nobody
// could ever open the item, so the withholding rides its own axis rather
// than the evaluation scope those two carriers happen to share.
describe("never-match is a carrier axis, not a scope reading", () => {
	const matchNone = predicateCardSchemaList.find(
		(schema) => schema.kind === "match-none",
	);

	it("stays offered wherever nothing-matches is a real answer", () => {
		expect(matchNone).toBeDefined();
		// The Search action's condition: `global` scope, and legitimately
		// allowed to be `match-none`.
		expect(matchNone?.applicable(ctx("global"))).toBe(true);
		// An ordinary case-list filter matching nothing is a real query.
		expect(matchNone?.applicable(ctx("per-case"))).toBe(true);
	});

	it("is withheld from a display condition in either of its scopes", () => {
		expect(matchNone?.applicable(displayConditionCtx("global"))).toBe(false);
		expect(matchNone?.applicable(displayConditionCtx("selected-case"))).toBe(
			false,
		);
		expect(
			predicateUnavailableReason("match-none", displayConditionCtx("global")),
		).toBe(NEVER_MATCH_UNAVAILABLE_REASON);
	});

	it("defaults to allowed, so no existing carrier loses the affordance", () => {
		expect(neverMatchInScope(ctx("global"))).toBe(true);
		expect(neverMatchInScope(ctx("per-case"))).toBe(true);
		expect(neverMatchInScope(ctx("selected-case"))).toBe(true);
	});

	it("withholds nothing else from the display-condition carrier", () => {
		for (const schema of predicateCardSchemaList) {
			if (schema.kind === "match-none") continue;
			expect(schema.applicable(displayConditionCtx("global"))).toBe(
				schema.applicable(ctx("global")),
			);
			expect(schema.applicable(displayConditionCtx("per-case"))).toBe(
				schema.applicable(ctx("per-case")),
			);
		}
	});
});
