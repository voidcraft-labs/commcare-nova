// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import type { ProseTemplate } from "@/lib/domain";
import {
	ReferenceProviderWrapper,
	useReferenceTemplateProjection,
} from "../ReferenceContext";

const FIELD_UUID = testUuid("selective-projection-field");
const template: ProseTemplate = {
	parts: [{ kind: "field-ref", uuid: FIELD_UUID }],
};

function context(path: string, unrelatedPath: string): XPathLintContext {
	return {
		formUuid: "form-a",
		validPaths: new Set([`/data/${path}`, `/data/${unrelatedPath}`]),
		reachableCaseTypes: undefined,
		formEntries: [
			{ uuid: FIELD_UUID, path, label: "Target", kind: "text" },
			{
				uuid: testUuid("selective-projection-unrelated"),
				path: unrelatedPath,
				label: "Unrelated",
				kind: "text",
			},
		],
		formType: "followup",
	};
}

describe("useReferenceTemplateProjection", () => {
	it("re-renders only when the projected spelling changes", () => {
		let currentContext = context("group_a/value", "other/a");
		let invalidate = () => {};
		let renders = 0;
		let subscribed = false;
		const wrapper = ({ children }: { children: ReactNode }) => (
			<ReferenceProviderWrapper
				getContextForForm={() => currentContext}
				currentFormUuid="form-a"
				subscribeMutation={(listener) => {
					invalidate = listener;
					subscribed = true;
					return () => {
						invalidate = () => {};
						subscribed = false;
					};
				}}
			>
				{children}
			</ReferenceProviderWrapper>
		);
		function Projection() {
			renders += 1;
			const projected = useReferenceTemplateProjection(template, "form-a");
			return <output aria-label="Projection">{projected}</output>;
		}

		const { unmount } = render(<Projection />, { wrapper });
		expect(subscribed).toBe(true);
		expect(screen.getByLabelText("Projection").textContent).toBe(
			"#form/group_a/value",
		);
		const initialRenders = renders;

		currentContext = context("group_a/value", "other/b");
		act(() => invalidate());
		expect(renders).toBe(initialRenders);

		currentContext = context("group_b/value", "other/b");
		act(() => invalidate());
		expect(renders).toBe(initialRenders + 1);
		expect(screen.getByLabelText("Projection").textContent).toBe(
			"#form/group_b/value",
		);
		unmount();
		expect(subscribed).toBe(false);
	});
});
