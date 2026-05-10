// @vitest-environment happy-dom
//
// components/builder/case-search-config/__tests__/DisplaySection.test.tsx
//
// DisplaySection composition tests — pin the public contract of the
// six display-cluster sub-controls + the section's validity gate:
//
//   - Round-trip: a fully-populated config renders every text input
//     and the predicate slot's clear affordance.
//   - Per-slot edits: typing into each text input emits a config
//     where only the targeted slot changes; every other slot flows
//     through unchanged. Setting a slot to "" clears it (the
//     emitted shape carries `slot: undefined` so strict-parse drops
//     the key on the next mount).
//   - Predicate validity: the slot-presence short-circuit drives
//     section validity. An absent display-condition reports `true`;
//     an invalid display-condition reports `false`.
//   - Cross-slot preservation: a display-cluster edit doesn't
//     clobber unrelated `caseSearchConfig` slots (e.g.,
//     `blacklistedOwnerIds`).
//
// The five visible label slots all share the section's local
// `OptionalTextRow` primitive (built on top of `useCommitField`),
// so per-slot edit tests are mechanical — the parameterized
// `it.each` block covers the four single-line inputs in one
// declaration. The textarea's commit path gets its own `it()`
// because the markdown row's layout (textarea + live preview)
// differs from the single-line input rows, and pinning the commit
// path on the textarea independently keeps both layouts under test.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import {
	gt,
	literal,
	matchAll,
	type Predicate,
	prop,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { DisplaySection } from "../DisplaySection";

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

// Fully-populated baseline. Every slot on `caseSearchConfigSchema`
// is optional; the populated baseline sets every display slot plus
// the `searchButtonDisplayCondition` predicate.
const POPULATED_CONFIG: CaseSearchConfig = {
	searchScreenTitle: "Find a patient",
	searchScreenSubtitle: "Search by **name** or *village*.",
	emptyListText: "No patients matched.",
	searchButtonLabel: "Search",
	searchAgainButtonLabel: "Search again",
	searchButtonDisplayCondition: matchAll(),
};

// ── Round-trip ────────────────────────────────────────────────────

describe("DisplaySection — round-trip", () => {
	it("renders the populated configuration: each text slot's input carries its bound value, the predicate slot shows the Clear affordance", () => {
		render(
			<DisplaySection
				value={POPULATED_CONFIG}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// Per-slot binding — read each input by its label so a
		// title-vs-subtitle slot swap (or any other miswiring) fails
		// loudly. A bag-shaped `getAllByRole("textbox")` would tolerate
		// that swap as long as both values were present somewhere in
		// the rendered tree.
		expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
			"Find a patient",
		);
		expect(
			(screen.getByLabelText("Subtitle") as HTMLTextAreaElement).value,
		).toBe("Search by **name** or *village*.");
		expect(
			(screen.getByLabelText("Empty results message") as HTMLInputElement)
				.value,
		).toBe("No patients matched.");
		expect(
			(screen.getByLabelText("Search button label") as HTMLInputElement).value,
		).toBe("Search");
		expect(
			(screen.getByLabelText("Search-again button label") as HTMLInputElement)
				.value,
		).toBe("Search again");

		// PredicateSlotCard renders the Clear affordance when the slot
		// is defined; the dashed Add affordance disappears.
		expect(screen.queryByLabelText(/^add display condition$/i)).toBeNull();
		expect(screen.getByLabelText(/^clear display condition$/i)).toBeDefined();
	});
});

// ── Per-slot edits ────────────────────────────────────────────────

