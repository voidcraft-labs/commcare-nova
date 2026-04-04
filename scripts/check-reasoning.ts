import { streamText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const apiKey = process.env.ANTHROPIC_API_KEY!;
const anthropic = createAnthropic({ apiKey });

async function main() {
	const result = streamText({
		model: anthropic("claude-opus-4-6"),
		output: Output.object({ schema: z.object({ answer: z.string() }) }),
		prompt: "What is 15 * 37? Show your work.",
		maxOutputTokens: 256,
		providerOptions: {
			anthropic: { thinking: { type: "adaptive", effort: "high" } },
		},
	});

	for await (const p of result.partialOutputStream) {
	}

	const usage = await result.usage;
	console.log("usage:", JSON.stringify(usage));

	const rt = await result.reasoningText;
	console.log("reasoningText:", rt ? rt.slice(0, 300) : "(empty/undefined)");

	const r = await result.reasoning;
	console.log("reasoning:", JSON.stringify(r)?.slice(0, 500));
}

main();
