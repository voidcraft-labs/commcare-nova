// @vitest-environment happy-dom
//
// InlineField — the compact labeled text editor in the form-settings
// panel. These tests pin the field-level validity guard: when a
// `validate` predicate is supplied, an invalid value must NOT commit
// (no `onChange`), the value reverts, and the reason renders inline
// while the field is focused. A valid value commits normally; without
// the prop, behavior is unchanged.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InlineField } from "../InlineField";

// A representative validator: rejects values containing a space, returns
// a reason string; else null. Mirrors the `connectIdError` shape
// (`(value) => string | null`) without coupling the test to that helper.
const rejectsSpaces = (v: string): string | null =>
	v.includes(" ") ? "No spaces allowed" : null;

describe("InlineField — field-level validity guard", () => {
	it("does not commit an invalid value on blur and surfaces the reason", () => {
		const onChange = vi.fn();
		render(
			<InlineField
				label="Module ID"
				value="ok_id"
				onChange={onChange}
				validate={rejectsSpaces}
			/>,
		);

		const input = screen.getByLabelText("Module ID") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "bad id" } });

		// The reason is visible while focused (a "can't save, here's why",
		// not a silent revert).
		expect(screen.getByText("No spaces allowed")).toBeTruthy();

		fireEvent.blur(input);

		// Commit was aborted — the bad value never reached the consumer.
		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not commit an invalid value on Enter", () => {
		const onChange = vi.fn();
		render(
			<InlineField
				label="Module ID"
				value="ok_id"
				onChange={onChange}
				validate={rejectsSpaces}
			/>,
		);

		const input = screen.getByLabelText("Module ID") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "bad id" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onChange).not.toHaveBeenCalled();
	});

	it("commits a valid value normally", () => {
		const onChange = vi.fn();
		render(
			<InlineField
				label="Module ID"
				value="ok_id"
				onChange={onChange}
				validate={rejectsSpaces}
			/>,
		);

		const input = screen.getByLabelText("Module ID") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "new_valid_id" } });
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("new_valid_id");
	});

	it("does not show a reason for a valid draft", () => {
		const onChange = vi.fn();
		render(
			<InlineField
				label="Module ID"
				value="ok_id"
				onChange={onChange}
				validate={rejectsSpaces}
			/>,
		);

		const input = screen.getByLabelText("Module ID") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "still_valid" } });

		expect(screen.queryByText("No spaces allowed")).toBeNull();
	});
});
