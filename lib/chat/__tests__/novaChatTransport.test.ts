import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { NovaUIMessage } from "../attachmentRefs";
import { type InputRound, inputRoundSchema } from "../inputRound";
import { createInputRoundContinuation } from "../inputRoundContinuation";
import {
	InputRoundReconciliationError,
	NovaChatTransport,
} from "../novaChatTransport";
import {
	incomingSourceReferences,
	removeRejectedSources,
	SourceAdmissionRejectionError,
} from "../sourceAdmission";

const round: InputRound = {
	id: "question-round",
	kind: "questions",
	assistantMessageId: "assistant",
	toolCallIds: ["ask"],
	state: "pending",
	acceptedStreamId: null,
};
const messages: UIMessage[] = [
	{
		id: "assistant",
		role: "assistant",
		parts: [
			{
				type: "tool-askQuestions",
				toolCallId: "ask",
				state: "output-available",
				input: {
					header: "Team",
					questions: [{ question: "Who?", options: [] }],
				},
				output: { "0": "Nurses" },
			},
		],
	},
];

function sse(parts: unknown[]) {
	return new Response(
		parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{
			headers: {
				"content-type": "text/event-stream",
				"x-vercel-ai-ui-message-stream": "v1",
				"x-workflow-run-id": "stream",
			},
		},
	);
}

describe("continuation through Nova's installed SDK transport", () => {
	it("does not recursively POST an answered card after a successful unframed reply", async () => {
		const continuation = createInputRoundContinuation(round);
		const requests: unknown[] = [];
		const transport = new NovaChatTransport<UIMessage>(
			{
				fetch: async (_url, init) => {
					requests.push(JSON.parse(String(init?.body)));
					return sse([
						{ type: "start", messageId: "assistant" },
						{ type: "text-start", id: "reply" },
						{
							type: "text-delta",
							id: "reply",
							delta: "Please attach the reference.",
						},
						{ type: "text-end", id: "reply" },
						{ type: "finish" },
					]);
				},
				prepareSendMessagesRequest: ({ messages }) => ({
					body: { messages, inputRoundId: continuation.round?.id },
				}),
			},
			() => chat.messages,
		);
		const chat: Chat<UIMessage> = new Chat({
			id: "thread",
			messages,
			transport,
			sendAutomaticallyWhen: ({ messages }) =>
				continuation.claimAutomatic(messages),
		});
		try {
			// The card's synchronous claim precedes the SDK's asynchronous send.
			expect(continuation.claimAutomatic(chat.messages)).toBe(true);
			await chat.sendMessage();
			expect(chat.status).toBe("ready");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ inputRoundId: round.id });
			expect(chat.messages[0].parts).toContainEqual({
				type: "text",
				text: "Please attach the reference.",
				state: "done",
			});
		} finally {
			await chat.stop();
		}
	});

	it("consumes authority through transient data even when text has no step boundaries", async () => {
		const continuation = createInputRoundContinuation(round);
		let calls = 0;
		const transport = new NovaChatTransport<UIMessage>(
			{
				fetch: async () => {
					calls++;
					return sse([
						{
							type: "data-input-round",
							data: {
								round: {
									...round,
									state: "consumed",
									acceptedStreamId: "stream",
								},
							},
							transient: true,
						},
						{ type: "start", messageId: "assistant" },
						{
							type: "data-input-round",
							data: {
								round: {
									...round,
									id: "message-round",
									kind: "message",
									toolCallIds: [],
								},
							},
							transient: true,
						},
						{ type: "finish" },
					]);
				},
			},
			() => chat.messages,
		);
		const chat: Chat<UIMessage> = new Chat({
			id: "thread",
			messages,
			transport,
			onData: (part) => {
				if (part.type === "data-input-round")
					continuation.adopt(
						inputRoundSchema.parse((part.data as { round: unknown }).round),
					);
			},
			sendAutomaticallyWhen: ({ messages }) =>
				continuation.claimAutomatic(messages),
		});
		try {
			await chat.sendMessage();
			expect(calls).toBe(1);
			expect(continuation.awaitsTypedMessage).toBe(true);
			expect(continuation.acceptsAnswer("ask")).toBe(false);
		} finally {
			await chat.stop();
		}
	});

	it.each(["input_round_consumed", "input_round_stale"] as const)(
		"preserves typed %s reconciliation instead of a generic stream failure",
		async (code) => {
			const payload = {
				code,
				threadId: "thread",
				inputRound: { ...round, state: "consumed", acceptedStreamId: "winner" },
				activeStreamId: "winner",
			};
			const transport = new NovaChatTransport<UIMessage>(
				{ fetch: async () => Response.json(payload, { status: 409 }) },
				() => messages,
			);
			const chat = new Chat({ id: "thread", messages, transport });
			try {
				await chat.sendMessage();
				expect(chat.error).toBeInstanceOf(InputRoundReconciliationError);
				expect(
					(chat.error as InputRoundReconciliationError).reconciliation,
				).toEqual(payload);
			} finally {
				await chat.stop();
			}
		},
	);
});

