// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/expression/UnwrapListCard.test.tsx
//
// `unwrap-list` produces a sequence type with no scalar consumer, but its
// text-shaped source is still a normal ValueExpression. The card preserves
// the outer expression and mounts the real recursive source editor.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import { prop, term, unwrapList } from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "tags_json", label: "Tags JSON", data_type: "text" },
		{ name: "choices_json", label: "Choices JSON", data_type: "text" },
	],
};

describe("UnwrapListCard — round-trip preservation", () => {
	it("mounts the unwrap-list arm without firing onChange on render", () => {
		const value = unwrapList(term(prop("patient", "tags_json")));
		const onChange = vi.fn();
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Read the saved list from/i);
		expect(
			screen.getByRole("button", {
				name: "Value source: Other case information",
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("explains that a list of values has no single-value slot", () => {
		const value = unwrapList(term(prop("patient", "tags_json")));
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(
			/stores several selections as a list/i,
		);
	});
});

describe("UnwrapListCard — source editing", () => {
	it("edits the inner expression without discarding the outer operation", async () => {
		const value = unwrapList(term(prop("patient", "tags_json")));
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const propertyButton = screen.getByRole("button", {
			name: /^Case information: Tags JSON/i,
		});
		fireEvent.click(propertyButton);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /^Choices JSON/i }),
		);
		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		expect(onChange.mock.calls[0]?.[0]).toEqual(
			unwrapList(term(prop("patient", "choices_json"))),
		);
	});
});
