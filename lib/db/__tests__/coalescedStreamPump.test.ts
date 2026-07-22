import { describe, expect, it, vi } from "vitest";
import {
	createCoalescedStreamPump,
	type StreamPumpRetryScheduler,
} from "../coalescedStreamPump";

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
} {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

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
		pump.close();
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
		pump.close();
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
		pump.close();
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
		pump.close();
	});

	it("close is idempotent, cancels retry, and makes late completion inert", async () => {
		const scheduler = manualRetryScheduler();
		const inFlight = deferred();
		const onError = vi.fn();
		const run = vi.fn<() => Promise<void>>().mockReturnValue(inFlight.promise);
		const pump = createCoalescedStreamPump({
			run,
			onError,
			scheduler: scheduler.scheduler,
		});

		pump.poke();
		pump.poke();
		pump.close();
		pump.close();
		inFlight.reject(new Error("late failure"));
		await settle();

		expect(onError).not.toHaveBeenCalled();
		expect(scheduler.retries).toHaveLength(0);
		expect(run).toHaveBeenCalledTimes(1);
		pump.poke();
		expect(run).toHaveBeenCalledTimes(1);
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

		pump.close();
		expect(retry.cancelled).toBe(true);
		scheduler.fire(retry);
		expect(run).toHaveBeenCalledTimes(1);
	});
});
