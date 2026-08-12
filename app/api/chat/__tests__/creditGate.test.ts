import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { creditGateDecision } from "../creditGate";

/**
 * Minimal `UIMessage` whose only load-bearing field for the gate is `role`:
 * `isChargeableTurn` reads the last message's role and nothing else.
 */
const message = (role: "user" | "assistant"): UIMessage =>
	({ id: "m", role, parts: [{ type: "text", text: "x" }] }) as UIMessage;

describe("creditGateDecision", () => {
	it("pre-flights a new build at the full 100 when the last raw message is a user instruction", () => {
		expect(
			creditGateDecision({
				rawMessages: [message("assistant"), message("user")],
				existingApp: false,
			}),
		).toEqual({ chargeable: true, preflightCost: 100 });
	});

	it("pre-flights an existing app at the 5-credit floor: the app row's real mode isn't loaded yet, and the floor can never falsely reject an affordable edit", () => {
		expect(
			creditGateDecision({
				rawMessages: [message("assistant"), message("user")],
				existingApp: true,
			}),
		).toEqual({ chargeable: true, preflightCost: 5 });
	});

	it("does not charge a continuation — last message assistant (answered-askQuestions auto-resend) is free", () => {
		expect(
			creditGateDecision({
				rawMessages: [message("user"), message("assistant")],
				existingApp: false,
			}),
		).toEqual({ chargeable: false, preflightCost: 0 });
	});

	it("treats an explicit exact-build redrive as a fresh claim even when the frozen transcript ends in an assistant message", () => {
		expect(
			creditGateDecision({
				rawMessages: [message("user"), message("assistant")],
				existingApp: true,
				redrive: true,
			}),
		).toEqual({ chargeable: true, preflightCost: 5 });
	});
});
