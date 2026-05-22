// components/builder/shared/__tests__/preservedOperandSwap.test.tsx
//
// Unit tests for `preservedOperandSwap` — the pure kind-replace
// transformation in `ChildPredicateEditor`. Given a current
// Predicate and a target kind, the function returns either:
//
//   1. **Operand-preserving swap** — when the source and target
//      kinds share an identical operand shape (one of the four
//      structural-twin pairs: `and ↔ or`, `is-null ↔ is-blank`,
//      comparison ↔ comparison, `exists ↔ missing`), it rebuilds
//      the predicate under the target kind with the operands
//      carried over verbatim.
//   2. **`null`** — for every non-twin transition (`eq → between`,
//      etc.). The caller (`KindReplaceMenu.replaceWith`) then falls
//      through to the target schema's `defaultValue(ctx)` factory,
//      so a non-twin swap always rebuilds from scratch with no
//      operand carry-over.
//
// Why test the function directly instead of driving the rendered
// "Change" menu: the contract is the emitted AST shape, not the
// menu chrome. The menu is just one of two interchangeable callers
// of this transformation — `ExistsCard`'s in-card `KindMenu`
// produces the identical result for `exists ↔ missing`. Asserting
// on the pure transformation pins the contract both callers share
// without mounting a Base UI floating tree (which schedules
// microtask / rAF work that leaks under `--detect-async-leaks`).
//
// For the non-twin reset cases we replicate the component's real
// fall-through — `preservedOperandSwap(...) ?? schema.defaultValue(
// editCtx)` — by asserting `null` from the swap AND calling the same
// `predicateCardSchemas[target].defaultValue` factory the menu calls,
// with the `PredicateEditContext` the menu builds. This proves both
// halves of the contract: no twin carry-over, and the fresh shape
// the user actually sees after the reset.

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	eq,
	exists,
	isBlank,
	literal,
	prop,
	relationStep,
	term,
} from "@/lib/domain/predicate";
import { preservedOperandSwap } from "../cards/ChildPredicateEditor";
import {
	type PredicateEditContext,
	predicateCardSchemas,
} from "../editorSchemas";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "name", label: "Name", data_type: "text" },
	],
};
const CASE_TYPES: readonly CaseType[] = [HOUSEHOLD, PATIENT];

// The exact `PredicateEditContext` `KindReplaceMenu` assembles from
// the surrounding `PredicateEditProvider`: case-type schema, the
// current scope, and the available search inputs (`knownInputs`,
// defaulted to `[]` by `PredicateCardEditor` when none are passed). We
// replicate the whole shape so the direct calls match what the menu
// passes its reset factories — `betweenDefault` and friends require a
// full `PredicateEditContext` even though they happen not to read
// `knownInputs`.
const EDIT_CTX: PredicateEditContext = {
	caseTypes: CASE_TYPES,
	currentCaseType: "patient",
	knownInputs: [],
};

describe("preservedOperandSwap — comparison ↔ comparison", () => {
	it("eq → lt preserves left and right operands verbatim", () => {
		const left = term(prop("patient", "age"));
		const right = term(literal(18));
		// Comparison twins share `{ left, right }` — switching the
		// discriminator routes through the target's comparison builder
		// and carries both operands across untouched.
		const next = preservedOperandSwap(eq(left, right), "lt");
		expect(next).toEqual({ kind: "lt", left, right });
	});
});

describe("preservedOperandSwap — exists ↔ missing", () => {
	it("exists(via, where) → missing preserves both via and where", () => {
		const via = ancestorPath(relationStep("parent"));
		const where = eq(prop("household", "region"), literal("north"));
		// Relational-quantifier twins share `{ via, where? }` — both
		// operands carry over verbatim to the target kind.
		const next = preservedOperandSwap(exists(via, where), "missing");
		expect(next).toEqual({ kind: "missing", via, where });
	});

	it("exists(via) without where → missing preserves via and omits the where key", () => {
		const via = ancestorPath(relationStep("parent"));
		// Absent-not-undefined contract: when the source has no `where`,
		// the swap calls `missing(via)` (not `missing(via, undefined)`),
		// producing a result with NO `where` key — matching the schema's
		// `.optional()` strip behavior on parse. `toEqual` alone treats
		// absent and `undefined` identically, so the explicit `in` check
		// is load-bearing here.
		const next = preservedOperandSwap(exists(via), "missing");
		expect(next).toEqual({ kind: "missing", via });
		expect(next).not.toBeNull();
		expect("where" in (next as object)).toBe(false);
	});
});

describe("preservedOperandSwap — and ↔ or", () => {
	it("and([p1, p2, p3]) → or preserves the three clauses verbatim", () => {
		const p1 = eq(prop("patient", "age"), literal(18));
		const p2 = eq(prop("patient", "name"), literal("Alice"));
		const p3 = eq(prop("patient", "name"), literal("Bob"));
		// Logical-group twins share `{ clauses }` — switching the
		// discriminator routes through the target's variadic builder and
		// preserves the author's clause list verbatim.
		const next = preservedOperandSwap(and(p1, p2, p3), "or");
		expect(next).toEqual({ kind: "or", clauses: [p1, p2, p3] });
	});
});

describe("preservedOperandSwap — is-null ↔ is-blank", () => {
	it("is-blank(prop) → is-null preserves left", () => {
		const left = term(prop("patient", "name"));
		// Null/blank twins share `{ left }` — only the strict-vs-portable
		// absence semantic differs, so the operand carries over verbatim.
		const next = preservedOperandSwap(isBlank(left), "is-null");
		expect(next).toEqual({ kind: "is-null", left });
	});
});

describe("preservedOperandSwap — non-twin transitions reset to default", () => {
	it("eq → between yields null (no twin) and resets to a fresh `between`", () => {
		// `eq`'s `{ left, right }` doesn't map onto `between`'s
		// `{ left, lower?, upper?, lowerInclusive, upperInclusive }`, so
		// the swap returns `null` — proving no operand carry-over.
		const swap = preservedOperandSwap(
			eq(prop("patient", "age"), literal(18)),
			"between",
		);
		expect(swap).toBeNull();

		// Replicate the component's real fall-through:
		// `preservedOperandSwap(...) ?? schema.defaultValue(editCtx)`.
		// The user lands on a fresh `between` built by the target
		// schema's factory — `kind` is `between` and the operand shape
		// is the factory's, not the source's `{ left, right }`. We assert
		// `kind` and the presence of `lower` / `upper` only; the precise
		// default content lives in `betweenDefault` and may evolve there
		// without invalidating this contract.
		const reset = predicateCardSchemas.between.defaultValue(EDIT_CTX);
		expect(reset.kind).toBe("between");
		expect(reset.lower).toBeDefined();
		expect(reset.upper).toBeDefined();
	});
});
