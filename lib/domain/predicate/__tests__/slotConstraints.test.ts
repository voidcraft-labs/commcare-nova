// lib/domain/predicate/__tests__/slotConstraints.test.ts
//
// Exercises selector constraints with concrete type and AST examples, including
// real checker admission. This finite corpus does not establish exhaustiveness.

import { describe, expect, it } from "vitest";
import { caseTypeSchema } from "@/lib/domain";
import {
	ALL_RESOLVED_TYPES,
	ANY_TYPE,
	absenceSubjectConstraint,
	admitsValueExpressionKind,
	betweenSubjectConstraint,
	branchConstraint,
	checkPredicate,
	comparisonObjectConstraint,
	comparisonOperatorsFor,
	comparisonSubjectConstraint,
	compatibleTypesFor,
	concat,
	dateAddOperandConstraint,
	eq,
	gt,
	ifExpr,
	inSubjectConstraint,
	literal,
	match,
	matchAll,
	matchModesFor,
	matchValueConstraint,
	ORDERED_TYPES,
	predicateSchema,
	prop,
	type ResolvedType,
	storageAssignmentConstraint,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

// The selector tests compare authored rule examples with the actual checker.
// They do not recompute expected sets by invoking the helpers being tested.
describe("compatibleTypesFor", () => {
	it.each([
		["int", ["int", "decimal", "_any"]],
		["date", ["date", "_any"]],
		["single_select", ["text", "single_select", "_any"]],
		["geopoint", ["geopoint", "_any"]],
	] as const)("keeps the supported comparisons for %s", (type, accepted) => {
		expect(compatibleTypesFor(type)).toEqual(new Set(accepted));
	});
	it("leaves an unresolved subject open until the checker can resolve it", () => {
		expect(compatibleTypesFor(undefined).has("date")).toBe(true);
		expect(compatibleTypesFor(undefined).has("multi_select")).toBe(true);
		expect(compatibleTypesFor(undefined).has("geopoint")).toBe(true);
	});
});

describe("comparisonOperatorsFor", () => {
	it("always admits eq/neq", () => {
		for (const t of [...ALL_RESOLVED_TYPES, undefined]) {
			const ops = comparisonOperatorsFor(t);
			expect(ops.has("eq")).toBe(true);
			expect(ops.has("neq")).toBe(true);
		}
	});

	it("admits ordering ops iff the subject is ordered (or null/unknown)", () => {
		for (const t of ALL_RESOLVED_TYPES) {
			const expectOrdered = t === ANY_TYPE || ORDERED_TYPES.has(t);
			expect(comparisonOperatorsFor(t).has("gt")).toBe(expectOrdered);
			expect(comparisonOperatorsFor(t).has("lte")).toBe(expectOrdered);
		}
		// unresolved subject can't prove incompatibility → admits all six.
		expect(comparisonOperatorsFor(undefined).has("gt")).toBe(true);
	});

	it("agrees with the checker: gt resolves on int, rejects on text", () => {
		const caseTypes = [
			caseTypeSchema.parse({
				name: "patient",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{
						name: "case_name",
						label: proseText("Case name"),
						data_type: "text",
					},
				],
			}),
		];
		const ctx = { caseTypes, knownInputs: [], currentCaseType: "patient" };

		expect(comparisonOperatorsFor("int").has("gt")).toBe(true);
		expect(checkPredicate(gt(prop("patient", "age"), literal(5)), ctx).ok).toBe(
			true,
		);

		expect(comparisonOperatorsFor("text").has("gt")).toBe(false);
		expect(
			checkPredicate(gt(prop("patient", "case_name"), literal("x")), ctx).ok,
		).toBe(false);
		// eq stays valid on text (admitted by the helper).
		expect(
			checkPredicate(eq(prop("patient", "case_name"), literal("x")), ctx).ok,
		).toBe(true);
	});
});

