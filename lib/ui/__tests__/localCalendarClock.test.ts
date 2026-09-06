import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalCalendarClock } from "../localCalendarClock";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("TZ", "America/Los_Angeles");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

it("publishes one new identity after midnight and keeps one timer", () => {
	vi.setSystemTime(new Date(2026, 6, 17, 23, 59, 59, 900));
	const clock = createLocalCalendarClock();
	const before = clock.getSnapshot();
	const observed: Date[] = [];
	const stop = clock.subscribe(() => observed.push(clock.getSnapshot()));
	try {
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(124);
		expect(clock.getSnapshot()).toBe(before);
		vi.advanceTimersByTime(1);
		expect(clock.getSnapshot()).toEqual(new Date(2026, 6, 18, 0, 0, 0, 25));
		expect(observed).toEqual([clock.getSnapshot()]);
		expect(vi.getTimerCount()).toBe(1);
	} finally {
		stop();
	}
	expect(vi.getTimerCount()).toBe(0);
});

it.each([
	["spring forward", new Date("2026-03-08T00:00:00-08:00"), 23],
	["fall back", new Date("2026-11-01T00:00:00-07:00"), 25],
])("schedules the next local midnight across %s", (_label, start, hours) => {
	vi.setSystemTime(start);
	const clock = createLocalCalendarClock();
	const stop = clock.subscribe(() => {});
	try {
		const before = clock.getSnapshot();
		vi.advanceTimersByTime(hours * 3_600_000 + 24);
		expect(clock.getSnapshot()).toBe(before);
		vi.advanceTimersByTime(1);
		expect(clock.getSnapshot().getDate()).toBe(before.getDate() + 1);
		expect(clock.getSnapshot().getHours()).toBe(0);
		expect(clock.getSnapshot().getMinutes()).toBe(0);
	} finally {
		stop();
	}
});

it("resyncs forward and backward clock changes without notifying for the same day", () => {
	vi.setSystemTime(new Date(2026, 6, 17, 10));
	const clock = createLocalCalendarClock();
	const first = clock.getSnapshot();
	const observed: Date[] = [];
	const stop = clock.subscribe(() => observed.push(clock.getSnapshot()));
	try {
		vi.setSystemTime(new Date(2026, 6, 17, 20));
		clock.sync();
		expect(clock.getSnapshot()).toBe(first);
		expect(observed).toEqual([]);
		vi.setSystemTime(new Date(2026, 6, 20, 10));
		clock.sync();
		vi.setSystemTime(new Date(2026, 6, 16, 23, 59, 59, 900));
		clock.sync();
		expect(observed.map((day) => day.getDate())).toEqual([20, 16]);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(125);
		expect(observed.map((day) => day.getDate())).toEqual([20, 16, 17]);
	} finally {
		stop();
	}
});

it("shares its timer, stops with the last subscriber and resyncs when subscribed again", () => {
	vi.setSystemTime(new Date(2026, 6, 17, 10));
	const clock = createLocalCalendarClock();
	expect(vi.getTimerCount()).toBe(0);
	const first = vi.fn();
	const second = vi.fn();
	const stopFirst = clock.subscribe(first);
	const stopSecond = clock.subscribe(second);
	expect(vi.getTimerCount()).toBe(1);
	stopFirst();
	expect(vi.getTimerCount()).toBe(1);
	vi.setSystemTime(new Date(2026, 6, 18, 10));
	clock.sync();
	expect(first).not.toHaveBeenCalled();
	expect(second).toHaveBeenCalledTimes(1);
	stopSecond();
	expect(vi.getTimerCount()).toBe(0);
	vi.setSystemTime(new Date(2026, 6, 20, 10));
	const stopAgain = clock.subscribe(second);
	expect(second).toHaveBeenCalledTimes(2);
	expect(clock.getSnapshot().getDate()).toBe(20);
	stopAgain();
	expect(vi.getTimerCount()).toBe(0);
});
