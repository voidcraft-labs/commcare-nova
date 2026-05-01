// lib/domain/predicate/__tests__/typeChecker.test.ts
//
// Acceptance tests for the schema-driven predicate type checker. Each
// `it` pins one operand-type rule by constructing a small predicate via
// the builders and asserting the type checker's verdict on it. The
// fixtures double as documentation for the rules themselves —
// changing an `it.each` row or message regex should be a deliberate
// signal that the rule changed at the code layer.
//
// This file lands the comparison-operator coverage. Logical, membership,
// geo, fuzzy, and when-input-present operators get their tests appended
// in subsequent tasks.

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { eq, gt, input, literal, lt, prop } from "../builders";
import { checkPredicate } from "../typeChecker";

// Single fixture reused across every test. Includes one property of each
// of the four data-type families exercised by the comparison-rule
// matrix: text (unordered), int (ordered numeric), date (ordered
// temporal), and single_select (string-coerced, with options).
const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{
			name: "status",
			label: "Status",
			data_type: "single_select",
			options: [
				{ value: "open", label: "Open" },
				{ value: "closed", label: "Closed" },
			],
		},
	],
};

// Default context — no declared search inputs. Tests that exercise
// input-ref behavior shadow `knownInputs` locally so the default fixture
// stays readable.
const ctx = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
	knownInputs: [],
};

describe("checkPredicate — comparison operators", () => {
	it("accepts int = int", () => {
		const p = eq(prop("patient", "age"), literal(42));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(true);
	});

	it("accepts text = text", () => {
		const p = eq(prop("patient", "name"), literal("Alice"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(true);
	});

	it("rejects int = string-literal mismatch", () => {
		const p = eq(prop("patient", "age"), literal("forty-two"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	it("accepts gt on int", () => {
		const p = gt(prop("patient", "age"), literal(18));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects gt on text (strings aren't ordered)", () => {
		const p = gt(prop("patient", "name"), literal("M"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/not ordered/i);
		}
	});

	it("accepts lt on date", () => {
		const p = lt(prop("patient", "dob"), literal("2000-01-01"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects an unknown property reference", () => {
		const p = eq(prop("patient", "bogus"), literal("x"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown property/i);
			// Pin the path-tracking contract: a top-level `eq` whose left
			// term fails to resolve must carry a `["left"]` path so the
			// editor can highlight the offending operand. Pinned in this
			// one negative test (rather than every one) because the path
			// shape is structural — it's set by `resolveTermType`'s
			// caller, not per-error — and locking it once is sufficient.
			expect(result.errors[0].path).toEqual(["left"]);
		}
	});

	it("rejects an unknown case type reference", () => {
		const p = eq(prop("alien_type", "x"), literal("y"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown case type/i);
		}
	});

	it("accepts input ref against int prop when input is declared", () => {
		const ctxWithInput = {
			...ctx,
			knownInputs: [
				{ kind: "input", name: "min_age", data_type: "int" } as const,
			],
		};
		const p = gt(prop("patient", "age"), input("min_age"));
		expect(checkPredicate(p, ctxWithInput).ok).toBe(true);
	});

	it("rejects input ref when input isn't declared", () => {
		const p = gt(prop("patient", "age"), input("undeclared"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown search input/i);
		}
	});
});
