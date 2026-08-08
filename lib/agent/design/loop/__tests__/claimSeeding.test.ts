/**
 * Deterministic cumulative claim seeding: the property the digest story
 * stands on: the WHOLE claim (id, statement, refs) is a pure function of
 * the thread, over EVERY answered round, so a package rebuilt over an
 * unchanged thread is byte-identical.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	deterministicDesignId,
	seedClaimsFromAnsweredRounds,
} from "@/lib/agent/design/loop/claimSeeding";

const THREAD = "00000000-0000-4000-8000-000000000777";

function answeredRound(messageId: string, question: string): UIMessage {
	return {
		id: messageId,
		role: "assistant",
		parts: [
			{
				type: "tool-askQuestions",
				toolCallId: `call-${messageId}`,
				state: "output-available",
				input: { header: "Questions", questions: [{ question, options: [] }] },
				output: { answers: { "0": "yes" } },
			} as never,
		],
	};
}

describe("deterministicDesignId", () => {
	it("emits a canonical RFC UUID, stable for one name", () => {
		const id = deterministicDesignId("design-claim:t:m:0");
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(deterministicDesignId("design-claim:t:m:0")).toBe(id);
		expect(deterministicDesignId("design-claim:t:m:1")).not.toBe(id);
	});
});

describe("seedClaimsFromAnsweredRounds", () => {
	it("is cumulative over every answered round, in thread order", () => {
		const messages: UIMessage[] = [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "Build it." }] },
			answeredRound("a1", "Offline or online?"),
			{ id: "u2", role: "user", parts: [{ type: "text", text: "More." }] },
			answeredRound("a2", "One clinic or many?"),
		];
		const claims = seedClaimsFromAnsweredRounds(THREAD, messages);
		expect(claims).toHaveLength(2);
		expect(claims[0]?.statement).toContain("Offline or online?");
		expect(claims[1]?.statement).toContain("One clinic or many?");
		expect(claims[0]?.sourceRefs[0]).toMatchObject({
			kind: "message",
			threadId: THREAD,
			messageId: "a1",
		});
	});

	it("re-derives byte-identical claims from an unchanged thread", () => {
		const messages = [answeredRound("a1", "Offline or online?")];
		const first = seedClaimsFromAnsweredRounds(THREAD, messages);
		const second = seedClaimsFromAnsweredRounds(THREAD, messages);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("ignores unanswered rounds and malformed parts", () => {
		const messages: UIMessage[] = [
			{
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool-askQuestions",
						toolCallId: "call-1",
						state: "input-available",
						input: { header: "Questions", questions: [] },
					} as never,
					{ type: "text", text: "Some talk." },
				],
			},
		];
		expect(seedClaimsFromAnsweredRounds(THREAD, messages)).toHaveLength(0);
	});
});
