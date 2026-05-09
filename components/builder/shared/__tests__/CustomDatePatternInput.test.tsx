// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/CustomDatePatternInput.test.tsx
//
// Empty-pattern signal tests for the shared
// `CustomDatePatternInput` primitive. The primitive is mounted by
// both `cards/expression/FormatDateCard` and
// `cards/column/DateColumnCard`; testing it once at the primitive
// level pins the behavior for both consumers without duplicating
// the assertion across the cards.
//
// Pinned behaviors:
//   1. Preset click commits the preset's pattern verbatim.
//   2. "Custom" button switches to free-text mode and seeds the
//      input with the supplied `customSeed`.
//   3. Empty-string commit on blur is REFUSED — the primitive
//      surfaces `aria-invalid="true"`, renders the inline error
//      message, and does NOT call `onChange`.
//   4. Non-empty draft commits on blur and clears the error
//      signal.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	CustomDatePatternInput,
	type DatePatternPreset,
} from "../primitives/CustomDatePatternInput";

const PRESETS: readonly DatePatternPreset[] = [
	{ id: "short", label: "Short", pattern: "short" },
	{ id: "long", label: "Long", pattern: "long" },
	{ id: "iso", label: "ISO", pattern: "%Y-%m-%d" },
];

describe("CustomDatePatternInput — preset selection", () => {
	it("commits the preset pattern verbatim on click", () => {
		const onChange = vi.fn();
		render(
			<CustomDatePatternInput
				value="short"
				onChange={onChange}
				presets={PRESETS}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^iso$/i }));
		expect(onChange).toHaveBeenCalledWith("%Y-%m-%d");
	});

	it("switching from preset to custom seeds with the customSeed pattern", () => {
		const onChange = vi.fn();
		render(
			<CustomDatePatternInput
				value="short"
				onChange={onChange}
				presets={PRESETS}
				customSeed="%d-%b-%Y"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^custom$/i }));
		expect(onChange).toHaveBeenCalledWith("%d-%b-%Y");
	});

	it("custom branch shows the free-text input when value isn't a preset", () => {
		const { container } = render(
			<CustomDatePatternInput
				value="%d-%b-%Y"
				onChange={() => {}}
				presets={PRESETS}
			/>,
		);
		const customInput = container.querySelector(
			'input[aria-label="Custom date pattern"]',
		);
		expect(customInput).not.toBeNull();
	});

	it("preset branch hides the free-text input", () => {
		const { container } = render(
			<CustomDatePatternInput
				value="short"
				onChange={() => {}}
				presets={PRESETS}
			/>,
		);
		const customInput = container.querySelector(
			'input[aria-label="Custom date pattern"]',
		);
		expect(customInput).toBeNull();
	});
});

describe("CustomDatePatternInput — empty-pattern signal", () => {
	it("refuses an empty-string commit on blur and surfaces the error", () => {
		const onChange = vi.fn();
		const { container } = render(
			<CustomDatePatternInput
				value="%d-%b-%Y"
				onChange={onChange}
				presets={PRESETS}
			/>,
		);
		const input = screen.getByLabelText(
			"Custom date pattern",
		) as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);
		expect(onChange).not.toHaveBeenCalled();
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(container.textContent).toMatch(/cannot be empty/i);
	});

	it("clears the error signal on the next non-empty keystroke", () => {
		const onChange = vi.fn();
		const { container } = render(
			<CustomDatePatternInput
				value="%d-%b-%Y"
				onChange={onChange}
				presets={PRESETS}
			/>,
		);
		const input = screen.getByLabelText(
			"Custom date pattern",
		) as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);
		// Error visible.
		expect(container.textContent).toMatch(/cannot be empty/i);
		// Re-focus and type a real pattern; the error clears as
		// soon as the draft is non-empty.
		input.focus();
		fireEvent.change(input, { target: { value: "%Y-%m-%d" } });
		expect(input.getAttribute("aria-invalid")).not.toBe("true");
	});

	it("commits a non-empty draft on blur", () => {
		const onChange = vi.fn();
		render(
			<CustomDatePatternInput
				value="%d-%b-%Y"
				onChange={onChange}
				presets={PRESETS}
			/>,
		);
		const input = screen.getByLabelText(
			"Custom date pattern",
		) as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: "%Y-%m" } });
		fireEvent.blur(input);
		expect(onChange).toHaveBeenCalledWith("%Y-%m");
	});

	it("treats whitespace-only draft as empty (refuses commit)", () => {
		const onChange = vi.fn();
		render(
			<CustomDatePatternInput
				value="%d-%b-%Y"
				onChange={onChange}
				presets={PRESETS}
			/>,
		);
		const input = screen.getByLabelText(
			"Custom date pattern",
		) as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.blur(input);
		expect(onChange).not.toHaveBeenCalled();
	});
});