describe("left-subject constraints", () => {
	it.each([
		["gt", "int", true],
		["gt", "text", false],
		["eq", "text", true],
		["eq", "geopoint", true],
		["lte", "datetime", true],
		["lte", "multi_select", false],
	] as const)("offers %s subject %s: %s", (kind, type, offered) => {
		const constraint = comparisonSubjectConstraint(kind);
		expect(constraint.accepts === "any" || constraint.accepts.has(type)).toBe(
			offered,
		);
		const caseTypes = [
			caseTypeSchema.parse({
				name: "patient",
				properties: [
					{ name: "value", label: proseText("Value"), data_type: type },
				],
			}),
		];
		const candidate = predicateSchema.parse({
			kind,
			left: term(prop("patient", "value")),
			right: term(prop("patient", "value")),
		});
		expect(checkPredicate(candidate, { caseTypes, knownInputs: [] }).ok).toBe(
			offered,
		);
	});

	it("keeps scalar membership broad and ordered ranges narrow", () => {
		const membership = inSubjectConstraint();
		const range = betweenSubjectConstraint();
		expect(membership.accepts).not.toBe("any");
		expect(range.accepts).not.toBe("any");
		if (membership.accepts === "any" || range.accepts === "any") return;

		expect(membership.accepts.has("text")).toBe(true);
		expect(membership.accepts.has("int")).toBe(true);
		expect(membership.accepts.has("single_select")).toBe(true);
		expect(membership.accepts.has("multi_select")).toBe(true);
		// Membership lists must contain a non-null literal, but the editor has
		// no geopoint literal control. Do not offer an unfinishable subject.
		expect(membership.accepts.has("geopoint")).toBe(false);
		expect(range.accepts.has("int")).toBe(true);
		expect(range.accepts.has("date")).toBe(true);
		expect(range.accepts.has("text")).toBe(false);
	});

	it("makes the absence literal restriction node-local", () => {
		const absence = absenceSubjectConstraint();
		expect(absence.accepts).toBe("any");
		expect(absence.forbidDirectLiteral).toBe(true);
	});

	it("returns stable descriptors for render-time memoization", () => {
		expect(comparisonSubjectConstraint("gt")).toBe(
			comparisonSubjectConstraint("gt"),
		);
		expect(inSubjectConstraint()).toBe(inSubjectConstraint());
		expect(betweenSubjectConstraint()).toBe(betweenSubjectConstraint());
		expect(absenceSubjectConstraint()).toBe(absenceSubjectConstraint());
	});
});

describe("storage assignment constraints", () => {
	it("keeps an untyped destination to concrete storable values", () => {
		const constraint = storageAssignmentConstraint([]);
		expect(constraint.accepts).not.toBe("any");
		if (constraint.accepts === "any") return;
		expect(constraint.accepts.has("text")).toBe(true);
		expect(constraint.accepts.has("multi_select")).toBe(true);
		expect(constraint.accepts.has("geopoint")).toBe(true);
		expect(constraint.accepts.has("_any")).toBe(false);
	});
});

describe("matchModesFor", () => {
	it.each([
		["text", ["fuzzy", "phonetic", "fuzzy-date", "starts-with"]],
		["date", ["fuzzy-date"]],
		["datetime", ["fuzzy-date"]],
		["int", []],
		["geopoint", []],
	] as const)("offers supported modes for %s", (type, modes) => {
		expect(matchModesFor(type)).toEqual(new Set(modes));
		const caseTypes = [
			caseTypeSchema.parse({
				name: "patient",
				properties: [
					{ name: "value", label: proseText("Value"), data_type: type },
				],
			}),
		];
		for (const mode of [
			"fuzzy",
			"phonetic",
			"fuzzy-date",
			"starts-with",
		] as const) {
			const candidate = predicateSchema.parse(
				match(prop("patient", "value"), literal("sample"), mode),
			);
			expect(checkPredicate(candidate, { caseTypes, knownInputs: [] }).ok).toBe(
				modes.some((allowed) => allowed === mode),
			);
		}
	});
});

