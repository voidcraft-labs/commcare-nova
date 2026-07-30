// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { CaseTargetPicker } from "../CaseTargetPicker";

describe("CaseTargetPicker", () => {
	it("does not construct an empty runtime expression target", async () => {
		const onChange = vi.fn();
		render(
			<CaseTargetPicker
				value={{ kind: "session" }}
				context={{
					priorCreates: [],
					sessionUnavailableReason: undefined,
					newOnly: false,
					allowsNone: false,
				}}
				ariaLabel="Case target"
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Case target: The case this form opened",
			}),
		);
		const expression = await screen.findByRole("menuitem", {
			name: /A case found by a calculation/,
		});
		expect(expression.getAttribute("aria-disabled")).toBe("true");
		expect(expression.textContent).toContain(
			"This screen cannot start a case-id calculation",
		);

		fireEvent.click(expression);
		await settleBaseUiTransitions();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("requests a parent-owned local draft without changing the document", async () => {
		const onChange = vi.fn();
		const onRequestExpression = vi.fn();
		render(
			<CaseTargetPicker
				value={{ kind: "session" }}
				context={{
					priorCreates: [],
					sessionUnavailableReason: undefined,
					newOnly: false,
					allowsNone: false,
				}}
				ariaLabel="Case target"
				onRequestExpression={onRequestExpression}
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Case target: The case this form opened",
			}),
		);
		const expression = await screen.findByRole("menuitem", {
			name: /A case found by a calculation/,
		});
		expect(expression.getAttribute("aria-disabled")).not.toBe("true");

		fireEvent.click(expression);
		await settleBaseUiTransitions();
		expect(onRequestExpression).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
	});
});
