// @vitest-environment happy-dom
//
// components/builder/case-search-config/__tests__/ClaimSection.test.tsx
//
// ClaimSection composition tests — pin the public contract of the
// three sub-controls + the section's validity aggregation:
//
//   - Round-trip: mount with a fully-populated config and verify the
//     three sub-controls render the expected initial state.
//   - Toggle persistence: clicking the don't-claim-already-owned
//     toggle fires onChange with the flipped boolean (and seeds the
//     required default when the section starts undefined).
//   - Blacklist collapse default: the blacklist body is hidden on
//     first render; the header click reveals it.
//   - Validity propagation: an invalid claim-condition predicate
//     flips the section's verdict to false; an invalid blacklist
//     ValueExpression does the same.
//
// Mock surface: ClaimSection imports `useValidityPropagator` from the
// case-list-config sibling and the `PredicateCardEditor` /
// `ExpressionCardEditor` primitives — none of which open Server
// Actions or doc-store reads. The test setup needs no module mocks
// beyond the standard happy-dom environment.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import {
	gt,
	literal,
	matchAll,
	prop,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { ClaimSection } from "../ClaimSection";

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

// Fully-populated baseline. `data_type` is intentionally omitted on
// the literal — the schema treats it as optional and the
// `caseSearchConfigSchema` round-trip test in `modules.test.ts` uses
// the same shape.
const POPULATED_CONFIG: CaseSearchConfig = {
	claimCondition: matchAll(),
	dontClaimAlreadyOwned: true,
	blacklistedOwnerIds: term(literal("owner-a owner-b")),
};

// ── Round-trip ────────────────────────────────────────────────────

describe("ClaimSection — round-trip", () => {
	it("mounts with a populated config and surfaces all three sub-controls in the expected initial state", () => {
		render(
			<ClaimSection
				value={POPULATED_CONFIG}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Claim condition slot is populated → the "Add claim condition"
		// affordance is hidden, the "Clear" affordance is visible.
		expect(screen.queryByLabelText(/^add claim condition$/i)).toBeNull();
		expect(screen.getByLabelText(/^clear claim condition$/i)).toBeDefined();

		// Toggle row reflects `dontClaimAlreadyOwned: true`. The shared
		// `Toggle` primitive renders as `role="switch"` + `aria-checked`.
		const toggle = screen.getByRole("switch");
		expect(toggle.getAttribute("aria-checked")).toBe("true");

		// Blacklist defaults to collapsed-closed even when the slot
		// is populated — the editor body stays mounted (so its
		// validity verdict keeps firing) but visually hidden via the
		// `hidden` attribute on the wrapper. The "Clear blacklisted
		// owner IDs" affordance lives inside the body; we read its
		// nearest ancestor with the `hidden` attribute as the
		// collapse signal.
		const clearButton = screen.getByLabelText(
			/^clear blacklisted owner ids$/i,
			{ selector: "button" },
		);
		const collapseWrapper = clearButton.closest("[hidden]");
		expect(collapseWrapper).not.toBeNull();
	});
});

// ── Toggle persistence ────────────────────────────────────────────

describe("ClaimSection — toggle persistence", () => {
	it("fires onChange with the flipped boolean when the toggle is clicked", () => {
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<ClaimSection
				value={{ dontClaimAlreadyOwned: false }}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const toggle = screen.getByRole("switch");
		fireEvent.click(toggle);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			dontClaimAlreadyOwned: true,
		});
	});

	it("seeds caseSearchConfig on first edit when the section starts undefined", () => {
		// Pins the seed pattern: the panel may receive a module without
		// `caseSearchConfig`, and the first edit MUST emit a config
		// that satisfies the schema's required `dontClaimAlreadyOwned`.
		// Without the seed, the parent would get a partial object that
		// fails strict parse.
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<ClaimSection
				value={undefined}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const toggle = screen.getByRole("switch");
		fireEvent.click(toggle);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			dontClaimAlreadyOwned: true,
		});
	});
});

