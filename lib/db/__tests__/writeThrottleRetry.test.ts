/**
 * Write-throttle ride-out contract for `runThrottledTransaction`.
 *
 * Firestore's write throttle ("This database has exceeded their maximum
 * bandwidth for writes…") reaches the client in transport-dependent shapes,
 * and the wrapper must recognize all of them because the SDK's own
 * transaction retry only recognizes the gRPC one:
 *
 *   - REST (`preferRest`, production): a raw `Error` whose message is the
 *     HTTP 429 response body, verbatim. `REST_THROTTLE_MESSAGE` below replays
 *     the exact body prod logged when an unretried throttle hard-failed
 *     /api/chat with "credit reservation failed".
 *   - REST, structured: a Gaxios-style error carrying `status: 429` (no
 *     recognizable message text, so only the structural check can match it).
 *   - gRPC (emulator, `preferRest` off): a GoogleError-style `code === 8`.
 *
 * Everything else must propagate on the FIRST attempt: retrying a business
 * rejection (the credit gate's `OutOfCreditsError`) would stall the request
 * ~8s only to fail identically, and contention ABORTs are already retried
 * inside `runTransaction` itself.
 */
import type { Firestore, Transaction } from "@google-cloud/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Each throttle bounce emits a `log.warn` (the shed-visibility contract);
 * stub the logger so retry tests stay silent and the warn call is assertable. */
const warnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
	log: { warn: warnMock, error: vi.fn(), info: vi.fn(), critical: vi.fn() },
}));

import { runThrottledTransaction, runThrottledWrite } from "@/lib/db/firestore";

const THROTTLE_TEXT =
	"This database has exceeded their maximum bandwidth for writes, please retry with exponential backoff. To learn more about best practices for increasing traffic, see 'Ramping up traffic' section of the support documentation.";

const REST_THROTTLE_MESSAGE = JSON.stringify(
	{
		error: {
			code: 429,
			message: THROTTLE_TEXT,
			errors: [
				{
					message: THROTTLE_TEXT,
					domain: "global",
					reason: "rateLimitExceeded",
				},
			],
			status: "RESOURCE_EXHAUSTED",
		},
	},
	null,
	2,
);

/**
 * A Firestore stub whose `runTransaction` throws `errors` in order, then runs
 * the update function for real — one throw per attempt, so call counts read
 * as attempt counts.
 */
function stubDb(errors: unknown[]) {
	let calls = 0;
	const runTransaction = vi.fn(
		async <T>(updateFunction: (tx: Transaction) => Promise<T>): Promise<T> => {
			const i = calls++;
			if (i < errors.length) throw errors[i];
			return updateFunction({} as Transaction);
		},
	);
	return { db: { runTransaction } as unknown as Firestore, runTransaction };
}

describe("runThrottledTransaction", () => {
	beforeEach(() => {
		warnMock.mockClear();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("rides out the REST-shaped throttle (raw 429 body as the message) and commits", async () => {
		const { db, runTransaction } = stubDb([
			new Error(REST_THROTTLE_MESSAGE),
			new Error(REST_THROTTLE_MESSAGE),
		]);
		const result = runThrottledTransaction(db, async () => "committed");
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe("committed");
		expect(runTransaction).toHaveBeenCalledTimes(3);
		// One warning per bounce — the shed-visibility contract.
		expect(warnMock).toHaveBeenCalledTimes(2);
	});

	it("rides out the gRPC-shaped throttle (code 8, no message text)", async () => {
		const { db, runTransaction } = stubDb([
			Object.assign(new Error("write throttled"), { code: 8 }),
		]);
		const result = runThrottledTransaction(db, async () => 7);
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe(7);
		expect(runTransaction).toHaveBeenCalledTimes(2);
	});

	it("rides out a structured HTTP 429 (Gaxios `status`, no message text)", async () => {
		const { db, runTransaction } = stubDb([
			Object.assign(new Error("Too Many Requests"), { status: 429 }),
		]);
		const result = runThrottledTransaction(db, async () => true);
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe(true);
		expect(runTransaction).toHaveBeenCalledTimes(2);
	});

	it("propagates a non-throttle error on the first attempt, no backoff scheduled", async () => {
		const { db, runTransaction } = stubDb([
			new Error("app document missing for appId=x"),
		]);
		await expect(
			runThrottledTransaction(db, async () => "unreachable"),
		).rejects.toThrow(/app document missing/);
		expect(runTransaction).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never classifies a transaction BODY error, whatever its message says", async () => {
		// A commit-gate rejection quoting user-authored text that matches the
		// message fallback must propagate on the first attempt — the classifier
		// applies to transport errors only (recognized by identity).
		const { db, runTransaction } = stubDb([]);
		const bodyRejection = new Error(
			`Field label "rateLimitExceeded — maximum bandwidth for writes" is invalid`,
		);
		await expect(
			runThrottledTransaction(db, async () => {
				throw bodyRejection;
			}),
		).rejects.toBe(bodyRejection);
		expect(runTransaction).toHaveBeenCalledTimes(1);
		expect(warnMock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("matches a stringified HTTP status ('429' on status)", async () => {
		const { db, runTransaction } = stubDb([
			Object.assign(new Error("Too Many Requests"), { status: "429" }),
		]);
		const result = runThrottledTransaction(db, async () => 1);
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe(1);
		expect(runTransaction).toHaveBeenCalledTimes(2);
	});

	it("runThrottledWrite rides out a shed on a plain write and propagates other errors", async () => {
		let calls = 0;
		const flaky = vi.fn(async () => {
			calls++;
			if (calls === 1)
				throw Object.assign(new Error("Too Many Requests"), { status: 429 });
			return "written";
		});
		const result = runThrottledWrite(flaky);
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe("written");
		expect(flaky).toHaveBeenCalledTimes(2);

		const hardFail = vi.fn(async () => {
			throw new Error("document missing");
		});
		await expect(runThrottledWrite(hardFail)).rejects.toThrow(
			/document missing/,
		);
		expect(hardFail).toHaveBeenCalledTimes(1);
	});

	it("gives up once the backoff schedule is exhausted and rethrows the throttle", async () => {
		const throttle = () => new Error(REST_THROTTLE_MESSAGE);
		const { db, runTransaction } = stubDb([
			throttle(),
			throttle(),
			throttle(),
			throttle(),
			throttle(),
		]);
		const result = runThrottledTransaction(db, async () => "unreachable");
		const assertion = expect(result).rejects.toThrow(
			/maximum bandwidth for writes/,
		);
		await vi.runAllTimersAsync();
		await assertion;
		expect(runTransaction).toHaveBeenCalledTimes(5);
	});
});
