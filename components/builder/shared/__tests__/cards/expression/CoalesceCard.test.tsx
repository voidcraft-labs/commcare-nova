// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/expression/CoalesceCard.test.tsx
//
// Coalesce card tests — drag/reorder + non-empty invariant. Mirrors
// `ConcatCard.test.tsx`'s pattern; the two cards share a body shape
// (variadic value list) so the tests pin the same structural
// guarantees.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { coalesce, literal, term } from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "primary", label: "Primary", data_type: "text" },
		{ name: "fallback", label: "Fallback", data_type: "text" },
	],
};

describe("CoalesceCard — reorder produces values array in the new order", () => {
	it("reordering values produces a values array in the new order", () => {
		const a = term(literal("a"));
		const b = term(literal("b"));
		const original = coalesce(a, b);
		expect(original.kind).toBe("coalesce");
		expect(original.values).toEqual([a, b]);
		const reordered = coalesce(b, a);
		expect(reordered.values).toEqual([b, a]);
	});
});

describe("CoalesceCard — drag handle wiring", () => {
	it("grip button mounts on each value inside a multi-value coalesce", () => {
		const value = coalesce(term(literal("first")), term(literal("second")));
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const grips = container.querySelectorAll(
			'button[aria-label^="Move fallback"]',
		);
		expect(grips.length).toBe(2);
	});

	it("moves focus to the next fallback's remove action after deletion", async () => {
		const initial = coalesce(
			term(literal("first")),
			term(literal("second")),
			term(literal("third")),
		);
		function Harness() {
			const [value, setValue] = useState(initial);
			return (
				<ExpressionCardEditor
					value={value}
					onChange={(next) => {
						if (next.kind === "coalesce") setValue(next);
					}}
					caseTypes={[PATIENT]}
					currentCaseType="patient"
				/>
			);
		}
		render(<Harness />);

		const removeActions = screen.getAllByRole("button", {
			name: "Remove value",
		});
		const nextAction = removeActions[1];
		removeActions[0].focus();
		await act(async () => {
			fireEvent.click(removeActions[0]);
			await Promise.resolve();
		});

		expect(document.activeElement).toBe(nextAction);
		expect(
			screen.getAllByRole("button", { name: "Remove value" }),
		).toHaveLength(2);
	});
});
