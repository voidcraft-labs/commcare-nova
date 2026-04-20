// @vitest-environment happy-dom

/**
 * TextEditor smoke tests.
 *
 * TextEditor is the declarative editor for plain-string field keys
 * (currently just `hint`). It wraps the shared EditableText commit
 * widget and adapts its string-only save callback to the generic
 * FieldEditorComponent onChange contract — empty commits clear the
 * key by dispatching `undefined`.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";
import { TextEditor } from "../TextEditor";

// Minimal TextField fixture — only the discriminant + identity keys
// the editor reads are meaningful. Narrowing constraints elsewhere
// use the full kind shape.
const baseField: TextField = {
	kind: "text",
	uuid: asUuid("u1"),
	id: "name",
	label: "Name",
};

describe("TextEditor", () => {
	it("renders the label and current value", () => {
		render(
			<TextEditor
				field={baseField}
				value="Enter your name"
				onChange={() => {}}
				label="Hint"
				keyName="hint"
			/>,
		);
		// getByText/getByDisplayValue throw if absent — presence is the assertion.
		expect(screen.getByText("Hint").textContent).toContain("Hint");
		expect(
			(screen.getByDisplayValue("Enter your name") as HTMLInputElement).value,
		).toBe("Enter your name");
	});

	it("dispatches the trimmed next value on commit", () => {
		const onChange = vi.fn();
		render(
			<TextEditor
				field={baseField}
				value="hello"
				onChange={onChange}
				label="Hint"
				keyName="hint"
			/>,
		);
		const input = screen.getByDisplayValue("hello") as HTMLInputElement;
		// Focus enters edit mode, change updates draft, blur commits it.
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "world" } });
		fireEvent.blur(input);
		expect(onChange).toHaveBeenCalledWith("world");
	});

	it("dispatches undefined when the input is cleared and committed", () => {
		const onChange = vi.fn();
		render(
			<TextEditor
				field={baseField}
				value="hello"
				onChange={onChange}
				label="Hint"
				keyName="hint"
			/>,
		);
		const input = screen.getByDisplayValue("hello") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);
		// Empty commit routes through onEmpty → onChange(undefined), which the
		// reducer treats as a property removal.
		expect(onChange).toHaveBeenCalledWith(undefined);
	});

	it("writes keyName to data-field-id so undo/redo focus hints target the input", () => {
		render(
			<TextEditor
				field={baseField}
				value="hi"
				onChange={() => {}}
				label="Hint"
				keyName="hint"
			/>,
		);
		const input = screen.getByDisplayValue("hi");
		expect(input.getAttribute("data-field-id")).toBe("hint");
	});
});
