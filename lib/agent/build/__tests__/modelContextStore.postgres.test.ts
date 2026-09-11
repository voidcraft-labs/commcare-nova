import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	DesignModelContextError,
	openDesignModelContext,
	recordDesignModelStepEvent,
	recoverableCompletedModelSteps,
} from "@/lib/agent/build/modelContextStore";
import { durableModelValueDigest } from "@/lib/agent/modelMessagePersistence";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { CommitReauthError, RunHolderLostError } from "@/lib/db/commitGuard";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { productionExecutorStep } from "../executorLoop";

const h = setupAppStateTestDb("design_model_context_", { poolMax: 3 });
const ACTOR = "context-owner";
const PROJECT = "context-project";
const RUN_ID = "context-run";
const NONCE = "6a0a35a4-1111-4222-8333-944445555667";
let designSessionId: string;

const authority = {
	actorUserId: ACTOR,
	runId: RUN_ID,
	holderNonce: NONCE,
	expectedProjectId: PROJECT,
};

const spec = () => ({
	designSessionId,
	kind: "executor" as const,
	modelId: "executor-model",
	promptVersion: "executor-v1",
	toolsetDigest: "0".repeat(64),
	contextVersion: "v1",
	authority,
});

async function started() {
	const opened = await openDesignModelContext(spec());
	await recordDesignModelStepEvent({
		designSessionId,
		contextId: opened.id,
		stepKey: "attempt:1",
		event: { eventKind: "started", requestDigest: "1".repeat(64) },
		authority,
	});
	const messages: ModelMessage[] = [
		{ role: "assistant", content: "A durable answer." },
	];
	return {
		opened,
		completion: {
			designSessionId,
			contextId: opened.id,
			appendKey: "response:attempt:1",
			messages,
			stepKey: "attempt:1",
			responseDigest: durableModelValueDigest(messages),
			usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
			authority,
		},
	};
}

async function storedRows(contextId: string) {
	return {
		context: await h
			.db()
			.selectFrom("design_model_contexts")
			.selectAll()
			.where("id", "=", contextId)
			.executeTakeFirstOrThrow(),
		items: await h
			.db()
			.selectFrom("design_model_context_items")
			.selectAll()
			.where("context_id", "=", contextId)
			.orderBy("ordinal")
			.execute(),
		steps: await h
			.db()
			.selectFrom("design_model_steps")
			.selectAll()
			.where("context_id", "=", contextId)
			.orderBy("event_kind")
			.execute(),
	};
}

beforeEach(async () => {
	designSessionId = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN_ID,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-08",
			reserved: 1,
			settled: false,
			userId: ACTOR,
			runId: RUN_ID,
		},
	});
});

