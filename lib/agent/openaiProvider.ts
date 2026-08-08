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
 * The dispatcher rides each request via `init.dispatcher` on the global
 * fetch — NOT a swapped fetch implementation and NOT a global dispatcher —
 * so tests keep capturing calls by stubbing `globalThis.fetch`, Next's own
 * fetches keep their defaults, and every call remains cancellable through
 * its abort signal. That shape couples the npm `undici` MAJOR to the undici
 * Node bundles for its fetch: the dispatch handler interface changes across
 * majors (an undici@8 Agent rejects Node 24's v7 handlers with
 * `UND_ERR_INVALID_ARG`), so a Node upgrade may require the dependency to
 * move in step. `__tests__/openaiProviderTransport.test.ts` pins all of it:
 * the dispatcher reaches `init`, and this Node's fetch genuinely honors a
 * package-built dispatcher's timeouts against a live local server.
 */

import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { Agent } from "undici";

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

/** The fetch every provider instance uses: the current `globalThis.fetch`
 *  (resolved at call time, so test stubs intercept) with the long-timeout
 *  dispatcher on the init. `dispatcher` is undici's documented RequestInit
 *  extension; lib.dom's types don't know it, hence the cast. */
export const modelCallFetch: typeof globalThis.fetch = (input, init) =>
	globalThis.fetch(input, {
		...init,
		dispatcher: modelCallDispatcher,
	} as RequestInit);

export function createNovaOpenAI(apiKey: string): OpenAIProvider {
	return createOpenAI({ apiKey, fetch: modelCallFetch });
}
