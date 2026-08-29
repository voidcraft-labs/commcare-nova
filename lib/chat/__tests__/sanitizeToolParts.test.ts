// Unit tests for the chat route's deploy-crossing history repair. The
// scenario under test is the one that bricked resumes: a thread persisted
// before a deploy carries tool parts the CURRENT tool surface no longer
// accepts — a retired tool name, or an IN-FLIGHT call (`input-available`)
// whose surviving tool's `.strict()` input schema dropped a key the old
// call carries (`generateSchema`'s `appName`). The repair must drop
// exactly the parts that remain invalid, preserve the SDK's native
// `dynamic-tool` conversion for loadable terminal history, keep everything
// else byte-identical, and leave a message set the route accepts.

import { type ToolSet, tool, type UIMessage, validateUIMessages } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sanitizeHistoricalToolParts } from "../sanitizeToolParts";

const tools: ToolSet = {
	generateSchema: tool({
		description: "record the data model",
		inputSchema: z
			.object({ caseTypes: z.array(z.object({ name: z.string() })) })
			.strict(),
	}),
	searchBlueprint: tool({
		description: "search",
		inputSchema: z.object({ query: z.string() }).strict(),
	}),
};

// Same widening the helper itself performs — `validateUIMessages`' tools
// slot is a per-name mapped type a plain `ToolSet` can't satisfy.
const validationTools = tools as Parameters<
	typeof validateUIMessages
>[0]["tools"];

const user = (id: string, text: string): UIMessage =>
	({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const CLEAN_INPUT = { caseTypes: [{ name: "patient" }] };
// The pre-deploy shape: `appName` was a required slot before naming moved
// to `updateApp`; today's `.strict()` schema rejects the leftover key.
const STALE_INPUT = { appName: "Clinic", caseTypes: [{ name: "patient" }] };

const toolPart = (over: Record<string, unknown>) => ({
	type: "tool-generateSchema",
	toolCallId: "call_1",
	state: "output-available",
	input: CLEAN_INPUT,
	output: { message: "Recorded." },
	...over,
});

const assistant = (id: string, parts: unknown[]): UIMessage =>
	({ id, role: "assistant", parts }) as UIMessage;

describe("sanitizeHistoricalToolParts", () => {
	it("keeps a clean history untouched — same message references", async () => {
		const messages = [
			user("u1", "build it"),
			assistant("a1", [{ type: "text", text: "Building." }, toolPart({})]),
		];
		const out = await sanitizeHistoricalToolParts(messages, tools);
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(messages[0]);
		expect(out[1]).toBe(messages[1]);
	});

	it("drops a completed part whose nonempty input the narrowed schema rejects", async () => {
		// AI SDK 7.0.83 validates completed typed calls too. A nonempty input
		// that no longer matches the named tool is not safe to expose under the
		// current static type and is not one of the SDK's loadable dynamic cases.
		const messages = [
			assistant("a1", [
				{ type: "text", text: "Here is the design." },
				toolPart({ input: STALE_INPUT }),
				toolPart({ toolCallId: "call_2", input: CLEAN_INPUT }),
			]),
		];
		const out = await sanitizeHistoricalToolParts(messages, tools);
		expect(out).toHaveLength(1);
		expect(out[0]).not.toBe(messages[0]);
		expect(out[0].parts).toEqual([
			{ type: "text", text: "Here is the design." },
			toolPart({ toolCallId: "call_2", input: CLEAN_INPUT }),
		]);
		await expect(
			validateUIMessages({ messages: out, tools: validationTools }),
		).resolves.toBeDefined();
	});

	it("drops an in-flight part whose input the narrowed strict schema rejects, keeps the rest", async () => {
		// An IN-FLIGHT call (`input-available`) still input-parses at
		// validation, so a stale input would throw at the route; the repair
		// drops exactly that part and keeps its clean siblings.
		const messages = [
			assistant("a1", [
				{ type: "text", text: "Here is the design." },
				{
					type: "tool-generateSchema",
					toolCallId: "call_1",
					state: "input-available",
					input: STALE_INPUT,
				},
				toolPart({ toolCallId: "call_2", input: CLEAN_INPUT }),
			]),
		];
		const out = await sanitizeHistoricalToolParts(messages, tools);
		expect(out).toHaveLength(1);
		const types = out[0].parts.map((p) => p.type);
		expect(types).toEqual(["text", "tool-generateSchema"]);
		const kept = out[0].parts.find((p) => p.type === "tool-generateSchema");
		expect((kept as { toolCallId?: string }).toolCallId).toBe("call_2");
		// The repaired set passes the route's real validation.
		await expect(
			validateUIMessages({ messages: out, tools: validationTools }),
		).resolves.toBeDefined();
	});

	it("converts a completed retired-tool part to native dynamic history", async () => {
		const messages = [
			assistant("a1", [
				toolPart({
					type: "tool-planAppDesign",
					input: { modules: [] },
					output: { planned: true },
				}),
			]),
		];
		const out = await sanitizeHistoricalToolParts(messages, tools);
		expect(out).toHaveLength(1);
		expect(out[0].parts[0]).toMatchObject({
			type: "dynamic-tool",
			toolName: "planAppDesign",
			toolCallId: "call_1",
			state: "output-available",
		});
		await expect(
			validateUIMessages({ messages: out, tools: validationTools }),
		).resolves.toBeDefined();
	});

	it("converts an invalid output-error input to native dynamic history", async () => {
		// A historical rejected call remains loadable, but no longer claims its
		// stale input satisfies the current static tool schema.
		const messages = [
			assistant("a1", [
				{ type: "text", text: "That didn't work." },
				toolPart({
					state: "output-error",
					input: STALE_INPUT,
					output: undefined,
					errorText: "unrecognized key",
				}),
			]),
		];
		const out = await sanitizeHistoricalToolParts(messages, tools);
		expect(out[0]).not.toBe(messages[0]);
		expect(out[0].parts[1]).toMatchObject({
			type: "dynamic-tool",
			toolName: "generateSchema",
			state: "output-error",
		});
		await expect(
			validateUIMessages({ messages: out, tools: validationTools }),
		).resolves.toBeDefined();
	});

	it("drops a non-terminal part naming a retired tool", async () => {
		const messages = [
			assistant("a1", [
				{
					type: "tool-planAppDesign",
					toolCallId: "call_1",
					state: "input-available",
					input: { modules: [] },
				},
			]),
			user("u1", "continue"),
		];
		const out = await sanitizeHistoricalToolParts(messages, tools);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
	});
});
