// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	CustomDatePatternInput,
	type DatePatternPreset,
} from "../primitives/CustomDatePatternInput";

const PRESETS: readonly DatePatternPreset[] = [
	{ id: "short", label: "Short", pattern: "short" },
	{ id: "long", label: "Long", pattern: "long" },
	{ id: "iso", label: "Year-month-day", pattern: "iso" },
];

function renderPattern(
	value: string,
	onChange: (next: string) => void = () => {},
) {
	return render(
		<CustomDatePatternInput
			value={value}
			onChange={onChange}
			presets={PRESETS}
		/>,
	);
}

async function settleDisclosureAnimation() {
	await act(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
}

describe("CustomDatePatternInput — common choices", () => {
	it("commits a preset without revealing technical syntax", () => {
		const onChange = vi.fn();
		renderPattern("short", onChange);

		fireEvent.click(screen.getByRole("button", { name: "Year-month-day" }));

		expect(onChange).toHaveBeenCalledWith("iso");
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("starts Custom from a real pattern", () => {
		const onChange = vi.fn();
		render(
			<CustomDatePatternInput
				value="short"
				onChange={onChange}
				presets={PRESETS}
				customSeed="%d-%b-%Y"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Custom" }));

		expect(onChange).toHaveBeenCalledWith("%d-%b-%Y");
	});

	it("shows a live example for a preset", () => {
		renderPattern("long");

		expect(screen.getByText("Example")).toBeDefined();
		expect(screen.getByText("“July 7, 2026”")).toBeDefined();
	});
});

describe("CustomDatePatternInput — custom style", () => {
	it("preserves an imported pattern and explains it only in Custom", () => {
		const onChange = vi.fn();
		renderPattern("Report %A, %B %e (%Y)", onChange);

		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		}) as HTMLInputElement;
		expect(input.value).toBe("Report %A, %B %e (%Y)");
		expect(screen.getByText("“Report Tuesday, July 7 (2026)”")).toBeDefined();
		expect(screen.queryByRole("button", { name: /Insert year/ })).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("reveals plain-language pieces on request and keeps 44px targets", async () => {
		renderPattern("%Y");

		const guide = screen.getByRole("button", {
			name: "Choose date pieces",
		});
		expect(guide.className).toContain("h-11");
		fireEvent.click(guide);
		await settleDisclosureAnimation();

		const year = screen.getByRole("button", {
			name: "Insert year, shown as 2026",
		});
		expect(year.className).toContain("min-h-11");
		expect(
			screen.getByRole("button", {
				name: "Insert time zone, shown as -07",
			}),
		).toBeDefined();
	});

	it("inserts a chosen piece at the caret in the one pattern input", async () => {
		const onChange = vi.fn();
		renderPattern("%Y-", onChange);
		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		}) as HTMLInputElement;
		input.focus();
		input.setSelectionRange(3, 3);

		fireEvent.click(screen.getByRole("button", { name: "Choose date pieces" }));
		await settleDisclosureAnimation();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Insert month number, shown as 07",
			}),
		);

		expect(input.value).toBe("%Y-%m");
		expect(document.activeElement).toBe(input);
		fireEvent.blur(input);
		expect(onChange).toHaveBeenCalledWith("%Y-%m");
	});

	it("updates the human example for every valid draft before commit", () => {
		const onChange = vi.fn();
		renderPattern("%d-%b-%Y", onChange);
		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		});

		fireEvent.change(input, { target: { value: "%B %e, %Y" } });

		expect(screen.getByText("“July 7, 2026”")).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("commits a supported draft on Enter", () => {
		const onChange = vi.fn();
		renderPattern("%Y", onChange);
		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		});
		fireEvent.change(input, { target: { value: "%Y %B" } });

		fireEvent.keyDown(input, { key: "Enter" });

		expect(onChange).toHaveBeenCalledWith("%Y %B");
	});

	it("keeps an unsupported draft visible with a specific correction", () => {
		const onChange = vi.fn();
		renderPattern("%d-%b-%Y", onChange);
		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		}) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "%Q" } });

		fireEvent.blur(input);

		expect(input.value).toBe("%Q");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(
			screen.getByText(
				"%Q isn’t a date piece. Choose another piece or remove it",
			),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("explains an unfinished percent piece without discarding it", () => {
		renderPattern("%Y");
		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		}) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "Date %" } });

		fireEvent.blur(input);

		expect(input.value).toBe("Date %");
		expect(
			screen.getByText("Finish the date piece after % or remove it"),
		).toBeDefined();
	});

	it("treats literal whitespace as a supported imported pattern", () => {
		const onChange = vi.fn();
		renderPattern("%Y", onChange);
		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		});
		fireEvent.change(input, { target: { value: "   " } });

		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledWith("   ");
		expect(screen.queryByText(/Enter a custom style/)).toBeNull();
	});

	it("refuses an empty draft and keeps it available for correction", () => {
		const onChange = vi.fn();
		renderPattern("%Y", onChange);
		const input = screen.getByRole("textbox", {
			name: "Custom date style",
		}) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "" } });

		fireEvent.blur(input);

		expect(input.value).toBe("");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(
			screen.getByText("Enter a custom style or choose a date piece"),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});
});
