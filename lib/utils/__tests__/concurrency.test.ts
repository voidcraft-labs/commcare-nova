/**
 * Tests for `mapWithConcurrency` — the bounded-parallel mapper the media
 * manifest uses to cap how many GCS downloads run at once.
 *
 * Determinism without timers: items yield a controlled number of microtask
 * ticks so completion order is exercised against input order with no
 * wall-clock dependency (and nothing left scheduled past the test, which
 * would trip the async-leak gate).
 */

import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
	it("preserves input order even when later items complete first", async () => {
		const out = await mapWithConcurrency([0, 1, 2, 3], 4, async (n) => {
			// Earlier items yield MORE microtask ticks, so they settle LAST —
			// completion order is the reverse of input order.
			for (let i = 0; i < 4 - n; i++) await Promise.resolve();
			return n * 10;
		});
		// Results are written by index, so order matches the input regardless.
		expect(out).toEqual([0, 10, 20, 30]);
	});

	it("runs in parallel but never exceeds the limit", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapWithConcurrency(
			Array.from({ length: 9 }, (_, i) => i),
			3,
			async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await Promise.resolve();
				await Promise.resolve();
				inFlight--;
			},
		);
		// Bounded at the limit (the property under test)…
		expect(peak).toBeLessThanOrEqual(3);
		// …and actually concurrent, not serialized one-at-a-time.
		expect(peak).toBeGreaterThan(1);
	});

	it("propagates the first rejection", async () => {
		await expect(
			mapWithConcurrency([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error("boom");
				return n;
			}),
		).rejects.toThrow("boom");
	});

	it("returns an empty array for empty input", async () => {
		expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
	});
});
