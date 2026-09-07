import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	arith,
	between,
	checkPredicate,
	concat,
	eq,
	exists,
	gte,
	input,
	isBlank,
	literal,
	matchesPattern,
	missing,
	predicateSchema,
	prop,
	relationStep,
	term,
	whenInput,
	within,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	buildPredicateKindReplacement,
	planPredicateTransition,
} from "../cards/ChildPredicateEditor";
import {
	buildComparison,
	buildContains,
	buildMatch,
	buildWithSubjectLeft,
} from "../cards/PredicateVerbMenu";
import type { PredicateEditContext } from "../editorSchemas";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "age", label: proseText("Age"), data_type: "int" },
			{ name: "case_name", label: proseText("Case name"), data_type: "text" },
			{
				name: "tags",
				label: proseText("Tags"),
				data_type: "multi_select",
				options: [{ value: "priority", label: proseText("Priority") }],
			},
			{ name: "location", label: proseText("Location"), data_type: "geopoint" },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "region", label: proseText("Region"), data_type: "text" },
		],
	},
];

const EDIT_CTX: PredicateEditContext = {
	caseTypes: CASE_TYPES,
	currentCaseType: "patient",
	knownInputs: [
		{ uuid: testUuid("query"), name: "query", data_type: "text" },
		{
			uuid: testUuid("location-query"),
			name: "location_query",
			data_type: "geopoint",
		},
	],
	caseDataScope: "per-case",
};

