import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { InputRound } from "../inputRound";
import {
	answeredInputRound,
	createInputRoundContinuation,
} from "../inputRoundContinuation";

const round: InputRound = {
	id: "round-a",
	kind: "questions",
	assistantMessageId: "assistant-a",
	toolCallIds: ["ask-a"],
	state: "pending",
	acceptedStreamId: null,
};
const answer = {
	type: "tool-askQuestions" as const,
	state: "output-available" as const,
	toolCallId: "ask-a",
	input: { questions: [{ question: "Where?", options: [] }], header: "Place" },
	output: { "0": "Clinics" },
};
const transcript: UIMessage[] = [
	{ id: "assistant-a", role: "assistant", parts: [answer] },
];

describe("server-owned input invitation", () => {
	it("never grants an automatic send from answered transcript shape alone", () => {
		const continuation = createInputRoundContinuation(null);
		expect(continuation.acceptsAnswer("ask-a")).toBe(false);
		expect(continuation.claimAutomatic(transcript)).toBe(false);
		continuation.adopt(round);
		expect(continuation.acceptsAnswer("ask-a")).toBe(true);
		expect(continuation.claimAutomatic(transcript)).toBe(true);
		// A successful empty/replayed response need not contain any framing.
		expect(continuation.claimAutomatic(transcript)).toBe(false);
	});

	it("requires the exact message and every uniquely identified answered call", () => {
		expect(
			answeredInputRound(transcript, { ...round, assistantMessageId: "other" }),
		).toBe(false);
		expect(
			answeredInputRound(transcript, {
				...round,
				toolCallIds: ["ask-a", "ask-b"],
			}),
		).toBe(false);
		expect(
			answeredInputRound(
				[{ ...transcript[0], parts: [answer, answer] }],
				round,
			),
		).toBe(false);
		expect(
			answeredInputRound(
				[
					{
						...transcript[0],
						parts: [{ ...answer, state: "input-available", output: undefined }],
					},
				],
				round,
			),
		).toBe(false);
		expect(
			answeredInputRound(
				[
					...transcript,
					{
						id: "user",
						role: "user",
						parts: [{ type: "text", text: "Another turn" }],
					},
				],
				round,
			),
		).toBe(false);
	});

	it("a text or review pause cannot resubmit an earlier answered card even without steps", () => {
		const continuation = createInputRoundContinuation(round);
		expect(continuation.claimAutomatic(transcript)).toBe(true);
		for (const kind of ["message", "review"] as const) {
			continuation.adopt({
				...round,
				id: `round-${kind}`,
				kind,
				toolCallIds: [],
			});
			expect(
				continuation.claimAutomatic([
					{
						...transcript[0],
						parts: [
							answer,
							{ type: "text", text: "Please send the reference file." },
						],
					},
				]),
			).toBe(false);
			expect(continuation.acceptsAnswer("ask-a")).toBe(false);
		}
	});

	it("consumption survives replay and only a new question round enables a new automatic send", () => {
		const continuation = createInputRoundContinuation({
			...round,
			state: "consumed",
			acceptedStreamId: "stream-a",
		});
		continuation.adopt(round);
		continuation.retryAnswer("ask-a");
		expect(continuation.claimAutomatic(transcript)).toBe(false);
		continuation.adopt({ ...round, id: "round-b", toolCallIds: ["ask-b"] });
		const next = [
			{ ...transcript[0], parts: [answer, { ...answer, toolCallId: "ask-b" }] },
		];
		expect(continuation.claimAutomatic(next)).toBe(true);
		expect(continuation.claimAutomatic(next)).toBe(false);
	});

	it("manual and attachment-bearing submissions consume the same automatic attempt", () => {
		const continuation = createInputRoundContinuation(round);
		continuation.markSubmitted();
		expect(continuation.claimAutomatic(transcript)).toBe(false);
		expect(continuation.round).toEqual(round);
		// An explicit retry can still send this pending id; only automation stops.
		expect(continuation.acceptsAnswer("ask-a")).toBe(true);
	});

	it("permits deliberate answer retries only while the same question is pending", () => {
		const continuation = createInputRoundContinuation(round);
		expect(continuation.claimAutomatic(transcript)).toBe(true);
		continuation.retryAnswer("different");
		expect(continuation.claimAutomatic(transcript)).toBe(false);
		continuation.retryAnswer("ask-a");
		expect(continuation.claimAutomatic(transcript)).toBe(true);
		continuation.suspend();
		continuation.retryAnswer("ask-a");
		expect(continuation.claimAutomatic(transcript)).toBe(false);
		expect(continuation.acceptsAnswer("ask-a")).toBe(false);
	});

	it("a verified legacy pause allows deliberate text but grants no card or automatic authority", () => {
		const continuation = createInputRoundContinuation(null, true);
		expect(continuation.awaitsTypedMessage).toBe(true);
		expect(continuation.acceptsAnswer("ask-a")).toBe(false);
		expect(continuation.claimAutomatic(transcript)).toBe(false);
		continuation.adopt(round);
		expect(continuation.awaitsTypedMessage).toBe(false);
		continuation.adopt(null);
		expect(continuation.awaitsTypedMessage).toBe(false);
	});
});
