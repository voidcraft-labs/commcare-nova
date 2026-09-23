/** Count only when a byte-based reservation would stop a paid quality trial.
 * This endpoint tokenizes the same provider input; it does not generate a reply.
 * https://developers.openai.com/api/docs/guides/token-counting
 */
import { z } from "zod";
import { pilotReservation } from "./authoringPilotLedger";

const COUNT_INPUT_KEYS = [
	"conversation",
	"input",
	"instructions",
	"model",
	"parallel_tool_calls",
	"personality",
	"previous_response_id",
	"reasoning",
	"text",
	"tool_choice",
	"tools",
	"truncation",
] as const;

export async function countAuthoringInput(args: {
	body: string;
	apiKey: string;
	signal: AbortSignal;
}): Promise<number> {
	const request = z
		.record(z.string(), z.unknown())
		.parse(JSON.parse(args.body));
	const body = Object.fromEntries(
		COUNT_INPUT_KEYS.filter((key) => Object.hasOwn(request, key)).map((key) => [
			key,
			request[key],
		]),
	);
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new Error("Input count timed out.")),
		30_000,
	);
	try {
		const response = await fetch(
			"https://api.openai.com/v1/responses/input_tokens",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${args.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.any([args.signal, timeout.signal]),
			},
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`Input count refused (${response.status}); model request not sent.`,
			);
		}
		return z
			.object({
				object: z.literal("response.input_tokens"),
				input_tokens: z.number().int().nonnegative(),
			})
			.parse(await response.json()).input_tokens;
	} finally {
		clearTimeout(timer);
	}
}

/** No assumed cache hit: long-context cache-write pricing and output ceiling,
 * with a 25% input allowance above the provider count. */
export function countedInputReservation(
	model: string,
	inputTokens: number,
	maxOutputTokens: number,
): number {
	return pilotReservation(
		model,
		Math.ceil(inputTokens * 1.25),
		maxOutputTokens,
	);
}
