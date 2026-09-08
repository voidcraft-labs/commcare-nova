/**
 * The token estimator and the moment weigher.
 *
 * The failures this prevents: a band that silently sums an uncountable part
 * as zero (an image billed by the provider would vanish from the bar), a
 * message weighed without its tool payloads, and a static band that mixes
 * in per-turn messages. Counts are estimates by contract; the tests assert
 * their shape and arithmetic, never a specific token number.
 */

import { describe, expect, it } from "vitest";
import {
	countableMessageText,
	estimateTokens,
	toolDefinitionText,
	weigh,
} from "../tokens";
import type { ContextItem, Moment } from "../types";

const SOURCE = { file: "lib/agent/prompts.ts", symbol: "x" };

function moment(items: ContextItem[]): Moment {
	return { id: "m", label: "m", why: "", needs: [], source: SOURCE, items };
}

describe("estimateTokens", () => {
	it("counts empty text as zero without loading the encoding", async () => {
		await expect(estimateTokens("")).resolves.toBe(0);
	});

	it("returns a stable positive integer well below the character count", async () => {
		const text = "The quick brown fox jumps over the lazy dog. ".repeat(25);
		const first = await estimateTokens(text);
		const second = await estimateTokens(text);
		expect(first).toBe(second);
		expect(Number.isInteger(first)).toBe(true);
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(text.length / 2);
	});
});

describe("countableMessageText", () => {
	it("includes tool call names and inputs and tool result outputs", () => {
		const call = countableMessageText({
			role: "assistant",
			content: [
				{ type: "text", text: "Adding a field." },
				{
					type: "tool-call",
					toolCallId: "c1",
					toolName: "addFields",
					input: { fields: [{ id: "name", kind: "text" }] },
				},
			],
		});
		expect(call.uncountedParts).toBe(0);
		expect(call.text).toContain("addFields");
		expect(call.text).toContain('"kind":"text"');
		const result = countableMessageText({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c1",
					toolName: "addFields",
					output: { type: "json", value: { message: "Added name." } },
				},
			],
		});
		expect(result.text).toContain("Added name.");
	});

	it("counts image and file parts as uncounted rather than as text", () => {
		const { text, uncountedParts } = countableMessageText({
			role: "user",
			content: [
				{ type: "text", text: "see attached" },
				{ type: "image", image: "data:image/png;base64,AAAA" },
				{
					type: "file",
					data: "data:application/pdf;base64,AAAA",
					mediaType: "application/pdf",
				},
			],
		});
		expect(uncountedParts).toBe(2);
		expect(text).toBe("see attached");
	});
});

