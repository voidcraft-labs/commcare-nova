// lib/domain/predicate/__tests__/slotConstraints.test.ts
//
// Pins the inverse "valid choices" helpers against the forward type
// checker they invert. The editor offers exactly what these admit, so
// these tests are the guarantee that the offered-set never drifts from
// the checker's accept-set.

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
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
	dateAddOperandConstraint,
	eq,
	gt,
	inSubjectConstraint,
	literal,
	MATCH_MODES,
	MATCH_PROPERTY_TYPES_BY_MODE,
	matchModesFor,
	matchValueConstraint,
	ORDERED_TYPES,
	prop,
	type ResolvedType,
	typesCompatible,
	type ValueExpression,
	valueExpressionKindResultClass,
} from "@/lib/domain/predicate";

// The real case-property data types — excludes the internal sentinels
// (`_any` = null literal, `_sequence` = unwrap-list), which never resolve
// from a property/subject. The inversion helpers special-case `_any` (it
// can't prove an incompatibility), so the per-type agreement checks below
// cover concrete data types only.
const REAL_TYPES = ALL_RESOLVED_TYPES.filter(
	(t) => t !== ANY_TYPE && t !== "_sequence",
) as ResolvedType[];

describe("compatibleTypesFor", () => {
	it("is exactly { u : typesCompatible(t, u) } for every t", () => {
		for (const t of ALL_RESOLVED_TYPES) {
			const expected = new Set(
				ALL_RESOLVED_TYPES.filter((u) => typesCompatible(t, u)),
			);
			expect(compatibleTypesFor(t)).toEqual(expected);
		}
	});

	it("admits the whole alphabet for an unresolved subject", () => {
		expect(compatibleTypesFor(undefined)).toEqual(new Set(ALL_RESOLVED_TYPES));
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
		const caseTypes: CaseType[] = [
			{
				name: "patient",
				properties: [
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "name", label: "Name", data_type: "text" },
				],
			} as CaseType,
		];
		const ctx = { caseTypes, knownInputs: [], currentCaseType: "patient" };

		expect(comparisonOperatorsFor("int").has("gt")).toBe(true);
		expect(checkPredicate(gt(prop("patient", "age"), literal(5)), ctx).ok).toBe(
			true,
		);

		expect(comparisonOperatorsFor("text").has("gt")).toBe(false);
		expect(
			checkPredicate(gt(prop("patient", "name"), literal("x")), ctx).ok,
		).toBe(false);
		// eq stays valid on text (admitted by the helper).
		expect(
			checkPredicate(eq(prop("patient", "name"), literal("x")), ctx).ok,
		).toBe(true);
	});
});

describe("left-subject constraints", () => {
	it("inverts each comparison operator's checker rules", () => {
		for (const kind of ["eq", "neq", "gt", "gte", "lt", "lte"] as const) {
			const constraint = comparisonSubjectConstraint(kind);
			expect(constraint.accepts).not.toBe("any");
			if (constraint.accepts === "any") continue;

			for (const type of ALL_RESOLVED_TYPES) {
				const expected =
					type !== "_sequence" && comparisonOperatorsFor(type).has(kind);
				expect(
					constraint.accepts.has(type),
					`${kind} subject admission for ${type}`,
				).toBe(expected);
			}
		}
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
		expect(membership.accepts.has("_sequence")).toBe(false);
		expect(range.accepts.has("int")).toBe(true);
		expect(range.accepts.has("date")).toBe(true);
		expect(range.accepts.has("text")).toBe(false);
		expect(range.accepts.has("_sequence")).toBe(false);
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

describe("matchModesFor", () => {
	it("inverts MATCH_PROPERTY_TYPES_BY_MODE for every concrete type", () => {
		for (const t of REAL_TYPES) {
			const expected = new Set(
				MATCH_MODES.filter((m) => MATCH_PROPERTY_TYPES_BY_MODE[m].has(t)),
			);
			expect(matchModesFor(t)).toEqual(expected);
		}
	});

	it("admits all modes for an unresolved subject", () => {
		expect(matchModesFor(undefined)).toEqual(new Set(MATCH_MODES));
	});
});

describe("valueExpressionKindResultClass", () => {
	const KINDS: ValueExpression["kind"][] = [
		"term",
		"arith",
		"double",
		"concat",
		"format-date",
		"today",
		"now",
		"date-add",
		"date-coerce",
		"datetime-coerce",
		"count",
		"unwrap-list",
		"if",
		"switch",
		"coalesce",
	];

	it("classifies every kind without throwing", () => {
		for (const k of KINDS) {
			expect(() => valueExpressionKindResultClass(k)).not.toThrow();
		}
	});

	it("distinguishes fixed temporal coercions from adaptable date-add", () => {
		expect(valueExpressionKindResultClass("date-add")).toBe("date-or-datetime");
		expect(valueExpressionKindResultClass("date-coerce")).toBe("date");
		expect(valueExpressionKindResultClass("datetime-coerce")).toBe("datetime");
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

	it("a term-only slot (match.value) admits only a term", () => {
		const c = matchValueConstraint("fuzzy");
		expect(admitsValueExpressionKind("term", c).admitted).toBe(true);
		expect(admitsValueExpressionKind("concat", c).admitted).toBe(false);
		expect(admitsValueExpressionKind("if", c).admitted).toBe(false);
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
