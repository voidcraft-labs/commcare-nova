import { describe, expect, it, vi } from "vitest";
import {
	createCoalescedStreamPump,
	type StreamPumpRetryScheduler,
} from "../coalescedStreamPump";

const deferred = () => Promise.withResolvers<void>();

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

interface ManualRetry {
	readonly delayMs: number;
	readonly callback: () => void;
	cancelled: boolean;
	fired: boolean;
}

function manualRetryScheduler(): {
	scheduler: StreamPumpRetryScheduler;
	retries: ManualRetry[];
	fire: (retry: ManualRetry) => void;
} {
	const retries: ManualRetry[] = [];
	return {
		retries,
		scheduler(callback, delayMs) {
			const retry = { delayMs, callback, cancelled: false, fired: false };
			retries.push(retry);
			return () => {
				retry.cancelled = true;
			};
		},
		fire(retry) {
			if (retry.cancelled || retry.fired) return;
			retry.fired = true;
			retry.callback();
		},
	};
}

describe("createCoalescedStreamPump", () => {
	it("owns the default retry timer through shutdown", async () => {
		vi.useFakeTimers();
		let reads = 0;
		const pump = createCoalescedStreamPump({
			async run() {
				reads++;
				throw new Error("temporary read failure");
			},
			onError() {},
		});
		try {
			pump.poke();
			await pump.drain();
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(249);
			expect(reads).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(reads).toBe(2);
			expect(vi.getTimerCount()).toBe(1);
			await pump.close();
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(reads).toBe(2);
		} finally {
			await pump.close();
			vi.useRealTimers();
		}
	});

	it.each(["resolve", "reject"] as const)(
		"close awaits the active read's %s and suppresses queued work",
		async (outcome) => {
			const read = Promise.withResolvers<void>();
			let reads = 0;
			const faults: unknown[] = [];
			const pump = createCoalescedStreamPump({
				run: () => {
					reads++;
					return read.promise;
				},
				onError: (error) => faults.push(error),
			});
			pump.poke();
			pump.poke();
			let closed = 0;
			const first = pump.close().then(() => {
				closed++;
			});
			const second = pump.close().then(() => {
				closed++;
			});
			await settle();
			expect(closed).toBe(0);
			if (outcome === "resolve") read.resolve();
			else read.reject(new Error("connection ended"));
			await Promise.all([first, second]);
			pump.poke();
			expect({ closed, reads, faults }).toEqual({
				closed: 2,
				reads: 1,
				faults: [],
			});
		},
	);

	it("drain awaits a coalesced follow-up and permits later reads", async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const reachedSecond = Promise.withResolvers<void>();
		let reads = 0;
		const pump = createCoalescedStreamPump({
			run: async () => {
				reads++;
				if (reads === 1) await first.promise;
				if (reads === 2) {
					reachedSecond.resolve();
					await second.promise;
				}
			},
			onError: (error) => {
				throw error;
			},
		});
		pump.poke();
		pump.poke();
		let drained = false;
		const drain = pump.drain().then(() => {
			drained = true;
		});
		first.resolve();
		await reachedSecond.promise;
		expect(drained).toBe(false);
		second.resolve();
		await drain;
		expect(reads).toBe(2);
		pump.poke();
		await pump.drain();
		expect(reads).toBe(3);
		await pump.close();
	});

	it("is single-flight and coalesces every poke during a run into one follow-up", async () => {
		const first = deferred();
		const second = deferred();
		const run = vi
			.fn<() => Promise<void>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const pump = createCoalescedStreamPump({ run, onError: vi.fn() });

		pump.poke();
		pump.poke();
		pump.poke();
		expect(run).toHaveBeenCalledTimes(1);

		first.resolve();
		await settle();
		expect(run).toHaveBeenCalledTimes(2);

		second.resolve();
		await settle();
		expect(run).toHaveBeenCalledTimes(2);
		await pump.close();
	});

	it("reports failures and retries indefinitely with capped exponential delay", async () => {
		const scheduler = manualRetryScheduler();
		const fault = new Error("read failed");
		const onError = vi.fn();
		const run = vi.fn<() => Promise<void>>().mockRejectedValue(fault);
		const pump = createCoalescedStreamPump({
			run,
			onError,
			scheduler: scheduler.scheduler,
			retryMinMs: 10,
			retryMaxMs: 40,
		});

		pump.poke();
		for (const expectedDelay of [10, 20, 40, 40, 40, 40]) {
			await settle();
			const retry = scheduler.retries.at(-1);
			expect(retry?.delayMs).toBe(expectedDelay);
			if (!retry) throw new Error("retry was not scheduled");
			scheduler.fire(retry);
		}
		await settle();

		expect(run).toHaveBeenCalledTimes(7);
		expect(onError).toHaveBeenCalledTimes(7);
		expect(onError).toHaveBeenLastCalledWith(fault);
		await pump.close();
	});

	it("lets a poke cancel a waiting retry and catch up immediately", async () => {
		const scheduler = manualRetryScheduler();
		const catchUp = deferred();
		const run = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("transient"))
			.mockReturnValueOnce(catchUp.promise);
		const pump = createCoalescedStreamPump({
			run,
			onError: vi.fn(),
			scheduler: scheduler.scheduler,
		});

		pump.poke();
		await settle();
		const retry = scheduler.retries[0];
		if (!retry) throw new Error("retry was not scheduled");

		pump.poke();
		expect(retry.cancelled).toBe(true);
		expect(run).toHaveBeenCalledTimes(2);
		scheduler.fire(retry);
		expect(run).toHaveBeenCalledTimes(2);

		catchUp.resolve();
		await settle();
		await pump.close();
	});

	it("resets backoff only after a successful read", async () => {
		const scheduler = manualRetryScheduler();
		const run = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("first"))
			.mockRejectedValueOnce(new Error("second"))
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(new Error("after success"));
		const pump = createCoalescedStreamPump({
			run,
			onError: vi.fn(),
			scheduler: scheduler.scheduler,
			retryMinMs: 10,
			retryMaxMs: 40,
		});

		pump.poke();
		await settle();
		const firstRetry = scheduler.retries[0];
		if (!firstRetry) throw new Error("first retry was not scheduled");
		scheduler.fire(firstRetry);
		await settle();
		const secondRetry = scheduler.retries[1];
		if (!secondRetry) throw new Error("second retry was not scheduled");
		expect(secondRetry.delayMs).toBe(20);

		// A fresh poke preempts the wait but does not erase the failure streak.
		pump.poke();
		expect(secondRetry.cancelled).toBe(true);
		await settle();
		pump.poke();
		await settle();

		expect(scheduler.retries.at(-1)?.delayMs).toBe(10);
		await pump.close();
	});

	it("close cancels an already scheduled retry", async () => {
		const scheduler = manualRetryScheduler();
		const run = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("no"));
		const pump = createCoalescedStreamPump({
			run,
			onError: vi.fn(),
			scheduler: scheduler.scheduler,
		});

		pump.poke();
		await settle();
		const retry = scheduler.retries[0];
		if (!retry) throw new Error("retry was not scheduled");

		await pump.close();
		expect(retry.cancelled).toBe(true);
		scheduler.fire(retry);
		expect(run).toHaveBeenCalledTimes(1);
	});
});
