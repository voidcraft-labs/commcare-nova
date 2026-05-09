// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/expression/UnwrapListCard.test.tsx
//
// `unwrap-list` produces a sequence type with no scalar consumer.
// The card mounts as a read-only badge so a saved AST containing
// `unwrap-list` round-trips through the editor without destruction;
// no editing affordance fires `onChange`. A "Replace" button offers
// a lossless recovery path: collapse `unwrap-list(<inner>)` to
// `<inner>` directly without going through the kind-replace menu's
// destructive default-value rebuild.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import { prop, term, unwrapList } from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "tags_json", label: "Tags JSON", data_type: "text" }],
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
		// The badge surfaces the wrapped property reference inline.
		expect(container.textContent).toMatch(/patient\.tags_json/i);
		// The badge itself is non-interactive; no onChange fired
		// during mount or render.
		expect(onChange).not.toHaveBeenCalled();
	});

	it("surfaces the CSQL-only hint copy", () => {
		const value = unwrapList(term(prop("patient", "tags_json")));
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/CSQL/i);
	});
});

describe("UnwrapListCard — lossless recovery via Replace", () => {
	it("Replace collapses unwrap-list to its inner expression verbatim", () => {
		// `unwrap-list(term(prop(...)))` — the canonical shape. Click
		// Replace; the next emit is the inner expression directly,
		// reference-identical to `value.value` on the source AST. The
		// inner shape becomes editable through whatever its native
		// card surfaces (TermCard for this shape).
		const inner = term(prop("patient", "tags_json"));
		const value = unwrapList(inner);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const replaceButton = screen.getByRole("button", {
			name: /Replace unwrap-list/i,
		});
		fireEvent.click(replaceButton);
		expect(onChange).toHaveBeenCalledTimes(1);
		// Reference equality: the inner expression survives the
		// unwrap verbatim — no rebuild, no operand loss.
		expect(onChange.mock.calls[0][0]).toBe(inner);
	});
});
