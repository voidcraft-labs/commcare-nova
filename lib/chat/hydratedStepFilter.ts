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
 * of the replay, not on any server-side guess: a server-computed boundary
 * reads the log/row at GET time, and every step completed between the page's
 * RSC hydration and that GET would be silently skipped.
 *
 * Mechanics — the window is keyed on MESSAGE IDENTITY, never position:
 *  - The stream's first chunk is `data-seed-steps`, the server's statement of
 *    how many of the message's steps PRECEDE this stream (nonzero only for an
 *    answered-askQuestions continuation, whose stream grows a message earlier
 *    streams started).
 *  - The replay's `start` chunk carries the id of the message THIS stream
 *    grows (the route mints it, so it is on the wire before the choke-point
 *    tee). At that chunk the filter counts the `step-start` parts of the
 *    client's own copy of THAT id — wherever it sits in the hydrated list, so
 *    a locally appended trailing user message (a Project-move's retained
 *    send) can't zero the count, and a stream growing a message the client
 *    has never seen (a newer turn claimed between hydration and the GET)
 *    correctly windows nothing.
 *  - Step content then drops until the replay passes
 *    `hydratedSteps − seedOffset` `start-step` chunks, and everything passes
 *    from there — the first step the client doesn't have is the first step it
 *    renders, with no gap and no duplication whatever completed in between.
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
 * during a deploy window) passes everything from its `start`: such a server
 * also wrote no mid-run transcript, so a hydrated partial to duplicate does
 * not exist and the full replay is exactly correct. A `start` with no
 * message id resolves to a zero count — replay everything — the same
 * graceful arm.
 *
 * Everything here is mechanical chunk-TYPE plus id-equality filtering; chunk
 * content is never otherwise interpreted.
 */

import type { UIMessageChunk } from "ai";

/** The stream's first chunk: `{ steps }` = the fold seed's `step-start`
 *  count. Written by the chat route, read only by this filter; transient, so
 *  it is never a message part and inert to every other consumer. */
export const SEED_STEPS_CHUNK_TYPE = "data-seed-steps";

/** Completed steps of the client's own copy of the message `messageId`
 *  names: its `step-start` part count (a step's parts are closed by
 *  construction in a barrier-persisted transcript). Zero when the id is
 *  absent or names a non-assistant message — nothing hydrated, so nothing to
 *  skip. */
export function countHydratedSteps(
	messages: readonly unknown[],
	messageId: string | undefined,
): number {
	if (messageId === undefined) return 0;
	for (const message of messages) {
		const m = message as { id?: unknown; role?: unknown; parts?: unknown };
		if (m.id !== messageId) continue;
		if (m.role !== "assistant" || !Array.isArray(m.parts)) return 0;
		return m.parts.filter(
			(part) => (part as { type?: unknown }).type === "step-start",
		).length;
	}
	return 0;
}

/**
 * The stateful per-chunk pass/drop decision — see the module doc. Pure of
 * stream machinery so the windowing rules are directly testable;
 * `createHydratedStepSkipFilter` is its TransformStream wrapper.
 * `getHydratedMessages` is read once, at the replay's `start` chunk — the
 * moment the stream declares which message it grows.
 */
export function createHydratedStepWindow(
	getHydratedMessages: () => readonly unknown[],
): (chunk: UIMessageChunk) => boolean {
	let passing = false;
	let seedOffset = 0;
	let sawSeedOffset = false;
	let skipTarget: number | null = null;
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
		if (type === "start") {
			if (!sawSeedOffset) {
				/* Pre-protocol stream (deploy window): no seed statement means
				 * no barrier-persisted partial to collide with — replay all. */
				passing = true;
				return true;
			}
			const messageId = (chunk as { messageId?: unknown }).messageId;
			skipTarget =
				countHydratedSteps(
					getHydratedMessages(),
					typeof messageId === "string" ? messageId : undefined,
				) - seedOffset;
			if (skipTarget <= 0) passing = true;
			return true;
		}
		if (type === "start-step") {
			if (skipTarget === null) {
				/* A step with no preceding `start` — not a shape the route
				 * writes. Replay everything rather than guess a window. */
				passing = true;
				return true;
			}
			streamStepsSeen += 1;
			if (streamStepsSeen > skipTarget) {
				passing = true;
				return true;
			}
			return false;
		}
		/* Content of an already-hydrated step (part opens/deltas/closes,
		 * `finish-step`, tool chunks): the seeded message holds it. */
		return false;
	};
}

/**
 * TransformStream dropping the replayed content of steps the client already
 * hydrated. A transport-internal retry mid-replay keeps the same filter
 * instance, so the window's progress spans the whole reconnect chain.
 */
export function createHydratedStepSkipFilter<
	Chunk extends UIMessageChunk = UIMessageChunk,
>(
	getHydratedMessages: () => readonly unknown[],
): TransformStream<Chunk, Chunk> {
	const passes = createHydratedStepWindow(getHydratedMessages);
	return new TransformStream<Chunk, Chunk>({
		transform(chunk, controller) {
			if (passes(chunk)) controller.enqueue(chunk);
		},
	});
}
