// @vitest-environment happy-dom
//
// TextEditor: declarative editor for plain-string field keys
// (`hint`, etc.). The component is a thin adapter that maps the
// FieldEditorComponent contract onto the EditableText primitive.
// The interesting wrap (`onEmpty` ↔ `onChange(undefined)`) lives in
// the adapter; the "no-op on never-set" gate lives in
// `handleEmpty` so the redundant-on-undefined dispatch is skipped
// without changing the EditableText primitive: other consumers of
// the primitive (XPathEditor's `validate_msg` editor) need
// unconditional `onEmpty` for their UI-state cleanup arm.
//
// Tests below pin the family fix at this consumer's surface, when
// the underlying `value` is `undefined` (the slot is unset), a
// passive focus + blur on the input must not call `onChange`. Mirror
// of `DisplaySection`'s `OptionalTextRow` regression test, this time
// at the field-editor consumer.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { TextField } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { TextEditor } from "../TextEditor";

const baseField: TextField = {
	kind: "text",
	uuid: testUuid("u1-text"),
	id: "patient_name",
	label: proseText("Patient name"),
};

describe("TextEditor — onChange no-op gate", () => {
	it("does not fire onChange when focusing and blurring an empty input on an undefined-valued key", () => {
		// Pins the family fix: a user passively focusing then blurring
		// the hint editor (without typing anything) on a field whose
		// `hint` is undefined must not write `onChange(undefined)` to
		// the doc store. Without the gate the reducer would receive a
		// removal patch on a slot that was already absent: a no-op
		// downstream but a real undo-history entry the user never
		// asked for.
		const onChange = vi.fn();
		render(
			<TextEditor
				field={baseField}
				value={undefined}
				onChange={onChange}
				label="Hint"
				keyName="hint"
			/>,
		);

		const input = screen.getByLabelText("Hint");
		fireEvent.focus(input);
		fireEvent.blur(input);

		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not fire onChange when focusing and pressing Escape on an empty input on an undefined-valued key", () => {
		// Mirror of the above for the cancel arm. `useCommitField`'s
		// Esc-on-empty path also routes through `onEmpty` → `onChange`;
		// `handleEmpty`'s `value === undefined` gate covers both arms.
		const onChange = vi.fn();
		render(
			<TextEditor
				field={baseField}
				value={undefined}
				onChange={onChange}
				label="Hint"
				keyName="hint"
			/>,
		);

		const input = screen.getByLabelText("Hint") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.keyDown(input, { key: "Escape" });

		expect(onChange).not.toHaveBeenCalled();
	});

	it("fires onChange(undefined) when blurring after clearing a populated value", async () => {
		// The gate is "nothing to clear," not "never fire." When the
		// field already has a hint and the user empties it, the editor
		// still needs to dispatch the removal patch.
		//
		// Cast the spread to `TextField` so the inferred field shape
		// keeps `hint` as `string | undefined` rather than narrowing
		// it to `string`: `OptionalStringKeys<F>` excludes required
		// keys, and a string-literal `hint` would make TS reject
		// `keyName="hint"` against the editor's narrowed generic.
		const populatedField: TextField = {
			...baseField,
			hint: proseText("Tap to enter the patient's name."),
		};
		const onChange = vi.fn();
		render(
			<TextEditor
				field={populatedField}
				value={proseText("Tap to enter the patient's name.")}
				onChange={onChange}
				label="Hint"
				keyName="hint"
			/>,
		);

		const input = screen.getByLabelText("Hint") as HTMLInputElement;
		// `fireEvent.focus`, not the raw `input.focus()` DOM call: focusing
		// drives EditableText's `handleFocus` state update (draft snapshot +
		// focused flag), which must run inside React's act() scope. A bare
		// `.focus()` dispatches the event outside act and trips the
		// "update … was not wrapped in act(...)" warning.
		fireEvent.focus(input);
		// ProseMirror follows focus with a zero-delay selection sync. Let that
		// committed editor work finish before changing and blurring the value.
		// The 20 ms window also drains its populated-content DOM-observer sync.
		await act(async () => {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
		});
		input.textContent = "";
		fireEvent.input(input, { inputType: "deleteContentBackward" });
		await act(async () => {
			await Promise.resolve();
		});
		fireEvent.blur(input);
		// Tiptap completes `commands.blur()` on its next animation frame.
		// Await that owned work inside act so the test cannot leave Happy DOM's
		// requestAnimationFrame setImmediate behind for the leak detector.
		await act(async () => {
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
		});

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toBeUndefined();
	});
});
