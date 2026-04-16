/**
 * Tests that the addQuestions structured output schema compiles within
 * Anthropic's grammar compiler limits. The compiler times out with >8
 * .optional() fields per array item — this script catches regressions.
 *
 * Usage: npx tsx scripts/test-schema.ts [opus]
 */
import "dotenv/config";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import { addQuestionsSchema } from "../lib/schemas/toolSchemas";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
	console.error("Set ANTHROPIC_API_KEY");
	process.exit(1);
}

const anthropic = createAnthropic({ apiKey });
const model =
	process.argv[2] === "opus" ? "claude-opus-4-7" : "claude-haiku-4-5-20251001";

const size = JSON.stringify(addQuestionsSchema.jsonSchema).length;
console.log(`addQuestionsSchema: ${size} chars`);
console.log(`Testing with ${model}...`);

const controller = new AbortController();
const timer = setTimeout(() => {
	console.log("TIMEOUT (180s)");
	controller.abort();
	process.exit(1);
}, 180000);

generateText({
	model: anthropic(model),
	output: Output.object({ schema: addQuestionsSchema.schema }),
	system: "Produce minimal valid output.",
	prompt:
		"A registration form with 2 questions: patient_name (text) and age (int).",
	maxOutputTokens: 1024,
	abortSignal: controller.signal,
})
	.then((r) => {
		clearTimeout(timer);
		console.log(`PASS (${r.usage.inputTokens}/${r.usage.outputTokens} tokens)`);
	})
	.catch((e) => {
		clearTimeout(timer);
		console.log("FAIL:", (e.responseBody ?? e.message ?? "").slice(0, 500));
		process.exit(1);
	});
