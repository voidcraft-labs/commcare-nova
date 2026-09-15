import { describe, expect, it } from "vitest";
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
});
