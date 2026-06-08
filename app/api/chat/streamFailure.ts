/**
 * Failure classification for the chat route's forward loop.
 *
 * The chat route drains the agent and forwards `toUIMessageStream` chunks to the
 * client. To decide whether the RUN failed (charge → refund + flip the app to
 * `error`), it must tell a FATAL model/stream error apart from a tool-level error
 * the Solutions Architect recovers from and continues past.
 *
 * The trap this guards against: the SDK's `toUIMessageStream({ onError })`
 * callback fires for THREE distinct chunk kinds — `tool-input-error` and
 * `tool-output-error` (a model-emitted invalid tool call, or a tool `execute()`
 * throw — the SA loop retries past both and the run can still complete
 * successfully) AND the terminal `error` chunk (the model run itself ending in
 * error). Only the last is fatal. Keying run-failure on "did `onError` fire at
 * all" wrongly fails a successful run that merely recovered from a tool error —
 * flipping a completed app to `error` and refunding a legitimate charge. So the
 * route keys on the fatal CHUNK type instead, via this predicate.
 */

/**
 * Is this forwarded UIMessage chunk the one that means the generation run itself
 * terminated in error (as opposed to a tool-level error the SA loop recovers
 * from)? Only the terminal `"error"` chunk is fatal; `"tool-input-error"` and
 * `"tool-output-error"` are not.
 */
export function isFatalStreamErrorChunk(chunkType: string): boolean {
	return chunkType === "error";
}
