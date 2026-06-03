import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { creditGateDecision } from "../creditGate";

/**
 * Minimal `UIMessage` whose only load-bearing field for the gate is `role` —
 * `isChargeableTurn` reads the last message's role and nothing else.
 */
const message = (role: "user" | "assistant"): UIMessage =>
	({ id: "m", role, parts: [{ type: "text", text: "x" }] }) as UIMessage;

describe("creditGateDecision", () => {
	it("charges a build (appReady false) the full 100 when the last raw message is a user instruction", () => {
		expect(
			creditGateDecision({
				rawMessages: [message("assistant"), message("user")],
				appReady: false,
			}),
		).toEqual({ chargeable: true, cost: 100 });
	});

	it("charges an edit (appReady true) the cheap 5 when the last raw message is a user instruction", () => {
		expect(
			creditGateDecision({
				rawMessages: [message("assistant"), message("user")],
				appReady: true,
			}),
		).toEqual({ chargeable: true, cost: 5 });
	});

	it("does not charge a continuation — last message assistant (answered-askQuestions auto-resend) is free", () => {
		expect(
			creditGateDecision({
				rawMessages: [message("user"), message("assistant")],
				appReady: false,
			}),
		).toEqual({ chargeable: false, cost: 0 });
	});
});