it.each(["http", "stream", "resume"])(
	"retains %s rejected source refs until explicit removal and resends without altering historical files",
	async (delivery) => {
		const assetId = testMediaAssetId("rejected-source");
		const ref = {
			assetId,
			kind: "text" as const,
			filename: "workflow.md",
			mimeType: "text/markdown",
		};
		const old: NovaUIMessage = {
			id: "old",
			role: "user",
			parts: [{ type: "text", text: "Earlier request" }],
			metadata: { attachments: [ref] },
		};
		const latest: NovaUIMessage = {
			id: "new",
			role: "user",
			parts: [{ type: "text", text: "New request" }],
			metadata: { attachments: [ref] },
		};
		const references = incomingSourceReferences([old, latest], [old]).map(
			({ messageId, ref }) => ({ messageId, assetId: ref.assetId }),
		);
		const requests: { messages: NovaUIMessage[] }[] = [];
		const data: unknown[] = [];
		const chat: Chat<NovaUIMessage> = new Chat({
			id: "source-thread",
			messages: [old, latest],
			onData: (part) => {
				data.push(part);
			},
			transport: new NovaChatTransport(
				{
					fetch: async (_url, init) => {
						requests.push(
							init?.body ? JSON.parse(String(init.body)) : { messages: [] },
						);
						if (requests.length === 1) {
							const payload = {
								code: "source_not_admitted",
								error: "This file couldn't be read.",
								references,
							};
							if (delivery === "http")
								return Response.json(payload, { status: 409 });
							return sse([
								{
									type: "data-credit-refund",
									data: { amount: 10 },
									transient: true,
								},
								{
									type: "data-source-rejection",
									data: payload,
									transient: true,
								},
								{ type: "finish" },
							]);
						}
						return sse([
							{ type: "start", messageId: "reply" },
							{ type: "finish" },
						]);
					},
				},
				() => chat.messages,
			),
		});
		try {
			if (delivery === "resume") await chat.resumeStream();
			else await chat.sendMessage();
			if (delivery !== "http")
				expect(data).toContainEqual({
					type: "data-credit-refund",
					data: { amount: 10 },
					transient: true,
				});
			expect(chat.error).toBeInstanceOf(SourceAdmissionRejectionError);
			expect(chat.messages).toEqual([old, latest]);
			expect(requests).toHaveLength(1);
			if (!(chat.error instanceof SourceAdmissionRejectionError))
				throw new Error("Expected source refusal");
			chat.messages = removeRejectedSources(
				chat.messages,
				chat.error.rejection,
			);
			chat.clearError();
			await chat.sendMessage();
			expect(chat.status).toBe("ready");
			expect(requests).toHaveLength(2);
			expect(requests[1].messages[0]).toEqual(old);
			expect(requests[1].messages[1]).toEqual({
				...latest,
				metadata: { attachments: [] },
			});
		} finally {
			await chat.stop();
		}
	},
);