describe("durable model context", () => {
	it.each(["digest", "encoding"] as const)(
		"refuses damaged item %s before returning recovered messages",
		async (damage) => {
			const { opened, completion } = await started();
			await completeDesignModelStep(completion);
			const rows = await storedRows(opened.id);
			const value = {
				...rows.items[0].message,
				encoding: "unknown-model-format",
			};
			await h
				.pool()
				.query(
					"update design_model_context_items set message=$1, item_digest=$2 where context_id=$3",
					[
						JSON.stringify(value),
						damage === "encoding"
							? canonicalJsonDigest(value)
							: rows.items[0].item_digest,
						opened.id,
					],
				);
			await expect(openDesignModelContext(spec())).rejects.toThrow(
				damage === "digest"
					? "no longer matches its digest"
					: "cannot be rehydrated",
			);
		},
	);

	it("keeps same-named usage steps distinct across generations and deduplicates exact replay identities", async () => {
		const { opened, completion } = await started();
		await completeDesignModelStep(completion);
		const successorSpec = { ...spec(), promptVersion: "next" };
		const successor = await openDesignModelContext(successorSpec);
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: successor.id,
			stepKey: completion.stepKey,
			event: { eventKind: "started", requestDigest: "3".repeat(64) },
			authority,
		});
		await completeDesignModelStep({ ...completion, contextId: successor.id });
		const recovered = await openDesignModelContext(successorSpec);
		expect(recovered.totalStartedStepCount).toBe(2);
		expect(recovered.startedStepKeys).toEqual(new Set([completion.stepKey]));
		expect(recovered.completedStepKeys).toEqual(new Set([completion.stepKey]));
		const accounting = recoverableCompletedModelSteps(
			[...recovered.completedSteps, ...recovered.completedSteps],
			RUN_ID,
		);
		expect(
			accounting.map((step) => [
				step.contextId,
				step.stepKey,
				step.usage.totalTokens,
			]),
		).toEqual([
			[opened.id, completion.stepKey, 16],
			[successor.id, completion.stepKey, 16],
		]);
		expect(
			recoverableCompletedModelSteps(recovered.completedSteps, "another-run"),
		).toEqual([]);
	});

	it("fences a context from another design session in every writer without changing either ledger", async () => {
		const { opened, completion } = await started();
		const otherSessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			project_id: PROJECT,
			run_id: RUN_ID,
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
		});
		const other = await openDesignModelContext({
			...spec(),
			designSessionId: otherSessionId,
		});
		const before = await storedRows(opened.id);
		const otherBefore = await storedRows(other.id);
		const wrongContext = { ...completion, contextId: other.id };
		for (const operation of [
			() => appendDesignModelContext(wrongContext),
			() => completeDesignModelStep(wrongContext),
			() =>
				recordDesignModelStepEvent({
					...wrongContext,
					event: {
						eventKind: "started" as const,
						requestDigest: "4".repeat(64),
					},
				}),
		]) {
			await expect(operation()).rejects.toBeInstanceOf(DesignModelContextError);
			expect(await storedRows(opened.id)).toEqual(before);
			expect(await storedRows(other.id)).toEqual(otherBefore);
		}
	});

	it.each(["changed", "shorter", "reordered"] as const)(
		"refuses %s bytes under an existing append key without changing any stored row",
		async (change) => {
			const opened = await openDesignModelContext(spec());
			const messages: ModelMessage[] = [
				{ role: "user", content: "First" },
				{ role: "assistant", content: "Second" },
			];
			const append = {
				designSessionId,
				contextId: opened.id,
				appendKey: "history",
				messages,
				authority,
			};
			expect(await appendDesignModelContext(append)).toBe(2);
			const before = await storedRows(opened.id);
			const replacement: ModelMessage[] =
				change === "shorter"
					? messages.slice(0, 1)
					: change === "reordered"
						? [...messages].reverse()
						: [{ role: "user", content: "Changed" }, messages[1]];
			await expect(
				appendDesignModelContext({ ...append, messages: replacement }),
			).rejects.toThrow("different model context bytes");
			expect(await storedRows(opened.id)).toEqual(before);
		},
	);

	it.each(["usage", "messages", "append-key"] as const)(
		"refuses a completed-step replay with changed %s after a later suffix append",
		async (change) => {
			const { opened, completion } = await started();
			await completeDesignModelStep(completion);
			const suffix: ModelMessage[] = [
				{ role: "user", content: "The next instruction" },
			];
			await appendDesignModelContext({
				designSessionId,
				contextId: opened.id,
				appendKey: "suffix",
				messages: suffix,
				authority,
			});
			const before = await storedRows(opened.id);
			// An exact retry returns the current revision and does not erase the suffix.
			expect(await completeDesignModelStep(completion)).toBe(2);
			expect(await storedRows(opened.id)).toEqual(before);
			const changedMessages: ModelMessage[] = [
				{ role: "assistant", content: "Changed answer" },
			];
			const replacement =
				change === "usage"
					? { usage: { inputTokens: 13, outputTokens: 4, totalTokens: 17 } }
					: change === "append-key"
						? { appendKey: "another-response" }
						: {
								messages: changedMessages,
								responseDigest: durableModelValueDigest(changedMessages),
							};
			await expect(
				completeDesignModelStep({ ...completion, ...replacement }),
			).rejects.toThrow("different response evidence");
			expect(await storedRows(opened.id)).toEqual(before);
			expect((await openDesignModelContext(spec())).messages).toEqual([
				...completion.messages,
				...suffix,
			]);
		},
	);

	it.each([
		"modelId",
		"promptVersion",
		"toolsetDigest",
		"contextVersion",
	] as const)(
		"supersedes on %s changes and fences all three stale writer methods",
		async (field) => {
			const { opened, completion } = await started();
			const before = await storedRows(opened.id);
			const changed = {
				...spec(),
				[field]: field === "toolsetDigest" ? "a".repeat(64) : "next-version",
			};
			const next = await openDesignModelContext(changed);
			expect(next.generation).toBe(1);
			expect(next.supersedesContextId).toBe(opened.id);
			expect(next.messages).toEqual([]);
			expect((await openDesignModelContext(changed)).id).toBe(next.id);
			for (const write of [
				() => completeDesignModelStep(completion),
				() => appendDesignModelContext(completion),
				() =>
					recordDesignModelStepEvent({
						...completion,
						event: {
							eventKind: "started" as const,
							requestDigest: "2".repeat(64),
						},
					}),
			]) {
				await expect(write()).rejects.toThrow("superseded");
				expect(await storedRows(opened.id)).toEqual(before);
			}
		},
	);

	it.each(["holder", "membership"] as const)(
		"reauthorizes %s after the actual session-row wait in every context entry point",
		async (revoked) => {
			const { opened, completion } = await started();
			const before = await storedRows(opened.id);
			const operations = [
				() => openDesignModelContext(spec()),
				() => appendDesignModelContext(completion),
				() => completeDesignModelStep(completion),
				() =>
					recordDesignModelStepEvent({
						...completion,
						event: {
							eventKind: "started" as const,
							requestDigest: "2".repeat(64),
						},
					}),
			];
			for (const operation of operations) {
				await expect(
					whileBlocked<unknown>(
						h,
						(pg) =>
							pg.query(
								"select id from design_sessions where id=$1 for update",
								[designSessionId],
							),
						operation,
						async (settled, pg) => {
							expect(settled).toBe(false);
							if (revoked === "holder")
								await pg.query(
									"update design_sessions set run_holder_nonce=$2 where id=$1",
									[designSessionId, "11111111-1111-4111-8111-111111111111"],
								);
							else
								await pg.query(
									`update auth_member set role='viewer' where "userId"=$1 and "organizationId"=$2`,
									[ACTOR, PROJECT],
								);
						},
						undefined,
						"COMMIT",
					),
				).rejects.toBeInstanceOf(
					revoked === "holder" ? RunHolderLostError : CommitReauthError,
				);
				expect(await storedRows(opened.id)).toEqual(before);
				if (revoked === "holder")
					await h
						.pool()
						.query(
							"update design_sessions set run_holder_nonce=$2 where id=$1",
							[designSessionId, NONCE],
						);
				else
					await h
						.pool()
						.query(
							`update auth_member set role='owner' where "userId"=$1 and "organizationId"=$2`,
							[ACTOR, PROJECT],
						);
			}
		},
	);

	it.each(["usage", "response_digest", "request_digest"] as const)(
		"refuses changed %s evidence on recovery before returning accounting or step state",
		async (field) => {
			const { opened, completion } = await started();
			await completeDesignModelStep(completion);
			// Deliberately bypass the append-only typed writer to simulate damaged storage.
			await h
				.pool()
				.query(
					`update design_model_steps set ${field}=$1 where context_id=$2 and event_kind=$3`,
					[
						field === "usage"
							? JSON.stringify({
									inputTokens: 999,
									outputTokens: 4,
									totalTokens: 1003,
								})
							: "e".repeat(64),
						opened.id,
						field === "request_digest" ? "started" : "completed",
					],
				);
			await expect(openDesignModelContext(spec())).rejects.toBeInstanceOf(
				DesignModelContextError,
			);
			await expect(
				openDesignModelContext({ ...spec(), promptVersion: "new-prompt" }),
			).rejects.toBeInstanceOf(DesignModelContextError);
			expect(
				await h
					.db()
					.selectFrom("design_model_contexts")
					.select("id")
					.where("design_session_id", "=", designSessionId)
					.execute(),
			).toEqual([{ id: opened.id }]);
		},
	);

	it("refuses a completion whose declared response digest does not bind its exact messages", async () => {
		const { opened, completion } = await started();
		const before = await storedRows(opened.id);
		await expect(
			completeDesignModelStep({
				...completion,
				responseDigest: "a".repeat(64),
			}),
		).rejects.toBeInstanceOf(DesignModelContextError);
		expect(await storedRows(opened.id)).toEqual(before);
	});

	it.each(["completion", "revision"] as const)(
		"rolls response items and completion back after a late %s write fails",
		async (point) => {
			const { opened, completion } = await started();
			const before = await storedRows(opened.id);
			await h
				.pool()
				.query(`CREATE FUNCTION fail_model_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected model completion fault'; END $$;
		CREATE TRIGGER model_completion_fault BEFORE ${point === "completion" ? "INSERT ON design_model_steps FOR EACH ROW WHEN (NEW.event_kind = 'completed')" : "UPDATE ON design_model_contexts FOR EACH ROW"} EXECUTE FUNCTION fail_model_completion();`);
			await expect(completeDesignModelStep(completion)).rejects.toThrow(
				"injected model completion fault",
			);
			expect(await storedRows(opened.id)).toEqual(before);
			await h
				.pool()
				.query(
					`DROP TRIGGER model_completion_fault ON ${point === "completion" ? "design_model_steps" : "design_model_contexts"}; DROP FUNCTION fail_model_completion();`,
				);
			expect(await completeDesignModelStep(completion)).toBe(1);
			expect((await openDesignModelContext(spec())).messages).toEqual(
				completion.messages,
			);
		},
	);

	it.each([true, false])(
		"serializes actual concurrent completions into one exact response: identical=%s",
		async (identical) => {
			const { opened, completion } = await started();
			const differentMessages: ModelMessage[] = [
				{ role: "assistant", content: "Another response." },
			];
			const contender = identical
				? completion
				: {
						...completion,
						messages: differentMessages,
						responseDigest: durableModelValueDigest(differentMessages),
					};
			const outcomes = await whileBlocked(
				h,
				(pg) =>
					pg.query("select id from design_sessions where id=$1 for update", [
						designSessionId,
					]),
				() =>
					Promise.allSettled([
						completeDesignModelStep(completion),
						completeDesignModelStep(contender),
					]),
				async (settled, pg) => {
					expect(settled).toBe(false);
					const deadline = Date.now() + 2000;
					for (;;) {
						await pg.query("select pg_stat_clear_snapshot()");
						const waiting = await pg.query<{ n: number }>(
							"with recursive waiters as (select pid from pg_stat_activity where datname=current_database() and pg_backend_pid() = any(pg_blocking_pids(pid)) union select activity.pid from pg_stat_activity activity join waiters on waiters.pid = any(pg_blocking_pids(activity.pid)) where activity.datname=current_database()) select count(*)::int as n from waiters",
						);
						if (waiting.rows[0].n === 2) break;
						if (Date.now() > deadline)
							throw new Error(
								"Both independent completion connections must reach the held session row",
							);
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
				},
			);
			expect(
				outcomes.filter((outcome) => outcome.status === "fulfilled"),
			).toHaveLength(identical ? 2 : 1);
			for (const outcome of outcomes)
				if (outcome.status === "rejected")
					expect(outcome.reason).toBeInstanceOf(DesignModelContextError);
			const recovered = await openDesignModelContext(spec());
			expect(recovered.revision).toBe(1);
			expect(recovered.messages).toEqual(
				outcomes[0].status === "fulfilled"
					? completion.messages
					: contender.messages,
			);
			expect(
				(await storedRows(opened.id)).steps.map((row) => row.event_kind),
			).toEqual(["completed", "started"]);
			expect(recovered.completedSteps).toHaveLength(1);
		},
	);
	it("atomically persists and replays the exact response and its usage-bearing completion", async () => {
		const { opened, completion } = await started();
		expect(await completeDesignModelStep(completion)).toBe(1);
		const before = await storedRows(opened.id);
		expect(await completeDesignModelStep(completion)).toBe(1);
		expect(await storedRows(opened.id)).toEqual(before);
		const recovered = await openDesignModelContext(spec());
		expect(recovered.messages).toEqual(completion.messages);
		expect(recovered.completedSteps).toEqual([
			{
				contextId: opened.id,
				stepKey: completion.stepKey,
				createdByRunId: RUN_ID,
				createdAt: before.steps[0].created_at,
				usage: {
					...completion.usage,
					inputTokenDetails: {
						noCacheTokens: undefined,
						cacheReadTokens: undefined,
						cacheWriteTokens: undefined,
					},
					outputTokenDetails: {
						textTokens: undefined,
						reasoningTokens: undefined,
					},
				},
			},
		]);
		expect(before.items.map((row) => row.ordinal)).toEqual(["1"]);
	});

	it("rehydrates the exact append-only transcript and deduplicates an append key", async () => {
		const spec = {
			designSessionId,
			kind: "executor" as const,
			modelId: "executor-model",
			promptVersion: "executor-v1",
			toolsetDigest: "a".repeat(64),
			contextVersion: "v1",
			authority,
		};
		const opened = await openDesignModelContext(spec);
		const messages: ModelMessage[] = [
			{ role: "user", content: "slice one" },
			{ role: "assistant", content: "working" },
		];
		await appendDesignModelContext({
			designSessionId,
			contextId: opened.id,
			appendKey: "slice:one",
			messages,
			authority,
		});
		await appendDesignModelContext({
			designSessionId,
			contextId: opened.id,
			appendKey: "slice:one",
			messages,
			authority,
		});

		const recovered = await openDesignModelContext(spec);
		expect(recovered.messages).toEqual(messages);
		expect(recovered.revision).toBe(2);
		expect(recovered.appendKeys).toEqual(new Set(["slice:one"]));
	});

	it("supersedes instead of rewriting a context under a changed provider contract", async () => {
		const spec = {
			designSessionId,
			kind: "design" as const,
			modelId: "design-model",
			promptVersion: "design-v1",
			toolsetDigest: "b".repeat(64),
			contextVersion: "v1",
			authority,
		};
		const original = await openDesignModelContext(spec);
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: original.id,
			stepKey: "old-generation:1",
			event: {
				eventKind: "started",
				requestDigest: "9".repeat(64),
			},
			authority,
		});
		const oldResponseKey = `design-response:user-turn-1:old-generation:1:${"8".repeat(64)}`;
		await completeDesignModelStep({
			designSessionId,
			contextId: original.id,
			appendKey: oldResponseKey,
			messages: [{ role: "assistant", content: "old exact response" }],
			stepKey: "old-generation:1",
			responseDigest: durableModelValueDigest([
				{ role: "assistant", content: "old exact response" },
			]),
			authority,
		});

		const successor = await openDesignModelContext({
			...spec,
			toolsetDigest: "c".repeat(64),
		});
		expect(successor.id).not.toBe(original.id);
		expect(successor.generation).toBe(1);
		expect(successor.supersedesContextId).toBe(original.id);
		expect(successor.messages).toEqual([]);
		expect(successor.predecessorItems).toEqual([
			{
				appendKey: oldResponseKey,
				message: { role: "assistant", content: "old exact response" },
			},
		]);
		expect(successor.appendKeys).toEqual(new Set());
		expect(successor.lineageAppendKeys).toEqual(new Set([oldResponseKey]));
		expect(successor.startedStepKeys).toEqual(new Set());
		expect(successor.totalStartedStepCount).toBe(1);
		await expect(
			appendDesignModelContext({
				designSessionId,
				contextId: original.id,
				appendKey: "stale-writer",
				messages: [{ role: "assistant", content: "too late" }],
				authority,
			}),
		).rejects.toBeInstanceOf(DesignModelContextError);

		const oldItems = await h
			.db()
			.selectFrom("design_model_context_items")
			.select(["append_key", "message"])
			.where("context_id", "=", original.id)
			.execute();
		expect(oldItems).toHaveLength(1);
		expect(oldItems[0]?.append_key).toBe(oldResponseKey);

		const reopened = await openDesignModelContext({
			...spec,
			toolsetDigest: "c".repeat(64),
		});
		expect(reopened.id).toBe(successor.id);
		expect(reopened.generation).toBe(1);
		expect(reopened.lineageAppendKeys).toEqual(new Set([oldResponseKey]));
		expect(reopened.totalStartedStepCount).toBe(1);
		await appendDesignModelContext({
			designSessionId,
			contextId: successor.id,
			appendKey: "state:item-only-rollover",
			messages: [{ role: "user", content: "new server state" }],
			authority,
		});

		const successorAfterItemOnlyGeneration = await openDesignModelContext({
			...spec,
			toolsetDigest: "d".repeat(64),
		});
		expect(successorAfterItemOnlyGeneration.generation).toBe(2);
		expect(successorAfterItemOnlyGeneration.predecessorItems).toEqual([
			{
				appendKey: oldResponseKey,
				message: { role: "assistant", content: "old exact response" },
			},
		]);
	});

	it("reopens one slice attempt but starts a fresh executor generation for the next attempt", async () => {
		const spec = {
			designSessionId,
			kind: "executor" as const,
			modelId: "executor-model",
			promptVersion: "executor-v2",
			toolsetDigest: "d".repeat(64),
			contextVersion: "v1",
			semanticScopeKey: "slice-a:attempt-a",
			authority,
		};
		const first = await openDesignModelContext(spec);
		await appendDesignModelContext({
			designSessionId,
			contextId: first.id,
			appendKey: "attempt-a-opening",
			messages: [{ role: "user", content: "attempt A" }],
			authority,
		});

		const recovered = await openDesignModelContext(spec);
		expect(recovered.id).toBe(first.id);
		expect(recovered.generation).toBe(first.generation);
		expect(recovered.messages).toEqual([
			{ role: "user", content: "attempt A" },
		]);

		const next = await openDesignModelContext({
			...spec,
			semanticScopeKey: "slice-b:attempt-b",
		});
		expect(next.id).not.toBe(first.id);
		expect(next.generation).toBe(first.generation + 1);
		expect(next.supersedesContextId).toBe(first.id);
		expect(next.messages).toEqual([]);
		expect(next.predecessorItems).toEqual([]);
		expect(next.lineageAppendKeys).toEqual(new Set(["attempt-a-opening"]));
		await expect(
			appendDesignModelContext({
				designSessionId,
				contextId: first.id,
				appendKey: "stale-attempt-a",
				messages: [{ role: "assistant", content: "late" }],
				authority,
			}),
		).rejects.toBeInstanceOf(DesignModelContextError);
	});

	it("records idempotent payload-free provider step boundaries", async () => {
		const spec = {
			designSessionId,
			kind: "executor" as const,
			modelId: "executor-model",
			promptVersion: "executor-v1",
			toolsetDigest: "e".repeat(64),
			contextVersion: "v1",
			authority,
		};
		const opened = await openDesignModelContext(spec);
		const started = {
			eventKind: "started" as const,
			requestDigest: "f".repeat(64),
		};
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: opened.id,
			stepKey: "attempt-1:1",
			event: started,
			authority,
		});
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: opened.id,
			stepKey: "attempt-1:1",
			event: started,
			authority,
		});
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: opened.id,
			stepKey: "attempt-1:1",
			event: {
				eventKind: "completed",
				responseDigest: "1".repeat(64),
				usage: { inputTokens: 100, outputTokens: 20 },
			},
			authority,
		});
		const rows = await h
			.db()
			.selectFrom("design_model_steps")
			.select(["event_kind", "request_digest", "response_digest", "usage"])
			.where("context_id", "=", opened.id)
			.orderBy("created_at", "asc")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			event_kind: "started",
			request_digest: "f".repeat(64),
			response_digest: null,
		});
		expect(rows[1]).toMatchObject({
			event_kind: "completed",
			request_digest: null,
			response_digest: "1".repeat(64),
			usage: { inputTokens: 100, outputTokens: 20 },
		});
		const recovered = await openDesignModelContext(spec);
		expect(recovered.startedStepKeys).toEqual(new Set(["attempt-1:1"]));
		expect(recovered.completedStepKeys).toEqual(new Set(["attempt-1:1"]));
		expect(recovered.completedSteps).toMatchObject([
			{
				contextId: opened.id,
				stepKey: "attempt-1:1",
				createdByRunId: RUN_ID,
				createdAt: expect.any(Date),
				usage: { inputTokens: 100, outputTokens: 20 },
			},
		]);
		expect(
			recoverableCompletedModelSteps(recovered.completedSteps, RUN_ID),
		).toHaveLength(1);
		expect(
			recoverableCompletedModelSteps(recovered.completedSteps, "another-run"),
		).toHaveLength(0);
	});

	it("replays a persisted image and an actual decoded response through the production SDK", async () => {
		const opened = await openDesignModelContext(spec());
		const png =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
		const message: ModelMessage = {
			role: "user",
			content: [
				{
					type: "file",
					mediaType: "image/png",
					data: { type: "url", url: new URL(png) },
				},
			],
		};
		await appendDesignModelContext({
			designSessionId,
			contextId: opened.id,
			appendKey: "image",
			messages: [message],
			authority,
		});
		const requests: unknown[] = [];
		await withResponsesPeer(
			(request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					requests.push(JSON.parse(body));
					respondWithObject(response, "Image received");
				});
			},
			async (provider) => {
				const step = productionExecutorStep(provider("gpt-5.6-luna"));
				const recovered = await openDesignModelContext(spec());
				expect(recovered.messages).toEqual([message]);
				const args = {
					system: "Inspect the image",
					messages: recovered.messages,
					tools: {},
					allowedTools: [],
					signal: new AbortController().signal,
				};
				await recordDesignModelStepEvent({
					designSessionId,
					contextId: opened.id,
					stepKey: "image:1",
					event: {
						eventKind: "started",
						requestDigest: durableModelValueDigest(args.messages),
					},
					authority,
				});
				const result = await step(args);
				expect(result.text).toBe("Image received");
				await completeDesignModelStep({
					designSessionId,
					contextId: opened.id,
					stepKey: "image:1",
					appendKey: "response:image:1",
					messages: result.responseMessages,
					responseDigest: durableModelValueDigest(result.responseMessages),
					usage: { ...result.usage },
					authority,
				});
				const next = await openDesignModelContext(spec());
				expect(next.messages).toEqual([message, ...result.responseMessages]);
				expect(next.completedSteps.map((item) => item.usage)).toEqual([
					result.usage,
				]);
				await step({ ...args, messages: next.messages });
			},
		);
		expect(requests).toHaveLength(2);
		for (const request of requests)
			expect(request).toMatchObject({
				input: expect.arrayContaining([
					{ role: "user", content: [{ type: "input_image", image_url: png }] },
				]),
			});
		expect(requests[1]).toMatchObject({
			input: expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: [{ type: "output_text", text: "Image received" }],
				}),
			]),
		});
	});
});