describe("admitsValueExpressionKind", () => {
	it("narrows an ordered comparison object even when the subject is null-typed", () => {
		const ordered = comparisonObjectConstraint("gt", ANY_TYPE);
		expect(ordered.accepts).not.toBe("any");
		if (ordered.accepts === "any") return;
		expect(ordered.accepts.has("int")).toBe(true);
		expect(ordered.accepts.has("date")).toBe(true);
		expect(ordered.accepts.has(ANY_TYPE)).toBe(true);
		expect(ordered.accepts.has("text")).toBe(false);
		expect(ordered.accepts.has("single_select")).toBe(false);
	});

	it("admits a numeric kind only at a numeric-accepting slot", () => {
		const numeric = comparisonObjectConstraint("eq", "int");
		const text = comparisonObjectConstraint("eq", "text");
		expect(admitsValueExpressionKind("arith", numeric).admitted).toBe(true);
		expect(admitsValueExpressionKind("arith", text).admitted).toBe(false);
		expect(admitsValueExpressionKind("concat", text).admitted).toBe(true);
		expect(admitsValueExpressionKind("concat", numeric).admitted).toBe(false);
	});

	it("always admits the input-dependent kinds (they propagate inward)", () => {
		const text = comparisonObjectConstraint("eq", "text");
		for (const k of ["term", "if", "switch", "coalesce"] as const) {
			expect(admitsValueExpressionKind(k, text).admitted).toBe(true);
		}
	});

	it("offers composed match values admitted by the real checker", () => {
		const context = { caseTypes: [], knownInputs: [] };
		const caseType = caseTypeSchema.parse({
			name: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
			],
		});
		const matchContext = {
			...context,
			caseTypes: [caseType],
			currentCaseType: "patient",
		};
		for (const value of [
			concat(term(literal("Al")), term(literal("ice"))),
			ifExpr(matchAll(), term(literal("Alice")), term(literal("Bob"))),
		]) {
			const candidate = predicateSchema.parse(
				match(prop("patient", "case_name"), value, "starts-with"),
			);
			expect(checkPredicate(candidate, matchContext)).toEqual({ ok: true });
			expect(
				admitsValueExpressionKind(
					value.kind,
					matchValueConstraint("starts-with"),
				).admitted,
			).toBe(true);
		}
		expect(
			checkPredicate(
				match(prop("patient", "case_name"), literal(""), "starts-with"),
				matchContext,
			).ok,
		).toBe(false);
		expect(
			admitsValueExpressionKind("arith", matchValueConstraint("starts-with"))
				.admitted,
		).toBe(false);
	});

	it("admits fixed temporal coercions only where their actual result fits", () => {
		const dateOnly = { accepts: new Set<ResolvedType>(["date"]) };
		const datetimeOnly = { accepts: new Set<ResolvedType>(["datetime"]) };

		expect(admitsValueExpressionKind("date-coerce", dateOnly).admitted).toBe(
			true,
		);
		expect(
			admitsValueExpressionKind("date-coerce", datetimeOnly).admitted,
		).toBe(false);
		expect(
			admitsValueExpressionKind("datetime-coerce", dateOnly).admitted,
		).toBe(false);
		expect(
			admitsValueExpressionKind("datetime-coerce", datetimeOnly).admitted,
		).toBe(true);
		// `date-add` follows its date operand, so either result can be seeded.
		expect(admitsValueExpressionKind("date-add", dateOnly).admitted).toBe(true);
		expect(admitsValueExpressionKind("date-add", datetimeOnly).admitted).toBe(
			true,
		);
	});
});

describe("dateAddOperandConstraint", () => {
	it("keeps both temporal arms for an unconstrained result", () => {
		const constraint = dateAddOperandConstraint({ accepts: "any" });
		expect(constraint.accepts).toEqual(
			new Set<ResolvedType>(["date", "datetime"]),
		);
	});

	it("chooses exactly the temporal arm accepted by the parent", () => {
		expect(
			dateAddOperandConstraint({
				accepts: new Set<ResolvedType>(["date", "text"]),
			}).accepts,
		).toEqual(new Set<ResolvedType>(["date"]));
		expect(
			dateAddOperandConstraint({
				accepts: new Set<ResolvedType>(["datetime", "text"]),
			}).accepts,
		).toEqual(new Set<ResolvedType>(["datetime"]));
	});

	it("returns an empty operand set when the parent cannot consume a date-add", () => {
		expect(
			dateAddOperandConstraint({
				accepts: new Set<ResolvedType>(["text"]),
			}).accepts,
		).toEqual(new Set());
	});
});

describe("branchConstraint", () => {
	it("treats unresolved and null-only siblings as neutral", () => {
		const parent = {
			accepts: new Set<ResolvedType>(["date", "datetime"]),
			nonEmpty: true,
			termOnly: true,
			forbidDirectLiteral: true,
		} as const;
		expect(branchConstraint(parent, undefined, ANY_TYPE)).toBe(parent);
	});

	it("intersects the parent with every sibling's compatible result types", () => {
		const narrowed = branchConstraint(
			{
				accepts: new Set<ResolvedType>(["int", "decimal", "text", ANY_TYPE]),
			},
			"int",
			"decimal",
		);
		expect(narrowed.accepts).toEqual(
			new Set<ResolvedType>(["int", "decimal", ANY_TYPE]),
		);
	});

	it("preserves parent structural flags while narrowing", () => {
		const narrowed = branchConstraint(
			{
				accepts: "any",
				nonEmpty: true,
				termOnly: true,
				forbidDirectLiteral: true,
			},
			"date",
		);
		expect(narrowed).toMatchObject({
			nonEmpty: true,
			termOnly: true,
			forbidDirectLiteral: true,
		});
		expect(narrowed.accepts).toEqual(new Set<ResolvedType>(["date", ANY_TYPE]));
	});

	it("returns an empty set for an incompatible parent or sibling group", () => {
		expect(
			branchConstraint({ accepts: new Set<ResolvedType>(["date"]) }, "datetime")
				.accepts,
		).toEqual(new Set());
		expect(
			branchConstraint({ accepts: "any" }, "date", "datetime").accepts,
		).toEqual(new Set());
	});
});
