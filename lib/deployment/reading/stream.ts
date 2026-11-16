/**
 * The one client-side reader of a bring-in route's stream: one JSON object a
 * line, stage and file lines as the work moves, then exactly one last line,
 * `done` with the answer or `failed`. A body that ends without that last line
 * is a lost request (the instance ended, or the network did), and so is a
 * line that is no event this stream writes.
 *
 * Client-safe: pure but for the response it is handed.
 */

import { READING_STAGES, type ReadingEvent, type ReadingStage } from "./types";

type ProgressEvent = Extract<ReadingEvent, { type: "stage" | "files" }>;
type LastEvent = Extract<ReadingEvent, { type: "done" | "failed" }>;
type Lost = { readonly type: "lost" };

const STAGES: ReadonlySet<string> = new Set<ReadingStage>(READING_STAGES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The event a line holds, or null where it is no event this stream writes. */
function eventOf(line: string): ProgressEvent | LastEvent | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	switch (value.type) {
		case "stage":
			return typeof value.stage === "string" && STAGES.has(value.stage)
				? { type: "stage", stage: value.stage as ReadingStage }
				: null;
		case "files":
			return isCount(value.done) &&
				isCount(value.total) &&
				value.done <= value.total
				? { type: "files", done: value.done, total: value.total }
				: null;
		case "done":
			return isRecord(value.answer) && typeof value.answer.kind === "string"
				? ({ type: "done", answer: value.answer } as LastEvent)
				: null;
		case "failed":
			return { type: "failed" };
		default:
			return null;
	}
}

/**
 * Reads a bring-in route's response body line by line, calls `onEvent` for each stage and file
 * event, and resolves with the last line's event. It resolves `{ type: "lost" }` where the body
 * ends with no `done` or `failed` line, or a line is no JSON object of a known `type`.
 */
export async function readBringInStream(
	response: Response,
	onEvent: (event: ProgressEvent) => void,
): Promise<LastEvent | Lost> {
	const body = response.body;
	if (body === null) return { type: "lost" };
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	// Widened by `as`: `take` assigns it, which narrowing at the returns below cannot see.
	let last = null as LastEvent | null;
	let settled = false;

	/** One complete line. False where the stream can no longer be read as an answer. */
	const take = (line: string): boolean => {
		if (line.trim() === "") return true;
		// Nothing follows the last line.
		if (last !== null) return false;
		const event = eventOf(line);
		if (event === null) return false;
		if (event.type === "stage" || event.type === "files") onEvent(event);
		else last = event;
		return true;
	};

	try {
		for (;;) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch {
				// The connection ended under the read.
				settled = true;
				return { type: "lost" };
			}
			if (chunk.done) {
				settled = true;
				buffered += decoder.decode();
				if (!take(buffered)) return { type: "lost" };
				return last ?? { type: "lost" };
			}
			buffered += decoder.decode(chunk.value, { stream: true });
			let end = buffered.indexOf("\n");
			while (end !== -1) {
				const line = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				if (!take(line)) return { type: "lost" };
				end = buffered.indexOf("\n");
			}
		}
	} finally {
		if (settled) reader.releaseLock();
		else await reader.cancel().catch(() => undefined);
	}
}
