import { describe, expect, it } from "vitest";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { designAgentToolDefinitions } from "@/lib/agent/design/loop/designAgent";
import {
	createDesignLoopActions,
	type DesignLoopToolDeps,
	designLoopToolDefinitions,
	designToolsetDigest,
} from "@/lib/agent/design/loop/tools";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";

/** `createDesignLoopActions` binds `execute` closures over its deps and reads
 * none of them until a tool runs, so a throwing proxy proves the mount is
 * definition-pure while yielding the exact bound record. */
const eagerDepsTrap = new Proxy({} as DesignLoopToolDeps, {
	get(_target, property) {
		throw new Error(
			`createDesignLoopActions read deps.${String(property)} at mount time.`,
		);
	},
});

describe("design loop tool definitions", () => {
	it("match the bound tools the agent mounts, key for key", async () => {
		const { tools: bound } = createDesignLoopActions(eagerDepsTrap);
		const definitions = designAgentToolDefinitions(designLoopToolDefinitions());
		const mounted = designAgentToolDefinitions(bound);
		expect(Object.keys(mounted)).toEqual(Object.keys(definitions));
		expect(await designToolsetDigest(mounted)).toBe(
			await designToolsetDigest(definitions),
		);
		for (const name of Object.keys(bound)) {
			expect(bound[name as keyof typeof bound]).toHaveProperty("execute");
		}
	});
	it("changes the context identity when discovery or a loading policy changes", async () => {
		const definitions = designAgentToolDefinitions(designLoopToolDefinitions());
		const digest = await designToolsetDigest(definitions);
		const { toolSearch: _search, ...withoutSearch } = definitions;
		expect(await designToolsetDigest(withoutSearch)).not.toBe(digest);
		expect(
			await designToolsetDigest({
				...definitions,
				updateRecords: {
					...definitions.updateRecords,
					providerOptions: { openai: { deferLoading: false } },
				},
			}),
		).not.toBe(digest);
	});
});

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
