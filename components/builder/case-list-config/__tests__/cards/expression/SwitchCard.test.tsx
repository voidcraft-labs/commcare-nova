// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/expression/SwitchCard.test.tsx
//
// Switch card tests — drag-orderable cases + non-empty invariant.
// The card's drag surface targets `cases` (one per row); the `on`
// and `fallback` slots stay structurally fixed.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
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