describe("DisplaySection — per-slot edits", () => {
	// Every plain-text slot mounts the same `OptionalTextRow` row,
	// so the per-slot edit path is mechanical: focus, type, blur,
	// assert onChange fires with `{ ...seeded, [slot]: value }`. The
	// label matcher uses the visible label string from the section's
	// authoring copy.
	it.each([
		["Title", "searchScreenTitle", "Find a patient", "Find a patient"],
		[
			"Empty results message",
			"emptyListText",
			"Nothing here.",
			"Nothing here.",
		],
		["Search button label", "searchButtonLabel", "Go", "Go"],
		["Search-again button label", "searchAgainButtonLabel", "Retry", "Retry"],
	] as const)("types into the %s slot and emits onChange with the new value", (label, slot, typed, expected) => {
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<DisplaySection
				value={undefined}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		// `input.focus()` BEFORE `fireEvent.change` mirrors the real
		// user gesture — `useCommitField` shows the prop value
		// outside of focus, so a `change` without a focus first would
		// not update what the input renders. Same pattern the
		// case-list-config card-edit tests use.
		const input = screen.getByLabelText(label) as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: typed } });
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			[slot]: expected,
		});
	});

	it("types into the Subtitle markdown textarea and emits onChange with the new value", () => {
		// Markdown subtitle uses the same blur-commit semantics as the
		// plain text rows; the only authoring-layer difference is the
		// textarea + the live `<PreviewMarkdown />` render. Pinning
		// the textarea's commit path independently keeps the markdown
		// row's commit semantics under direct test.
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<DisplaySection
				value={undefined}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const textarea = screen.getByLabelText("Subtitle") as HTMLTextAreaElement;
		textarea.focus();
		fireEvent.change(textarea, { target: { value: "Search by **name**." } });
		fireEvent.blur(textarea);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			searchScreenSubtitle: "Search by **name**.",
		});
	});

	it("clearing a populated text slot emits onChange with the slot omitted (empty-string-clears)", () => {
		// Pins the omit-on-empty contract — clearing the only slot on
		// the input config emits the empty object, AND the slot key is
		// genuinely absent on the emitted object (a destructured drop,
		// not a `key: undefined` assignment). `toEqual` is satisfied by
		// either shape, so the explicit `in` probe pins the absent-key
		// half of the contract loudly — a regression to the leaky
		// `key: undefined` shape would land the key as an own enumerable
		// property under the doc store's `Object.assign(mod, patch)`
		// merge and break downstream `key in config` presence checks.
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<DisplaySection
				value={{
					searchScreenTitle: "Find a patient",
				}}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const input = screen.getByLabelText("Title") as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledTimes(1);
		const emitted = onChange.mock.calls[0]?.[0];
		expect(emitted).toEqual({});
		expect("searchScreenTitle" in (emitted ?? {})).toBe(false);
	});

	it("does not emit onChange when focusing and blurring an empty input on an undefined config", () => {
		// Pins the "no-op on never-set" contract on
		// `OptionalTextRow`'s `onEmpty` arm. Without the
		// `value !== undefined` gate, `useCommitField`'s
		// "delete on empty" semantic fires `onCommit(undefined)` on a
		// focus-blur-without-typing gesture, which would transition
		// `caseSearchConfig` from absent to present-with-empty for a
		// "I clicked on this and looked away" interaction. That's a
		// spurious autosave + an undo-history entry the user never
		// asked for; this test fails the regression class loudly.
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<DisplaySection
				value={undefined}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const input = screen.getByLabelText("Title") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.blur(input);

		expect(onChange).not.toHaveBeenCalled();
	});
});

// ── Validity propagation ──────────────────────────────────────────

describe("DisplaySection — validity propagation", () => {
	it("reports valid: true when the search-button display-condition slot is undefined", () => {
		// Slot-presence short-circuit at the PredicateSlotCard layer —
		// when no predicate is authored, the section is trivially
		// valid regardless of the inner shadow.
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<DisplaySection
				value={undefined}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("reports valid: false when the display-condition predicate has a type-mismatch comparison", () => {
		// `gt(int, "string")` is rejected by the predicate type
		// checker — the editor's onValidityChange flows the verdict
		// to PredicateSlotCard, then through DisplaySection, to its
		// parent.
		const invalidPredicate: Predicate = gt(
			prop("patient", "age"),
			literal("string"),
		);
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<DisplaySection
				value={{
					searchButtonDisplayCondition: invalidPredicate,
				}}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});
});

// ── Cross-slot preservation ───────────────────────────────────────

describe("DisplaySection — cross-slot preservation", () => {
	it("typing into a display slot leaves unrelated `caseSearchConfig` slots intact", () => {
		// Per-slot patches spread `value` forward, so any sibling slot
		// the patch doesn't touch flows through every emission.
		// `blacklistedOwnerIds` is the canary — the display section
		// never reads or writes it directly (it lives on the advanced
		// cluster), so its presence on the emitted config exercises the
		// base spread without any code path inside the section being
		// able to fake the result.
		const blacklistedOwnerIds: ValueExpression = term(literal("owner-a"));
		const onChange = vi.fn<(next: CaseSearchConfig) => void>();
		render(
			<DisplaySection
				value={{
					blacklistedOwnerIds,
				}}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const input = screen.getByLabelText("Title") as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: "Find a patient" } });
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toEqual({
			blacklistedOwnerIds,
			searchScreenTitle: "Find a patient",
		});
	});
});
