// @vitest-environment happy-dom
//
// components/builder/case-search-config/__tests__/AdvancedSection.test.tsx
//
// AdvancedSection composition tests — pin the public contract of the
// niche-search-filter section. Today the section hosts a single sub-
// control (`blacklistedOwnerIds`); tests exercise the section through
// that slot:
//
//   - Empty state: an undefined config renders the collapsed header
//     only — no "Clear" button, no editor mounted.
//   - Add path: clicking the chevron toggle opens the body; clicking
//     Add seeds `term(literal(""))` and emits the next config.
//   - Round-trip with populated slot: the editor mounts inside a
//     collapsed body by default, but the Clear affordance lives in
//     the header at `ml-auto` (matching the canonical
//     `PredicateSlotCard` shape) so it stays one click away regardless
//     of collapse state.
//   - Validity propagation: an absent slot reports `valid: true`; an
//     invalid populated expression reports `valid: false` even when
//     the body is collapsed (mount-stays-on contract).
//   - Cross-slot preservation: editing the blacklist leaves unrelated
//     `caseSearchConfig` slots intact.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import {
	literal,
	prop,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { AdvancedSection } from "../AdvancedSection";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};
const CASE_TYPES = [PATIENT];

// ── Empty state ───────────────────────────────────────────────────

describe("AdvancedSection — empty state", () => {
	it("renders the collapsed header only when the slot is undefined", () => {
		render(
			<AdvancedSection
				value={undefined}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Chevron toggle is present and reads as collapsed.
		const toggle = screen.getByRole("button", {
			expanded: false,
			name: /^expand blacklisted owner ids$/i,
		});
		expect(toggle).toBeDefined();
		// Heading is rendered as a sibling, not as button text.
		expect(
			screen.getByRole("heading", { name: /exclude cases/i }),
		).toBeDefined();

		// No Clear / Add affordances surface — Clear renders in the
		// header only when the slot is defined; Add renders inside
		// the body only when collapse-open + slot undefined. A
		// regression that surfaced either would fire here.
		expect(
			screen.queryByLabelText(/^clear blacklisted owner ids$/i),
		).toBeNull();
		expect(screen.queryByLabelText(/^add blacklisted owner ids$/i)).toBeNull();
	});
});

// ── Add path ──────────────────────────────────────────────────────

describe("AdvancedSection — add path", () => {
	it("opens the collapse on chevron click and surfaces the Add affordance", () => {
		render(
			<AdvancedSection
				value={undefined}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				expanded: false,
				name: /^expand blacklisted owner ids$/i,
			}),
		);

		// Toggle now reads as expanded; Add affordance is visible.
		expect(
			screen.getByRole("button", {
				expanded: true,
				name: /^collapse blacklisted owner ids$/i,
			}),
		).toBeDefined();
		expect(screen.getByLabelText(/^add blacklisted owner ids$/i)).toBeDefined();
	});

	it('seeds caseSearchConfig with `term(literal(""))` when Add is clicked from an undefined section', () => {
		// Pins the first-edit contract: the panel may receive a module
		// without `caseSearchConfig`, and the first edit emits a config
		// carrying only the freshly-seeded blacklist slot. Every slot on
		// `caseSearchConfigSchema` is optional, so an otherwise-empty
		// config is a valid persisted shape.
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<AdvancedSection
				value={undefined}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Open the collapse → body now exposes the Add affordance.
		fireEvent.click(
			screen.getByRole("button", {
				expanded: false,
				name: /^expand blacklisted owner ids$/i,
			}),
		);
		fireEvent.click(screen.getByLabelText(/^add blacklisted owner ids$/i));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			blacklistedOwnerIds: term(literal("")),
		});
	});

	it("preserves unrelated `caseSearchConfig` slots through a per-slot mutation", () => {
		// Pins the spread on every per-slot patch path. `searchScreenTitle`
		// is the canary because the section never reads or writes it
		// itself — a regression dropping the base spread would emit a
		// config missing the title and the parent's strict parse would
		// silently lose it on the next save.
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<AdvancedSection
				value={{
					searchScreenTitle: "Find a patient",
				}}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				expanded: false,
				name: /^expand blacklisted owner ids$/i,
			}),
		);
		fireEvent.click(screen.getByLabelText(/^add blacklisted owner ids$/i));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			blacklistedOwnerIds: term(literal("")),
			searchScreenTitle: "Find a patient",
		});
	});
});

// ── Round-trip with populated slot ────────────────────────────────

