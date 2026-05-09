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
//   - Add path: clicking the header opens the body; clicking Add seeds
//     `term(literal(""))` and emits the next config.
//   - Round-trip with populated slot: the editor mounts hidden by
//     default (collapse keeps the body invisible until expanded) but
//     the Clear affordance is reachable inside the hidden wrapper, so
//     test queries can confirm the slot's presence.
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

		// Header is present and reads as collapsed.
		const header = screen.getByRole("button", {
			expanded: false,
			name: /exclude cases/i,
		});
		expect(header).toBeDefined();

		// No Clear / Add affordances surface — both live inside the
		// hidden body. A regression that mounted the body unconditionally
		// would expose either, and the test would fire.
		expect(
			screen.queryByLabelText(/^clear blacklisted owner ids$/i),
		).toBeNull();
		expect(screen.queryByLabelText(/^add blacklisted owner ids$/i)).toBeNull();
	});
});

// ── Add path ──────────────────────────────────────────────────────

describe("AdvancedSection — add path", () => {
	it("opens the collapse on header click and surfaces the Add affordance", () => {
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
				name: /exclude cases/i,
			}),
		);

		// Header now reads as expanded; Add affordance is visible.
		expect(
			screen.getByRole("button", {
				expanded: true,
				name: /exclude cases/i,
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
				name: /exclude cases/i,
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
				name: /exclude cases/i,
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
	it("renders the populated blacklist slot with the body collapsed-closed by default", () => {
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

		// Editor body stays mounted (so its validity verdict keeps
		// firing) but visually hidden via the `hidden` attribute on
		// the wrapper. The "Clear blacklisted owner IDs" affordance
		// lives inside the body; we read its nearest ancestor with
		// the `hidden` attribute as the collapse signal.
		const clearButton = screen.getByLabelText(
			/^clear blacklisted owner ids$/i,
			{ selector: "button" },
		);
		const collapseWrapper = clearButton.closest("[hidden]");
		expect(collapseWrapper).not.toBeNull();
	});

	it("reveals the body on header click", () => {
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

		const clearButton = screen.getByLabelText(
			/^clear blacklisted owner ids$/i,
			{ selector: "button" },
		);
		// Pre-click: closed.
		expect(clearButton.closest("[hidden]")).not.toBeNull();

		fireEvent.click(
			screen.getByRole("button", {
				expanded: false,
				name: /exclude cases/i,
			}),
		);
		// Post-click: open.
		expect(clearButton.closest("[hidden]")).toBeNull();
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
