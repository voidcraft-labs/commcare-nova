import { describe, expect, it } from "vitest";
import {
	nextWebFormActivity,
	type WebFormActivity,
	webFormActivityWindow,
} from "../webFormActivity";

const opened: WebFormActivity = {
	workerId: "ruth",
	workerName: "Ruth",
	title: "A visit",
	windowSeconds: 3600,
	kind: "opened",
	at: 10_000,
};
const submitted: WebFormActivity = { ...opened, kind: "submitted" };

describe("recent form activity in Web Apps", () => {
	it("reads an integer window like Formplayer and caps the time an event is visible", () => {
		for (const value of [
			null,
			"",
			" 8",
			"8.0",
			"-",
			"2147483648",
			"-2147483649",
			"𝟠",
		]) {
			expect(webFormActivityWindow(value)).toBe(300);
		}
		expect(webFormActivityWindow("+٠٨")).toBe(8);
		expect(webFormActivityWindow("7200")).toBe(3600);
		expect(webFormActivityWindow("-2147483648")).toBe(-2147483648);
		expect(webFormActivityWindow("0")).toBe(0);
	});
	it("keeps a submission through earlier, simultaneous and later restores", () => {
		const next = { ...opened, workerId: "mai", at: opened.at + 3_599_000 };
		for (const [watermark, stale] of [
			[submitted.at - 1, true],
			[submitted.at, false],
		] as const) {
			expect(nextWebFormActivity(submitted, next, watermark)).toMatchObject({
				write: null,
				notice: {
					kind: "submitted",
					workerName: "Ruth",
					dataMayHaveChanged: stale,
				},
			});
		}
		expect(nextWebFormActivity(submitted, next, submitted.at + 1)).toEqual({
			write: null,
			notice: null,
		});
		const expired = { ...next, at: opened.at + 3_600_000 };
		expect(nextWebFormActivity(submitted, expired, 0)).toEqual({
			write: expired,
			notice: null,
		});
	});
	it("records another open even after a sync and keeps the original worker's title and window at submit", () => {
		const next = {
			...opened,
			at: opened.at + 1,
			workerId: "ada",
			title: "Another visit",
		};
		expect(nextWebFormActivity(opened, next, next.at)).toMatchObject({
			write: next,
			notice: { kind: "opened", title: "A visit", dataMayHaveChanged: false },
		});
		const event = {
			...submitted,
			title: "Edited",
			windowSeconds: 0,
			at: opened.at + 2,
		};
		expect(nextWebFormActivity(opened, event, 0)).toEqual({
			write: { ...event, windowSeconds: 3600, title: opened.title },
			notice: null,
		});
		expect(() => nextWebFormActivity(null, event, 0)).toThrow(
			"greater than zero",
		);
		expect(
			nextWebFormActivity(submitted, { ...opened, windowSeconds: 0 }, 0),
		).toEqual({ write: null, notice: null });
	});
});
