/**
 * NDJSON (newline-delimited JSON) stream reader.
 *
 * Reads a `ReadableStream<Uint8Array>` line-by-line, parses each line as JSON,
 * and dispatches the result to a callback. Handles partial lines across chunk
 * boundaries — a common scenario when the server flushes mid-JSON-object.
 *
 * If a line fails to parse (proxy-injected HTML, chunk-split corruption),
 * dispatches a synthetic error and stops — continuing would leave the UI
 * stuck in a progress state with no resolution.
 */

/** Generic NDJSON event — callers narrow this to their specific event union. */
export type NdjsonEvent = Record<string, unknown>;

/**
 * Read an NDJSON response body line-by-line, dispatching each parsed
 * event to the callback.
 *
 * @param body - The response body stream (e.g. `res.body` from fetch)
 * @param onEvent - Called once per parsed JSON line
 * @param onParseError - Called when a line fails to parse. If not provided,
 *   dispatches `{ type: "error", message: "..." }` via onEvent.
 */
export async function readNdjsonStream<T = NdjsonEvent>(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: T) => void,
	onParseError?: () => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		/* Last element is either an incomplete line or empty — keep it. */
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				onEvent(JSON.parse(line) as T);
			} catch {
				if (onParseError) {
					onParseError();
				} else {
					onEvent({
						type: "error",
						message: "Received invalid data from the server.",
					} as T);
				}
				return;
			}
		}
	}
}
