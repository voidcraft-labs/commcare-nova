// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/MatchCard.test.tsx
//
// Inline-error regression test for the MatchCard's value-slot
// rendering. The type checker (`checkMatch` in
// `lib/domain/predicate/typeChecker.ts`) emits term-resolution
// failures (Unknown property / Unknown search input) at
// `[..., "value", "term"]` — one segment deeper than the operator-
// level mode-mismatch path `[..., "value"]`. The slot is composed via
// `ExpressionPicker`, whose `CardShell` footer reads operator-level
// errors at the slot path exactly via `useEditorErrorsAt`; the inner
// `TermCard` reads strict-descendant errors via `useEditorErrorsBelow`
// so the deeper match-side resolution failures still surface inline.
// Without the strict-descendant lookup, term-resolution failures
// would silently drop from display while still flipping the parent's
// save gate.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { literal, match, prop } from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../../PredicateCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "status", label: "Status", data_type: "text" },
	],
};

describe("MatchCard — inline value-slot errors", () => {
	it("surfaces an Unknown property failure on the value slot", () => {
		// The value carries a `prop` term referencing a property that
		// doesn't exist on the case type. The type checker emits the
		// resolution error at `[..., "value", "term"]`. The card's
		// prefix-capture lookup must reach it so the inline diagnostic
		// renders next to the value picker.
		const value = match(
			prop("patient", "name"),
			{
				kind: "term",
				term: prop("patient", "DOES_NOT_EXIST"),
			},
			"fuzzy",
		);
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Unknown property/i);
	});

	it("surfaces operator-level mode-mismatch errors at the value slot", () => {
		// Empty-string literal → `checkMatch` emits the empty-string
		// rejection error at `[..., "value"]` directly (the operator-
		// level slot path). Verifies the card still picks up errors
		// at the slot's own path alongside the deeper term-side
		// errors.
		const value = match(prop("patient", "name"), literal(""), "fuzzy");
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/empty string/i);
	});

	it("renders no error rows for a well-typed match", () => {
		const value = match(prop("patient", "name"), literal("Alice"), "fuzzy");
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
	});
});
