// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseSelectionSetting } from "../canvas/CaseSelectionSetting";

describe("CaseSelectionSetting", () => {
	it("stores only the several-case state", () => {
		const onChange = vi.fn();
		render(
			<CaseSelectionSetting value={undefined} canEdit onChange={onChange} />,
		);

		expect(
			(screen.getByRole("radio", { name: "One case" }) as HTMLInputElement)
				.checked,
		).toBe(true);
		fireEvent.click(screen.getByRole("radio", { name: "Several cases" }));
		expect(onChange).toHaveBeenLastCalledWith({
			kind: "multiple",
			maximum: 100,
		});
	});

	it("names and bounds the maximum directly", () => {
		const onChange = vi.fn();
		render(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 12 }}
				canEdit
				onChange={onChange}
			/>,
		);

		const input = screen.getByLabelText("Most cases a worker can choose");
		expect(input.getAttribute("min")).toBe("1");
		expect(input.getAttribute("max")).toBe("100");
		fireEvent.change(input, { target: { value: "25" } });
		expect(onChange).toHaveBeenLastCalledWith({
			kind: "multiple",
			maximum: 25,
		});
	});

	it("explains the setting without exposing controls to viewers", () => {
		render(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 8 }}
				canEdit={false}
				onChange={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("People can choose up to 8 cases before continuing"),
		).toBeDefined();
		expect(screen.queryByRole("radiogroup")).toBeNull();
	});
});
