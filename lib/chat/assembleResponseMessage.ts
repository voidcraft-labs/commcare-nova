/**
 * Rebuild the run's final assistant `UIMessage` from the durable chunk log.
 *
 * The chunk log is the single source of truth for what a POST streamed —
 * including turn-retry part closures and suppressed `start` chunks — so
 * assembling from it yields EXACTLY the message any client (live or
 * resuming) assembles, with no double bookkeeping in the route. Runs whose
 * browser went away still assemble: the server-side drain keeps writing the
 * log regardless of the connection.
 *
 * Uses the AI SDK's own `readUIMessageStream` (the same processor the
 * client runs), so part semantics can't drift from the SDK's: transient
 * data parts are excluded, tool parts carry their streamed states, a paused
 * askQuestions round assembles as `input-available`.
 */
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { readStreamChunksFrom } from "@/lib/db/streamChunks";
import { log } from "@/lib/logger";

/**
 * Read the whole chunk log for `streamId` and assemble the assistant
 * message. Returns null when the run streamed nothing message-worthy (a
 * zero-step failure) or the log read/assembly fails — persistence callers
 * treat null as "nothing to append". Never throws; a failure here must not
 * take down run finalization.
 *
 * `continues` is the incoming history's TRAILING assistant message, when
 * there is one (an answered askQuestions round): the SA's response streams
 * as a CONTINUATION of that message (`toUIMessageStream({originalMessages})`
 * reuses its id), and the client merges the new parts into it — so the
 * assembly must start from the same base or the persisted transcript would
 * split one message into two same-id siblings.
 */
export async function assembleResponseMessage(
	streamId: string,
	continues?: UIMessage,
): Promise<UIMessage | null> {
	try {
		const { chunks } = await readStreamChunksFrom(streamId, 0);
		if (chunks.length === 0) return null;

		const stream = new ReadableStream<UIMessageChunk>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(chunk as UIMessageChunk);
				}
				controller.close();
			},
		});

		let message: UIMessage | undefined;
		for await (const snapshot of readUIMessageStream({
			// The processor mutates its base; clone so the caller's copy of the
			// incoming history stays pristine.
			message: continues ? structuredClone(continues) : undefined,
			stream,
			// A fatal error chunk in the log is already surfaced to the user as a
			// conversation event; here it must not abort assembly of whatever
			// parts streamed before it.
			onError: () => {},
		})) {
			message = snapshot;
		}

		if (!message || message.parts.length === 0) return null;
		/* A pure continuation base with nothing new appended (the run died
		 * before its first content chunk) has nothing to persist either. */
		if (continues && message.parts.length === continues.parts.length) {
			return null;
		}
		return message;
	} catch (err) {
		log.error("[chat] response-message assembly failed", err, { streamId });
		return null;
	}
}
