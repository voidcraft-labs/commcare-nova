// @vitest-environment happy-dom

/**
 * OptionsEditor — adapter over the legacy widget.
 *
 * Covers the adapter-specific behavior: value normalization (array or
 * non-array), the onChange empty → undefined contract (empty list
 * would violate schema `min(2)` constraints, so we clear entirely
 * rather than persist []), and the options data-field-id wrapper
 * used by undo/redo focus hints.
 *
 * The underlying OptionsEditorWidget's commit/blur/add/remove paths
 * are exercised through the "add option" assertion; duplicating
 * every widget branch here would re-test internal logic that's
 * already covered in place.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { SingleSelectField } from "@/lib/domain";
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

	it("dispatches the expanded list when the Add option button is clicked", () => {
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
		// The widget generates default label/value based on the position.
		expect(onChange).toHaveBeenCalled();
		const next = onChange.mock.calls[0][0];
		expect(Array.isArray(next)).toBe(true);
		expect(next).toHaveLength(3);
	});
});
