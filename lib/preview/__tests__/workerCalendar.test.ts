import { expect, it } from "vitest";
import {
	calendarDay,
	calendarDayOfIso,
	calendarMonth,
	isoOfCalendarDay,
} from "../workerCalendar";

it("uses the civil Gregorian day for both worker calendars across the Ethiopian new year", () => {
	const day = Date.UTC(2023, 8, 12) / 86400000;
	expect(calendarDay(day, "ethiopian")).toEqual({
		year: 2016,
		month: 1,
		day: 1,
	});
	expect(calendarDay(day - 1, "ethiopian")).toEqual({
		year: 2015,
		month: 13,
		day: 6,
	});
	expect(
		calendarMonth(day - 1, "ethiopian")?.dates.map(isoOfCalendarDay),
	).toEqual([
		"2023-09-06",
		"2023-09-07",
		"2023-09-08",
		"2023-09-09",
		"2023-09-10",
		"2023-09-11",
	]);
});
it("uses Core's Nepali month lengths, epoch and 32-day months", () => {
	expect(calendarDay(0, "nepali")).toEqual({ year: 2026, month: 9, day: 17 });
	const oct = Date.UTC(2024, 9, 2) / 86400000;
	expect(calendarDay(oct, "nepali")).toEqual({ year: 2081, month: 6, day: 16 });
	const month = calendarMonth(oct, "nepali");
	if (!month?.next) throw new Error("The 2081 month and next month must exist");
	expect(calendarDay(month.start - 1, "nepali")?.month).toBe(5);
	expect(calendarDay(month.next, "nepali")?.day).toBe(1);
	expect(calendarMonth(month.start - 1, "nepali")?.dates.length).toBe(31);
	expect(calendarDayOfIso("2024-02-30")).toBeUndefined();
});
