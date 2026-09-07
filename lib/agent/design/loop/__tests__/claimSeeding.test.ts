import type { UIMessage } from "ai";
import { v5 as uuidV5 } from "uuid";
import { describe, expect, it } from "vitest";
import { sourceClaimSchema } from "@/lib/agent/design/evidence";
import {
	deterministicDesignId,
	seedClaimsFromAnsweredRounds,
} from "@/lib/agent/design/loop/claimSeeding";
import { askQuestionsInputSchema } from "@/lib/agent/tools/askQuestions";
import { validateChatMessages } from "@/lib/chat/validateMessages";

const THREAD = "00000000-0000-4000-8000-000000000777";
const NAMESPACE = "b7e43c1a-5a2e-4f5e-9d3a-0c9a4d8f2e61";

function questionPart(
	toolCallId: string,
	questions: string[],
	answers: Record<string, string>,
): UIMessage["parts"][number] {
	return {
		type: "tool-askQuestions",
		toolCallId,
		state: "output-available",
		input: askQuestionsInputSchema.parse({
			header: "Questions",
			questions: questions.map((question) => ({ question, options: [] })),
		}),
		// The actual AskQuestionsCard result is flat, keyed by immutable question
		// index. It is not wrapped in an `answers` object.
		output: answers,
	};
}
function round(id: string, parts: UIMessage["parts"]): UIMessage {
	return { id, role: "assistant", parts };
}
function expectedClaim(
	messageId: string,
	partIndex: number,
	statement: string,
	threadId = THREAD,
) {
	return {
		id: uuidV5(`design-claim:${threadId}:${messageId}:${partIndex}`, NAMESPACE),
		statement,
		sourceRefs: [{ kind: "message", threadId, messageId, partIndex }],
	};
}

describe("answered question source projection", () => {
	it.each([
		"",
		"design-claim:t:m:0",
		"design-claim:t:m:1",
		"Répondre au patient 🏥",
	])("matches independent UUIDv5 for %j", (name) => {
		expect(deterministicDesignId(name)).toBe(uuidV5(name, NAMESPACE));
	});

	it("retains every completed card with exact question, answer, and transcript coordinates", () => {
		const messages: UIMessage[] = [
			{
				id: "u1",
				role: "user",
				parts: [{ type: "text", text: "Build the clinic app." }],
			},
			round("a1", [
				{ type: "text", text: "A few choices first." },
				questionPart("call1", ["Offline or online?", "One clinic or many?"], {
					"0": "Offline",
					"1": "User Responded: Three clinics",
				}),
				questionPart("call2", ["Referral destination?"], {
					"0": "District hospital",
				}),
			]),
			{
				id: "u2",
				role: "user",
				parts: [{ type: "text", text: "Also track referrals." }],
			},
			round("a2", [
				questionPart("call3", ["Referral language?"], { "0": "Français" }),
			]),
		];
		const before = structuredClone(messages);
		const claims = seedClaimsFromAnsweredRounds(THREAD, messages);
		expect(claims).toEqual([
			expectedClaim(
				"a1",
				1,
				'The user answered the design questions ["Offline or online?","One clinic or many?"] with {"0":"Offline","1":"User Responded: Three clinics"}.',
			),
			expectedClaim(
				"a1",
				2,
				'The user answered the design questions ["Referral destination?"] with {"0":"District hospital"}.',
			),
			expectedClaim(
				"a2",
				0,
				'The user answered the design questions ["Referral language?"] with {"0":"Français"}.',
			),
		]);
		expect(claims.map((claim) => sourceClaimSchema.parse(claim))).toEqual(
			claims,
		);
		expect(
			seedClaimsFromAnsweredRounds(
				THREAD,
				JSON.parse(JSON.stringify(messages)),
			),
		).toEqual(claims);
		expect(messages).toEqual(before);
	});

	it("preserves earlier claims on append, scopes identities to a thread and part, and changes content when an answer changes", () => {
		const messages = [
			round("a1", [
				questionPart("call1", ["Pilot scope?"], { "0": "One clinic" }),
			]),
		];
		const first = seedClaimsFromAnsweredRounds(THREAD, messages);
		const extended = [
			...messages,
			round("a2", [questionPart("call2", ["Next clinic?"], { "0": "South" })]),
		];
		expect(seedClaimsFromAnsweredRounds(THREAD, extended).slice(0, 1)).toEqual(
			first,
		);
		expect(
			seedClaimsFromAnsweredRounds(
				"00000000-0000-4000-8000-000000000778",
				messages,
			)[0]?.id,
		).not.toBe(first[0]?.id);
		const edited = [
			round("a1", [
				questionPart("call1", ["Pilot scope?"], { "0": "Three clinics" }),
			]),
		];
		const changed = seedClaimsFromAnsweredRounds(THREAD, edited);
		expect(changed[0]?.id).toBe(first[0]?.id);
		expect(changed[0]?.statement).toBe(
			'The user answered the design questions ["Pilot scope?"] with {"0":"Three clinics"}.',
		);
		expect(changed).not.toEqual(first);
	});

	it.each([
		"input-streaming",
		"input-available",
		"output-error",
		"output-denied",
	])("does not claim an unanswered or ended %s card", (state) => {
		const part = {
			...questionPart("call1", ["Pilot scope?"], { "0": "One" }),
			state,
		};
		const messages = JSON.parse(
			JSON.stringify([round("a1", [part as UIMessage["parts"][number]])]),
		);
		expect(seedClaimsFromAnsweredRounds(THREAD, messages)).toEqual([]);
	});

	it("requires an answer for every question before a completed round becomes evidence", () => {
		const part = questionPart("call1", ["Pilot scope?", "First clinic?"], {
			"0": "One",
		});
		expect(seedClaimsFromAnsweredRounds(THREAD, [round("a1", [part])])).toEqual(
			[],
		);
	});

	it("ignores tool-looking user parts and ordinary assistant prose", () => {
		expect(
			seedClaimsFromAnsweredRounds(THREAD, [
				{
					id: "u1",
					role: "user",
					parts: [questionPart("call1", ["Pilot?"], { "0": "Yes" })],
				},
				round("a1", [{ type: "text", text: "The user answered yes." }]),
			]),
		).toEqual([]);
	});

	it.each([
		{ input: { questions: "not an array" } },
		{ input: { questions: [null] } },
		{
			input: { header: "Questions", questions: [{ question: 3, options: [] }] },
		},
		{ input: { header: "Questions", questions: [] } },
		{ output: null },
		{ output: [] },
		{ output: { answers: { "0": "One" } } },
		{ output: {} },
		{ output: { "0": 5 } },
		{ output: { "0": "  " } },
	])(
		"does not turn a malformed client card into source evidence: %j",
		(override) => {
			const raw = [
				{
					id: "a1",
					role: "assistant",
					parts: [
						{
							...questionPart("call1", ["Pilot scope?"], { "0": "One" }),
							...override,
						},
					],
				},
			];
			// This is the route's real metadata gate. SDK tool validation is not run
			// before the build orchestrator seeds these claims.
			const admitted = validateChatMessages(JSON.parse(JSON.stringify(raw)));
			if (!admitted.ok) throw new Error(admitted.error);
			expect(seedClaimsFromAnsweredRounds(THREAD, admitted.messages)).toEqual(
				[],
			);
		},
	);
});
