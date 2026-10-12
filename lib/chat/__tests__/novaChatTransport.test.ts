import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { type InputRound, inputRoundSchema } from "../inputRound";
import { createInputRoundContinuation } from "../inputRoundContinuation";
import {
	InputRoundReconciliationError,
	NovaChatTransport,
} from "../novaChatTransport";

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
