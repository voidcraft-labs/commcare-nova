/**
 * `withAppTx` — the one transaction entry point for `lib/db`, with a bounded
 * deadlock/serialization retry.
 *
 * This replaces the Firestore write-throttle ride-out (`runThrottledTransaction`
 * / `runThrottledWrite`): on Postgres the only transport-level transient worth a
 * bounded in-process retry is a serialization/deadlock SQLSTATE, and the SDK
 * doesn't retry those for us. `withAppTx` re-runs the body from scratch on a
 * `40P01` (deadlock detected) or `40001` (serialization failure), up to
 * `TX_RETRY_DELAYS_MS.length` times; every OTHER error — a domain rejection
 * (`OutOfCreditsError`, a commit-gate reject) or any non-retryable SQLSTATE
 * (e.g. a `23505` unique violation the guarded-commit dedup converges on itself)
 * — propagates on the FIRST attempt so a business rejection never stalls behind
 * a pointless backoff.
 *
 * Driven against an injected fake `Kysely<AppDatabase>` (via `__setAppDbForTests`)
 * whose `transaction().execute()` throws a scripted error per attempt, so call
 * counts read as attempt counts — no real database needed.
 */

import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppDbForTests, type AppDatabase, withAppTx } from "@/lib/db/pg";

afterEach(() => {
	__setAppDbForTests(null);
});

/**
 * A fake app-db whose `transaction().execute(body)` throws `errors` in order —
 * one throw per attempt, so `execute`'s call count IS the attempt count — then,
 * once the scripted errors run out, runs the body for real and returns its value.
 */
function fakeDb(errors: unknown[]) {
	const execute = vi.fn(
		async (body: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
			const attempt = execute.mock.calls.length - 1;
			if (attempt < errors.length) throw errors[attempt];
			return body({});
		},
	);
	const db = {
		transaction: () => ({ execute }),
	} as unknown as Kysely<AppDatabase>;
	return { db, execute };
}

describe("withAppTx retry", () => {
	it("retries a deadlock (40P01) and resolves once it clears", async () => {
		const { db, execute } = fakeDb([{ code: "40P01" }, { code: "40P01" }]);
		__setAppDbForTests(db);

		await expect(withAppTx(async () => "committed")).resolves.toBe("committed");
		// Two deadlock bounces + the successful third attempt.
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("retries a serialization failure (40001) the same way", async () => {
		const { db, execute } = fakeDb([{ code: "40001" }]);
		__setAppDbForTests(db);

		await expect(withAppTx(async () => 42)).resolves.toBe(42);
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("propagates a non-retryable SQLSTATE (23505 unique violation) on the first attempt", async () => {
		// The guarded-commit dedup converges a concurrent unique violation itself, so
		// `withAppTx` must NOT retry a 23505 — it propagates immediately.
		const err = { code: "23505" };
		const { db, execute } = fakeDb([err]);
		__setAppDbForTests(db);

		await expect(withAppTx(async () => "unreachable")).rejects.toBe(err);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("propagates a domain rejection (no SQLSTATE) on the first attempt", async () => {
		// A business rejection like `OutOfCreditsError` carries no retryable code;
		// retrying it would stall the request only to fail identically.
		const err = new Error("Out of credits for this period");
		const { db, execute } = fakeDb([err]);
		__setAppDbForTests(db);

		await expect(withAppTx(async () => "unreachable")).rejects.toBe(err);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("gives up once the backoff schedule is exhausted and rethrows the deadlock", async () => {
		// TX_RETRY_DELAYS_MS has length 3, so a persistently-deadlocking body runs
		// 1 initial attempt + 3 retries = 4 total, then the final error propagates.
		const err = { code: "40P01" };
		const { db, execute } = fakeDb([err, err, err, err, err]);
		__setAppDbForTests(db);

		await expect(withAppTx(async () => "unreachable")).rejects.toBe(err);
		expect(execute).toHaveBeenCalledTimes(4);
	});
});
