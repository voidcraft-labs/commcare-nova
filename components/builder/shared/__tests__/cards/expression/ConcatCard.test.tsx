// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/expression/ConcatCard.test.tsx
//
// Concat card tests:
//   - reorder-by-builder contract through the public `concat`
//     builder (the editor's onDrop reconstructs through the same
//     builder, so reordering produces an AST whose `parts` array
//     matches the new visual order).
//   - drag-handle wiring — confirms the grip button reaches the
//     DOM for every part in the list, mirroring the `LogicalGroupCard`
//     test pattern.
//   - clause removal contract — refusing the last-row removal so
//     the schema's non-empty `parts` invariant holds.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { focusElement } from "@/__tests__/helpers/baseUiInteractions";
import type { CaseType } from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "first", label: "First", data_type: "text" },
		{ name: "last", label: "Last", data_type: "text" },
	],
};

describe("ConcatCard — reorder produces parts array in the new order", () => {
	it("reordering parts produces a parts array in the new order", () => {
		const a = term(literal("a"));
		const b = term(literal("b"));
		const c = term(literal("c"));

		const original = concat(a, b, c);
		expect(original.kind).toBe("concat");
		expect(original.parts).toEqual([a, b, c]);

		// Simulate a drag of `c` to position 0 — the editor's onDrop
		// constructs a new `concat(...)` with the rearranged list.
		const reordered = concat(c, a, b);
		expect(reordered.parts).toEqual([c, a, b]);
		// Reordering preserves part references — same a / b / c
		// references appear in the new envelope's parts.
		expect(reordered.parts[0]).toBe(c);
		expect(reordered.parts[1]).toBe(a);
		expect(reordered.parts[2]).toBe(b);
	});
});

describe("ConcatCard — drag handle wiring", () => {
	it("grip button mounts on each part inside a multi-part concat", () => {
		const value = concat(
			term(literal("first ")),
			term(literal("middle ")),
			term(literal("last")),
		);
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// Each row threads a `dragHandleRef` into the card-shell grip,
		// so we expect one grip per part — three in this case.
		const grips = container.querySelectorAll(
			'button[aria-label^="Move value"]',
		);
		expect(grips.length).toBe(3);
	});

	it("grip stays mounted when only one part remains", () => {
		// Single part — the row still mounts the grip (drag itself is
		// a no-op with no other targets, but the affordance stays so
		// the visual remains consistent with multi-row state).
		const value = concat(term(literal("only")));
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const grips = container.querySelectorAll(
			'button[aria-label^="Move value"]',
		);
		expect(grips.length).toBe(1);
	});

	it("moves a value from the keyboard and keeps focus on its handle", () => {
		const initial = concat(
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
						if (next.kind === "concat") setValue(next);
					}}
					caseTypes={[PATIENT]}
					currentCaseType="patient"
				/>
			);
		}
		render(<Harness />);

		const second = screen.getByRole("button", {
			name: "Move value 2 of 3",
		});
		focusElement(second);
		fireEvent.keyDown(second, { key: "Home" });

		expect(document.activeElement).toBe(second);
		expect(second.getAttribute("aria-label")).toBe("Move value 1 of 3");
		expect(screen.getByRole("status").textContent).toBe(
			"Value 2 moved earlier",
		);
	});

	it("moves focus to the next value's remove action after deletion", async () => {
		const initial = concat(
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
						if (next.kind === "concat") setValue(next);
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
		focusElement(removeActions[0]);
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