describe("AdvancedSection — populated round-trip", () => {
	it("renders the Clear affordance in the header when the slot is defined — even with the body collapsed", () => {
		// Pins the canonical `PredicateSlotCard` shape for this
		// section: Clear lives in the header at `ml-auto`, so a
		// collapsed body (the default for a backend-loaded config)
		// keeps the Clear affordance reachable without a prior
		// expand click. Without this contract, an author landing on
		// a populated slot would have to expand the body first to
		// drop the slot — friction with no upside.
		render(
			<AdvancedSection
				value={{
					blacklistedOwnerIds: term(literal("owner-a owner-b")),
				}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Toggle reads as collapsed (the body is hidden), but the
		// Clear button surfaces from the header — `ml-auto` placement
		// puts it outside the collapsed body wrapper.
		expect(
			screen.getByRole("button", {
				expanded: false,
				name: /^expand blacklisted owner ids$/i,
			}),
		).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: /^clear blacklisted owner ids$/i,
			}),
		).toBeDefined();
	});

	it("toggles body visibility on chevron click without affecting the header Clear", () => {
		render(
			<AdvancedSection
				value={{
					blacklistedOwnerIds: term(literal("owner-a")),
				}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Pre-click: header reads collapsed, Clear is already
		// reachable in the header (the load-bearing contract for
		// this fix).
		expect(
			screen.getByRole("button", {
				expanded: false,
				name: /^expand blacklisted owner ids$/i,
			}),
		).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: /^clear blacklisted owner ids$/i,
			}),
		).toBeDefined();

		fireEvent.click(
			screen.getByRole("button", {
				expanded: false,
				name: /^expand blacklisted owner ids$/i,
			}),
		);

		// Post-click: toggle now reads as expanded; Clear stays in
		// the header. The collapse state controls the body's
		// visibility, not the Clear affordance.
		expect(
			screen.getByRole("button", {
				expanded: true,
				name: /^collapse blacklisted owner ids$/i,
			}),
		).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: /^clear blacklisted owner ids$/i,
			}),
		).toBeDefined();
	});

	it("Clear in the header drops the slot — works with the body collapsed (no expand prerequisite)", () => {
		// Pins the user-actionable contract: a populated slot can be
		// cleared without expanding the body. This is the failure
		// mode the fix targets — a backend-loaded invalid expression
		// mounts default-collapsed, and the user must be able to
		// drop the slot in one click.
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<AdvancedSection
				value={{
					blacklistedOwnerIds: term(literal("owner-a")),
					searchScreenTitle: "Find a patient",
				}}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Body is collapsed (default), but Clear is reachable.
		fireEvent.click(
			screen.getByRole("button", {
				name: /^clear blacklisted owner ids$/i,
			}),
		);

		// `clearBlacklist` spreads `...(value ?? {})` and assigns
		// `blacklistedOwnerIds: undefined`, so the unrelated
		// `searchScreenTitle` slot survives and the cleared slot
		// reads as `undefined`. The doc-store strict parse on the
		// next save would otherwise lose the title.
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			blacklistedOwnerIds: undefined,
			searchScreenTitle: "Find a patient",
		});
	});
});

// ── Validity propagation ──────────────────────────────────────────

describe("AdvancedSection — validity propagation", () => {
	it("reports valid: true when the slot is absent (empty config)", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<AdvancedSection
				value={{}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("reports valid: true when the config is undefined", () => {
		// Pins the full short-circuit. `value=undefined` is the shape a
		// freshly-mounted module without a `caseSearchConfig` produces;
		// the slot-presence short-circuit must drop the `expressionValid`
		// stash from the aggregate just as it does on `value={}`. Without
		// this arm, a regression that read into `value!.blacklistedOwnerIds`
		// only on the empty-object path would slip past.
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<AdvancedSection
				value={undefined}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("reports valid: false when the blacklist references an unknown property — even with the collapse closed", () => {
		// Pins the load-bearing decision that collapse is a VISIBILITY
		// toggle, not a mount toggle: a backend-loaded invalid blacklist
		// expression renders into the default-collapsed section, but its
		// type-check pass still runs and the section's validity verdict
		// propagates. Without the keep-mounted contract, the section
		// would silently report `valid: true` while the user's blacklist
		// held an invalid expression — a save-gate desync.
		const invalidExpression: ValueExpression = term(
			prop("patient", "DOES_NOT_EXIST"),
		);
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<AdvancedSection
				value={{
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
});