describe("durable design turn admission", () => {
	it("keeps starts across rollover, deduplicates replay, and grants a different turn its own allowance", async () => {
		const designSpec = { ...spec(), kind: "design" as const };
		let context = await openDesignModelContext(designSpec);
		const reserve = (stepKey: string, turn: string) =>
			recordDesignModelStepEvent({
				designSessionId,
				contextId: context.id,
				stepKey,
				event: {
					eventKind: "started",
					requestDigest: "1".repeat(64),
					turnProvenanceId: turn,
				},
				turnBudget: { limit: 1, includeLegacy: false },
				authority,
			});
		await reserve("first", "message-a");
		await reserve("first", "message-a");
		context = await openDesignModelContext({
			...designSpec,
			promptVersion: "design-v2",
		});
		expect(context.startedStepsByTurn.get("message-a")).toBe(1);
		await expect(reserve("second", "message-a")).rejects.toThrow(
			"step allowance",
		);
		await reserve("third", "answered-question-b");
		const reopened = await openDesignModelContext({
			...designSpec,
			promptVersion: "design-v2",
		});
		expect(reopened.totalStartedStepCount).toBe(2);
		expect(reopened.startedStepsByTurn.get("answered-question-b")).toBe(1);
	});
	it("serializes competing reservations for the last step", async () => {
		const context = await openDesignModelContext({ ...spec(), kind: "design" });
		const outcomes = await Promise.allSettled(
			["a", "b"].map((stepKey) =>
				recordDesignModelStepEvent({
					designSessionId,
					contextId: context.id,
					stepKey,
					event: {
						eventKind: "started",
						requestDigest: "2".repeat(64),
						turnProvenanceId: "same-turn",
					},
					turnBudget: { limit: 1, includeLegacy: false },
					authority,
				}),
			),
		);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect((await storedRows(context.id)).steps).toHaveLength(1);
	});
	it("keeps legacy digest verification and conservatively charges a legacy continuation", async () => {
		const designSpec = { ...spec(), kind: "design" as const };
		const context = await openDesignModelContext(designSpec);
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: context.id,
			stepKey: "legacy",
			event: { eventKind: "started", requestDigest: "3".repeat(64) },
			authority,
		});
		const reopened = await openDesignModelContext(designSpec);
		expect(reopened.legacyStartedStepCount).toBe(1);
		await expect(
			recordDesignModelStepEvent({
				designSessionId,
				contextId: context.id,
				stepKey: "new",
				event: {
					eventKind: "started",
					requestDigest: "4".repeat(64),
					turnProvenanceId: "legacy-turn",
				},
				turnBudget: { limit: 1, includeLegacy: true },
				authority,
			}),
		).rejects.toThrow("step allowance");
	});
});
