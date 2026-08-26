import { afterEach, describe, expect, it, vi } from "vitest";
import { javaRosaSleep } from "../javaRosaSleep";

afterEach(() => vi.useRealTimers());

describe("JavaRosa sleep boundary", () => {
	it("resolves the already-evaluated value after the duration", async () => {
		vi.useFakeTimers();
		const result = javaRosaSleep(25, { value: 7 });
		await vi.advanceTimersByTimeAsync(24);
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toEqual({ value: 7 });
	});

	it("supports cancellation without leaking the timer", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const result = javaRosaSleep(25, "value", controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(result).rejects.toThrow("cancelled");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects durations Java Thread.sleep cannot accept", async () => {
		await expect(javaRosaSleep(-1, true)).rejects.toThrow(
			"nonnegative integer",
		);
	});
});
