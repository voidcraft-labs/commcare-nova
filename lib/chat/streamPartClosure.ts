/**
 * Open-part tracking for the chat route's turn-retry loop — what makes an
 * aborted attempt END CLEANLY on the wire instead of littering the transcript.
 *
 * The UI message protocol has no "discard that" instruction, and the client's
 * stream processor accumulates every part of one response into ONE assistant
 * message — so when a transient provider failure aborts attempt N mid-part,
 * the retried attempt's content lands in the same message, after attempt N's
 * dangling parts. Left unclosed, those parts render stuck (a text part
 * forever in its streaming state, a tool card forever pending), on the live
 * client and on every future replay of the chunk log.
 *
 * The tracker mirrors the client's part-lifetime bookkeeping over the chunks
 * the route forwards; at retry time `closures()` returns the chunks that
 * close everything currently open — `text-end`/`reasoning-end` for open
 * streaming parts, a `tool-output-error` for tool calls the failure orphaned
 * (honest: the attempt was interrupted; the retry re-plans against committed
 * state), and a `finish-step` so the client resets its active-part maps
 * exactly where a completed step would. The result reads as a step that
 * stopped, followed by the retried step — one message, nothing dangling.
 */

import type { UIMessageChunk } from "ai";

/** The message shown on a tool card whose call the aborted attempt orphaned. */
const INTERRUPTED_TOOL_MESSAGE =
	"Interrupted by a temporary provider error — retried automatically.";

export interface OpenPartTracker {
	/** Observe every SA chunk the route forwards, in order. */
	observe(chunk: UIMessageChunk): void;
	/**
	 * The chunks that cleanly close everything currently open, in safe order
	 * (parts first, then the step). Resets the tracker — the retried attempt
	 * starts from a clean slate, exactly like the client does.
	 */
	closures(): UIMessageChunk[];
}

export function createOpenPartTracker(): OpenPartTracker {
	const openText = new Set<string>();
	const openReasoning = new Set<string>();
	const openToolCalls = new Set<string>();
	let stepOpen = false;

	function observe(chunk: UIMessageChunk): void {
		switch (chunk.type) {
			case "start-step":
				stepOpen = true;
				break;
			case "finish-step":
				stepOpen = false;
				break;
			case "text-start":
				openText.add(chunk.id);
				break;
			case "text-end":
				openText.delete(chunk.id);
				break;
			case "reasoning-start":
				openReasoning.add(chunk.id);
				break;
			case "reasoning-end":
				openReasoning.delete(chunk.id);
				break;
			/* A tool part stays open from its first input chunk until an output
			 * (or input error) closes it — `tool-input-available` only completes
			 * the INPUT; the card still awaits a result. */
			case "tool-input-start":
			case "tool-input-available":
				openToolCalls.add(chunk.toolCallId);
				break;
			case "tool-input-error":
			case "tool-output-available":
			case "tool-output-error":
				openToolCalls.delete(chunk.toolCallId);
				break;
			default:
				break;
		}
	}

	function closures(): UIMessageChunk[] {
		const out: UIMessageChunk[] = [];
		for (const id of openText) {
			out.push({ type: "text-end", id } as UIMessageChunk);
		}
		for (const id of openReasoning) {
			out.push({ type: "reasoning-end", id } as UIMessageChunk);
		}
		for (const toolCallId of openToolCalls) {
			out.push({
				type: "tool-output-error",
				toolCallId,
				errorText: INTERRUPTED_TOOL_MESSAGE,
			} as UIMessageChunk);
		}
		if (stepOpen || out.length > 0) {
			out.push({ type: "finish-step" } as UIMessageChunk);
		}
		openText.clear();
		openReasoning.clear();
		openToolCalls.clear();
		stepOpen = false;
		return out;
	}

	return { observe, closures };
}
