import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";
import { toolViews } from "../compositions/shared";

// This availability contract is independent of the definition factory: these
// journey controls must survive compaction without another hosted discovery.
const EAGER_JOURNEY_TOOLS = new Set([
	"startAppTest",
	"continueAppTest",
	"readAppTest",
]);

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
	it("lists discovery, private-work lifecycle and questions before shared tools", () => {
		const definitions = solutionsArchitectToolDefinitions();
		expect(Object.keys(definitions)).toEqual([
			"toolSearch",
			"getWork",
			"saveWork",
			"discardWork",
			"askQuestions",
			...SHARED_TOOL_REGISTRY.map((entry) => entry.saName),
		]);
		for (const definition of Object.values(definitions).filter(
			(definition) => definition.type !== "provider",
		)) {
			expect(definition.strict).toBe(false);
		}
	});

	it("carry shared descriptions, authored schemas and stable journey availability into anatomy", async () => {
		const definitions = solutionsArchitectToolDefinitions();
		const views = await toolViews(definitions);
		expect(views.map((view) => view.name)).toEqual(Object.keys(definitions));
		const byName = new Map(views.map((view) => [view.name, view]));
		for (const entry of SHARED_TOOL_REGISTRY) {
			const definition = definitions[entry.saName];
			expect(definition, entry.saName).toBeDefined();
			expect(definition?.description, entry.saName).toBe(
				entry.tool.description,
			);
			expect(definition?.providerOptions, entry.saName).toEqual(
				EAGER_JOURNEY_TOOLS.has(entry.saName)
					? undefined
					: { openai: { deferLoading: true } },
			);
			const expected = authoringToolSchema(
				entry.saName,
				entry.tool.inputSchema,
			).json;
			expect(
				await wireJsonSchema(definition?.inputSchema),
				entry.saName,
			).toEqual(expected);
			expect(byName.get(entry.saName), entry.saName).toMatchObject({
				description: entry.tool.description,
				inputSchema: expected,
				strict: false,
				deferred: !EAGER_JOURNEY_TOOLS.has(entry.saName),
			});
		}
		expect(
			SHARED_TOOL_REGISTRY.filter(
				(entry) => byName.get(entry.saName)?.deferred === false,
			)
				.map((entry) => entry.saName)
				.sort(),
		).toEqual([...EAGER_JOURNEY_TOOLS].sort());
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
		const sentFunctions = (
			JSON.parse(received) as {
				tools: {
					type: string;
					name?: string;
					description?: string;
					parameters?: unknown;
					strict?: boolean;
					defer_loading?: boolean;
				}[];
			}
		).tools.filter((tool) => tool.type === "function");
		expect(sentFunctions.map((tool) => tool.name)).toEqual([
			"getWork",
			"saveWork",
			"discardWork",
			"askQuestions",
			...SHARED_TOOL_REGISTRY.map((entry) => entry.saName),
		]);
		const sent = new Map(sentFunctions.map((tool) => [tool.name ?? "", tool]));
		for (const entry of SHARED_TOOL_REGISTRY) {
			const tool = sent.get(entry.saName);
			expect(tool, entry.saName).toMatchObject({
				description: entry.tool.description,
				strict: false,
			});
			expect(tool?.parameters, entry.saName).toEqual(
				authoringToolSchema(entry.saName, entry.tool.inputSchema).json,
			);
			expect(tool?.defer_loading, entry.saName).toBe(
				EAGER_JOURNEY_TOOLS.has(entry.saName) ? undefined : true,
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
