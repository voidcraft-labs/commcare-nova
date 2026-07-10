import { createGateway, Output, streamText } from "ai";
import { z } from "zod";
import { SA_MODEL } from "../lib/models";

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is required");

const gateway = createGateway({ apiKey });

async function main() {
	const result = streamText({
		model: gateway(SA_MODEL),
		output: Output.object({ schema: z.object({ answer: z.string() }) }),
		prompt: "What is 15 * 37? Show your work.",
		maxOutputTokens: 256,
		providerOptions: {
			anthropic: {
				thinking: { type: "adaptive", display: "summarized" },
				effort: "xhigh",
			},
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
