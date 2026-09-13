/**
 * The anatomy's ledger reader over rows the production writers persisted.
 *
 * Every write goes through `openDesignModelContext`,
 * `appendDesignModelContext`, `recordDesignModelStepEvent`, and
 * `completeDesignModelStep`, so the reader is proven against the exact
 * encoding, ordering, and step-event shape the design and executor loops
 * leave behind, not against a hand-made row. The failures this prevents: a
 * reader that misorders items or generations, mislabels a family, drops a
 * completed step's usage, or fails to join an executor context to its slice
 * attempt through the semantic scope in its context version.
 */

import type { ModelMessage } from "ai";
import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	openDesignModelContext,
	recordDesignModelStepEvent,
} from "@/lib/agent/build/modelContextStore";
import {
	durableModelValueDigest,
	persistModelMessage,
} from "@/lib/agent/modelMessagePersistence";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { listDesignSessions, readDesignSession } from "../recorded";

const h = setupAppStateTestDb("anatomy_recorded_", { poolMax: 3 });
const ACTOR = "anatomy-owner";
const PROJECT = "anatomy-project";
const RUN_ID = "anatomy-run";
const NONCE = "7b1b46b5-2222-4333-8444-a55556666778";
let designSessionId: string;
let attemptId: string;
let sliceId: string;

const authority = {
	actorUserId: ACTOR,
	runId: RUN_ID,
	holderNonce: NONCE,
	expectedProjectId: PROJECT,
};

const designSpec = (promptVersion = "design-agent-test") => ({
	designSessionId,
	kind: "design" as const,
	modelId: "design-model",
	promptVersion,
	toolsetDigest: "a".repeat(64),
	contextVersion: "v1",
	authority,
});

const seedMessages: ModelMessage[] = [
	{ role: "user", content: "Build a visit tracker for outreach workers." },
	{ role: "user", content: "Each visit records a date and an outcome." },
];
const stateMessage: ModelMessage = {
	role: "user",
	content: "# Design session state (server-derived)\n\nNo artifacts yet.",
};
const responseMessages: ModelMessage[] = [
	{ role: "assistant", content: "I will start with the visit record." },
];

async function append(
	contextId: string,
	appendKey: string,
	messages: ModelMessage[],
) {
	await appendDesignModelContext({
		designSessionId,
		contextId,
		appendKey,
		messages,
		authority,
	});
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
			period: "2026-09",
			reserved: 1,
			settled: false,
			userId: ACTOR,
			runId: RUN_ID,
		},
	});
	const lineage = await h.seedDesignLineage({
		existingSessionId: designSessionId,
		project_id: PROJECT,
	});
	attemptId = lineage.attemptId;
	sliceId = lineage.sliceId;
});

