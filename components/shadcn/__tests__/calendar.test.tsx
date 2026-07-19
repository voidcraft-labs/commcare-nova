// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Calendar } from "../calendar";

const JANUARY_2025 = new Date(2025, 0, 1);

describe("Calendar", () => {
	it("keeps day and month navigation controls at the shared touch height", () => {
		render(<Calendar mode="single" defaultMonth={JANUARY_2025} />);

		const calendar = document.querySelector<HTMLElement>(
			'[data-slot="calendar"]',
		);
		expect(calendar).not.toBeNull();
		expect(calendar?.className).toContain("[--cell-target-size:2.75rem]");
		expect(calendar?.className).toContain(
			"[--cell-size:min(2.75rem,calc((100dvw-3rem)/7))]",
		);

		const previous = screen.getByRole("button", { name: /previous month/i });
		const next = screen.getByRole("button", { name: /next month/i });
		expect(previous.className).toContain("size-(--cell-target-size)");
		expect(next.className).toContain("size-(--cell-target-size)");

		const firstDay = screen.getByRole("button", {
			name: /wednesday, january 1st, 2025/i,
		});
		expect(firstDay.className).toContain("h-(--cell-target-size)");
		expect(firstDay.className).toContain("w-(--cell-size)");
	});

	it("preserves the calendar's accessible button behavior", () => {
		const onSelect = vi.fn();
		render(
			<Calendar
				mode="single"
				defaultMonth={JANUARY_2025}
				onSelect={onSelect}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: /wednesday, january 1st, 2025/i,
			}),
		);

		expect(onSelect).toHaveBeenCalledOnce();
		expect(onSelect.mock.calls[0]?.[0]).toEqual(JANUARY_2025);
	});

	it("gives month and year dropdowns the same touch height", () => {
		render(
			<Calendar
				mode="single"
				defaultMonth={JANUARY_2025}
				captionLayout="dropdown"
			/>,
		);

		const dropdowns = screen.getAllByRole("combobox");
		expect(dropdowns).toHaveLength(2);
		for (const dropdown of dropdowns) {
			expect(dropdown.parentElement?.className).toContain(
				"h-(--cell-target-size)",
			);
		}
	});

	it("allows room for the optional week-number column on narrow viewports", () => {
		render(
			<Calendar mode="single" defaultMonth={JANUARY_2025} showWeekNumber />,
		);

		const calendar = document.querySelector<HTMLElement>(
			'[data-slot="calendar"]',
		);
		expect(calendar?.className).toContain(
			"[--cell-size:min(2.75rem,calc((100dvw-3rem)/8))]",
		);
	});
});
