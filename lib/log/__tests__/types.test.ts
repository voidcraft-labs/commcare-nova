/** Persisted-event decoding: complete supported payload families, strict
 * envelopes, private annotation boundaries and explicit opaque archives. */
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { DESTINATIONS_LOOKUP } from "@/lib/__tests__/lookupFixtures";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { decodeEvents } from "../reader";
import { type ConversationPayload, type Event, eventSchema } from "../types";

const envelope = { runId: "run", ts: 1000, seq: 0, source: "chat" } as const;
const payloads = {
	"user-message": [
		{
			type: "user-message",
			text: "Visit",
			attachments: [
				{
					assetId: asMediaAssetId(testUuid("audit-asset")),
					kind: "audio",
					filename: "visit.mp3",
					mimeType: "audio/mpeg",
					title: "Recorded visit",
					summary: "A historical attachment receipt",
				},
			],
		},
	],
	"assistant-text": [{ type: "assistant-text", text: "Visit recorded" }],
	"assistant-reasoning": [
		{ type: "assistant-reasoning", text: "Checking the workflow" },
	],
	"tool-call": [
		{
			type: "tool-call",
			toolCallId: "call",
			toolName: "setAppName",
			input: { name: "Visits", nested: [1, null, true] },
		},
	],
	"tool-result": [
		{
			type: "tool-result",
			toolCallId: "call",
			toolName: "setAppName",
			output: null,
		},
		{
			type: "tool-result",
			toolCallId: "other",
			toolName: "inspectApp",
			output: { name: "Visits" },
		},
	],
	error: [
		{
			type: "error",
			error: {
				type: "rate_limit",
				message: "Trying again",
				fatal: false,
				runContinues: true,
			},
		},
	],
	"validation-attempt": [
		{
			type: "validation-attempt",
			attempt: 1,
			errors: ["Historical validation finding"],
		},
	],
	"step-usage": [
		{
			type: "step-usage",
			model: "model",
			pricingTier: "long",
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 75,
			cacheWriteTokens: 0,
			finishReason: "tool-calls",
			rawFinishReason: "tool_calls",
			stepTimeMs: 123.45,
			responseTimeMs: 100.25,
			toolCallIds: ["call"],
		},
	],
	"design-tool-outcome": [
		{
			type: "design-tool-outcome",
			toolCallId: "design-call",
			toolName: "stageContract",
			inputChars: 24,
			durationMs: 12,
			outcome: "needs-input",
			code: "CONSTRUCTION_NEEDS_INPUT",
			validationStage: "construction",
			issueCount: 1,
		},
	],
	"executor-tool-outcome": [
		{
			type: "executor-tool-outcome",
			modelStep: 1,
			toolName: "addModule",
			operationIndex: 0,
			workspaceRevision: 2,
			outcome: "non-applied",
			code: "TARGET_INVALID",
		},
	],
	"attachment-prep": [
		{ type: "attachment-prep", phase: "start", count: 1 },
		{ type: "attachment-prep", phase: "done" },
	],
} satisfies {
	[K in ConversationPayload["type"]]: Extract<
		ConversationPayload,
		{ type: K }
	>[];
};

function conversation(payload: ConversationPayload): Event {
	return { ...envelope, kind: "conversation", payload };
}

it.each(Object.entries(payloads))(
	"decodes every persisted %s payload without losing fields",
	(_kind, samples) => {
		const events = samples.map(conversation);
		expect(decodeEvents(JSON.parse(JSON.stringify(events)))).toEqual(events);
	},
);

it("preserves canonical mutation identity and rejects an invalid mutation inside an otherwise valid envelope", () => {
	const event: Event = {
		...envelope,
		kind: "mutation",
		actor: "agent",
		stage: "app",
		mutation: {
			kind: "addModule",
			module: {
				uuid: testUuid("module"),
				id: "visits",
				name: "Visits",
				displayCondition: {
					kind: "eq",
					left: {
						kind: "term",
						term: {
							kind: "table-column",
							tableId: DESTINATIONS_LOOKUP.tableId,
							columnId: DESTINATIONS_LOOKUP.valueColumnId,
						},
					},
					right: { kind: "term", term: { kind: "literal", value: "open" } },
				},
			},
		},
	};
	expect(eventSchema.parse(event)).toEqual(event);
	expect(
		eventSchema.safeParse({ ...event, mutation: { kind: "unknown-mutation" } })
			.success,
	).toBe(false);
	expect(
		eventSchema.safeParse({ ...event, actor: "unknown-actor" }).success,
	).toBe(false);
});

