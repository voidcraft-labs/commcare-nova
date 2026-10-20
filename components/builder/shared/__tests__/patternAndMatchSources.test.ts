// components/builder/shared/__tests__/patternAndMatchSources.test.ts
//
// The match card's calculated subject and the two cards' "Calculated"
// pattern offer exactly what the commit gate admits. Each offer is the exact
// expression the card commits, judged by `expressionEditVerdict` over real
// slot contexts built from a fixture document. No React renderer.

import { describe, expect, it } from "vitest";
import {
	type EditorFixtureCarrier,
	expressionEditorFixture,
} from "@/__tests__/helpers/expressionEditorFixture";
import { testUuid } from "@/__tests__/helpers/uuid";
import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import type { CaseType } from "@/lib/domain";
import {
	concat,
	type Expression,
	type ExpressionContext,
	eq,
	FORMAT_DATE_PRESETS,
	formatDate,
	input,
	literal,
	match,
	matchesPattern,
	prop,
	sessionContext,
	term,
	today,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { buildMatch } from "../cards/PredicateVerbMenu";
import type { ExpressionChangeAdmission } from "../editorContext";
import {
	matchSubjectCalculable,
	matchSubjectExpression,
	matchSubjectFromExpression,
	replaceMatchSubject,
} from "../matchSubjectModel";
import {
	calculatedPatternSeed,
	fixedPatternText,
	patternSourceAdmission,
	storedPattern,
	textPatternFor,
} from "../patternSourceModel";

const PERSON: CaseType = {
	name: "person",
	properties: [
		{ name: "full_name", label: proseText("Full name"), data_type: "text" },
	],
};
const WORDS = testUuid("pattern-source-words");

function contextFor(carrier: EditorFixtureCarrier): ExpressionContext {
	return expressionEditorFixture(carrier, {
		caseTypes: [PERSON],
		currentCaseType: "person",
		// A module with a Search field is searchable, so its case list filter
		// is evaluated by CommCare's server search too.
		knownInputs:
			carrier === "case-filter"
				? []
				: [{ uuid: WORDS, name: "words", data_type: "text" }],
	}).context.expressionContext;
}

function gate(context: ExpressionContext) {
	return (candidate: Expression): ExpressionChangeAdmission => {
		const verdict = expressionEditVerdict(candidate, context);
		return verdict.ok
			? { admitted: true }
			: { admitted: false, reason: verdict.reason };
	};
}

describe("match subject", () => {
	const calculated = replaceMatchSubject(
		match(prop("person", "full_name"), "ann", "starts-with"),
		term(sessionContext("username")),
	);

	it.each([
		["case-filter", true],
		["search-case-filter", false],
		["search-predicate", false],
	] as const)(
		"%s offers a calculated subject: %s, as the gate admits it",
		(carrier, offered) => {
			const context = contextFor(carrier);
			expect(matchSubjectCalculable(context)).toBe(offered);
			if (carrier === "search-predicate") return;
			expect(expressionEditVerdict(calculated, context).ok).toBe(offered);
		},
	);

	it("stores a property subject directly and keeps any other value", () => {
		const property = prop("person", "full_name");
		expect(matchSubjectFromExpression(matchSubjectExpression(property))).toBe(
			property,
		);
		const subject = term(input(WORDS));
		expect(matchSubjectFromExpression(subject)).toBe(subject);
		expect(calculated.value).toEqual(term(literal("ann")));
		expect(calculated.mode).toBe("starts-with");
	});
});

describe("calculated pattern", () => {
	it("carries the written pattern, so the rule keeps its meaning", () => {
		const seed = calculatedPatternSeed("^[0-9]+$");
		expect(fixedPatternText(seed)).toBe("^[0-9]+$");
		expect(textPatternFor(seed, "x")).toEqual({
			text: "^[0-9]+$",
			losesCalculation: false,
		});
	});

	it("asks before a calculation is replaced by written text", () => {
		const calculation = concat(term(literal("^")), term(input(WORDS)));
		expect(textPatternFor(calculation, "^[0-9]+$")).toEqual({
			text: "^[0-9]+$",
			losesCalculation: true,
		});
	});

	it("stores a bare written value as the written pattern, but keeps a format-date preset name calculated", () => {
		expect(storedPattern(term(literal("^a")))).toBe("^a");
		const presets = { presetNames: FORMAT_DATE_PRESETS };
		const shortText = term(literal("short"));
		expect(storedPattern(shortText, presets)).toBe(shortText);
		expect(storedPattern(term(literal("%Y")), presets)).toBe("%Y");
		expect(
			textPatternFor(calculatedPatternSeed("short"), "iso", presets),
		).toEqual({ text: "iso", losesCalculation: true });
	});

	it("offers a calculated pattern match where the gate admits one", () => {
		const context = contextFor("search-required");
		const left = term(input(WORDS));
		const admission = patternSourceAdmission(
			"text",
			{
				text: matchesPattern(left, "^[0-9]+$"),
				calculated: matchesPattern(left, calculatedPatternSeed("^[0-9]+$")),
			},
			gate(context),
		);
		expect(admission.calculated).toEqual({ admitted: true });
	});

	it("refuses a calculated date style where Nova's case store works the value out", () => {
		const context = contextFor("calculated-column");
		expect(context.profile.targets.has("PG")).toBe(true);
		const admission = patternSourceAdmission(
			"text",
			{
				text: formatDate(today(), "short"),
				calculated: formatDate(today(), calculatedPatternSeed("%m/%d/%Y")),
			},
			gate(context),
		);
		expect(admission.text).toEqual({ admitted: true });
		expect(admission.calculated.admitted).toBe(false);
	});

	it("admits a calculated date style where no Postgres target reads the slot", () => {
		const context = contextFor("search-required");
		expect(context.profile.targets.has("PG")).toBe(false);
		const condition = (pattern: string | Expression) =>
			eq(formatDate(today(), pattern), literal("01/02/2026"));
		const admission = patternSourceAdmission(
			"text",
			{
				text: condition("short"),
				calculated: condition(calculatedPatternSeed("%m/%d/%Y")),
			},
			gate(context),
		);
		expect(admission.calculated).toEqual({ admitted: true });
	});

	it("keeps the source in use selectable so a refused saved value is repairable", () => {
		const refuseAll = () =>
			({ admitted: false, reason: "No" }) as ExpressionChangeAdmission;
		const pattern = matchesPattern(term(input(WORDS)), "^a");
		const admission = patternSourceAdmission(
			"calculated",
			{ text: pattern, calculated: pattern },
			refuseAll,
		);
		expect(admission.calculated).toEqual({ admitted: true });
		expect(admission.text.admitted).toBe(false);
	});
});

describe("switching a comparison to a match", () => {
	const calculatedSubject = concat(
		term(prop("person", "full_name")),
		term(literal(" ")),
	);
	const comparison = eq(calculatedSubject, term(literal("ann")));

	it("carries a calculated subject where the card can show it", () => {
		for (const carrier of ["case-filter", "search-case-filter"] as const) {
			const fixture = expressionEditorFixture(carrier, {
				caseTypes: [PERSON],
				currentCaseType: "person",
				knownInputs:
					carrier === "case-filter"
						? []
						: [{ uuid: WORDS, name: "words", data_type: "text" }],
			}).context;
			const built = buildMatch("starts-with", comparison, fixture);
			if (built.kind !== "match") throw new Error("A match was built.");
			if (matchSubjectCalculable(fixture.expressionContext)) {
				// The subject moves with the verb, and the gate admits it.
				expect(built.property).toEqual(calculatedSubject);
				expect(expressionEditVerdict(built, fixture.expressionContext).ok).toBe(
					true,
				);
			} else {
				// A server search needs a property: the seed's property stands in.
				expect(built.property.kind).toBe("prop");
			}
		}
	});
});