describe("weigh", () => {
	const system: ContextItem = {
		kind: "system",
		id: "system",
		label: "System",
		origin: "composed",
		source: SOURCE,
		text: "You are Nova.\n\n---\n\nBe calm.",
		segments: [
			{ id: "a", title: "A", text: "You are Nova.", source: SOURCE },
			{ id: "b", title: "B", text: "Be calm.", source: SOURCE },
		],
	};
	const tools: ContextItem = {
		kind: "tools",
		id: "tools",
		label: "Tools",
		origin: "composed",
		source: SOURCE,
		tools: [
			{
				name: "askQuestions",
				description: "Ask the user.",
				inputSchema: { type: "object", properties: { q: { type: "string" } } },
				strict: false,
			},
			{
				name: "getForm",
				description: "Read a form.",
				inputSchema: {
					type: "object",
					properties: { uuid: { type: "string" } },
				},
				strict: false,
			},
		],
	};
	const schema: ContextItem = {
		kind: "output-schema",
		id: "output-schema",
		label: "Output",
		origin: "composed",
		source: SOURCE,
		jsonSchema: {
			type: "object",
			properties: { decision: { type: "string" } },
		},
		strict: true,
	};
	const text: ContextItem = {
		kind: "message",
		id: "history:0",
		label: "user",
		origin: "derived",
		source: SOURCE,
		wireRole: "user",
		message: { role: "user", content: "Build me a visit form." },
	};
	const missing: ContextItem = {
		kind: "missing",
		id: "app-state",
		label: "App state",
		origin: "composed",
		source: SOURCE,
		needs: "app",
		explanation: "Pick an app.",
	};

	it("sums the static band from system, tools, and output schema and the variable band from messages", async () => {
		const weighed = await weigh(moment([system, tools, schema, text, missing]));
		const weightOf = (id: string) => {
			const item = weighed.items.find((candidate) => candidate.id === id);
			if (item === undefined) throw new Error(`no weighed item ${id}`);
			return item.weight;
		};
		const tokensOf = (id: string) => {
			const tokens = weightOf(id).tokens;
			if (tokens === null) throw new Error(`item ${id} weighed as opaque`);
			return tokens;
		};
		const [askQuestions, getForm] = tools.tools;
		if (askQuestions === undefined || getForm === undefined) {
			throw new Error("the tools fixture lost a tool");
		}
		expect(tokensOf("system")).toBe(await estimateTokens(system.text));
		expect(tokensOf("tools")).toBe(
			(await estimateTokens(toolDefinitionText(askQuestions))) +
				(await estimateTokens(toolDefinitionText(getForm))),
		);
		expect(weighed.bands.static).toEqual({
			chars:
				weightOf("system").chars +
				weightOf("tools").chars +
				weightOf("output-schema").chars,
			tokens:
				tokensOf("system") + tokensOf("tools") + tokensOf("output-schema"),
		});
		expect(weighed.bands.variable).toEqual(weightOf("history:0"));
		expect(weightOf("app-state")).toEqual({ chars: 0, tokens: 0 });
	});

	it("weighs each segment and each tool individually", async () => {
		const weighed = await weigh(moment([system, tools]));
		const weighedSystem = weighed.items[0];
		const weighedTools = weighed.items[1];
		if (weighedSystem?.kind !== "system" || weighedTools?.kind !== "tools") {
			throw new Error("The weighed items lost their kinds.");
		}
		expect(
			weighedSystem.segments.map((segment) => segment.weight.tokens),
		).toEqual([
			await estimateTokens("You are Nova."),
			await estimateTokens("Be calm."),
		]);
		expect(weighedSystem.outline.length).toBeGreaterThan(0);
		expect(weighedTools.tools.map((tool) => tool.name)).toEqual([
			"askQuestions",
			"getForm",
		]);
		for (const tool of weighedTools.tools) {
			expect(tool.weight.tokens).toBeGreaterThan(0);
		}
	});

	it("marks a message with an image as uncountable and makes the variable band unknown", async () => {
		const withImage: ContextItem = {
			kind: "message",
			id: "history:1",
			label: "user",
			origin: "derived",
			source: SOURCE,
			wireRole: "user",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "see attached" },
					{ type: "image", image: "data:image/png;base64,AAAA" },
				],
			},
		};
		const weighed = await weigh(moment([system, text, withImage]));
		const image = weighed.items[2];
		expect(image?.weight.tokens).toBeNull();
		expect(image?.weight.chars).toBe("see attached".length);
		expect(weighed.bands.variable.tokens).toBeNull();
		expect(weighed.bands.variable.chars).toBe(
			"Build me a visit form.".length + "see attached".length,
		);
		expect(weighed.bands.static.tokens).toBe(await estimateTokens(system.text));
	});

	it("weighs a compaction checkpoint as opaque", async () => {
		const compaction: ContextItem = {
			kind: "compaction",
			id: "history:compaction",
			label: "Compaction checkpoint",
			origin: "recorded",
			source: SOURCE,
		};
		const weighed = await weigh(moment([compaction, text]));
		expect(weighed.items[0]?.weight).toEqual({ chars: 0, tokens: null });
		expect(weighed.bands.variable.tokens).toBeNull();
	});
});

describe("presented messages", () => {
	it("counts the real message, then carries a URL as its text and bytes as a labeled placeholder", async () => {
		const bytes = new Uint8Array(2048);
		const rehydrated: ContextItem = {
			kind: "message",
			id: "history:2",
			label: "user message",
			origin: "recorded",
			source: SOURCE,
			wireRole: "user",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "the plan" },
					{
						type: "file",
						data: new URL("https://example.test/plan.pdf"),
						mediaType: "application/pdf",
					},
					{ type: "image", image: bytes },
				],
			},
		};
		const weighed = await weigh(moment([rehydrated]));
		const item = weighed.items[0];
		expect(item?.kind).toBe("message");
		if (item?.kind !== "message") return;
		expect(item.weight.tokens).toBeNull();
		expect(item.weight.chars).toBe("the plan".length);
		expect(item.message).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "the plan" },
				{
					type: "file",
					data: "https://example.test/plan.pdf",
					mediaType: "application/pdf",
				},
				{ type: "image", image: "[binary, 2,048 bytes]" },
			],
		});
		expect(JSON.stringify(item.message)).not.toContain("0,0,0");
	});
});
