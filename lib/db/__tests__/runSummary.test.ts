/**
 * Tests cover two concerns:
 *   1. The `RunSummaryDoc` Zod schema (pure shape validation) — unchanged; the
 *      schema still guards the in-memory record the writer accepts.
 *   2. `writeRunSummary`'s accumulate-on-conflict logic over a real `run_summaries`
 *      row (the per-test DB harness): first write inserts the full row; a
 *      subsequent write for the same `(app_id, run_id)` accumulates the numeric
 *      deltas, overwrites the scalars (finished_at / module_count), and leaves
 *      the pinned fields (started_at / prompt_mode / app_ready / model) as the
 *      first write's — all read back via `loadRunSummary`.
 *
 * On typed Postgres columns there is no converter to fail parsing, so the
 * `"overwritten"` action is unreachable; the deadlock/serialization retry lives
 * in `withAppTx`, covered by its own unit test.
 */

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { __setAppDbForTests, type AppDatabase } from "../pg";
import { type RunSummaryDoc, runSummaryDocSchema } from "../types";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("run_summary_");
const APP = "app-1";
const TARGET = { kind: "app", appId: APP } as const;

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
		appReady: false,
		moduleCount: 0,
		stepCount: 7,
		model: "gpt-5.6-sol",
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

describe("writeRunSummary", () => {
	const RUN = "run-xyz";
	const delta: RunSummaryDoc = {
		runId: RUN,
		startedAt: "2026-04-20T05:00:00.000Z",
		finishedAt: "2026-04-20T05:01:00.000Z",
		promptMode: "edit",
		appReady: true,
		moduleCount: 3,
		stepCount: 2,
		model: "gpt-5.6-sol",
		inputTokens: 1_000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheWriteTokens: 100,
		costEstimate: 0.01,
		toolCallCount: 3,
	};

	it("writes the full summary on the first call and reads it back verbatim", async () => {
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");
		await expect(writeRunSummary(TARGET, RUN, delta)).resolves.toBe("created");
		expect(await loadRunSummary(TARGET, RUN)).toEqual(delta);
	});

	it("accumulates numerics, overwrites scalars, and pins the first write's identity fields", async () => {
		const prev: RunSummaryDoc = {
			runId: RUN,
			startedAt: "2026-04-20T04:50:00.000Z",
			finishedAt: "2026-04-20T04:50:30.000Z",
			promptMode: "build",
			appReady: false,
			moduleCount: 0,
			stepCount: 5,
			model: "gpt-5.6-sol",
			inputTokens: 10_000,
			outputTokens: 800,
			cacheReadTokens: 3_000,
			cacheWriteTokens: 500,
			costEstimate: 0.05,
			toolCallCount: 7,
		};
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");

		await writeRunSummary(TARGET, RUN, prev);
		await expect(writeRunSummary(TARGET, RUN, delta)).resolves.toBe(
			"incremented",
		);

		expect(await loadRunSummary(TARGET, RUN)).toEqual({
			runId: RUN,
			// Pinned — the first write's values stand.
			startedAt: prev.startedAt,
			promptMode: prev.promptMode,
			appReady: prev.appReady,
			model: prev.model,
			// Scalar overwrite — latest turn wins.
			finishedAt: delta.finishedAt,
			moduleCount: delta.moduleCount,
			// Accumulated — prev + delta.
			stepCount: 5 + 2,
			toolCallCount: 7 + 3,
			inputTokens: 10_000 + 1_000,
			outputTokens: 800 + 500,
			cacheReadTokens: 3_000 + 200,
			cacheWriteTokens: 500 + 100,
			costEstimate: 0.05 + 0.01,
		});
	});

	it("advances moduleCount to the latest turn's value", async () => {
		const prev: RunSummaryDoc = {
			...delta,
			moduleCount: 0,
		};
		const later: RunSummaryDoc = {
			...delta,
			moduleCount: 7,
		};
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");

		await writeRunSummary(TARGET, RUN, prev);
		await writeRunSummary(TARGET, RUN, later);

		const stored = await loadRunSummary(TARGET, RUN);
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

		await writeRunSummary(TARGET, RUN, prev);
		await writeRunSummary(TARGET, RUN, zeroDelta);

		const stored = await loadRunSummary(TARGET, RUN);
		// finishedAt + moduleCount advance to the latest turn; counters are prev+0.
		expect(stored?.finishedAt).toBe(zeroDelta.finishedAt);
		expect(stored?.moduleCount).toBe(zeroDelta.moduleCount);
		expect(stored?.stepCount).toBe(4);
		expect(stored?.costEstimate).toBe(0.03);
	});

	it("keeps finishedAt monotonic when an older overlapping flush commits later", async () => {
		const { writeRunSummary, loadRunSummary } = await import("../runSummary");
		await writeRunSummary(TARGET, RUN, delta);
		await writeRunSummary(TARGET, RUN, {
			...delta,
			finishedAt: "2026-04-20T05:00:30.000Z",
			moduleCount: 1,
			stepCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costEstimate: 0,
			toolCallCount: 0,
		});
		expect((await loadRunSummary(TARGET, RUN))?.finishedAt).toBe(
			delta.finishedAt,
		);
		expect((await loadRunSummary(TARGET, RUN))?.moduleCount).toBe(
			delta.moduleCount,
		);
	});

	it("admits one durable model-step contribution exactly once", async () => {
		const designSessionId = await h.seedDesignSession();
		const contextId = crypto.randomUUID();
		await h
			.db()
			.insertInto("design_model_contexts")
			.values({
				id: contextId,
				design_session_id: designSessionId,
				context_kind: "executor",
				generation: 0,
				supersedes_context_id: null,
				model_id: "gpt-5.6-luna",
				prompt_version: "executor-v1",
				toolset_digest: "a".repeat(64),
				context_version: "v1",
				revision: 0,
			})
			.execute();
		await h
			.db()
			.insertInto("design_model_steps")
			.values({
				context_id: contextId,
				step_key: "attempt:1",
				event_kind: "completed",
				event_digest: "b".repeat(64),
				request_digest: null,
				response_digest: "c".repeat(64),
				usage: JSON.stringify({ inputTokens: 40, outputTokens: 10 }),
				created_by_run_id: RUN,
			})
			.execute();
		const contribution = {
			contextId,
			stepKey: "attempt:1",
			stepCount: 1,
			inputTokens: 40,
			outputTokens: 10,
			cacheReadTokens: 5,
			cacheWriteTokens: 0,
			costEstimate: 0.002,
		};
		const zero = {
			...delta,
			stepCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costEstimate: 0,
			toolCallCount: 0,
		};
		const { writeRunSummaryWithDurableContributions, loadRunSummary } =
			await import("../runSummary");
		await expect(
			writeRunSummaryWithDurableContributions(
				TARGET,
				RUN,
				zero,
				[contribution],
				{ userId: "owner-test", period: "2026-04" },
			),
		).resolves.toMatchObject({
			action: "created",
			admittedContributions: [contribution],
			monthlyUsageAccrued: true,
			runCostEstimate: 0.002,
		});
		await expect(
			writeRunSummaryWithDurableContributions(
				TARGET,
				RUN,
				zero,
				[contribution],
				{ userId: "owner-test", period: "2026-04" },
			),
		).resolves.toMatchObject({
			action: "incremented",
			admittedContributions: [],
			monthlyUsageAccrued: false,
			runCostEstimate: 0.002,
		});
		expect(await loadRunSummary(TARGET, RUN)).toMatchObject({
			stepCount: 1,
			inputTokens: 40,
			outputTokens: 10,
			cacheReadTokens: 5,
			costEstimate: 0.002,
		});
		expect(
			await h
				.db()
				.selectFrom("design_model_step_usage_accounts")
				.select("step_key")
				.where("context_id", "=", contextId)
				.execute(),
		).toHaveLength(1);
		expect(
			await h
				.db()
				.selectFrom("usage_months")
				.select([
					"input_tokens",
					"output_tokens",
					"cost_estimate",
					"request_count",
				])
				.where("user_id", "=", "owner-test")
				.where("period", "=", "2026-04")
				.executeTakeFirst(),
		).toMatchObject({
			input_tokens: "40",
			output_tokens: "10",
			cost_estimate: 0.002,
			request_count: 1,
		});
	});

	it("accrues monthly usage independently of the summary transaction", async () => {
		// The fallback for a failed summary write: same UPSERT, no summary row.
		const { accrueMonthlyUsageBestEffort } = await import("../runSummary");
		const billing = { userId: "owner-test", period: "2026-04" };
		const totals = { inputTokens: 40, outputTokens: 10, costEstimate: 0.002 };
		await expect(accrueMonthlyUsageBestEffort(billing, totals)).resolves.toBe(
			true,
		);
		await expect(accrueMonthlyUsageBestEffort(billing, totals)).resolves.toBe(
			true,
		);
		expect(
			await h
				.db()
				.selectFrom("usage_months")
				.select([
					"input_tokens",
					"output_tokens",
					"cost_estimate",
					"request_count",
				])
				.where("user_id", "=", "owner-test")
				.where("period", "=", "2026-04")
				.executeTakeFirst(),
		).toMatchObject({
			input_tokens: "80",
			output_tokens: "20",
			cost_estimate: 0.004,
			request_count: 2,
		});
	});

	it("the accrual fallback returns false instead of throwing on a dead pool", async () => {
		const deadPool = new Pool({ connectionString: h.uri(), max: 1 });
		await deadPool.end();
		__setAppDbForTests(
			new Kysely<AppDatabase>({
				dialect: new PostgresDialect({
					pool: deadPool as unknown as PostgresPool,
				}),
			}),
		);
		const { accrueMonthlyUsageBestEffort } = await import("../runSummary");
		await expect(
			accrueMonthlyUsageBestEffort(
				{ userId: "owner-test", period: "2026-04" },
				{ inputTokens: 1, outputTokens: 1, costEstimate: 0.001 },
			),
		).resolves.toBe(false);
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
		await expect(writeRunSummary(TARGET, RUN, delta)).resolves.toBe("failed");
	});

	describe("write action result", () => {
		it("returns 'created' when no prior row exists", async () => {
			const { writeRunSummary } = await import("../runSummary");
			await expect(writeRunSummary(TARGET, RUN, delta)).resolves.toBe(
				"created",
			);
		});

		it("returns 'incremented' when a prior row exists", async () => {
			const { writeRunSummary } = await import("../runSummary");
			await writeRunSummary(TARGET, RUN, delta);
			await expect(writeRunSummary(TARGET, RUN, delta)).resolves.toBe(
				"incremented",
			);
		});
	});
});
