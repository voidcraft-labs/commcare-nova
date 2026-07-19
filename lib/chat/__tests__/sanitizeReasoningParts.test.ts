// Unit tests for the chat route's reasoning-part wire contract. The class
// under test: replayed reasoning items are model-bound encrypted blobs with
// strict pairing rules, so a resumed thread's history must send them ONLY
// where the wire requires them (a trailing answered-askQuestions round on
// the same model) and never anywhere they could 400 the turn — including
// after a deploy switches the SA model while a question round sits open.

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { sanitizeHistoricalReasoningParts } from "../sanitizeReasoningParts";

const MODEL = "gpt-5.6-sol";
const OLD_MODEL = "gpt-5.6-terra";

type Part = UIMessage["parts"][number];

const reasoning = (text: string): Part =>
	({
		type: "reasoning",
		text,
		state: "done",
		providerMetadata: {
			openai: { itemId: `rs_${text}`, reasoningEncryptedContent: "gAAAA..." },
		},
	}) as unknown as Part;

const text = (t: string): Part => ({ type: "text", text: t }) as Part;

const askQuestions = (answered: boolean): Part =>
	({
		type: "tool-askQuestions",
		toolCallId: "call-1",
		state: answered ? "output-available" : "input-available",
		input: {
			header: "A couple of details",
			questions: [
				{ question: "Track referrals?", options: [{ label: "Yes" }] },
				{ question: "Who owns follow-ups?", options: [{ label: "CHW" }] },
			],
		},
		...(answered ? { output: { "0": "Yes", "1": "CHW" } } : {}),
	}) as unknown as Part;

const executedTool = (): Part =>
	({
		type: "tool-searchBlueprint",
		toolCallId: "call-2",
		state: "output-available",
		input: { query: "referral" },
		output: { matches: [] },
	}) as unknown as Part;

const user = (id: string, t: string): UIMessage =>
	({ id, role: "user", parts: [text(t)] }) as UIMessage;

const assistant = (
	id: string,
	parts: Part[],
	metadata?: Record<string, unknown>,
): UIMessage =>
	({
		id,
		role: "assistant",
		parts,
		...(metadata ? { metadata } : {}),
	}) as UIMessage;

describe("sanitizeHistoricalReasoningParts", () => {
	it("strips reasoning from completed historical assistant turns, keeping text and tool parts", () => {
		const messages = [
			user("u1", "build me a clinic app"),
			assistant(
				"a1",
				[reasoning("design"), text("Here's the plan."), executedTool()],
				{ model: MODEL },
			),
			user("u2", "add a referral module"),
		];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		const a1 = out[1];
		expect(a1.parts.map((p) => p.type)).toEqual([
			"text",
			"tool-searchBlueprint",
		]);
		// User messages pass through by reference.
		expect(out[0]).toBe(messages[0]);
		expect(out[2]).toBe(messages[2]);
	});

	it("returns the array by reference when nothing carries reasoning", () => {
		const messages = [
			user("u1", "hello"),
			assistant("a1", [text("hi")], { model: MODEL }),
		];
		expect(sanitizeHistoricalReasoningParts(messages, MODEL)).toBe(messages);
	});

	it("keeps a same-model trailing answered round untouched — the wire requires its reasoning", () => {
		const paused = assistant(
			"a1",
			[reasoning("which options"), text("Quick check:"), askQuestions(true)],
			{ model: MODEL },
		);
		const messages = [user("u1", "build it"), paused];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		expect(out[1]).toBe(paused);
	});

	it("textifies a trailing round whose producing model no longer matches", () => {
		const messages = [
			user("u1", "build it"),
			assistant(
				"a1",
				[
					reasoning("which options"),
					text("Quick check:"),
					executedTool(),
					askQuestions(true),
				],
				{ model: OLD_MODEL },
			),
		];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		const tail = out[1];
		// Reasoning + executed tool call drop; the round survives as dialogue.
		expect(tail.parts.map((p) => p.type)).toEqual(["text", "text"]);
		const rendered = (tail.parts[1] as { text: string }).text;
		expect(rendered).toContain("A couple of details");
		expect(rendered).toContain("Track referrals?\n→ Yes");
		expect(rendered).toContain("Who owns follow-ups?\n→ CHW");
	});

	it("treats a missing model stamp as a crossing (pre-stamp histories can't prove pairing)", () => {
		const messages = [
			user("u1", "build it"),
			assistant("a1", [reasoning("r"), askQuestions(true)]),
		];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		expect(out[1].parts.every((p) => p.type === "text")).toBe(true);
	});

	it("renders unanswered questions in a textified round as unanswered", () => {
		const part = askQuestions(false);
		const messages = [
			user("u1", "build it"),
			assistant("a1", [reasoning("r"), part], { model: OLD_MODEL }),
		];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		const rendered = (out[1].parts[0] as { text: string }).text;
		expect(rendered).toContain("→ (unanswered)");
	});

	it("drops a crossing tail repaired down to nothing", () => {
		const messages = [
			user("u1", "build it"),
			assistant("a1", [reasoning("r"), executedTool()], { model: OLD_MODEL }),
		];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
	});

	it("strips reasoning from a trailing assistant message with no tool parts", () => {
		// The tool sanitizer can drop a paused round's part entirely (schema
		// narrowing); orphaned reasoning must not ride behind it.
		const messages = [
			user("u1", "build it"),
			assistant("a1", [reasoning("r"), text("thinking done")], {
				model: MODEL,
			}),
		];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		expect(out[1].parts.map((p) => p.type)).toEqual(["text"]);
	});

	it("strips reasoning from an answered round that is no longer the tail", () => {
		const messages = [
			user("u1", "build it"),
			assistant("a1", [reasoning("r1"), askQuestions(true)], {
				model: MODEL,
			}),
			user("u2", "also add referrals"),
		];
		const out = sanitizeHistoricalReasoningParts(messages, MODEL);
		// Historical answered rounds keep the tool part (completed pairs replay
		// fine in deep history) but never the reasoning.
		expect(out[1].parts.map((p) => p.type)).toEqual(["tool-askQuestions"]);
	});

	it("is idempotent", () => {
		const messages = [
			user("u1", "build it"),
			assistant("a1", [reasoning("r"), text("plan"), executedTool()], {
				model: MODEL,
			}),
			user("u2", "next"),
			assistant("a2", [reasoning("r2"), askQuestions(true)], {
				model: OLD_MODEL,
			}),
		];
		const once = sanitizeHistoricalReasoningParts(messages, MODEL);
		const twice = sanitizeHistoricalReasoningParts(once, MODEL);
		expect(twice).toEqual(once);
	});
});
