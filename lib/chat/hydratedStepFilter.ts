/**
 * The client half of the cold-resume protocol: replay everything, keep only
 * what the client doesn't already have.
 *
 * A cold resume (page refresh onto a live run) replays the in-flight stream's
 * chunk log FROM CHUNK 0 — the client's page load also hydrated the
 * barrier-persisted transcript, so without a filter the replay would push
 * duplicate text/reasoning parts into the seeded trailing assistant message
 * (part-open chunks append unconditionally). The correct replay window is a
 * property of the CLIENT'S OWN STATE — which steps its hydrated transcript
 * already holds — so the window lives here, keyed on that state at the moment
 * of the reconnect, not on any server-side guess: a server-computed boundary
 * reads the log/row at GET time, and every step completed between the page's
 * RSC hydration and that GET would be silently skipped.
 *
 * Mechanics: the transcript's trailing assistant message carries one
 * `step-start` part per completed step (`countHydratedSteps`). The stream's
 * first chunk is `data-seed-steps`, the server's statement of how many of
 * those steps PRECEDE this stream (nonzero only for an answered-askQuestions
 * continuation, whose stream grows a message earlier streams started). The
 * filter drops step CONTENT until the replay passes
 * `hydratedSteps − seedOffset` `start-step` chunks, then passes everything —
 * so the first step the client doesn't have is the first step it renders,
 * with no gap and no duplication whatever completed in between.
 *
 * Three chunk classes always pass, mid-skip or not:
 *  - transient `data-*` chunks: session/event state (conversation events,
 *    mutation frames, the run/app receipts, the holder-nonce marker swap),
 *    never message parts — the refreshed session store rebuilds from the
 *    full replay exactly as it always has;
 *  - terminal chunks (`finish`, `error`, `abort`): the transport only stops
 *    reconnecting on a `finish`, so swallowing one would tail forever;
 *  - `message-metadata`: idempotent against the seeded message.
 *
 * A stream with NO `data-seed-steps` chunk (written by a pre-protocol server
 * during a deploy window) passes everything from its first `start-step`: such
 * a server also wrote no mid-run transcript, so a hydrated partial to
 * duplicate does not exist and the full replay is exactly correct.
 *
 * Everything here is mechanical chunk-TYPE filtering; chunk content is never
 * interpreted.
 */

import type { UIMessageChunk } from "ai";

/** The stream's first chunk: `{ steps }` = the fold seed's `step-start`
 *  count. Written by the chat route, read only by this filter; transient, so
 *  it is never a message part and inert to every other consumer. */
export const SEED_STEPS_CHUNK_TYPE = "data-seed-steps";

/** Completed steps the client's transcript already holds: the trailing
 *  assistant message's `step-start` part count (a step's parts are closed by
 *  construction in a barrier-persisted transcript). A trailing user message
 *  means nothing of the in-flight turn is hydrated. */
export function countHydratedSteps(messages: readonly unknown[]): number {
	const last = messages[messages.length - 1] as
		| { role?: unknown; parts?: unknown }
		| undefined;
	if (last?.role !== "assistant" || !Array.isArray(last.parts)) return 0;
	return last.parts.filter(
		(part) => (part as { type?: unknown }).type === "step-start",
	).length;
}

/**
 * The stateful per-chunk pass/drop decision — see the module doc. Pure of
 * stream machinery so the windowing rules are directly testable;
 * `createHydratedStepSkipFilter` is its TransformStream wrapper.
 */
export function createHydratedStepWindow(
	hydratedSteps: number,
): (chunk: UIMessageChunk) => boolean {
	let passing = hydratedSteps <= 0;
	let seedOffset = 0;
	let sawSeedOffset = false;
	let streamStepsSeen = 0;
	return (chunk) => {
		if (passing) return true;
		const type = (chunk as { type?: unknown }).type;
		if (typeof type !== "string") return true;
		if (type === SEED_STEPS_CHUNK_TYPE) {
			const steps = (chunk as { data?: { steps?: unknown } }).data?.steps;
			if (typeof steps === "number" && Number.isFinite(steps)) {
				sawSeedOffset = true;
				seedOffset = steps;
				/* The client's whole transcript predates this stream: nothing
				 * to skip (the RSC-raced continuation attach lands here). */
				if (hydratedSteps - seedOffset <= 0) passing = true;
			}
			return true;
		}
		if (
			type.startsWith("data-") &&
			(chunk as { transient?: unknown }).transient === true
		) {
			return true;
		}
		if (
			type === "finish" ||
			type === "error" ||
			type === "abort" ||
			type === "message-metadata"
		) {
			return true;
		}
		if (type === "start-step") {
			if (!sawSeedOffset) {
				/* Pre-protocol stream (deploy window): no seed statement means
				 * no barrier-persisted partial to collide with — replay all. */
				passing = true;
				return true;
			}
			streamStepsSeen += 1;
			if (streamStepsSeen > hydratedSteps - seedOffset) {
				passing = true;
				return true;
			}
			return false;
		}
		/* Content of an already-hydrated step (part opens/deltas/closes,
		 * `start`, `finish-step`, tool chunks): the seeded message holds it. */
		return false;
	};
}

/**
 * TransformStream dropping the replayed content of steps the client already
 * hydrated. `hydratedSteps` is captured at reconnect time; a
 * transport-internal retry mid-replay keeps the same filter instance, so the
 * window's progress spans the whole reconnect chain.
 */
export function createHydratedStepSkipFilter(
	hydratedSteps: number,
): TransformStream<UIMessageChunk, UIMessageChunk> {
	const passes = createHydratedStepWindow(hydratedSteps);
	return new TransformStream<UIMessageChunk, UIMessageChunk>({
		transform(chunk, controller) {
			if (passes(chunk)) controller.enqueue(chunk);
		},
	});
}
