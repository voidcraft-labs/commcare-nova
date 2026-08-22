import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	DesignModelContextError,
	openDesignModelContext,
	recordDesignModelStepEvent,
	recoverableCompletedModelSteps,
} from "@/lib/agent/build/modelContextStore";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("design_model_context_");
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
	it("atomically persists a response and its usage-bearing completion", async () => {
		const spec = {
			designSessionId,
			kind: "executor" as const,
			modelId: "executor-model",
			promptVersion: "executor-v1",
			toolsetDigest: "0".repeat(64),
			contextVersion: "v1",
			authority,
		};
		const opened = await openDesignModelContext(spec);
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: opened.id,
			stepKey: "attempt:1",
			event: { eventKind: "started", requestDigest: "1".repeat(64) },
			authority,
		});
		const completion = {
			designSessionId,
			contextId: opened.id,
			appendKey: "response:attempt:1",
			messages: [{ role: "assistant", content: "complete" }] as ModelMessage[],
			stepKey: "attempt:1",
			responseDigest: "2".repeat(64),
			usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
			authority,
		};
		await completeDesignModelStep(completion);
		await completeDesignModelStep(completion);

		const recovered = await openDesignModelContext(spec);
		expect(recovered.messages).toEqual(completion.messages);
		expect(recovered.completedSteps).toMatchObject([
			{
				contextId: opened.id,
				stepKey: "attempt:1",
				usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
			},
		]);
		expect(
			await h
				.db()
				.selectFrom("design_model_context_items")
				.select("ordinal")
				.where("context_id", "=", opened.id)
				.execute(),
		).toHaveLength(1);
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
			responseDigest: "8".repeat(64),
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

	it("round-trips inline image URLs as executable ModelMessage data", async () => {
		const spec = {
			designSessionId,
			kind: "design" as const,
			modelId: "design-model",
			promptVersion: "design-v1",
			toolsetDigest: "d".repeat(64),
			contextVersion: "v1",
			authority,
		};
		const opened = await openDesignModelContext(spec);
		const message: ModelMessage = {
			role: "user",
			content: [
				{
					type: "file",
					mediaType: "image/png",
					data: {
						type: "url",
						url: new URL("data:image/png;base64,AAAA"),
					},
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
		const recovered = await openDesignModelContext(spec);
		const content = (recovered.messages[0] as typeof message).content;
		if (typeof content === "string") throw new Error("recovered file missing");
		const part = content[0];
		expect(part?.type).toBe("file");
		if (part?.type !== "file" || typeof part.data !== "object") {
			throw new Error("recovered file data missing");
		}
		expect("url" in part.data ? part.data.url : null).toBeInstanceOf(URL);
		expect("url" in part.data ? part.data.url.toString() : null).toBe(
			"data:image/png;base64,AAAA",
		);
	});
});
