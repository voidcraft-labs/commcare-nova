/**
 * Tests cover two concerns:
 *   1. The RunSummaryDoc Zod schema (pure shape validation).
 *   2. `writeRunSummary`'s transactional merge logic — first-write
 *      creates the full doc; subsequent writes delegate numeric
 *      accumulation to `FieldValue.increment`, advance `finishedAt`,
 *      and leave every other field to Firestore's `merge: true`
 *      semantics (i.e. unchanged from the existing on-disk doc).
 *
 * The mock surface mirrors `runSummary.ts`'s entry points: `getDb`
 * exposes the `collection().doc().collection().doc()` chain that
 * resolves to a Firestore DocumentReference, plus `runTransaction`
 * which drives the closure with a `tx` that carries `get` + `set`
 * spies. We keep the real `FieldValue` import so the increment
 * sentinels that land in the merge payload are structurally
 * comparable, not just `any`-shaped blobs.
 */
import { FieldValue } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type RunSummaryDoc, runSummaryDocSchema } from "../types";

/**
 * Hoisted mocks — `vi.mock` factories run before imports, and any captured
 * identifiers must exist at factory call time. `vi.hoisted` lifts them
 * alongside. One `txGet` + `txSet` pair represents "the transaction's
 * inner tx object"; `runTransactionMock` drives the closure so tests can
 * script what the transactional get returns.
 */
const { txGet, txSet, runTransactionMock, docRef } = vi.hoisted(() => {
	const ref = {};
	return {
		txGet: vi.fn(),
		txSet: vi.fn(),
		runTransactionMock: vi.fn(),
		docRef: ref,
	};
});

vi.mock("../firestore", () => ({
	getDb: () => ({
		collection: () => ({
			doc: () => ({
				collection: () => ({
					doc: () => docRef,
				}),
			}),
		}),
		runTransaction: runTransactionMock,
	}),
}));

describe("runSummaryDocSchema", () => {
	const sample = {
		runId: "run-abc",
		startedAt: "2026-04-18T12:00:00.000Z",
		finishedAt: "2026-04-18T12:01:30.000Z",
		promptMode: "build" as const,
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
		stepCount: 7,
		model: "claude-opus-4-7",
		inputTokens: 1234,
		outputTokens: 567,
		cacheReadTokens: 891,
		cacheWriteTokens: 0,
		costEstimate: 0.0421,
		toolCallCount: 14,
	};

	it("parses a populated summary", () => {
		expect(runSummaryDocSchema.parse(sample)).toEqual(sample);
	});

	it("rejects missing required fields", () => {
		const { costEstimate: _c, ...partial } = sample;
		expect(() => runSummaryDocSchema.parse(partial)).toThrow();
	});

	it("accepts zero-valued token counts and cost", () => {
		expect(
			runSummaryDocSchema.parse({
				...sample,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costEstimate: 0,
			}),
		).toBeDefined();
	});

	it("rejects negative token counts", () => {
		expect(() =>
			runSummaryDocSchema.parse({ ...sample, inputTokens: -1 }),
		).toThrow();
	});

	it("rejects non-integer token counts", () => {
		expect(() =>
			runSummaryDocSchema.parse({ ...sample, inputTokens: 1.5 }),
		).toThrow();
	});

	it("rejects unknown promptMode values", () => {
		expect(() =>
			runSummaryDocSchema.parse({ ...sample, promptMode: "foo" }),
		).toThrow();
	});
});

/**
 * `writeRunSummary` is the persistence boundary for run-level observability.
 * It handles the cross-request accumulation that keeps a run's on-disk doc
 * in sync with the cumulative work done across every chat turn that shares
 * a runId (initial build + follow-up edits).
 *
 * The writer runs inside `db.runTransaction(...)` so concurrent retries on
 * the same runId can't lose a turn's delta to a TOCTOU. These tests drive
 * the transaction closure by hand: `runTransactionMock` accepts the
 * closure and invokes it with `{ get: txGet, set: txSet }`. From there
 * we assert the set payload — either a full RunSummaryDoc on first write
 * or a merge-partial payload with `FieldValue.increment` sentinels on
 * subsequent writes.
 */