it("rejects unknown discriminators and envelope fields independently", () => {
	const valid = conversation(payloads["assistant-text"][0]);
	expect(eventSchema.parse(valid)).toEqual(valid);
	const invalid = [
		{ ...valid, kind: "unknown-event" },
		{ ...valid, source: "unknown-source" },
		{ ...valid, payload: { type: "unknown-payload", text: "Visit" } },
		{ ...valid, futureEnvelope: true },
		{
			...valid,
			payload: { ...payloads["assistant-text"][0], futurePayload: true },
		},
		{ ...valid, seq: -1 },
		{ ...valid, seq: 0.5 },
		{ ...valid, ts: -1 },
		{ ...valid, ts: 0.5 },
	];
	for (const event of invalid)
		expect(eventSchema.safeParse(event).success).toBe(false);
	const { source: _source, ...missingSource } = valid;
	expect(eventSchema.safeParse(missingSource).success).toBe(false);
});

it("keeps private outcome annotations free of raw inputs, outputs, and rejection prose", () => {
	for (const payload of [
		payloads["executor-tool-outcome"][0],
		payloads["design-tool-outcome"][0],
	]) {
		expect(eventSchema.parse(conversation(payload))).toEqual(
			conversation(payload),
		);
		for (const extra of [
			{ input: { name: "Private design" } },
			{ output: { result: "Private result" } },
			{ message: "Private rejection" },
		]) {
			expect(
				eventSchema.safeParse({
					...envelope,
					kind: "conversation",
					payload: { ...payload, ...extra },
				}).success,
			).toBe(false);
		}
		for (const patch of [
			{ outcome: "unknown-outcome" },
			{ code: "" },
			{ toolName: "" },
		]) {
			expect(
				eventSchema.safeParse({
					...envelope,
					kind: "conversation",
					payload: { ...payload, ...patch },
				}).success,
			).toBe(false);
		}
	}
});

it("accepts fractional measured durations while rejecting malformed usage counters and aggregate cost", () => {
	const payload = payloads["step-usage"][0];
	expect(eventSchema.parse(conversation(payload))).toEqual(
		conversation(payload),
	);
	for (const patch of [
		{ inputTokens: -1 },
		{ outputTokens: 1.5 },
		{ cacheReadTokens: -1 },
		{ stepTimeMs: -1 },
		{ responseTimeMs: Number.POSITIVE_INFINITY },
		{ cost: 0.5 },
		{ toolCallIds: [""] },
	]) {
		expect(
			eventSchema.safeParse({
				...envelope,
				kind: "conversation",
				payload: { ...payload, ...patch },
			}).success,
		).toBe(false);
	}
});

it("keeps classified errors and historical attachment receipts strict at their own nested boundaries", () => {
	const error = payloads.error[0];
	const message = payloads["user-message"][0];
	expect(
		eventSchema.safeParse({
			...envelope,
			kind: "conversation",
			payload: { ...error, error: { ...error.error, stack: "internal stack" } },
		}).success,
	).toBe(false);
	expect(
		eventSchema.safeParse({
			...envelope,
			kind: "conversation",
			payload: {
				...message,
				attachments: [
					{ ...message.attachments[0], url: "https://example.test/live-asset" },
				],
			},
		}).success,
	).toBe(false);
});

it("keeps archived bytes opaque while enforcing their envelope, and never returns a partial page", () => {
	const archived: Event = {
		...envelope,
		kind: "archived-mutation",
		archived: { oldKind: "pre-cutover", arbitrary: [null, { shape: true }] },
	};
	const text = conversation(payloads["assistant-text"][0]);
	expect(decodeEvents([text, archived])).toEqual([text, archived]);
	expect(() =>
		decodeEvents([text, { ...archived, compatibilityHint: "ignore" }, text]),
	).toThrow();
});
