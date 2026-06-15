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
	admitsValueExpressionKind,
	checkPredicate,
	comparisonObjectConstraint,
	comparisonOperatorsFor,
	compatibleTypesFor,
	eq,
	gt,
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
});

describe("admitsValueExpressionKind", () => {
	it("admits a numeric kind only at a numeric-accepting slot", () => {
		const numeric = comparisonObjectConstraint("int");
		const text = comparisonObjectConstraint("text");
		expect(admitsValueExpressionKind("arith", numeric).admitted).toBe(true);
		expect(admitsValueExpressionKind("arith", text).admitted).toBe(false);
		expect(admitsValueExpressionKind("concat", text).admitted).toBe(true);
		expect(admitsValueExpressionKind("concat", numeric).admitted).toBe(false);
	});

	it("always admits the input-dependent kinds (they propagate inward)", () => {
		const text = comparisonObjectConstraint("text");
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
});
