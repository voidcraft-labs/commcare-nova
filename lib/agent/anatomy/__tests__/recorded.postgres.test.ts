/** Inspection reads the production ledger, including paid usage and damaged rows. */
import type { ModelMessage } from "ai";
import { sql } from "kysely";
import { beforeEach, expect, it } from "vitest";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	type DesignModelContextSpec,
	openDesignModelContext,
	recordDesignModelStepEvent,
} from "@/lib/agent/build/modelContextStore";
import {
	durableModelValueDigest,
	persistModelMessage,
} from "@/lib/agent/modelMessagePersistence";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import { listDesignSessions, readDesignSession } from "../recorded";

const h = setupAppStateTestDb("anatomy_recorded_");
const ACTOR = "anatomy-owner";
const PROJECT = "anatomy-project";
const RUN = "anatomy-run";
let spec: DesignModelContextSpec;

beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const claim = await createAndClaimDesignSessionRun({
		actorUserId: ACTOR,
		projectId: PROJECT,
		runId: RUN,
		cost: 1,
	});
	spec = {
		designSessionId: claim.designSessionId,
		kind: "architect",
		modelId: "gpt-5.6-sol",
		promptVersion: "v1",
		toolsetDigest: "a".repeat(64),
		contextVersion: "v1",
		authority: {
			actorUserId: ACTOR,
			expectedProjectId: PROJECT,
			runId: RUN,
			holderNonce: claim.holderNonce,
		},
	};
});
const requests: ModelMessage[] = [
	{ role: "user", content: "Build a visit tracker for outreach workers." },
	{ role: "user", content: "Each visit records a date and an outcome." },
];
const response: ModelMessage[] = [
	{
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "A follow-up should update the selected client.",
			},
			{
				type: "tool-call",
				toolName: "readPlan",
				toolCallId: "read-plan",
				input: {},
			},
		],
	},
];
const usage = {
	inputTokens: 1200,
	outputTokens: 80,
	totalTokens: 1280,
	inputTokenDetails: { cacheReadTokens: 1000, noCacheTokens: 200 },
	outputTokenDetails: { reasoningTokens: 30, textTokens: 50 },
};
async function append(
	contextId: string,
	appendKey: string,
	messages: ModelMessage[],
) {
	return appendDesignModelContext({ ...spec, contextId, appendKey, messages });
}
async function complete(
	contextId: string,
	stepKey: string,
	messages = response,
) {
	await recordDesignModelStepEvent({
		...spec,
		contextId,
		stepKey,
		event: {
			eventKind: "started",
			requestDigest: "1".repeat(64),
			turnProvenanceId: "request-1",
		},
	});
	await completeDesignModelStep({
		...spec,
		contextId,
		stepKey,
		appendKey: `response:${stepKey}`,
		messages,
		responseDigest: durableModelValueDigest(messages),
		usage,
	});
}

it("preserves the actual conversation, reasoning, tool results and unknown items in ledger order", async () => {
	const opened = await openDesignModelContext(spec);
	await append(opened.id, "request:1", requests);
	await complete(opened.id, "step-1");
	const result: ModelMessage = {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolName: "readPlan",
				toolCallId: "read-plan",
				output: {
					type: "json",
					value: { revision: 2, markdown: "Register clients, then follow up." },
				},
			},
		],
	};
	await append(opened.id, "tool:read-plan", [result]);
	const unrecognized: ModelMessage = {
		role: "user",
		content: "A future observation remains inspectable.",
	};
	await append(opened.id, "future-observation", [unrecognized]);
	const session = await readDesignSession(spec.designSessionId);
	const context = session?.contexts[0];
	expect(context).toMatchObject({
		contextId: opened.id,
		kind: "architect",
		modelId: spec.modelId,
		generation: 0,
		promptVersion: "v1",
		toolsetDigest: spec.toolsetDigest,
	});
	expect(
		context?.items.map((item) => [
			item.ordinal,
			item.itemKind,
			item.appendIndex,
		]),
	).toEqual([
		[1, "source", 0],
		[2, "source", 1],
		[3, "response", 0],
		[4, "tool-result", 0],
		[5, "unknown", 0],
	]);
	expect(context?.items.map((item) => item.message)).toEqual([
		...requests,
		...response,
		result,
		unrecognized,
	]);
	expect(
		context?.items.every(
			(item) => item.verified && item.createdByRunId === RUN,
		),
	).toBe(true);
	expect(context?.steps).toMatchObject([
		{
			stepKey: "step-1",
			requestDigest: "1".repeat(64),
			responseDigest: durableModelValueDigest(response),
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			usage: {
				inputTokens: 1200,
				outputTokens: 80,
				totalTokens: 1280,
				cachedInputTokens: 1000,
				reasoningTokens: 30,
			},
		},
	]);
});

it("shows a damaged message without presenting it as verified or hiding adjacent messages", async () => {
	const opened = await openDesignModelContext(spec);
	await append(opened.id, "request:1", requests);
	const changed: ModelMessage = {
		role: "user",
		content: "Not the original request.",
	};
	await sql`UPDATE design_model_context_items
    SET message = ${JSON.stringify(persistModelMessage(changed))}::jsonb
    WHERE context_id = ${opened.id} AND ordinal = 2`.execute(h.db());
	const recorded = await readDesignSession(spec.designSessionId);
	expect(
		recorded?.contexts[0]?.items.map((item) => [item.message, item.verified]),
	).toEqual([
		[requests[0], true],
		[changed, false],
	]);
});

it("keeps architect generations and independent peers distinct and totals the actual accounted usage", async () => {
	const first = await openDesignModelContext(spec);
	await append(first.id, "request:1", requests);
	await complete(first.id, "first");
	const second = await openDesignModelContext({ ...spec, promptVersion: "v2" });
	await append(second.id, "previous-conversation", [...requests, ...response]);
	const peer = await openDesignModelContext({
		...spec,
		kind: "peer",
		contextVersion: "review-1",
	});
	const review: ModelMessage = {
		role: "user",
		content: "Review the source, saved plan and actual app.",
	};
	await append(peer.id, "review-context", [review]);
	await complete(peer.id, "peer", [
		{
			role: "assistant",
			content: "The workflow needs a clear closing action.",
		},
	]);
	const recorded = await readDesignSession(spec.designSessionId);
	const leads = recorded?.contexts.filter(
		(context) => context.kind === "architect",
	);
	expect(
		leads?.map((context) => [
			context.contextId,
			context.generation,
			context.supersedesContextId,
		]),
	).toEqual([
		[first.id, 0, null],
		[second.id, 1, first.id],
	]);
	expect(
		recorded?.contexts.find((context) => context.kind === "peer")?.items[0],
	).toMatchObject({
		message: review,
		itemKind: "plan",
	});
	const summary = (await listDesignSessions()).find(
		(row) => row.designSessionId === spec.designSessionId,
	);
	expect(summary).toMatchObject({
		appId: null,
		architectContexts: 2,
		peerContexts: 1,
		billedInputTokens: 2400,
		billedOutputTokens: 160,
	});
	expect(summary?.costEstimate).toBeGreaterThan(0);
	await expect(readDesignSession("not-an-id")).resolves.toBeNull();
	await expect(
		readDesignSession("00000000-0000-4000-8000-000000000000"),
	).resolves.toBeNull();
});
