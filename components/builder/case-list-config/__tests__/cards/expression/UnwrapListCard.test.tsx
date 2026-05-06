// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/expression/UnwrapListCard.test.tsx
//
// `unwrap-list` produces a sequence type with no scalar consumer.
// The card mounts as a read-only badge so a saved AST containing
// `unwrap-list` round-trips through the editor without destruction;
// no editing affordance fires `onChange`.

import { render } from "@testing-library/react";
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
