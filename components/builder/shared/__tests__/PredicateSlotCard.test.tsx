// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/PredicateSlotCard.test.tsx
//
// PredicateSlotCard composition tests — pin the public contract of
// the optional-Predicate slot primitive that FiltersSection and
// ClaimSection both consume:
//
//   - Slot-empty state surfaces the "Add ..." dashed CTA; the
//     "Clear ..." button is absent.
//   - Slot-populated state surfaces the inner editor + the "Clear ..."
//     button; the "Add ..." CTA is absent.
//   - Add affordance: undefined → defined seeds `match-all()`.
//   - Clear affordance: defined → undefined.
//   - Validity propagation: an invalid populated predicate flips
//     valid: false; clearing the slot flips back to true even with
//     the stale-shadow path active (slot-presence short-circuit).

import tablerFilter from "@iconify-icons/tabler/filter";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	eq,
	gt,
	literal,
	matchAll,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";
import { PredicateSlotCard } from "../PredicateSlotCard";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "status", label: "Status", data_type: "text" },
	],
};
const CASE_TYPES = [PATIENT];

// Common props shape — every test renders against these unless it
// overrides a slot. Centralizes the test-side defaults so a future
// prop addition has one place to update.
const baseProps = {
	icon: tablerFilter,
	title: "Filter",
	description: "Always-on predicate that narrows the case list.",
	addLabel: "Add filter",
	clearLabel: "Clear filter",
	caseTypes: CASE_TYPES,
	currentCaseType: "patient",
} as const;

// ── Slot-empty state ──────────────────────────────────────────────

describe("PredicateSlotCard — slot empty", () => {
	it("surfaces the Add CTA and hides the Clear button", () => {
		render(
			<PredicateSlotCard
				{...baseProps}
				value={undefined}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByLabelText(/^add filter$/i)).toBeDefined();
		expect(screen.queryByLabelText(/^clear filter$/i)).toBeNull();
	});

	it("emits match-all() seed when the Add CTA is clicked", () => {
		const onChange = vi.fn<(next: Predicate | undefined) => void>();
		render(
			<PredicateSlotCard
				{...baseProps}
				value={undefined}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByLabelText(/^add filter$/i));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({ kind: "match-all" });
	});
});

// ── Slot-populated state ──────────────────────────────────────────

describe("PredicateSlotCard — slot populated", () => {
	it("surfaces the Clear button and hides the Add CTA when the slot is defined", () => {
		const populated: Predicate = eq(
			prop("patient", "status"),
			literal("active"),
		);
		render(
			<PredicateSlotCard
				{...baseProps}
				value={populated}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByLabelText(/^clear filter$/i)).toBeDefined();
		expect(screen.queryByLabelText(/^add filter$/i)).toBeNull();
	});

	it("emits undefined when Clear is clicked", () => {
		const populated: Predicate = matchAll();
		const onChange = vi.fn<(next: Predicate | undefined) => void>();
		render(
			<PredicateSlotCard
				{...baseProps}
				value={populated}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByLabelText(/^clear filter$/i));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(undefined);
	});
});

// ── Validity propagation ──────────────────────────────────────────

describe("PredicateSlotCard — validity", () => {
	it("reports valid: true when the slot is undefined", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<PredicateSlotCard
				{...baseProps}
				value={undefined}
				onChange={() => {}}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("reports valid: true when the slot is a well-typed predicate", () => {
		const populated: Predicate = eq(
			prop("patient", "status"),
			literal("active"),
		);
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<PredicateSlotCard
				{...baseProps}
				value={populated}
				onChange={() => {}}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("reports valid: false when the slot is a type-mismatch comparison", () => {
		// `gt(int, "string")` is rejected by the predicate type
		// checker — the inner editor's onValidityChange flows through
		// the card to its onValidityChange prop.
		const populated: Predicate = gt(prop("patient", "age"), literal("string"));
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<PredicateSlotCard
				{...baseProps}
				value={populated}
				onChange={() => {}}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("flips back to valid: true on transition from defined-invalid to undefined", () => {
		// Pins the slot-presence short-circuit on the cleared path.
		// When an invalid predicate is cleared, the card MUST report
		// valid: true even though the inner shadow may still carry
		// the pre-clear false.
		const invalid: Predicate = gt(prop("patient", "age"), literal("string"));
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		const { rerender } = render(
			<PredicateSlotCard
				{...baseProps}
				value={invalid}
				onChange={() => {}}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);

		rerender(
			<PredicateSlotCard
				{...baseProps}
				value={undefined}
				onChange={() => {}}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});