describe("writeRunSummary", () => {
	const delta: RunSummaryDoc = {
		runId: "run-xyz",
		startedAt: "2026-04-20T05:00:00.000Z",
		finishedAt: "2026-04-20T05:01:00.000Z",
		promptMode: "edit",
		freshEdit: true,
		appReady: true,
		cacheExpired: true,
		moduleCount: 3,
		stepCount: 2,
		model: "claude-opus-4-7",
		inputTokens: 1_000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheWriteTokens: 100,
		costEstimate: 0.01,
		toolCallCount: 3,
	};

	beforeEach(() => {
		txGet.mockReset();
		txSet.mockReset();
		runTransactionMock.mockReset();
		/* Default: drive the closure exactly once with a tx object backed
		 * by our spies. Tests that need retry behavior override this. */
		runTransactionMock.mockImplementation(
			async (
				closure: (tx: {
					get: typeof txGet;
					set: typeof txSet;
				}) => Promise<void>,
			) => {
				await closure({ get: txGet, set: txSet });
			},
		);
	});

	/**
	 * Helper: extract the payload the writer passed to `tx.set` on its
	 * first call. Asserts ref identity too so a future accidental ref
	 * reconstruction shows up as a failed test instead of a silent
	 * wrong-doc write.
	 */
	function firstSetPayload(): unknown {
		expect(txSet).toHaveBeenCalledTimes(1);
		const [ref, payload] = txSet.mock.calls[0];
		expect(ref).toBe(docRef);
		return payload;
	}

	it("writes the full summary on first call (no existing doc)", async () => {
		txGet.mockResolvedValue({ exists: false, data: () => undefined });
		const { writeRunSummary } = await import("../runSummary");
		await writeRunSummary("app-1", "run-xyz", delta);
		/* Parse through the real schema — asserts the payload is a valid
		 * RunSummaryDoc rather than an `as` cast that accepts anything. */
		expect(runSummaryDocSchema.parse(firstSetPayload())).toEqual(delta);
		/* Locks the no-options invariant on the first-write branch: a
		 * regression that "defensively" adds `{ merge: true }` would let
		 * a malformed pre-existing doc's leftover fields leak through.
		 * The first write must always replace the whole doc. */
		expect(txSet.mock.calls[0]).toHaveLength(2);
	});

	it("accumulates numeric fields via FieldValue.increment and pins scalars on subsequent calls", async () => {
		const prev: RunSummaryDoc = {
			runId: "run-xyz",
			startedAt: "2026-04-20T04:50:00.000Z",
			finishedAt: "2026-04-20T04:50:30.000Z",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
			stepCount: 5,
			model: "claude-opus-4-7",
			inputTokens: 10_000,
			outputTokens: 800,
			cacheReadTokens: 3_000,
			cacheWriteTokens: 500,
			costEstimate: 0.05,
			toolCallCount: 7,
		};
		txGet.mockResolvedValue({ exists: true, data: () => prev });

		const { writeRunSummary } = await import("../runSummary");
		await writeRunSummary("app-1", "run-xyz", delta);

		/* Merge write semantics:
		 *   - finishedAt + moduleCount: scalar overwrite (latest wins).
		 *   - freshEdit + cacheExpired: boolean OR with prev (cold cache
		 *     anywhere in the thread = cold cache on the summary).
		 *   - numerics: FieldValue.increment sentinels.
		 *   - pinned fields (runId, startedAt, promptMode, appReady, model)
		 *     are absent from the payload so Firestore's `merge: true`
		 *     leaves them as-is on disk. */
		const payload = firstSetPayload();
		expect(payload).toEqual({
			finishedAt: delta.finishedAt,
			moduleCount: delta.moduleCount,
			/* prev.freshEdit=false || delta.freshEdit=true → true.
			 * This is the cost-observability property: if ANY turn
			 * hits a cold cache, the summary reflects it. */
			freshEdit: true,
			cacheExpired: true,
			stepCount: FieldValue.increment(delta.stepCount),
			toolCallCount: FieldValue.increment(delta.toolCallCount),
			inputTokens: FieldValue.increment(delta.inputTokens),
			outputTokens: FieldValue.increment(delta.outputTokens),
			cacheReadTokens: FieldValue.increment(delta.cacheReadTokens),
			cacheWriteTokens: FieldValue.increment(delta.cacheWriteTokens),
			costEstimate: FieldValue.increment(delta.costEstimate),
		});
		/* Second argument is `{ merge: true }` — without it, the payload
		 * would replace the whole doc and the first-write scalars would
		 * be wiped. This assertion exists specifically to catch a
		 * regression that drops the merge option. */
		expect(txSet.mock.calls[0][2]).toEqual({ merge: true });
	});

	/**
	 * Pinning vs. advancing vs. union semantics matter most when a
	 * thread's character changes between turns. This test exercises the
	 * "character" change explicitly: prev had `freshEdit=true` and
	 * `cacheExpired=true`; the new turn has both false. The union
	 * policy must keep them `true` on disk (because an earlier turn
	 * hit the cold cache), and `moduleCount` must advance to the new
	 * value (because the latest turn's blueprint is the source of
	 * truth admin tools want to filter on).
	 */
	it("unions freshEdit/cacheExpired across turns and advances moduleCount to latest", async () => {
		const prev: RunSummaryDoc = {
			...delta,
			freshEdit: true,
			cacheExpired: true,
			moduleCount: 0,
			stepCount: 3,
			toolCallCount: 5,
			inputTokens: 5_000,
			outputTokens: 500,
			cacheReadTokens: 1_000,
			cacheWriteTokens: 200,
			costEstimate: 0.02,
		};
		const later: RunSummaryDoc = {
			...delta,
			freshEdit: false,
			cacheExpired: false,
			moduleCount: 7,
		};
		txGet.mockResolvedValue({ exists: true, data: () => prev });

		const { writeRunSummary } = await import("../runSummary");
		await writeRunSummary("app-1", "run-xyz", later);

		const payload = firstSetPayload() as Record<string, unknown>;
		expect(payload.freshEdit).toBe(true);
		expect(payload.cacheExpired).toBe(true);
		expect(payload.moduleCount).toBe(7);
	});

	/**
	 * Zero-impact turn — the admin still wants a row, and `finishedAt`
	 * still advances to reflect activity. Increments of 0 are no-ops for
	 * counters but the write must still happen so `finishedAt` moves.
	 */
	it("still advances finishedAt on a zero-cost follow-up turn", async () => {
		const prev: RunSummaryDoc = {
			...delta,
			stepCount: 4,
			toolCallCount: 9,
			inputTokens: 5_000,
			outputTokens: 700,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costEstimate: 0.03,
			finishedAt: "2026-04-20T04:59:00.000Z",
		};
		const zeroDelta: RunSummaryDoc = {
			...delta,
			stepCount: 0,
			toolCallCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costEstimate: 0,
		};
		txGet.mockResolvedValue({ exists: true, data: () => prev });

		const { writeRunSummary } = await import("../runSummary");
		await writeRunSummary("app-1", "run-xyz", zeroDelta);

		const payload = firstSetPayload() as Record<string, unknown>;
		expect(payload.finishedAt).toBe(zeroDelta.finishedAt);
		/* All increments are still emitted (with value 0) so the merge
		 * payload stays structurally stable request-over-request. */
		expect(payload.stepCount).toEqual(FieldValue.increment(0));
		/* moduleCount still advances to the new turn's value even when
		 * that value is unchanged — admin tools see a consistent,
		 * latest-blueprint reading regardless of per-turn cost. */
		expect(payload.moduleCount).toBe(zeroDelta.moduleCount);
	});

	/**
	 * `exists:true` with `data()` returning undefined is a contract
	 * violation. We treat it as "no prev" and overwrite — strictly safer
	 * than dropping the current request's data to preserve garbage.
	 */
	it("treats exists=true with empty data as missing and writes the full summary", async () => {
		txGet.mockResolvedValue({ exists: true, data: () => undefined });
		const { writeRunSummary } = await import("../runSummary");
		await writeRunSummary("app-1", "run-xyz", delta);
		expect(runSummaryDocSchema.parse(firstSetPayload())).toEqual(delta);
	});

	/**
	 * If the on-disk doc fails schema parse — a schema-evolution hazard or
	 * a corrupt legacy shape — we log a warning and overwrite rather than
	 * dropping the current turn's accumulation into a black hole.
	 */
	it("overwrites when the existing doc fails schema parse", async () => {
		txGet.mockResolvedValue({
			exists: true,
			data: () => ({ runId: "run-xyz" /* everything else missing */ }),
		});
		const { writeRunSummary } = await import("../runSummary");
		await writeRunSummary("app-1", "run-xyz", delta);
		expect(runSummaryDocSchema.parse(firstSetPayload())).toEqual(delta);
	});

	/**
	 * Firestore may retry the transaction closure on contention. The
	 * closure must remain correct across successive invocations even
	 * when `tx.get` returns different snapshots on each retry (a
	 * concurrent writer landed a doc between attempts). This test
	 * simulates exactly that: attempt 1 sees no prior doc, attempt 2
	 * sees one. Both paths must produce a valid write — the
	 * FieldValue.increment sentinels are server-side and only apply on
	 * the winning commit, so no double-increment risk from the
	 * re-invocation itself.
	 */
	it("remains correct across a transaction retry that sees a new prev", async () => {
		const prev: RunSummaryDoc = {
			...delta,
			stepCount: 1,
			toolCallCount: 1,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 20,
			cacheWriteTokens: 10,
			costEstimate: 0.001,
		};
		/* Attempt 1: exists=false (write full summary).
		 * Attempt 2: exists=true with prev (merge-increment path). */
		txGet
			.mockResolvedValueOnce({ exists: false, data: () => undefined })
			.mockResolvedValueOnce({ exists: true, data: () => prev });
		/* Drive the closure twice — Firestore's real retry loop does this
		 * when another writer commits between our read and our set. */
		runTransactionMock.mockImplementationOnce(
			async (
				closure: (tx: {
					get: typeof txGet;
					set: typeof txSet;
				}) => Promise<void>,
			) => {
				await closure({ get: txGet, set: txSet });
				await closure({ get: txGet, set: txSet });
			},
		);

		const { writeRunSummary } = await import("../runSummary");
		await writeRunSummary("app-1", "run-xyz", delta);

		expect(txSet).toHaveBeenCalledTimes(2);
		/* First attempt: full summary write, no merge option. */
		expect(runSummaryDocSchema.parse(txSet.mock.calls[0][1])).toEqual(delta);
		expect(txSet.mock.calls[0]).toHaveLength(2);
		/* Second attempt: merge-increment payload. */
		expect(txSet.mock.calls[1][2]).toEqual({ merge: true });
		const mergePayload = txSet.mock.calls[1][1] as Record<string, unknown>;
		expect(mergePayload.stepCount).toEqual(
			FieldValue.increment(delta.stepCount),
		);
	});

	/**
	 * Firestore errors are swallowed inside `writeRunSummary` — observability
	 * writes must never fail the request path. A rejected `runTransaction`
	 * must still leave the returned promise resolved.
	 */
	it("swallows runTransaction failures so the caller's await resolves", async () => {
		runTransactionMock.mockRejectedValue(new Error("firestore down"));
		const { writeRunSummary } = await import("../runSummary");
		await expect(
			writeRunSummary("app-1", "run-xyz", delta),
		).resolves.toBeUndefined();
	});
});
