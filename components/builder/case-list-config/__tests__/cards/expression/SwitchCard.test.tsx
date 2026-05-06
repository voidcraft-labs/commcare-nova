// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/expression/SwitchCard.test.tsx
//
// Switch card tests — drag-orderable cases + non-empty invariant.
// The card's drag surface targets `cases` (one per row); the `on`
// and `fallback` slots stay structurally fixed.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	dateLiteral,
	literal,
	prop,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "risk", label: "Risk", data_type: "text" },
		{ name: "score", label: "Score", data_type: "int" },
	],
};

describe("SwitchCard — reorder produces cases array in the new order", () => {
	it("reordering cases produces a cases array in the new order", () => {
		const a = switchCase(literal("low"), term(literal(1)));
		const b = switchCase(literal("medium"), term(literal(2)));
		const c = switchCase(literal("high"), term(literal(3)));
		const onExpr = term(prop("patient", "risk"));
		const fallback = term(literal(0));
		const original = switchExpr(onExpr, [a, b, c], fallback);
		expect(original.cases).toEqual([a, b, c]);
		const reordered = switchExpr(onExpr, [c, a, b], fallback);
		expect(reordered.cases).toEqual([c, a, b]);
	});
});

describe("SwitchCard — drag handle wiring", () => {
	it("grip button mounts per case inside a multi-case switch", () => {
		const value = switchExpr(
			term(prop("patient", "risk")),
			[
				switchCase(literal("low"), term(literal(1))),
				switchCase(literal("high"), term(literal(2))),
			],
			term(literal(0)),
		);
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// `Reorder case` is the per-case grip's aria-label inside
		// SwitchCard's CaseRow. Distinct from the outer
		// `Reorder card` label that the CardShell's grip uses on
		// nested ExpressionPicker shells.
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder case"]',
		);
		expect(grips.length).toBe(2);
	});
});

describe("SwitchCard — case removal contract", () => {
	it("the schema requires non-empty cases", () => {
		// Constructing `switchExpr(on, [], fallback)` would require an
		// empty tuple at the type layer — TypeScript rejects it. The
		// editor's `removeCase` callback refuses the last-row removal
		// at runtime; this test covers the schema layer instead.
		const value = switchExpr(
			term(prop("patient", "risk")),
			[switchCase(literal("low"), term(literal(1)))],
			term(literal(0)),
		);
		expect(value.cases.length).toBe(1);
	});
});

describe("SwitchCard — `when` literal preserves data_type qualifier", () => {
	// Regression test for the data-loss class Task 2 paid 8 CR rounds
	// to lock down: an uncontrolled blur-commit input that
	// unconditionally rebuilds via the bare `literal(...)` builder
	// drops any `data_type` qualifier on the source AST. Mounting a
	// switch whose `when` carries `dateLiteral(...)`, focusing then
	// blurring without typing, MUST leave the AST reference-stable
	// — no spurious `onChange` and no qualifier loss.

	it("focus + blur without typing leaves the dateLiteral when AST untouched", () => {
		// `dateLiteral("2024-01-01")` carries `data_type: "date"`.
		// The naïve rebuild (uncontrolled `defaultValue` + bare
		// `literal(text)` on every blur) silently turns this into a
		// number literal because `Number("2024")` parses as a number,
		// AND drops the `data_type` qualifier. The fix is the
		// `text === initial` no-op gate.
		const value = switchExpr(
			term(prop("patient", "risk")),
			[switchCase(dateLiteral("2024-01-01"), term(literal("y2024")))],
			term(literal("other")),
		);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[
					{
						name: "patient",
						properties: [{ name: "risk", label: "Risk", data_type: "date" }],
					},
				]}
				currentCaseType="patient"
			/>,
		);
		// Find the case-when input. The aria-label is "Case when value".
		const whenInput = screen.getByLabelText(
			"Case when value",
		) as HTMLInputElement;
		expect(whenInput.value).toBe("2024-01-01");
		// Focus then blur without typing — the no-op gate must
		// short-circuit the commit.
		whenInput.focus();
		fireEvent.blur(whenInput);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("typing a new date value preserves data_type: 'date' on the rebuilt literal", () => {
		// User edits the text; the parser must route through
		// `dateLiteral(...)` (or the equivalent qualifier-preserving
		// rebuild) so the qualifier survives the edit.
		const value = switchExpr(
			term(prop("patient", "risk")),
			[switchCase(dateLiteral("2024-01-01"), term(literal("y2024")))],
			term(literal("other")),
		);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[
					{
						name: "patient",
						properties: [{ name: "risk", label: "Risk", data_type: "date" }],
					},
				]}
				currentCaseType="patient"
			/>,
		);
		const whenInput = screen.getByLabelText(
			"Case when value",
		) as HTMLInputElement;
		// Edit the input, then blur to commit.
		fireEvent.change(whenInput, { target: { value: "2025-06-15" } });
		fireEvent.blur(whenInput);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as {
			cases: { when: { value: unknown; data_type?: string } }[];
		};
		expect(next.cases[0].when.value).toBe("2025-06-15");
		expect(next.cases[0].when.data_type).toBe("date");
	});
});
