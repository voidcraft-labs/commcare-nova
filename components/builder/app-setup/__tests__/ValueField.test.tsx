// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { UserProperty } from "@/lib/domain";
import { ValueField } from "../ValueField";

const PROPERTY: UserProperty = {
	uuid: testUuid("property"),
	slug: "region",
	label: "Region",
};

function pressSelectOption(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
}

describe("ValueField override semantics", () => {
	it("round-trips inherited, explicit blank, and a choice equal to the old sentinel", async () => {
		const onChange = vi.fn();
		const property: UserProperty = {
			...PROPERTY,
			choices: ["__nova_no_value", "north"],
		};
		const view = render(
			<ValueField
				property={property}
				value={undefined}
				inheritedValue="south"
				disabled={false}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Region" }));
		await settleBaseUiTransitions();
		expect(
			screen.getByRole("option", { name: "Use role value: south" }),
		).toBeDefined();
		expect(screen.getByRole("option", { name: "Blank" })).toBeDefined();
		const oldSentinelChoice = screen.getByRole("option", {
			name: "__nova_no_value",
		});
		expect(screen.getAllByRole("option")).toHaveLength(4);
		pressSelectOption(oldSentinelChoice);
		await settleBaseUiTransitions();
		expect(onChange).toHaveBeenLastCalledWith("__nova_no_value");

		view.rerender(
			<ValueField
				property={property}
				value=""
				inheritedValue="south"
				disabled={false}
				onChange={onChange}
			/>,
		);
		await settleBaseUiTransitions();
		expect(
			screen.getByRole("combobox", { name: "Region" }).textContent,
		).toContain("Blank");
	});

	it("keeps an explicit blank text override distinct from inheriting", () => {
		const onChange = vi.fn();
		const view = render(
			<ValueField
				property={PROPERTY}
				value={undefined}
				inheritedValue="south"
				disabled={false}
				onChange={onChange}
			/>,
		);
		const input = screen.getByRole("textbox", { name: "Region" });
		expect(input.getAttribute("placeholder")).toBe("south");

		fireEvent.change(input, { target: { value: "x" } });
		view.rerender(
			<ValueField
				property={PROPERTY}
				value="x"
				inheritedValue="south"
				disabled={false}
				onChange={onChange}
			/>,
		);
		fireEvent.change(input, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith("");

		view.rerender(
			<ValueField
				property={PROPERTY}
				value=""
				inheritedValue="south"
				disabled={false}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Use role value" }));
		expect(onChange).toHaveBeenLastCalledWith(undefined);
		expect(
			screen
				.getByRole("button", { name: "Use role value" })
				.className.split(/\s+/),
		).toContain("min-h-11");
	});
});