describe("predicate transition planning", () => {
	it("maps a comparison into the matching range bound without losing a computed value", () => {
		const right = arith("+", term(literal(17)), term(literal(1)));
		const current = gte(prop("patient", "age"), right);
		const next = buildWithSubjectLeft("between", current, EDIT_CTX);

		expect(next).toEqual(
			between(current.left, {
				lower: current.right,
				lowerInclusive: true,
				upperInclusive: true,
			}),
		);
		expect(planPredicateTransition(current, next, "is between")).toEqual({
			next,
		});
	});

	it("maps a one-sided range back to its exact comparison without a warning", () => {
		const lower = term(literal(18));
		const current = between(prop("patient", "age"), {
			lower,
			lowerInclusive: true,
		});
		const next = buildComparison("gte", current, EDIT_CTX);

		expect(next).toEqual(gte(current.left, lower));
		expect(planPredicateTransition(current, next, "is at least")).toEqual({
			next,
		});
	});

	it("names the exact range information a single-value target cannot keep", () => {
		const current = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		const next = buildComparison("eq", current, EDIT_CTX);
		const plan = planPredicateTransition(current, next, "is");

		expect(plan.confirmation).toEqual({
			title: "Change to “is”?",
			description:
				"This removes one range bound and the range boundary choices. Saved case data won't change. You can undo this change.",
		});
	});

	it("keeps an admissible computed comparison value when switching to text match", () => {
		const computed = concat(term(literal("Braxton")), term(literal(" Perry")));
		const current = eq(prop("patient", "case_name"), computed);
		const next = buildMatch("starts-with", current, EDIT_CTX);

		expect(next.kind).toBe("match");
		if (next.kind !== "match") throw new Error("Expected a match predicate");
		expect(next.value).toBe(computed);
		expect(planPredicateTransition(current, next, "starts with")).toEqual({
			next,
		});
	});

	it("warns when a literal-only target cannot represent a computed value", () => {
		const computed = arith("+", term(literal(17)), term(literal(1)));
		const current = eq(prop("patient", "age"), computed);
		const next = buildWithSubjectLeft("in", current, EDIT_CTX);

		expect(
			planPredicateTransition(current, next, "is any of").confirmation,
		).toEqual({
			title: "Change to “is any of”?",
			description:
				"This removes the comparison value. Saved case data won't change. You can undo this change.",
		});
	});

	it("moves a saved literal into a list without claiming the value is lost", () => {
		const savedValue = literal("active");
		const comparison = eq(prop("patient", "case_name"), savedValue);
		const comparisonList = buildWithSubjectLeft("in", comparison, EDIT_CTX);
		if (
			comparison.right.kind !== "term" ||
			comparison.right.term.kind !== "literal"
		) {
			throw new Error("Expected a literal comparison value");
		}
		const authoredComparisonValue = comparison.right.term;

		expect(comparisonList.kind).toBe("in");
		if (comparisonList.kind !== "in") throw new Error("Expected a list");
		expect(comparisonList.values[0]).toBe(authoredComparisonValue);
		expect(
			planPredicateTransition(comparison, comparisonList, "is any of"),
		).toEqual({ next: comparisonList });

		const matchValue = literal("Taylor");
		const textMatch = {
			kind: "match" as const,
			property: prop("patient", "case_name"),
			value: term(matchValue),
			mode: "starts-with" as const,
		};
		const matchList = buildWithSubjectLeft("in", textMatch, EDIT_CTX);
		expect(matchList.kind).toBe("in");
		if (matchList.kind !== "in") throw new Error("Expected a list");
		expect(matchList.values[0]).toBe(matchValue);
		expect(planPredicateTransition(textMatch, matchList, "is any of")).toEqual({
			next: matchList,
		});
	});

	it("replaces a null-only candidate when moving into a persisted value list", () => {
		const membership = buildWithSubjectLeft(
			"in",
			eq(prop("patient", "case_name"), literal(null)),
			EDIT_CTX,
		);
		const contains = buildContains(
			"any",
			eq(prop("patient", "tags"), literal(null)),
			EDIT_CTX,
		);
		const typeCtx = {
			caseTypes: [...CASE_TYPES],
			knownInputs: [...EDIT_CTX.knownInputs],
			currentCaseType: "patient",
		};

		for (const next of [membership, contains]) {
			expect(predicateSchema.safeParse(next).success).toBe(true);
			expect(checkPredicate(next, typeCtx).ok).toBe(true);
			if (next.kind === "in" || next.kind === "multi-select-contains") {
				expect(next.values.some((candidate) => candidate.value !== null)).toBe(
					true,
				);
			}
		}
	});

	it("keeps a nearby center but warns that its distance settings cannot map", () => {
		const center = term(input(testUuid("location-query")));
		const current = within(
			prop("patient", "location"),
			center,
			25,
			"kilometers",
		);
		const next = buildComparison("eq", current, EDIT_CTX);
		const plan = planPredicateTransition(current, next, "is");

		expect(next).toEqual(eq(term(current.property), center));
		expect(plan.confirmation).toEqual({
			title: "Change to “is”?",
			description:
				"This removes the distance and unit. Saved case data won't change. You can undo this change.",
		});
	});

	it("wraps structural predicates without discarding their subtree", () => {
		const relation = ancestorPath(relationStep("parent", "household"));
		const where = eq(prop("household", "region"), literal("north"));
		const current = exists(relation, where);
		const next = buildPredicateKindReplacement(current, "not", EDIT_CTX);

		expect(planPredicateTransition(current, next, "Exclude when")).toEqual({
			next,
		});
	});

	it("preserves relation twins and stages a reset that would remove relation work", () => {
		const relation = ancestorPath(relationStep("parent", "household"));
		const where = eq(prop("household", "region"), literal("north"));
		const current = exists(relation, where);
		const twin = buildPredicateKindReplacement(current, "missing", EDIT_CTX);

		expect(twin).toEqual(missing(relation, where));
		expect(
			planPredicateTransition(current, twin, "Has no related case"),
		).toEqual({ next: twin });

		const reset = buildPredicateKindReplacement(current, "eq", EDIT_CTX);
		expect(
			planPredicateTransition(current, reset, "Is").confirmation?.title,
		).toBe("Change to “Is”?");
	});

	it("preserves a wrapper's child but confirms before removing its search-answer gate", () => {
		const clause = eq(prop("patient", "case_name"), literal("Alice"));
		const current = whenInput(input(testUuid("query")), clause);
		const next = buildPredicateKindReplacement(current, "eq", EDIT_CTX);

		expect(next).toBe(clause);
		expect(planPredicateTransition(current, next, "Is").confirmation).toEqual({
			title: "Change to “Is”?",
			description:
				"This removes the search answer. Saved case data won't change. You can undo this change.",
		});
	});
});

it("requires confirmation when a preserved subject loses its authored text pattern", () => {
	const current = matchesPattern(
		prop("patient", "case_name"),
		"^North-[0-9]+$",
	);
	const next = buildWithSubjectLeft("is-blank", current, EDIT_CTX);
	expect(next).toEqual(isBlank(current.left));
	expect(planPredicateTransition(current, next, "is blank")).toEqual({
		next,
		confirmation: {
			title: "Change to “is blank”?",
			description:
				"This removes the text pattern. Saved case data won't change. You can undo this change.",
		},
	});
});
