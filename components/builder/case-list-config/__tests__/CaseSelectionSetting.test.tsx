// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseSelectionSetting } from "../canvas/CaseSelectionSetting";

describe("CaseSelectionSetting", () => {
	it("offers the two modes as one radio group and stores only several cases", () => {
		const onChange = vi.fn();
		render(
			<CaseSelectionSetting value={undefined} canEdit onChange={onChange} />,
		);

		const one = screen.getByRole("radio", {
			name: "One case",
		}) as HTMLInputElement;
		const several = screen.getByRole("radio", {
			name: "Several cases",
		}) as HTMLInputElement;
		expect(one.checked).toBe(true);
		expect(several.checked).toBe(false);
		expect(one.name).toBe(several.name);

		fireEvent.click(several);
		expect(onChange).toHaveBeenLastCalledWith(
			{
				kind: "multiple",
				maximum: 100,
			},
			expect.any(HTMLElement),
		);
	});

	it("commits a valid maximum only on blur or Enter", () => {
		const onChange = vi.fn();
		render(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 12 }}
				canEdit
				onChange={onChange}
			/>,
		);

		const input = screen.getByLabelText(
			"Most cases a worker can choose",
		) as HTMLInputElement;
		expect(input.getAttribute("min")).toBe("1");
		expect(input.getAttribute("max")).toBe("100");
		fireEvent.change(input, { target: { value: "25" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.blur(input);
		expect(onChange).toHaveBeenLastCalledWith(
			{
				kind: "multiple",
				maximum: 25,
			},
			expect.any(HTMLElement),
		);
		// The requested value is not shown as saved while a parent review is
		// still deciding whether to commit it.
		expect(input.value).toBe("12");

		onChange.mockClear();
		fireEvent.change(input, { target: { value: "30" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenLastCalledWith(
			{
				kind: "multiple",
				maximum: 30,
			},
			expect.any(HTMLElement),
		);
	});

	it("describes an invalid maximum and lets Escape restore the saved value", () => {
		const onChange = vi.fn();
		render(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 12 }}
				canEdit
				onChange={onChange}
			/>,
		);

		const input = screen.getByLabelText(
			"Most cases a worker can choose",
		) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "101" } });
		fireEvent.blur(input);

		expect(onChange).not.toHaveBeenCalled();
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const error = screen.getByRole("alert");
		expect(error.textContent).toBe("Choose a whole number from 1 to 100.");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);

		fireEvent.keyDown(input, { key: "Escape" });
		expect(input.value).toBe("12");
		expect(input.hasAttribute("aria-invalid")).toBe(false);
		expect(screen.queryByRole("alert")).toBeNull();
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
			screen.getByText(
				"People choose up to 8 cases and complete the form once. Existing case information does not fill this shared form. Answers entered in the shared form save to every selected case.",
			),
		).toBeDefined();
		expect(screen.queryByRole("radio", { name: "One case" })).toBeNull();
	});

	it("explains how several-case forms start and save", () => {
		render(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 8 }}
				canEdit
				onChange={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(
				"A question without a starting answer begins blank. Leaving it blank keeps each case's current value.",
			),
		).toBeDefined();
	});

	it("does not overwrite a local limit draft when the saved limit changes elsewhere", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 12 }}
				canEdit
				onChange={onChange}
			/>,
		);
		const input = screen.getByLabelText(
			"Most cases a worker can choose",
		) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "25" } });

		rerender(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 18 }}
				canEdit
				onChange={onChange}
			/>,
		);
		expect(input.value).toBe("25");

		fireEvent.blur(input);
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain(
			"changed elsewhere",
		);

		fireEvent.keyDown(input, { key: "Escape" });
		expect(input.value).toBe("18");
	});

	it("drops an invalid draft after returning to one case", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 12 }}
				canEdit
				onChange={onChange}
			/>,
		);
		const input = screen.getByLabelText(
			"Most cases a worker can choose",
		) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "101" } });
		fireEvent.blur(input);
		expect(screen.getByRole("alert")).toBeDefined();

		rerender(
			<CaseSelectionSetting value={undefined} canEdit onChange={onChange} />,
		);
		rerender(
			<CaseSelectionSetting
				value={{ kind: "multiple", maximum: 100 }}
				canEdit
				onChange={onChange}
			/>,
		);

		const restored = screen.getByLabelText(
			"Most cases a worker can choose",
		) as HTMLInputElement;
		expect(restored.value).toBe("100");
		expect(restored.hasAttribute("aria-invalid")).toBe(false);
	});
});
