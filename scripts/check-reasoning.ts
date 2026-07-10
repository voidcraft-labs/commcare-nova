import "dotenv/config";
import { createGateway, Output, streamText } from "ai";
import { z } from "zod";
import {
	GATEWAY_PROVIDER_OPTIONS,
	SA_BUILD_MODEL,
	SA_REASONING,
} from "../lib/models";

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is required");

const gateway = createGateway({ apiKey });

async function main() {
	const result = streamText({
		model: gateway(SA_BUILD_MODEL),
		output: Output.object({ schema: z.object({ answer: z.string() }) }),
		prompt: "What is 15 * 37? Show your work.",
		maxOutputTokens: 256,
		providerOptions: {
			openai: {
				reasoningEffort: SA_REASONING.effort,
				reasoningSummary: "auto",
			},
			gateway: GATEWAY_PROVIDER_OPTIONS,
		},
	});

	for await (const _p of result.partialOutputStream) {
	}

	const usage = await result.usage;
	console.log("usage:", JSON.stringify(usage));

	const rt = await result.reasoningText;
	console.log("reasoningText:", rt ? rt.slice(0, 300) : "(empty/undefined)");

	const r = await result.reasoning;
	console.log("reasoning:", JSON.stringify(r)?.slice(0, 500));
}

main();
