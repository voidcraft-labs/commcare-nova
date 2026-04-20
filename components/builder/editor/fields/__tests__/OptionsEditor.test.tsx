// @vitest-environment happy-dom

/**
 * OptionsEditor adapter + widget behavior.
 *
 * Covers:
 *   - label/value rows render, data-field-id wraps the widget,
 *   - add/remove/edit dispatch the expected lists,
 *   - Add Option keeps the new input focused (regression for the
 *     self-sync focus-loss bug: the commit's echoed prop MUST NOT
 *     regenerate draft ids and unmount the focused input),
 *   - the adapter clamps sub-minimum drafts to `undefined` to
 *     respect the schema's `min(2)` constraint on single/multi
 *     select options.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { SelectOption, SingleSelectField } from "@/lib/domain";
import { OptionsEditor } from "../OptionsEditor";

const baseField: SingleSelectField = {
	kind: "single_select",
	uuid: asUuid("u1-options"),
	id: "color",
	label: "Color",
	options: [
		{ value: "red", label: "Red" },
		{ value: "blue", label: "Blue" },
	],
};

/**
 * Minimal controlled parent — mirrors the real doc-store round-trip
 * where `onChange` eventually feeds back in as the new `value` prop.
 * This exposes bugs that only surface on the echo (the focus-loss
 * regression, for example).
 */
function ControlledOptionsEditor({
	initial,
	onDispatch,
}: {
	initial: SelectOption[];
	onDispatch?: (next: SelectOption[] | undefined) => void;
}) {
	const [value, setValue] = useState<SelectOption[] | undefined>(initial);
	return (
		<OptionsEditor
			field={{ ...baseField, options: value ?? [] } as SingleSelectField}
			value={value as SingleSelectField["options"]}
			onChange={(next) => {
				setValue(next as SelectOption[] | undefined);
				onDispatch?.(next as SelectOption[] | undefined);
			}}
			label="Options"
			keyName="options"
		/>
	);
}

describe("OptionsEditor", () => {
	it("renders every option row with its label and value", () => {
		render(
			<OptionsEditor
				field={baseField}
				value={baseField.options}
				onChange={() => {}}
				label="Options"
				keyName="options"
			/>,
		);
		expect((screen.getByDisplayValue("Red") as HTMLInputElement).value).toBe(
			"Red",
		);
		expect((screen.getByDisplayValue("Blue") as HTMLInputElement).value).toBe(
			"Blue",
		);
	});

	it("wraps the widget in a data-field-id=options container", () => {
		const { container } = render(
			<OptionsEditor
				field={baseField}
				value={baseField.options}
				onChange={() => {}}
				label="Options"
				keyName="options"
			/>,
		);
		expect(container.querySelector('[data-field-id="options"]')).not.toBeNull();
	});

	it("dispatches the expanded list when Add option is clicked", () => {
		const onChange = vi.fn();
		render(
			<OptionsEditor
				field={baseField}
				value={baseField.options}
				onChange={onChange}
				label="Options"
				keyName="options"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Add option/i }));
		expect(onChange).toHaveBeenCalled();
		const next = onChange.mock.calls[0][0];
		expect(Array.isArray(next)).toBe(true);
		expect(next).toHaveLength(3);
	});

	it("keeps the new input focused after Add option + parent round-trip", () => {
		// Controlled harness echoes the dispatched list back as the new
		// prop value, reproducing the real doc-store round-trip. A
		// self-sync regression would regenerate draft ids on the echo,
		// unmount the newly-mounted input, and drop focus.
		render(<ControlledOptionsEditor initial={baseField.options} />);
		fireEvent.click(screen.getByRole("button", { name: /Add option/i }));
		const labelInputs = screen.getAllByPlaceholderText(
			"Label",
		) as HTMLInputElement[];
		expect(labelInputs).toHaveLength(3);
		expect(document.activeElement).toBe(labelInputs[2]);
	});

	it("dispatches the updated list when a label is edited and the group blurs", async () => {
		const onChange = vi.fn();
		render(
			<OptionsEditor
				field={baseField}
				value={baseField.options}
				onChange={onChange}
				label="Options"
				keyName="options"
			/>,
		);
		const red = screen.getByDisplayValue("Red") as HTMLInputElement;
		red.focus();
		fireEvent.change(red, { target: { value: "Crimson" } });
		// Group-blur runs inside rAF; flush the frame inside act so
		// React's state update is observed before we assert.
		red.blur();
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
		expect(onChange).toHaveBeenCalled();
		const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
		expect(last[0]).toEqual({ value: "red", label: "Crimson" });
		expect(last[1]).toEqual({ value: "blue", label: "Blue" });
	});

	it("dispatches a shorter list when an option row is removed", () => {
		const onChange = vi.fn();
		render(
			<OptionsEditor
				field={{
					...baseField,
					options: [
						{ value: "red", label: "Red" },
						{ value: "blue", label: "Blue" },
						{ value: "green", label: "Green" },
					],
				}}
				value={[
					{ value: "red", label: "Red" },
					{ value: "blue", label: "Blue" },
					{ value: "green", label: "Green" },
				]}
				onChange={onChange}
				label="Options"
				keyName="options"
			/>,
		);
		// The per-row trash buttons and the Add button are all
		// descendants of the fieldset; the row buttons come first, the
		// Add button is last. Grab the first one and click it.
		const fieldset = screen.getByRole("group");
		const buttons = fieldset.querySelectorAll("button[type='button']");
		fireEvent.click(buttons[0] as HTMLButtonElement);
		expect(onChange).toHaveBeenCalled();
		const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
		expect(last).toHaveLength(2);
		expect(last[0]).toEqual({ value: "blue", label: "Blue" });
	});

	it("clamps drafts below min(2) to undefined at the adapter boundary", () => {
		const onChange = vi.fn();
		render(
			<OptionsEditor
				field={baseField}
				value={baseField.options}
				onChange={onChange}
				label="Options"
				keyName="options"
			/>,
		);
		// Remove one of two rows → the widget would try to save a
		// 1-entry list, which the adapter collapses to `undefined` so
		// the reducer treats it as a removal patch. Persisting a
		// 1-entry list would fail the schema's `min(2)` on the next
		// validation pass.
		const fieldset = screen.getByRole("group");
		const buttons = fieldset.querySelectorAll("button[type='button']");
		fireEvent.click(buttons[0] as HTMLButtonElement);
		const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
		expect(last).toBeUndefined();
	});
});
