import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";
import { Output, streamText } from "ai";
import { z } from "zod";
import {
	reasoningProviderOptions,
	SA_BUILD_MODEL,
	SA_BUILD_REASONING,
} from "../lib/models";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const openai = createOpenAI({ apiKey });

async function main() {
	const result = streamText({
		model: openai(SA_BUILD_MODEL),
		output: Output.object({ schema: z.object({ answer: z.string() }) }),
		prompt: "What is 15 * 37? Show your work.",
		maxOutputTokens: 256,
		providerOptions: reasoningProviderOptions(SA_BUILD_REASONING.effort),
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
