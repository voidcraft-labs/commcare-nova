import { afterEach, expect, test, vi } from "vitest";
import { triggerAssetExtraction } from "../mediaClient";

afterEach(() => vi.restoreAllMocks());

test("decodes split UTF-8 frames, publishes progress, and cancels the body after the terminal frame", async () => {
	const extract = {
		status: "ready",
		version: 1,
		truncated: false,
		charCount: 12,
		title: "Santé",
	};
	const text = `${JSON.stringify({ type: "progress", chars: 4 })}\n${JSON.stringify({ type: "progress", chars: 8 })}\n${JSON.stringify({ type: "done", extract })}\n`;
	const bytes = new TextEncoder().encode(text);
	const cancelled = vi.fn();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
			for (const byte of bytes) value.enqueue(new Uint8Array([byte]));
		},
		cancel: cancelled,
	});
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
	const progress = vi.fn();
	try {
		expect(
			await triggerAssetExtraction("document", { onProgress: progress }),
		).toEqual(extract);
		expect(progress.mock.calls).toEqual([[4], [8]]);
		expect(cancelled).toHaveBeenCalledOnce();
	} finally {
		if (cancelled.mock.calls.length === 0) controller?.close();
	}
});

test.each([
	[200, "{not JSON}\n"],
	[403, "diagnostic body"],
])(
	"HTTP %s or invalid framing releases an unfinished response body",
	async (status, frame) => {
		const cancelled = vi.fn();
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				value.enqueue(new TextEncoder().encode(frame));
			},
			cancel: cancelled,
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(body, { status }),
		);
		try {
			expect(await triggerAssetExtraction("document")).toMatchObject({
				status: "failed",
				charCount: 0,
				truncated: false,
			});
			expect(cancelled).toHaveBeenCalledOnce();
		} finally {
			if (cancelled.mock.calls.length === 0) controller?.close();
		}
	},
);

test.each([
	"",
	'{"type":"progress","chars":3}\n',
	'{"type":"done","extract":{"status":"ready"}',
])("an incomplete stream %j cannot become a ready result", async (body) => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
	expect(await triggerAssetExtraction("document")).toMatchObject({
		status: "failed",
	});
});