describe("readDesignSession", () => {
	it("returns null for a session that does not exist", async () => {
		await expect(
			readDesignSession("00000000-0000-4000-8000-000000000000"),
		).resolves.toBeNull();
	});

	it("reads a design context's items in ledger order with their families and the completed step's billed usage", async () => {
		const opened = await openDesignModelContext(designSpec());
		await append(opened.id, "seed:package-digest", seedMessages);
		await append(opened.id, "state:state-digest", [stateMessage]);
		const stepKey = "design:attempt:1";
		await recordDesignModelStepEvent({
			designSessionId,
			contextId: opened.id,
			stepKey,
			event: {
				eventKind: "started",
				requestDigest: "1".repeat(64),
				turnProvenanceId: "user-turn-1",
			},
			authority,
		});
		await completeDesignModelStep({
			designSessionId,
			contextId: opened.id,
			appendKey: "design-response:turn-1:author:",
			messages: responseMessages,
			stepKey,
			responseDigest: durableModelValueDigest(responseMessages),
			usage: {
				inputTokens: 1200,
				outputTokens: 80,
				totalTokens: 1280,
				inputTokenDetails: { cacheReadTokens: 1000, noCacheTokens: 200 },
				outputTokenDetails: { reasoningTokens: 30, textTokens: 50 },
			},
			authority,
		});

		const session = await readDesignSession(designSessionId);
		expect(session).not.toBeNull();
		expect(session?.designSessionId).toBe(designSessionId);
		expect(session?.appName).toBeNull();
		const context = session?.contexts.find(
			(candidate) => candidate.kind === "design",
		);
		expect(context).toMatchObject({
			contextId: opened.id,
			generation: 0,
			supersedesContextId: null,
			modelId: "design-model",
			promptVersion: "design-agent-test",
			toolsetDigest: "a".repeat(64),
			contextVersion: "v1",
		});
		expect(context?.slice).toBeUndefined();
		expect(
			context?.items.map((item) => [
				item.ordinal,
				item.itemKind,
				item.appendKey,
				item.appendIndex,
			]),
		).toEqual([
			[1, "seed", "seed:package-digest", 0],
			[2, "seed", "seed:package-digest", 1],
			[3, "state-packet", "state:state-digest", 0],
			[4, "response", "design-response:turn-1:author:", 0],
		]);
		expect(context?.items.map((item) => item.message)).toEqual([
			...seedMessages,
			stateMessage,
			...responseMessages,
		]);
		expect(context?.items.every((item) => item.createdByRunId === RUN_ID)).toBe(
			true,
		);
		expect(context?.items.every((item) => !item.compaction)).toBe(true);
		expect(context?.steps).toHaveLength(1);
		expect(context?.steps[0]).toMatchObject({
			stepKey,
			requestDigest: "1".repeat(64),
			responseDigest: durableModelValueDigest(responseMessages),
			usage: {
				inputTokens: 1200,
				outputTokens: 80,
				totalTokens: 1280,
				cachedInputTokens: 1000,
				reasoningTokens: 30,
			},
		});
		expect(context?.steps[0]?.startedAt).not.toBeNull();
		expect(context?.steps[0]?.completedAt).not.toBeNull();
	});

	it("marks a row whose stored message no longer matches its digest, and keeps the rest verified", async () => {
		const opened = await openDesignModelContext(designSpec());
		await append(opened.id, "seed:package-digest", seedMessages);
		await append(opened.id, "state:state-digest", [stateMessage]);
		// Edit one row behind the writer's back, the way a hand repair or a
		// corrupted column would; the digest beside it stays as written.
		await sql`
			update design_model_context_items
			set message = ${JSON.stringify(persistModelMessage({ role: "user", content: "not what was sent" }))}::jsonb
			where context_id = ${opened.id} and ordinal = 2
		`.execute(h.db());

		const session = await readDesignSession(designSessionId);
		const items = session?.contexts[0]?.items ?? [];
		expect(items.map((item) => [item.ordinal, item.verified])).toEqual([
			[1, true],
			[2, false],
			[3, true],
		]);
		expect(items[1]?.message).toEqual({
			role: "user",
			content: "not what was sent",
		});
	});

	it("returns a rolled-over session's generations in order, linked to their predecessors", async () => {
		const first = await openDesignModelContext(designSpec("design-agent-v1"));
		await append(first.id, "seed:package-digest", seedMessages);
		const second = await openDesignModelContext(designSpec("design-agent-v2"));
		expect(second.id).not.toBe(first.id);
		await append(second.id, "seed-through:message-2", seedMessages);

		const session = await readDesignSession(designSessionId);
		const design = session?.contexts.filter(
			(context) => context.kind === "design",
		);
		expect(
			design?.map((context) => [
				context.contextId,
				context.generation,
				context.supersedesContextId,
			]),
		).toEqual([
			[first.id, 0, null],
			[second.id, 1, first.id],
		]);
		expect(design?.[0]?.promptVersion).toBe("design-agent-v1");
		expect(design?.[1]?.promptVersion).toBe("design-agent-v2");
		expect(design?.[1]?.items.map((item) => item.itemKind)).toEqual([
			"seed",
			"seed",
		]);
	});

	it("joins an executor context to its slice attempt through the semantic scope and chips its tool results", async () => {
		const opened = await openDesignModelContext({
			designSessionId,
			kind: "executor",
			modelId: "executor-model",
			promptVersion: "build-executor-test",
			toolsetDigest: "b".repeat(64),
			contextVersion: "v1",
			semanticScopeKey: attemptId,
			authority,
		});
		const scope = attemptId;
		await append(opened.id, `slice-brief:${scope}`, [
			{
				role: "user",
				content: "## Accepted execution brief\n\nBuild the visit form.",
			},
		]);
		await append(opened.id, `candidate:${scope}:digest`, [
			{
				role: "user",
				content: "## Current authoritative private candidate\n\n(empty)",
			},
		]);
		await append(opened.id, `focus:${scope}:digest`, [
			{ role: "user", content: "## Current slice focus\n\nOne form." },
		]);
		await append(opened.id, `step:${scope}:1:tool:call-1`, [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "reportExecutionBlocker",
						output: { type: "json", value: { decision: "continue" } },
					},
				],
			},
		]);
		await append(opened.id, `step:${scope}:2:tool:call-2`, [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-2",
						toolName: "createForm",
						output: {
							type: "json",
							value: {
								error: "rejected",
								architectGuidance: "Host it on the parent.",
							},
						},
					},
				],
			},
		]);
		await append(opened.id, `step:${scope}:2:empty`, [
			{ role: "user", content: "Continue building." },
		]);

		const session = await readDesignSession(designSessionId);
		const context = session?.contexts.find(
			(candidate) => candidate.kind === "executor",
		);
		expect(context).toMatchObject({
			contextId: opened.id,
			kind: "executor",
			contextVersion: `v1:semantic-scope:${attemptId}`,
			slice: { attemptId, sliceId, attempt: 1, status: "running" },
		});
		expect(context?.items.map((item) => item.itemKind)).toEqual([
			"slice-brief",
			"candidate-checkpoint",
			"slice-focus",
			"blocker",
			"auto-blocker",
			"empty-step-nudge",
		]);
		expect(context?.steps).toEqual([]);
	});
});

