/**
 * The ONE OpenAI provider constructor — every model call in Nova goes
 * through `createNovaOpenAI`, never a bare `createOpenAI`.
 *
 * What it adds over the SDK default is the transport timeout policy. Node's
 * fetch (undici) defaults both `headersTimeout` and `bodyTimeout` to 300
 * seconds, and a reasoning model legitimately exceeds both: a BLOCKING call
 * sends no response headers until the whole generation finishes, and a
 * STREAMING call can go minutes between chunks while the model reasons
 * silently. Under the defaults a long generation dies at exactly 300s with
 * `Headers Timeout Error` — observed live killing the design author call on
 * all three SDK attempts, ~15 minutes of guaranteed-doomed requests.
 *
 * OpenAI requests use the npm package's `fetch` and `Agent` together, so both
 * sides speak Undici 8's dispatcher contract. This is deliberately scoped to
 * the provider rather than installed as a global dispatcher: Next's fetches
 * keep their defaults, while model calls receive the long timeout and remain
 * cancellable through their abort signal. The transport test pins both timeout
 * and success behavior against a live local server.
 */

import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";

/** Transport ceiling for one model call's headers AND its inter-chunk idle
 *  gap. Generous by design: real cancellation is the caller's abort signal;
 *  this exists only to beat the 300s undici default that no long reasoning
 *  call survives. */
export const MODEL_CALL_TIMEOUT_MS = 20 * 60_000;

/** Exported for the transport pin test's identity assertion only. */
export const modelCallDispatcher = new Agent({
	headersTimeout: MODEL_CALL_TIMEOUT_MS,
	bodyTimeout: MODEL_CALL_TIMEOUT_MS,
});

/** The fetch every production provider instance uses. The AI SDK's fetch
 *  contract is the DOM signature; Undici's equivalent structural types are
 *  declared separately, so the cast is isolated at this one transport seam. */
export function createModelCallFetch(
	dispatcher: Dispatcher,
): typeof globalThis.fetch {
	return (input, init) =>
		undiciFetch(
			input as Parameters<typeof undiciFetch>[0],
			{
				...init,
				dispatcher,
			} as Parameters<typeof undiciFetch>[1],
		) as unknown as Promise<Response>;
}

export const modelCallFetch = createModelCallFetch(modelCallDispatcher);

export function createNovaOpenAI(
	apiKey: string,
	transport: typeof globalThis.fetch = modelCallFetch,
): OpenAIProvider {
	return createOpenAI({ apiKey, fetch: transport });
}
