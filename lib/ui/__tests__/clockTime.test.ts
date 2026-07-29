import { describe, expect, it } from "vitest";
import { storageTimeValue } from "@/lib/domain/temporalValues";
import { formatClockTime, parseClockTime } from "../clockTime";

describe("parseClockTime", () => {
	it("reads the locale clock a person types", () => {
		expect(parseClockTime("2:30 PM")).toBe("14:30:00");
		expect(parseClockTime("9:05am")).toBe("09:05:00");
		expect(parseClockTime("12:00 AM")).toBe("00:00:00");
		expect(parseClockTime("12:00 PM")).toBe("12:00:00");
	});

	it("still reads the bare 24-hour spelling", () => {
		expect(parseClockTime("14:30")).toBe("14:30:00");
		expect(parseClockTime("14:30:05")).toBe("14:30:05");
	});

	it("rejects text that is not a clock time", () => {
		expect(parseClockTime("2:3")).toBeNull();
		expect(parseClockTime("25:00")).toBeNull();
		expect(parseClockTime("14:60")).toBeNull();
		expect(parseClockTime("13:00 PM")).toBeNull();
		expect(parseClockTime("")).toBeNull();
	});
});

describe("formatClockTime", () => {
	it("projects a stored time to the clock a person reads", () => {
		expect(formatClockTime("14:30:00.000Z")).toBe("2:30 PM");
		expect(formatClockTime("09:05:00.000Z")).toBe("9:05 AM");
		expect(formatClockTime("00:00:00.000Z")).toBe("12:00 AM");
		expect(formatClockTime("12:00:00.000Z")).toBe("12:00 PM");
	});

	it("shows seconds only when the answer has them", () => {
		expect(formatClockTime("14:30:07.000Z")).toBe("2:30:07 PM");
	});

	it("reads a stored time that carries a real offset", () => {
		// A datetime's clock half is exactly this shape, and the wall clock
		// is what the field shows — the offset is the answer's zone, not a
		// conversion the display performs.
		expect(formatClockTime("14:30:00.000-05:00")).toBe("2:30 PM");
	});

	it("is the inverse of parseClockTime for every value it formats", () => {
		// The round trip is what lets a field show friendly text and still
		// commit the stored value after a focus and blur that changed
		// nothing. A projection that lost information would rewrite the
		// answer every time someone tabbed through it.
		for (const stored of [
			"14:30:00.000Z",
			"09:05:00.000Z",
			"00:00:00.000Z",
			"12:00:00.000Z",
			"23:59:59.000Z",
			"14:30:07.000Z",
		]) {
			const shown = formatClockTime(stored);
			expect(shown).not.toBeNull();
			expect(storageTimeValue(parseClockTime(shown as string) as string)).toBe(
				stored,
			);
		}
	});

	it("reads a stored time that predates the millisecond rule", () => {
		// The shape the pre-#376 writer left in rows. Requiring canonical
		// padding here would show a person wire text instead of a clock.
		expect(formatClockTime("08:45:00Z")).toBe("8:45 AM");
	});

	it("reads a datetime's own clock half, which carries no zone", () => {
		// A datetime's zone lives on the whole value, so the half is padded
		// and zoneless — still machine-written, still ours to project.
		expect(formatClockTime("14:30:00.000")).toBe("2:30 PM");
	});

	it("declines text that is not a stored time, so it is shown verbatim", () => {
		// Half-typed input above all: reformatting "2:30" into "2:30 AM"
		// under someone still reaching for PM is the one thing a field that
		// formats as you type must not do.
		expect(formatClockTime("2:30")).toBeNull();
		expect(formatClockTime("14:30")).toBeNull();
		expect(formatClockTime("14:30:00")).toBeNull();
		expect(formatClockTime("2:3")).toBeNull();
		expect(formatClockTime("2:30 PM")).toBeNull();
		expect(formatClockTime("")).toBeNull();
	});

	it("declines a stored time this spelling could not carry back", () => {
		// An imported fractional second has nowhere to go in a locale clock,
		// so the raw value stays on screen rather than being shown as one
		// that would commit back a half-second short.
		expect(formatClockTime("14:30:00.500Z")).toBeNull();
	});
});
