// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/ComparisonCard.test.tsx
//
// Inline-error rendering test for the comparison card. Pins the
// validity-index path lookup contract — operand-level errors
// (`["left"]`, `["right"]`) land next to the matching input;
// operator-level errors (`[]`, e.g. "ordered-types violation")
// land at the card shell's footer. Mounts through the full
// `PredicateCardEditor` so the validity index is the real one
// produced by `checkPredicate`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { eq, gt, literal, prop } from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../../PredicateCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "name", label: "Name", data_type: "text" },
	],
};

describe("ComparisonCard — inline errors", () => {
	it("renders no error rows for a well-typed comparison", () => {
		const value = eq(prop("patient", "name"), literal("Alice"));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// No `aria-invalid` markers and no error-styled chrome.
		expect(container.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
	});

	it("renders inline error chrome when operands disagree on type", () => {
		// `gt(int, "string")` — type checker rejects via the
		// "not comparable" rule. The verdict propagates to the
		// validity index; the card surfaces it inline.
		const value = gt(prop("patient", "age"), literal("not-an-int"));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// At least one element gets the error border treatment via
		// the `border-nova-error` accent the CardShell applies for
		// operator-level errors. The CSS class is the structural
		// signal here.
		const errorClassed = container.querySelector(".border-nova-error\\/35");
		expect(errorClassed).not.toBeNull();
	});

	it("renders an error message for an unknown property", () => {
		const value = eq(prop("patient", "DOES_NOT_EXIST"), literal("x"));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// The error message references the unknown property by name
		// — the type checker emits a message including the property
		// name, and the card renders the message verbatim under the
		// offending input.
		expect(container.textContent).toMatch(/Unknown property/i);
	});
});