// ── Blacklist collapse default ────────────────────────────────────

describe("ClaimSection — blacklist collapse", () => {
	it("hides the blacklist editor body on first render and reveals it after the header click", () => {
		const blacklistValue: ValueExpression = term(literal("owner-a"));
		render(
			<ClaimSection
				value={{
					dontClaimAlreadyOwned: false,
					blacklistedOwnerIds: blacklistValue,
				}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Header collapse toggle exists; aria-expanded reads false.
		const collapseHeader = screen.getByRole("button", {
			expanded: false,
			name: /blacklisted owner ids/i,
		});
		expect(collapseHeader).toBeDefined();

		// Editor body is mounted (the editor stays mounted across
		// collapse toggles so its type-check verdict keeps firing)
		// but visually hidden via the wrapper's `hidden` attribute.
		// We confirm the collapsed state by walking up from the
		// body's "Clear" button to its nearest ancestor carrying
		// `hidden`.
		const clearButton = screen.getByLabelText(
			/^clear blacklisted owner ids$/i,
			{ selector: "button" },
		);
		expect(clearButton.closest("[hidden]")).not.toBeNull();

		// Click the header → state flips to expanded; the wrapper
		// no longer carries `hidden`.
		fireEvent.click(collapseHeader);
		expect(clearButton.closest("[hidden]")).toBeNull();
	});
});

// ── Validity propagation ──────────────────────────────────────────

describe("ClaimSection — validity propagation", () => {
	it("reports valid: true when both slots are absent", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<ClaimSection
				value={{ dontClaimAlreadyOwned: false }}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("reports valid: false when the claim condition has a type-mismatch comparison", () => {
		// `gt(int, "string")` is rejected by the predicate type
		// checker — the editor's onValidityChange flows the verdict
		// to ClaimSection, which forwards to its parent.
		const invalidPredicate = gt(prop("patient", "age"), literal("string"));
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<ClaimSection
				value={{
					dontClaimAlreadyOwned: false,
					claimCondition: invalidPredicate,
				}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("reports valid: false when the blacklist references an unknown property — even with the collapse closed", () => {
		// `term(prop("patient", "DOES_NOT_EXIST"))` — the expression
		// type checker rejects unknown property references. Pins
		// the load-bearing decision that collapse is a VISIBILITY
		// toggle, not a mount toggle: a backend-loaded invalid
		// blacklist expression renders into the default-collapsed
		// section, but its type-check pass still runs and the
		// section's validity verdict propagates. Without the
		// keep-mounted contract, the section would silently report
		// `valid: true` while the user's blacklist held an invalid
		// expression — a save-gate desync.
		const invalidExpression: ValueExpression = term(
			prop("patient", "DOES_NOT_EXIST"),
		);
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<ClaimSection
				value={{
					dontClaimAlreadyOwned: false,
					blacklistedOwnerIds: invalidExpression,
				}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);

		// No collapse-open click — the editor is mounted under the
		// hidden body and emits its verdict regardless.
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("reports valid: true after the claim condition is cleared even when the prior state was invalid", () => {
		// Pins the slot-presence short-circuit on the claim-condition
		// arm: when an invalid predicate is cleared, the section MUST
		// flip back to valid: true even though the inner shadow may
		// still carry the pre-clear `false`. Without the short-
		// circuit, the cleared state would leak the inner `false`
		// until the (unmounted) editor's first verdict landed —
		// which never happens because the editor isn't mounted on
		// the cleared state.
		const invalidPredicate = gt(prop("patient", "age"), literal("string"));
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		const { rerender } = render(
			<ClaimSection
				value={{
					dontClaimAlreadyOwned: false,
					claimCondition: invalidPredicate,
				}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);

		rerender(
			<ClaimSection
				value={{ dontClaimAlreadyOwned: false }}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});
