import { afterEach, describe, expect, it, vi } from "vitest";
import { javaRosaSleep } from "../javaRosaSleep";

afterEach(() => vi.useRealTimers());

describe("JavaRosa sleep boundary", () => {
	it("resolves the original value at the deadline and releases its abort listener", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const value = { value: 7 };
		let settled = false;
		const result = javaRosaSleep(25, value, controller.signal);
		const observed = result.then(() => {
			settled = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(24);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(await result).toBe(value);
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			controller.abort();
			await Promise.allSettled([result, observed]);
		}
	});

	it("supports cancellation without leaking the timer", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const result = javaRosaSleep(25, "value", controller.signal);
		const rejected = expect(result).rejects.toThrow("cancelled");
		controller.abort(new Error("cancelled"));
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not schedule an already cancelled operation", async () => {
		vi.useFakeTimers();
		const reason = new Error("stale revision");
		await expect(
			javaRosaSleep(25, true, AbortSignal.abort(reason)),
		).rejects.toBe(reason);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects unsupported duration %s without scheduling", async (duration) => {
		vi.useFakeTimers();
		await expect(javaRosaSleep(duration, true)).rejects.toThrow(
			"nonnegative integer",
		);
		expect(vi.getTimerCount()).toBe(0);
	});
});
