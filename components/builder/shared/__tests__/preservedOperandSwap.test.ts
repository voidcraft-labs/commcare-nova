import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	eq,
	exists,
	literal,
	prop,
	relationStep,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	buildPredicateKindReplacement,
	preservedOperandSwap,
} from "../cards/ChildPredicateEditor";
import type { PredicateEditContext } from "../editorSchemas";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [
		{ name: "region", label: proseText("Region"), data_type: "text" },
	],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "case_name", label: proseText("Case name"), data_type: "text" },
	],
};
const CASE_TYPES: readonly CaseType[] = [HOUSEHOLD, PATIENT];

// The exact `PredicateEditContext` `KindReplaceMenu` assembles from
// the surrounding `PredicateEditProvider`: case-type schema, the
// current scope, and the available search inputs (`knownInputs`,
// defaulted to `[]` by `PredicateCardEditor` when none are passed). We
// replicate the whole shape so the direct calls match what the menu
// passes its reset factories: `betweenDefault` and friends require a
// full `PredicateEditContext` even though they happen not to read
// `knownInputs`.
const EDIT_CTX: PredicateEditContext = {
	caseTypes: CASE_TYPES,
	currentCaseType: "patient",
	knownInputs: [],
	caseDataScope: "per-case",
};

describe("preservedOperandSwap — comparison ↔ comparison", () => {
	it("eq → lt preserves left and right operands verbatim", () => {
		const left = term(prop("patient", "age"));
		const right = term(literal(18));
		// Comparison twins share `{ left, right }`: switching the
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
		// Relational-quantifier twins share `{ via, where? }`: both
		// operands carry over verbatim to the target kind.
		const next = preservedOperandSwap(exists(via, where), "missing");
		expect(next).toEqual({ kind: "missing", via, where });
	});

	it("exists(via) without where → missing preserves via and omits the where key", () => {
		const via = ancestorPath(relationStep("parent"));
		// Absent-not-undefined contract: when the source has no `where`,
		// the swap calls `missing(via)` (not `missing(via, undefined)`),
		// producing a result with NO `where` key: matching the schema's
		// `.optional()` strip behavior on parse. `toEqual` alone treats
		// absent and `undefined` identically, so the explicit `in` check
		// is load-bearing here.
		const next = preservedOperandSwap(exists(via), "missing");
		expect(next).toEqual({ kind: "missing", via });
		expect(next).not.toBeNull();
		expect(next).toStrictEqual({ kind: "missing", via });
	});
});

describe("preservedOperandSwap — and ↔ or", () => {
	it("and([p1, p2, p3]) → or preserves the three clauses verbatim", () => {
		const p1 = eq(prop("patient", "age"), literal(18));
		const p2 = eq(prop("patient", "case_name"), literal("Alice"));
		const p3 = eq(prop("patient", "case_name"), literal("Bob"));
		// Logical-group twins share `{ clauses }`: switching the
		// discriminator routes through the target's variadic builder and
		// preserves the author's clause list verbatim.
		const next = preservedOperandSwap(and(p1, p2, p3), "or");
		expect(next).toEqual({ kind: "or", clauses: [p1, p2, p3] });
	});
});

describe("preservedOperandSwap — non-twin transitions reset to default", () => {
	it("eq → between yields null (no twin) and resets to a fresh `between`", () => {
		// `eq`'s `{ left, right }` doesn't map onto `between`'s
		// `{ left, lower?, upper?, lowerInclusive, upperInclusive }`, so
		// the swap returns `null`: proving no operand carry-over.
		const swap = preservedOperandSwap(
			eq(prop("patient", "age"), literal(18)),
			"between",
		);
		expect(swap).toBeNull();

		// Execute the real menu planner rather than reconstructing its fallback.
		const reset = buildPredicateKindReplacement(
			eq(prop("patient", "age"), literal(18)),
			"between",
			EDIT_CTX,
		);
		expect(reset.kind).toBe("between");
		if (reset.kind !== "between") throw new Error("Expected between reset");
		expect(reset.lower).toBeDefined();
		expect(reset.upper).toBeDefined();
	});
});
