/**
 * Tests cover two concerns:
 *   1. The `RunSummaryDoc` Zod schema (pure shape validation) — unchanged; the
 *      schema still guards the in-memory record the writer accepts.
 *   2. `writeRunSummary`'s accumulate-on-conflict logic over a real `run_summaries`
 *      row (the per-test DB harness): first write inserts the full row; a
 *      subsequent write for the same `(app_id, run_id)` accumulates the numeric
 *      deltas, overwrites the scalars (finished_at / module_count), unions the
 *      booleans, and leaves the pinned fields (started_at / prompt_mode /
 *      app_ready / model) as the first write's — all read back via `loadRunSummary`.
 *
 * The former Firestore-transaction arms (FieldValue.increment payload shapes,
 * the `merge:true` option, the empty-`data()` and schema-parse-failure overwrite
 * paths, and the "closure re-runs across a retry" driver) are gone: on typed
 * Postgres columns there is no converter to fail parsing (the `"overwritten"`
 * action is unreachable), and the deadlock/serialization retry is `withAppTx`'s,
 * covered by its own unit test.
 */

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { __setAppDbForTests, type AppDatabase } from "../pg";
import { type RunSummaryDoc, runSummaryDocSchema } from "../types";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("run_summary_");
const APP = "app-1";

/** Seed the app row the `run_summaries` FK requires. */
beforeEach(async () => {
	await h.seedApp({ id: APP });
});

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
		model: "openai/gpt-5.6-sol",
		inputTokens: 1234,
		outputTokens: 567,
		cacheReadTokens: 891,
		cacheWriteTokens: 0,
		costEstimate: 0.0421,
		actualCost: 0.0398,
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

describe("writeRunSummary", () => {
	const RUN = "run-xyz";
	const delta: RunSummaryDoc = {
		runId: RUN,
		startedAt: "2026-04-20T05:00:00.000Z",
		finishedAt: "2026-04-20T05:01:00.000Z",
		promptMode: "edit",
		freshEdit: true,
		appReady: true,
		cacheExpired: true,
		moduleCount: 3,
		stepCount: 2,
		model: "openai/gpt-5.6-sol",
		inputTokens: 1_000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheWriteTokens: 100,
		costEstimate: 0.01,
		actualCost: 0.012,
		toolCallCount: 3,
	};

	it("writes the full summary on the first call and reads it back verbatim", async () => {
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");
		await expect(writeRunSummary(APP, RUN, delta)).resolves.toBe("created");
		expect(await loadRunSummary(APP, RUN)).toEqual(delta);
	});

	it("accumulates numerics, overwrites scalars, unions booleans, and pins the first write's identity fields", async () => {
		const prev: RunSummaryDoc = {
			runId: RUN,
			startedAt: "2026-04-20T04:50:00.000Z",
			finishedAt: "2026-04-20T04:50:30.000Z",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
			stepCount: 5,
			model: "openai/gpt-5.6-sol",
			inputTokens: 10_000,
			outputTokens: 800,
			cacheReadTokens: 3_000,
			cacheWriteTokens: 500,
			costEstimate: 0.05,
			actualCost: 0.06,
			toolCallCount: 7,
		};
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");

		await writeRunSummary(APP, RUN, prev);
		await expect(writeRunSummary(APP, RUN, delta)).resolves.toBe("incremented");

		expect(await loadRunSummary(APP, RUN)).toEqual({
			runId: RUN,
			// Pinned — the first write's values stand.
			startedAt: prev.startedAt,
			promptMode: prev.promptMode,
			appReady: prev.appReady,
			model: prev.model,
			// Scalar overwrite — latest turn wins.
			finishedAt: delta.finishedAt,
			moduleCount: delta.moduleCount,
			// Union — any cold-cache/fresh-edit turn taints the whole run.
			freshEdit: true,
			cacheExpired: true,
			// Accumulated — prev + delta.
			stepCount: 5 + 2,
			toolCallCount: 7 + 3,
			inputTokens: 10_000 + 1_000,
			outputTokens: 800 + 500,
			cacheReadTokens: 3_000 + 200,
			cacheWriteTokens: 500 + 100,
			costEstimate: 0.05 + 0.01,
			actualCost: 0.06 + 0.012,
		});
	});

	it("unions freshEdit/cacheExpired across turns and advances moduleCount to latest", async () => {
		const prev: RunSummaryDoc = {
			...delta,
			freshEdit: true,
			cacheExpired: true,
			moduleCount: 0,
		};
		const later: RunSummaryDoc = {
			...delta,
			freshEdit: false,
			cacheExpired: false,
			moduleCount: 7,
		};
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");

		await writeRunSummary(APP, RUN, prev);
		await writeRunSummary(APP, RUN, later);

		const stored = await loadRunSummary(APP, RUN);
		expect(stored?.freshEdit).toBe(true);
		expect(stored?.cacheExpired).toBe(true);
		expect(stored?.moduleCount).toBe(7);
	});

	it("still advances finishedAt on a zero-cost follow-up turn without changing the counters", async () => {
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
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");

		await writeRunSummary(APP, RUN, prev);
		await writeRunSummary(APP, RUN, zeroDelta);

		const stored = await loadRunSummary(APP, RUN);
		// finishedAt + moduleCount advance to the latest turn; counters are prev+0.
		expect(stored?.finishedAt).toBe(zeroDelta.finishedAt);
		expect(stored?.moduleCount).toBe(zeroDelta.moduleCount);
		expect(stored?.stepCount).toBe(4);
		expect(stored?.costEstimate).toBe(0.03);
	});

	it("swallows a write failure and resolves to the 'failed' action (never throws on the request path)", async () => {
		// Point the injected handle at a DEAD pool so the write errors — the writer
		// must log-and-swallow to the `"failed"` sentinel, never bubble.
		const deadPool = new Pool({ connectionString: h.uri(), max: 1 });
		await deadPool.end();
		__setAppDbForTests(
			new Kysely<AppDatabase>({
				dialect: new PostgresDialect({
					pool: deadPool as unknown as PostgresPool,
				}),
			}),
		);
		const { writeRunSummary } = await import("../runSummary");
		await expect(writeRunSummary(APP, RUN, delta)).resolves.toBe("failed");
	});

	describe("write action result", () => {
		it("returns 'created' when no prior row exists", async () => {
			const { writeRunSummary } = await import("../runSummary");
			await expect(writeRunSummary(APP, RUN, delta)).resolves.toBe("created");
		});

		it("returns 'incremented' when a prior row exists", async () => {
			const { writeRunSummary } = await import("../runSummary");
			await writeRunSummary(APP, RUN, delta);
			await expect(writeRunSummary(APP, RUN, delta)).resolves.toBe(
				"incremented",
			);
		});
	});
});
