// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocalCalendarDay } from "../useLocalCalendarDay";

function DayProbe() {
	const day = useLocalCalendarDay();
	return (
		<output aria-label="local day">
			{day.getFullYear()}-{String(day.getMonth() + 1).padStart(2, "0")}-
			{String(day.getDate()).padStart(2, "0")}
		</output>
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("useLocalCalendarDay", () => {
	it("updates an Activity-preserved screen when local midnight passes", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 6, 17, 23, 59, 59, 900));
		const view = render(<DayProbe />);

		expect(screen.getByLabelText("local day").textContent).toBe("2026-07-17");
		act(() => vi.advanceTimersByTime(200));
		expect(screen.getByLabelText("local day").textContent).toBe("2026-07-18");

		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
