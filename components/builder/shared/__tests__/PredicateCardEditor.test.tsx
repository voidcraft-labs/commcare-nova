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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	type CheckError,
	checkPredicate,
	eq,
	exists,
	gt,
	literal,
	type Predicate,
	prop,
	relationStep,
} from "@/lib/domain/predicate";
import { presentCheckErrorForEditor } from "../checkErrorPresentation";
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
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
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
		expect(screen.getByText("Choose available case information")).toBeTruthy();
		expect(screen.queryByText(/Unknown property/)).toBeNull();
	});
});

describe("PredicateCardEditor — user-facing diagnostics", () => {
	it.each([
		[
			"property",
			{ code: "unknown-property", path: ["left"] },
			"Choose available case information",
		],
		[
			"value type",
			{ code: "incompatible-values", path: ["right"] },
			"Choose values that use compatible kinds of information",
		],
		[
			"search question",
			{ code: "unknown-search-input", path: ["input"] },
			"Choose an available Search field",
		],
		[
			"relationship",
			{ code: "relation-path", path: ["via"] },
			"Choose an available connection to another case",
		],
		[
			"relationship destination",
			{ code: "relation-destination", path: ["via"] },
			"Choose a connection that leads to an available kind of case",
		],
		[
			"matching property",
			{ code: "match-value", path: ["property"] },
			"Choose other case information or a different matching method",
		],
		[
			"empty matching value",
			{ code: "match-value-empty", path: ["value"] },
			"Enter a value to match",
		],
	] as const)(
		"presents a next action for %s errors",
		(_label, finding, copy) => {
			const error: CheckError = {
				code: finding.code,
				path: [...finding.path],
				message: "Detailed checker prose that must stay out of the UI",
			};
			expect(presentCheckErrorForEditor(error)).toBe(copy);
		},
	);

	it.each([
		[["property"], "Choose available case information"],
		[["input"], "Choose an available Search field"],
		[["via"], "Choose an available connection to another case"],
		[["right"], "Choose a value that works here"],
	] as const)(
		"keeps a path-specific next action for an unknown diagnostic at %j",
		(path, copy) => {
			const futureError = {
				path: [...path],
				code: "future-checker-category",
				message: "Raw future checker detail",
			} as unknown as CheckError;
			expect(presentCheckErrorForEditor(futureError)).toBe(copy);
		},
	);
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

describe("PredicateCardEditor — readable choice menus", () => {
	it("wraps complete condition and value-source guidance instead of clipping it", () => {
		render(
			<PredicateCardEditor
				value={eq(prop("patient", "status"), literal("active"))}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Condition is" }));
		let popup = document.querySelector<HTMLElement>(
			'[data-slot="dropdown-menu-popup"]',
		);
		expect(popup).not.toBeNull();
		expect(popup?.querySelector(".truncate")).toBeNull();
		for (const item of popup?.querySelectorAll(
			'[data-slot="dropdown-menu-item"]',
		) ?? []) {
			expect(item.className).toContain("whitespace-normal");
		}

		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		fireEvent.click(screen.getByRole("button", { name: /^Value source:/ }));
		popup = document.querySelector<HTMLElement>(
			'[data-slot="dropdown-menu-popup"]',
		);
		expect(popup).not.toBeNull();
		expect(popup?.querySelector(".truncate")).toBeNull();
		for (const item of popup?.querySelectorAll(
			'[data-slot="dropdown-menu-item"]',
		) ?? []) {
			expect(item.className).toContain("whitespace-normal");
		}
	});

	it("seeds date adjustment with date and time in a datetime slot", async () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={eq(prop("patient", "last_seen"), literal(null))}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /^Value source:/ }));
		const adjustDate = await screen.findByRole("menuitem", {
			name: /^Adjust a date/i,
		});
		// Base UI schedules initial focus in a microtask. Let the menu finish
		// opening before choosing an item, otherwise opening the confirmation
		// dialog in the same turn strands the menu focus task at test teardown.
		await Promise.resolve();
		fireEvent.click(adjustDate);
		const replace = await screen.findByRole("button", { name: "Replace" });
		// The confirmation dialog has the same initial-focus contract.
		await Promise.resolve();
		fireEvent.click(replace);
		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		// Base UI releases its scroll lock on a zero-delay timeout after the
		// dialog unmounts; drain that owned cleanup before the leak gate samples.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const next = onChange.mock.calls[0][0] as Predicate;
		expect(next.kind).toBe("eq");
		if (next.kind !== "eq") throw new Error("Expected equality");
		expect(next.right.kind).toBe("date-add");
		if (next.right.kind !== "date-add") throw new Error("Expected date-add");
		expect(next.right.date.kind).toBe("now");
		expect(
			checkPredicate(next, {
				caseTypes: CASE_TYPES,
				knownInputs: [],
				currentCaseType: "patient",
			}).ok,
		).toBe(true);
	});
});
