// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/preservedOperandSwap.test.tsx
//
// Operand-preserving kind-replace tests. The outer "Change" menu
// in `ChildPredicateEditor` flips a card's kind via two
// strategies:
//
//   1. **Operand-preserving swap** — when the source and target
//      kinds share an identical operand shape (one of the four
//      structural-twin pairs), the AST's operands carry over
//      verbatim. The same result the in-card `KindMenu` produces
//      for `exists` ↔ `missing`.
//   2. **Default-value reset** — for non-twin transitions
//      (`eq` → `between`, etc.), the target schema's
//      `defaultValue(...)` factory builds a fresh predicate.
//
// These tests interact with the real "Change" menu in the
// rendered UI: open the menu, click the target kind, capture the
// resulting onChange call, and assert the AST shape. Compares
// against AST shape, not rendered output.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
import { PredicateCardEditor } from "../PredicateCardEditor";

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
const CASE_TYPES = [HOUSEHOLD, PATIENT];

/** Escape regex metacharacters so the caller can pass plain
 *  registry-description strings without thinking about regex syntax. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Open the outer "Change" menu and click the option whose
 *  description matches `targetDescription`. Targets the registry
 *  entry's `description` field (the second line in each menu
 *  item's body) rather than the `label` because labels share
 *  prefixes — `Less than` is a prefix of `Less than or equal`,
 *  `Any of` is a prefix of `Any of (OR)` chiclets in the addClause
 *  menu, etc. Descriptions are unique per registry entry by
 *  construction.
 *
 *  Returns the next AST emitted via `onChange`. */
function openChangeMenuAndPick(
	onChange: ReturnType<typeof vi.fn>,
	targetDescription: string,
): unknown {
	// Each card carries one Change trigger ("Change") and possibly
	// one inner kind menu (e.g. ExistsCard's "Has"/"No"). Pick the
	// first; ChildPredicateEditor mounts the outer menu first.
	const changeTriggers = screen.getAllByRole("button", {
		name: /change card type/i,
	});
	fireEvent.click(changeTriggers[0]);
	// The menu item's accessible name is the concatenation of its
	// label and description (CardShell renders both as inline text
	// nodes inside the Menu.Item). Matching on the description
	// substring picks the right item even when labels collide on
	// shared prefixes.
	const pattern = new RegExp(escapeRegex(targetDescription), "i");
	const targetItem = screen.getByRole("menuitem", { name: pattern });
	fireEvent.click(targetItem);
	expect(onChange).toHaveBeenCalledTimes(1);
	return onChange.mock.calls[0][0];
}

describe("preservedOperandSwap — comparison ↔ comparison", () => {
	it("eq → lt preserves left and right operands verbatim", () => {
		const left = term(prop("patient", "age"));
		const right = term(literal(18));
		const value = eq(left, right);
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const next = openChangeMenuAndPick(
			onChange,
			"Property is less than a value",
		);
		expect(next).toEqual({ kind: "lt", left, right });
	});
});

describe("preservedOperandSwap — exists ↔ missing", () => {
	it("exists(via, where) → missing preserves both via and where", () => {
		const via = ancestorPath(relationStep("parent"));
		const where = eq(prop("household", "region"), literal("north"));
		const value = exists(via, where);
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const next = openChangeMenuAndPick(
			onChange,
			"No related case satisfies a condition",
		);
		expect(next).toEqual({ kind: "missing", via, where });
	});

	it("exists(via) without where → missing preserves via and omits the where key", () => {
		const via = ancestorPath(relationStep("parent"));
		const value = exists(via);
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const next = openChangeMenuAndPick(
			onChange,
			"No related case satisfies a condition",
		);
		// Absent-not-undefined: the result has no `where` key at all,
		// matching the schema's `.optional()` strip behavior on
		// parse. Using `toEqual` plus the `in` check — `toEqual`
		// alone treats absent and undefined identically.
		expect(next).toEqual({ kind: "missing", via });
		expect("where" in (next as object)).toBe(false);
	});
});

describe("preservedOperandSwap — and ↔ or", () => {
	it("and([p1, p2, p3]) → or preserves the three clauses verbatim", () => {
		const p1 = eq(prop("patient", "age"), literal(18));
		const p2 = eq(prop("patient", "name"), literal("Alice"));
		const p3 = eq(prop("patient", "name"), literal("Bob"));
		const value = and(p1, p2, p3);
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const next = openChangeMenuAndPick(
			onChange,
			"At least one nested clause must match",
		);
		expect(next).toEqual({ kind: "or", clauses: [p1, p2, p3] });
	});
});

describe("preservedOperandSwap — is-null ↔ is-blank", () => {
	it("is-blank(prop) → is-null preserves left", () => {
		const left = term(prop("patient", "name"));
		const value = isBlank(left);
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const next = openChangeMenuAndPick(onChange, "Property is absent (strict");
		expect(next).toEqual({ kind: "is-null", left });
	});
});

describe("preservedOperandSwap — non-twin transitions reset to default", () => {
	it("eq → between resets to a fresh `between` (no operand carry-over)", () => {
		const value = eq(prop("patient", "age"), literal(18));
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const next = openChangeMenuAndPick(
			onChange,
			"Property falls within a range",
		);
		// `eq → between` falls through to `betweenDefault(ctx)` —
		// the result's `kind` is `between` and the operand shape is
		// the default factory's, NOT the source's `{ left, right }`
		// carried over. We only assert on `kind` and the presence of
		// `lower` / `upper`; the precise default content lives at
		// the `betweenDefault` factory and changes there should not
		// flake this test.
		expect((next as { kind: string }).kind).toBe("between");
		expect((next as { lower?: unknown }).lower).toBeDefined();
		expect((next as { upper?: unknown }).upper).toBeDefined();
	});
});
