/**
 * Verify that every provider-facing Nova tool schema is accepted by OpenAI.
 *
 * The shared-tool inventory comes from `SHARED_TOOL_MANIFEST`, the same array
 * that registers chat and MCP. That makes this paid gate complete by
 * construction: a new shared tool cannot be live while silently missing here.
 * `askQuestions` is chat-only and `uploadMediaAsset` is MCP-only, so those two
 * boundary exceptions are added explicitly.
 *
 * The provider receives `wireToolSchema(...)`, exactly as the production chat
 * agent does. Local validation still uses the untouched Zod schema; only the
 * repeated Predicate / ValueExpression families are compacted on the wire.
 *
 * Usage: `npm run test:schema -- [sol] [schema-name]`
 *   - `sol` uses the production SA build model; the default Luna model is
 *     cheaper and exercises the same tool-schema acceptance path.
 *   - a schema name runs only that entry; omit it to run the complete inventory.
 *
 * This command spends money: one live provider call per selected schema.
 */

import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { SHARED_TOOL_MANIFEST } from "../lib/agent/sharedToolManifest";
import { askQuestionsTool } from "../lib/agent/tools/askQuestions";
import { wireToolSchema } from "../lib/agent/wireSchemas";
import { uploadMediaAssetInputSchema } from "../lib/mcp/tools/uploadMediaAsset";
import { OPENAI_BASE_OPTIONS, SA_BUILD_MODEL } from "../lib/models";

interface ProviderSchemaTest {
	readonly name: string;
	readonly description: string;
	readonly schema: z.ZodObject<z.ZodRawShape>;
}

const SCHEMA_TESTS: readonly ProviderSchemaTest[] = [
	{
		name: "askQuestions",
		description: askQuestionsTool.description,
		schema: askQuestionsTool.inputSchema,
	},
	...SHARED_TOOL_MANIFEST.map(({ chatName, tool: sharedTool }) => ({
		name: chatName,
		description: sharedTool.description,
		schema: sharedTool.inputSchema,
	})),
	{
		name: "uploadMediaAsset",
		description: "Upload a media file to the library from inline base64 bytes.",
		schema: uploadMediaAssetInputSchema,
	},
];

const names = SCHEMA_TESTS.map(({ name }) => name);
if (new Set(names).size !== names.length) {
	throw new Error("Provider schema inventory contains a duplicate tool name.");
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
	console.error("Set OPENAI_API_KEY");
	process.exit(1);
}

const args = process.argv.slice(2);
const useSol = args.includes("sol");
const explicitName = args.find((arg) => arg !== "sol");
const selected = explicitName
	? SCHEMA_TESTS.filter(({ name }) => name === explicitName)
	: SCHEMA_TESTS;

if (selected.length === 0) {
	console.error(`Unknown schema name: ${explicitName}`);
	console.error(`Known names: ${names.join(", ")}`);
	process.exit(1);
}

const model = useSol ? SA_BUILD_MODEL : "gpt-5.6-luna";
const openai = createOpenAI({ apiKey });
const exampleUuid = "11111111-1111-4111-8111-111111111111";

console.log(`Testing ${selected.length} schema(s) with ${model}...`);

/* `tsx` transpiles this script to CJS, so keep top-level await inside an IIFE.
 * Sequential calls keep spend and output explicit instead of bursting the
 * complete inventory at the provider. */
(async () => {
	let exitCode = 0;
	for (const schemaTest of selected) {
		const rawSize = JSON.stringify(
			z.toJSONSchema(schemaTest.schema, {
				target: "draft-7",
				io: "input",
			}),
		).length;
		console.log(`\n${schemaTest.name}: ${rawSize} raw-schema chars`);

		const controller = new AbortController();
		const timer = setTimeout(() => {
			console.log("TIMEOUT (180s)");
			controller.abort();
		}, 180_000);

		try {
			const result = await generateText({
				model: openai(model),
				tools: {
					[schemaTest.name]: tool({
						description: schemaTest.description,
						inputSchema: wireToolSchema(schemaTest.schema),
						strict: false,
						execute: async () => "ok",
					}),
				},
				stopWhen: stepCountIs(2),
				system:
					"Call the supplied tool exactly once. Produce syntactically valid input for its schema; the call is a schema probe and does not execute against a real app.",
				prompt:
					`Call ${schemaTest.name} now. Invent reasonable sample values. ` +
					`Use canonical lowercase UUIDs such as ${exampleUuid} for every UUID slot, ` +
					"and use complete objects for any required arrays or discriminated unions.",
				maxOutputTokens: 1_024,
				abortSignal: controller.signal,
				providerOptions: { openai: OPENAI_BASE_OPTIONS },
			});
			clearTimeout(timer);
			console.log(
				`PASS (${result.usage.inputTokens}/${result.usage.outputTokens} tokens, finishReason=${result.finishReason})`,
			);
		} catch (error) {
			clearTimeout(timer);
			const providerError = error as {
				responseBody?: string;
				message?: string;
			};
			console.log(
				"FAIL:",
				(providerError.responseBody ?? providerError.message ?? "").slice(
					0,
					500,
				),
			);
			exitCode = 1;
		}
	}
	process.exit(exitCode);
})();
