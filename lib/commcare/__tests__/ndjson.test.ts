import { describe, expect, it, vi } from "vitest";
import { readNdjsonStream } from "../ndjson";

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a ReadableStream from an array of string chunks (simulates network delivery). */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]));
				index++;
			} else {
				controller.close();
			}
		},
	});
}

/** Collect all events from an NDJSON stream into an array. */
async function collectEvents<T>(
	stream: ReadableStream<Uint8Array>,
): Promise<T[]> {
	const events: T[] = [];
	await readNdjsonStream<T>(stream, (event) => events.push(event));
	return events;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("readNdjsonStream", () => {
	it("parses a single event in one chunk", async () => {
		const stream = streamFromChunks(['{"type":"complete","value":42}\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "complete", value: 42 }]);
	});

	it("parses multiple events in one chunk", async () => {
		const stream = streamFromChunks([
			'{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n',
		]);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "a" }, { type: "b" }, { type: "c" }]);
	});

	it("handles events split across chunk boundaries", async () => {
		/* The JSON object {"type":"testing","n":1} is split mid-word
		 * between two chunks — the reader must buffer the partial line. */
		const stream = streamFromChunks(['{"type":"test', 'ing","n":1}\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "testing", n: 1 }]);
	});

	it("handles multiple events split across many chunks", async () => {
		const stream = streamFromChunks([
			'{"type":"a"}\n{"typ',
			'e":"b"}\n',
			'{"type":"c"}\n',
		]);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "a" }, { type: "b" }, { type: "c" }]);
	});

	it("ignores empty lines between events", async () => {
		const stream = streamFromChunks(['{"type":"a"}\n\n\n{"type":"b"}\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "a" }, { type: "b" }]);
	});

	it("ignores whitespace-only lines", async () => {
		const stream = streamFromChunks(['{"type":"a"}\n   \n{"type":"b"}\n']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "a" }, { type: "b" }]);
	});

	it("handles stream with no trailing newline", async () => {
		/* Data in the buffer after the last chunk is discarded if not
		 * newline-terminated — this is by design, as incomplete lines
		 * indicate truncation. */
		const stream = streamFromChunks(['{"type":"a"}\n{"type":"incomplete"']);
		const events = await collectEvents(stream);
		expect(events).toEqual([{ type: "a" }]);
	});

	it("emits synthetic error on invalid JSON and stops", async () => {
		const stream = streamFromChunks(['{"type":"a"}\nNOT_JSON\n{"type":"b"}\n']);
		const events = await collectEvents(stream);
		/* Should get event "a", then the synthetic error, but NOT "b". */
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({ type: "a" });
		expect(events[1]).toEqual({
			type: "error",
			message: "Received invalid data from the server.",
		});
	});

	it("emits synthetic error on HTML injection (proxy error pages)", async () => {
		const stream = streamFromChunks([
			"<html><body>502 Bad Gateway</body></html>\n",
		]);
		const events = await collectEvents(stream);
		expect(events).toEqual([
			{
				type: "error",
				message: "Received invalid data from the server.",
			},
		]);
	});

	it("calls custom onParseError when provided", async () => {
		const stream = streamFromChunks(["NOT_JSON\n"]);
		const onEvent = vi.fn();
		const onParseError = vi.fn();
		await readNdjsonStream(stream, onEvent, onParseError);
		expect(onParseError).toHaveBeenCalledOnce();
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("handles empty stream", async () => {
		const stream = streamFromChunks([]);
		const events = await collectEvents(stream);
		expect(events).toEqual([]);
	});
});
