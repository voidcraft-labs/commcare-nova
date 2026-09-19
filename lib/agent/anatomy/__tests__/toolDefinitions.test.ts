import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";

/** The chat wire projection is an SDK `Schema`, whose `jsonSchema` may
 * resolve lazily; the definition type widens it to `FlexibleSchema`. */
async function wireJsonSchema(schema: unknown): Promise<unknown> {
	if (
		typeof schema !== "object" ||
		schema === null ||
		!("jsonSchema" in schema)
	) {
		throw new Error("the definition's inputSchema is not a wire Schema");
	}
	return await (schema as { jsonSchema: unknown }).jsonSchema;
}

describe("Solutions Architect tool definitions", () => {
	it("lists hosted discovery and questions before deferred shared tools", () => {
		const definitions = solutionsArchitectToolDefinitions();
		expect(Object.keys(definitions)).toEqual([
			"toolSearch",
			"askQuestions",
			...SHARED_TOOL_REGISTRY.map((entry) => entry.saName),
		]);
		for (const definition of Object.values(definitions).filter(
			(definition) => definition.type !== "provider",
		)) {
			expect(definition.strict).toBe(false);
		}
	});

	it("carry each shared tool's description and chat wire projection", async () => {
		const definitions = solutionsArchitectToolDefinitions();
		for (const entry of SHARED_TOOL_REGISTRY) {
			const definition = definitions[entry.saName];
			expect(definition, entry.saName).toBeDefined();
			expect(definition?.providerOptions).toEqual({
				openai: { deferLoading: true },
			});
			const expected = authoringToolSchema(
				entry.saName,
				entry.tool.inputSchema,
			).json;
			expect(
				await wireJsonSchema(definition?.inputSchema),
				entry.saName,
			).toEqual(expected);
		}
	});

	it("reach OpenAI exactly as authored, with nothing removed by the provider", async () => {
		const definitions = solutionsArchitectToolDefinitions();
		let received = "";
		const warnings = await withResponsesPeer(
			(request, response) => {
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					received += chunk;
				});
				request.on("end", () => respondWithObject(response, "Ready"));
			},
			async (provider) => {
				const result = streamText({
					model: provider("gpt-5.6-luna"),
					prompt: "Add a follow-up visit form.",
					tools: definitions,
					providerOptions: { openai: { store: false } },
					maxRetries: 0,
				});
				await result.text;
				return await result.warnings;
			},
		);

		expect(warnings).toEqual([]);
		const sent = new Map<string, unknown>(
			(
				JSON.parse(received) as {
					tools: { type: string; name?: string; parameters?: unknown }[];
				}
			).tools
				.filter((tool) => tool.type === "function")
				.map((tool) => [tool.name ?? "", tool.parameters]),
		);
		for (const entry of SHARED_TOOL_REGISTRY) {
			expect(sent.get(entry.saName), entry.saName).toEqual(
				authoringToolSchema(entry.saName, entry.tool.inputSchema).json,
			);
		}
	});

	it("say what every open-keyed record is keyed by", () => {
		// The projection removes `propertyNames`, which OpenAI cannot accept, and
		// states the keys on the record instead. A record whose key schema had no
		// description would reach the model as an open object with no word on
		// what to key it by.
		const unexplained: string[] = [];
		const visit = (node: unknown, path: string): void => {
			if (Array.isArray(node)) {
				node.forEach((child, index) => {
					visit(child, `${path}[${index}]`);
				});
				return;
			}
			if (node === null || typeof node !== "object") return;
			const schema = node as Record<string, unknown>;
			const openKeyed =
				schema.additionalProperties !== null &&
				typeof schema.additionalProperties === "object";
			if (openKeyed && !String(schema.description ?? "").includes("Keys: "))
				unexplained.push(path);
			for (const [key, child] of Object.entries(schema))
				visit(child, `${path}.${key}`);
		};
		for (const entry of SHARED_TOOL_REGISTRY)
			visit(
				authoringToolSchema(entry.saName, entry.tool.inputSchema).json,
				entry.saName,
			);
		expect(unexplained).toEqual([]);
	});

	it("tell the model what a record's keys are on the record itself", () => {
		const { json } = authoringToolSchema(
			"updateLocation",
			SHARED_TOOL_REGISTRY.find((entry) => entry.saName === "updateLocation")
				?.tool.inputSchema as never,
		);
		const values = (json.properties as Record<string, Record<string, unknown>>)
			.values;
		expect(values.description).toBe("Keys: Place property name or stable ID.");
		expect(values).not.toHaveProperty("propertyNames");
	});
});
