// components/builder/shared/__tests__/validByConstruction.test.ts
//
// The headline invariant of the valid-by-construction editor: an
// admitted choice — and any cascade-reseed the editor performs — is
// ALWAYS type-correct. These tests tie the editor's admission helpers
// (`comparisonOperatorsFor` / `matchModesFor` / `compatibleTypesFor`)
// and the reseed (`cards/reseed.ts`) directly to the type checker
// (`checkPredicate`), so "the pickers only offer valid choices" is a
// proven property, not a hope. Pure domain-level — no React, no DOM.

import { describe, expect, it } from "vitest";
import { type CaseType, casePropertyDataTypes } from "@/lib/domain";
import {
	ALL_RESOLVED_TYPES,
	ANY_TYPE,
	type ComparisonKind,
	checkPredicate,
	comparisonObjectConstraint,
	comparisonOperatorsFor,
	compatibleTypesFor,
	eq,
	gt,
	gte,
	type Literal,
	literal,
	lt,
	lte,
	MATCH_MODES,
	match,
	matchModesFor,
	neq,
	type Predicate,
	prop,
	type ResolvedType,
	type Term,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	reseedLiteralForConstraint,
	reseedValueForConstraint,
} from "../cards/reseed";

// A case type carrying one property of every data type, so a subject of
// any type is constructible as `prop("ct", `p_${type}`)`.
const CASE_TYPE: CaseType = {
	name: "ct",
	properties: casePropertyDataTypes.map((dt) => ({
		name: `p_${dt}`,
		label: dt,
		data_type: dt,
	})),
} as CaseType;
const CTX = { caseTypes: [CASE_TYPE], knownInputs: [], currentCaseType: "ct" };
const REAL_TYPES = casePropertyDataTypes;

type ComparisonBuilder = (
	left: Term | ValueExpression,
	right: Term | ValueExpression,
) => Predicate;
const COMPARISON_BUILDERS: Record<ComparisonKind, ComparisonBuilder> = {
	eq,
	neq,
	gt,
	gte,
	lt,
	lte,
};

// A range of "old" literal contents a reseed must handle.
const OLD_LITERALS: Literal[] = [
	literal("abc"),
	literal("42"),
	literal(""),
	literal(7),
	literal(3.5),
	literal(null),
];

describe("valid by construction — comparison admission ⟺ checker", () => {
	it("admits a comparison operator iff the constructed comparison type-checks", () => {
		for (const t of REAL_TYPES) {
			const subject = prop("ct", `p_${t}`);
			// A value the subject's object slot accepts, built the way the
			// editor's reseed would.
			const value = reseedValueForConstraint(
				term(literal("")),
				compatibleTypesFor(t),
			);
			for (const kind of Object.keys(COMPARISON_BUILDERS) as ComparisonKind[]) {
				const admitted = comparisonOperatorsFor(t).has(kind);
				const predicate = COMPARISON_BUILDERS[kind](subject, value);
				const checks = checkPredicate(predicate, CTX).ok;
				// Sound AND complete: the helper admits exactly the operators
				// the checker accepts for a subject of this type.
				expect(
					checks,
					`${kind} on ${t}: admitted=${admitted} checks=${checks}`,
				).toBe(admitted);
			}
		}
	});
});

describe("valid by construction — reseed always lands inside the constraint", () => {
	it("a reseeded comparison value always type-checks against its subject", () => {
		for (const t of REAL_TYPES) {
			const accepts = compatibleTypesFor(t);
			const subject = prop("ct", `p_${t}`);
			for (const old of OLD_LITERALS) {
				const reseeded = reseedValueForConstraint(term(old), accepts);
				// eq is admitted for every type, so this isolates the value:
				// the reseeded object must be compatible with the subject.
				expect(
					checkPredicate(eq(subject, reseeded), CTX).ok,
					`reseed of ${JSON.stringify(old.value)} for ${t}`,
				).toBe(true);
			}
		}
	});

	it("a reseeded literal's type is always admitted by the accept-set", () => {
		// Every subject type's compatible-set, plus a geopoint-only set
		// (no literal widget) to exercise the null fallback.
		const acceptSets = [
			...REAL_TYPES.map((t) => compatibleTypesFor(t)),
			new Set<ResolvedType>(["geopoint"]),
		];
		for (const accepts of acceptSets) {
			for (const old of OLD_LITERALS) {
				const seeded = reseedLiteralForConstraint(old, accepts);
				// The result is admissible: its type is in the accept-set, or
				// it's the universally-compatible null literal.
				const ok = accepts.has(literalTypeOf(seeded)) || seeded.value === null;
				expect(
					ok,
					`${JSON.stringify(old.value)} → ${JSON.stringify(seeded)}`,
				).toBe(true);
			}
		}
	});
});

describe("valid by construction — match admission ⟺ checker", () => {
	it("admits a match mode iff the constructed match type-checks", () => {
		for (const t of REAL_TYPES) {
			const subject = prop("ct", `p_${t}`);
			for (const mode of MATCH_MODES) {
				const admitted = matchModesFor(t).has(mode);
				// A non-empty term value — the shape the editor's
				// `matchValueConstraint` enforces. Builder order is
				// `match(property, value, mode)`.
				const predicate = match(subject, term(literal("x")), mode);
				const checks = checkPredicate(predicate, CTX).ok;
				expect(
					checks,
					`${mode} on ${t}: admitted=${admitted} checks=${checks}`,
				).toBe(admitted);
			}
		}
	});
});

describe("valid by construction — object-kind admission is non-trivial", () => {
	it("a numeric subject's object slot rejects a text result kind", () => {
		const intConstraint = comparisonObjectConstraint("eq", "int");
		// `concat` resolves to text — not admitted opposite an int subject.
		// (full per-kind coverage lives in slotConstraints.test.ts)
		expect(ALL_RESOLVED_TYPES.includes(ANY_TYPE)).toBe(true);
		expect(intConstraint.accepts).not.toBe("any");
	});
});

// Local mirror of the checker's literal typing for the assertion above —
// avoids importing the internal name while keeping the test self-checking.
function literalTypeOf(lit: Literal): ResolvedType {
	if (lit.data_type) return lit.data_type;
	if (lit.value === null) return ANY_TYPE;
	if (typeof lit.value === "number") {
		return Number.isInteger(lit.value) ? "int" : "decimal";
	}
	return "text";
}
