/**
 * `deriveRunId` unit tests.
 *
 * Server-side run_id derivation — clients never supply or see a
 * run_id; the server infers one from the app doc's current `run_id`
 * + `updated_at` state. Tests cover the three behavioral paths:
 *   - Within window, `currentRunId` is reused as-is (continuing run).
 *   - Beyond window, a fresh UUID v4 is minted (closing the old run
 *     and starting a new one).
 *   - No prior run, a fresh UUID is minted (first-run bootstrap).
 */

import { describe, expect, it } from "vitest";
import { deriveRunId, RUN_WINDOW_MS } from "../runId";

/**
 * Loose UUID-v4 matcher for the minted branches. Pinning an exact
 * value would force a mock of `crypto.randomUUID`; matching shape proves
 * the function produced a real v4 while staying decoupled from the
 * runtime's UUID internals.
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fixed wall-clock used across tests. Using a pinned value makes the
 * window arithmetic deterministic — the `lastActiveMs` offsets below
 * are computed relative to this base.
 */
const NOW = new Date("2026-04-24T12:00:00.000Z");

describe("deriveRunId — within window", () => {
	it("reuses the current run_id when the app was touched 1 minute ago", () => {
		const id = deriveRunId({
			currentRunId: "existing-run",
			lastActiveMs: NOW.getTime() - 60_000,
			now: NOW,
		});
		expect(id).toBe("existing-run");
	});

	it("reuses the current run_id at the edge of the window (just under)", () => {
		/* Just under `RUN_WINDOW_MS` — still within. The strict `<`
		 * comparison means the boundary moment itself tips to the
		 * mint branch, covered in the next describe block. */
		const id = deriveRunId({
			currentRunId: "edge-run",
			lastActiveMs: NOW.getTime() - (RUN_WINDOW_MS - 1),
			now: NOW,
		});
		expect(id).toBe("edge-run");
	});
});

describe("deriveRunId — beyond window", () => {
	it("mints a fresh UUID when the app was last touched beyond the window", () => {
		const id = deriveRunId({
			currentRunId: "stale-run",
			lastActiveMs: NOW.getTime() - (RUN_WINDOW_MS + 1),
			now: NOW,
		});
		expect(id).not.toBe("stale-run");
		expect(id).toMatch(UUID_RE);
	});

	it("mints a fresh UUID exactly at the window boundary (strict <)", () => {
		/* At `now - RUN_WINDOW_MS` the inequality `elapsed < WINDOW_MS`
		 * is false, so the boundary moment mints. This pins the
		 * inclusivity choice so future refactors can't silently invert
		 * it. */
		const id = deriveRunId({
			currentRunId: "boundary-run",
			lastActiveMs: NOW.getTime() - RUN_WINDOW_MS,
			now: NOW,
		});
		expect(id).not.toBe("boundary-run");
		expect(id).toMatch(UUID_RE);
	});
});

describe("deriveRunId — no prior run", () => {
	it("mints a fresh UUID when currentRunId is null", () => {
		/* First mutation on a freshly-created app (or one that's never
		 * been through a run yet). No id to continue; mint one. */
		const id = deriveRunId({
			currentRunId: null,
			lastActiveMs: NOW.getTime(),
			now: NOW,
		});
		expect(id).toMatch(UUID_RE);
	});

	it("mints a fresh UUID when lastActiveMs is null", () => {
		/* Defensive path — shouldn't happen in practice because
		 * `updated_at` is set on creation, but if a malformed row
		 * leaked past the Zod converter we don't want the derivation
		 * to crash. Treat absence as "closed run" and mint. */
		const id = deriveRunId({
			currentRunId: "orphan-run",
			lastActiveMs: null,
			now: NOW,
		});
		expect(id).not.toBe("orphan-run");
		expect(id).toMatch(UUID_RE);
	});

	it("mints a unique UUID per call on the mint branch", () => {
		/* Two minted ids must differ — otherwise new runs would
		 * collapse onto each other and the grouping signal would
		 * degenerate. */
		const a = deriveRunId({ currentRunId: null, lastActiveMs: null, now: NOW });
		const b = deriveRunId({ currentRunId: null, lastActiveMs: null, now: NOW });
		expect(a).not.toBe(b);
		expect(a).toMatch(UUID_RE);
		expect(b).toMatch(UUID_RE);
	});
});