describe("listDesignSessions", () => {
	it("lists the session with its context counts and the billed run totals", async () => {
		const design = await openDesignModelContext(designSpec());
		await append(design.id, "seed:package-digest", seedMessages);
		await openDesignModelContext({
			designSessionId,
			kind: "executor",
			modelId: "executor-model",
			promptVersion: "build-executor-test",
			toolsetDigest: "b".repeat(64),
			contextVersion: "v1",
			semanticScopeKey: attemptId,
			authority,
		});
		const startedAt = new Date("2026-09-01T10:00:00Z").toISOString();
		await h
			.db()
			.insertInto("run_summaries")
			.values([
				{
					app_id: null,
					design_session_id: designSessionId,
					run_id: RUN_ID,
					started_at: startedAt,
					finished_at: new Date("2026-09-01T10:05:00Z").toISOString(),
					prompt_mode: "build",
					app_ready: false,
					module_count: 0,
					step_count: 3,
					model: "design-model",
					input_tokens: 1200,
					output_tokens: 80,
					cache_read_tokens: 1000,
					cache_write_tokens: 0,
					cost_estimate: 0.0125,
					tool_call_count: 2,
				},
				{
					app_id: null,
					design_session_id: designSessionId,
					run_id: `${RUN_ID}-2`,
					started_at: startedAt,
					finished_at: new Date("2026-09-01T10:15:00Z").toISOString(),
					prompt_mode: "build",
					app_ready: false,
					module_count: 0,
					step_count: 1,
					model: "design-model",
					input_tokens: 300,
					output_tokens: 20,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					cost_estimate: 0.0025,
					tool_call_count: 0,
				},
			])
			.execute();

		const sessions = await listDesignSessions();
		const listed = sessions.find(
			(session) => session.designSessionId === designSessionId,
		);
		expect(listed).toMatchObject({
			appId: null,
			appName: null,
			mode: "build",
			state: "active",
			designContexts: 1,
			executorContexts: 1,
			billedInputTokens: 1500,
			billedOutputTokens: 100,
		});
		expect(listed?.costEstimate).toBeCloseTo(0.015, 6);
		expect(Number.isNaN(Date.parse(listed?.updatedAt ?? ""))).toBe(false);
	});
});
