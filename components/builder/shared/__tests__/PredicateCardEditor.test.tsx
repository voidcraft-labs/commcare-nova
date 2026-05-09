// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/PredicateCardEditor.test.tsx
//
// Top-level editor tests. Exercises the integration of the type
// checker, the validity-index plumbing, the registry-driven
// dispatch, and the recursive shell. The card bodies' visual
// chrome is covered by the per-card smoke tests; this file pins
// the editor's structural contract — what reaches the parent's
// `onChange` / `onValidityChange`, and how nested errors land on
// the right card.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	eq,
	exists,
	gt,
	literal,
	type Predicate,
	prop,
	relationStep,
} from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../PredicateCardEditor";

// ── Fixtures ───────────────────────────────────────────────────────────

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "status", label: "Status", data_type: "text" },
	],
};
const CASE_TYPES = [HOUSEHOLD, PATIENT];

describe("PredicateCardEditor — validity propagation", () => {
	it("reports valid for a well-typed predicate", () => {
		const value = eq(prop("patient", "status"), literal("active"));
		const onValidityChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("reports invalid when a comparison's operands disagree on type", () => {
		// `gt(int, "string")` is rejected by the type checker —
		// the editor surfaces the verdict to the parent so save
		// can be disabled. The card itself shows the diagnostic
		// inline via the validity-index lookup.
		const value = gt(prop("patient", "age"), literal("string"));
		const onValidityChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});

	it("reports invalid for an unknown property", () => {
		const value = eq(prop("patient", "DOES_NOT_EXIST"), literal("x"));
		const onValidityChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});
});

describe("PredicateCardEditor — recursive nesting", () => {
	it("renders an exists card with a nested where predicate without throwing", () => {
		// The editor flips `currentCaseType` inside the where
		// clause to the relation walk's destination
		// (`household` for an ancestor walk via `parent`). The
		// nested clause's property reference resolves against
		// the destination scope.
		const value = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const onValidityChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(container).toBeTruthy();
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("nested clause errors do not bubble up to the parent's operator-level path", () => {
		// `where`'s scope-pin contract: a property reference inside
		// `exists.where` must use the destination scope. Naming the
		// originating scope is rejected by the type checker and the
		// editor reports invalid to the parent, but the operator-
		// level error attaches to the nested clause's path, not the
		// outer exists card. This test exercises that the editor
		// renders both cards without throwing — the detailed path
		// shape is covered by `path.test.ts` and the type checker's
		// own tests.
		const value = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("patient", "status"), literal("active")),
		);
		const onValidityChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});
});

describe("PredicateCardEditor — and/or grouping", () => {
	it("renders an and-group with two clauses", () => {
		const value: Predicate = and(
			eq(prop("patient", "status"), literal("active")),
			gt(prop("patient", "age"), literal(18)),
		);
		const onValidityChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(container).toBeTruthy();
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});
});
