// Unit tests for the chat route's deploy-crossing history repair. The
// scenario under test is the one that bricked resumes: a thread persisted
// before a deploy carries tool parts the CURRENT tool surface no longer
// accepts — a retired tool name, or a surviving name whose `.strict()`
// input schema dropped a key old calls carry (`generateSchema`'s
// `appName`). The repair must drop exactly those parts, keep everything
// else byte-identical, and leave a message set the route's
// `validateUIMessages` accepts.

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

	it("drops a part whose input the narrowed strict schema rejects, keeps the rest", async () => {
		const messages = [
			assistant("a1", [
				{ type: "text", text: "Here is the design." },
				toolPart({ input: STALE_INPUT }),
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

	it("drops parts naming a retired tool; a message left empty drops whole", async () => {
		const messages = [
			assistant("a1", [
				toolPart({
					type: "tool-planAppDesign",
					input: { modules: [] },
					output: { planned: true },
				}),
			]),
			user("u1", "continue"),
		];
		const out = await sanitizeHistoricalToolParts(messages, tools);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
	});

	it("leaves output-error parts alone — validation never parses their input", async () => {
		// A historical REJECTED call (bad input by definition) must survive:
		// `validateUIMessages` only input-parses input-available /
		// output-available parts, and the repair mirrors that exactly.
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
		expect(out[0]).toBe(messages[0]);
		await expect(
			validateUIMessages({ messages: out, tools: validationTools }),
		).resolves.toBeDefined();
	});
});
