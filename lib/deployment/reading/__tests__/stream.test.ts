import { describe, expect, it } from "vitest";
import { readBringInStream } from "../stream";
import type { ReadingEvent } from "../types";

type Progress = Extract<ReadingEvent, { type: "stage" | "files" }>;

/** A response whose body is `text` cut into the given chunk sizes, in bytes. */
function responseOf(
	text: string,
	cuts: readonly number[],
	options: { readonly breakAfter?: boolean } = {},
): Response {
	const bytes = new TextEncoder().encode(text);
	const chunks: Uint8Array[] = [];
	let at = 0;
	for (const cut of cuts) {
		chunks.push(bytes.subarray(at, at + cut));
		at += cut;
	}
	if (at < bytes.length) chunks.push(bytes.subarray(at));
	let next = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[next];
			next += 1;
			if (chunk !== undefined) controller.enqueue(chunk);
			else if (options.breakAfter) controller.error(new TypeError("network"));
			else controller.close();
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
	});
}

const lines = (...values: readonly unknown[]): string =>
	values.map((value) => `${JSON.stringify(value)}\n`).join("");

const ANSWER = {
	kind: "account",
	appName: "Clinique de santé",
	findings: [],
	more: 0,
	counts: { notYet: 0, never: 0, fixInHq: 0 },
	mediaChecked: true,
};

async function read(response: Response) {
	const seen: Progress[] = [];
	const end = await readBringInStream(response, (event) => {
		seen.push(event);
	});
	return { seen, end };
}

describe("readBringInStream", () => {
	it("hands on every stage and file line once, in order, across chunks that split lines, and resolves with the done line", async () => {
		const text = lines(
			{ type: "stage", stage: "connecting" },
			{ type: "stage", stage: "reading-app" },
			{ type: "stage", stage: "checking-media" },
			{ type: "files", done: 1, total: 3 },
			{ type: "files", done: 3, total: 3 },
			{ type: "stage", stage: "checking" },
			{ type: "done", answer: ANSWER },
		);
		// Cuts of one to seven bytes split lines, keys and the two-byte `é`.
		const cuts = Array.from({ length: text.length }, (_, i) => (i % 7) + 1);
		const { seen, end } = await read(responseOf(text, cuts));
		expect(seen).toEqual([
			{ type: "stage", stage: "connecting" },
			{ type: "stage", stage: "reading-app" },
			{ type: "stage", stage: "checking-media" },
			{ type: "files", done: 1, total: 3 },
			{ type: "files", done: 3, total: 3 },
			{ type: "stage", stage: "checking" },
		]);
		expect(end).toEqual({ type: "done", answer: ANSWER });
	});

	it("reads a last line that has no line break after it", async () => {
		const text = `${lines({ type: "stage", stage: "connecting" })}${JSON.stringify(
			{
				type: "done",
				answer: ANSWER,
			},
		)}`;
		const { end } = await read(responseOf(text, [5]));
		expect(end).toEqual({ type: "done", answer: ANSWER });
	});

	it("resolves failed for a failed line", async () => {
		const { seen, end } = await read(
			responseOf(
				lines({ type: "stage", stage: "connecting" }, { type: "failed" }),
				[9],
			),
		);
		expect(seen).toEqual([{ type: "stage", stage: "connecting" }]);
		expect(end).toEqual({ type: "failed" });
	});

	it("resolves lost where the body ends after a stage line", async () => {
		const { seen, end } = await read(
			responseOf(
				lines(
					{ type: "stage", stage: "connecting" },
					{ type: "stage", stage: "reading-app" },
				),
				[12],
			),
		);
		expect(seen).toHaveLength(2);
		expect(end).toEqual({ type: "lost" });
	});

	it("resolves lost where the connection breaks before the last line", async () => {
		const { end } = await read(
			responseOf(lines({ type: "stage", stage: "connecting" }), [4], {
				breakAfter: true,
			}),
		);
		expect(end).toEqual({ type: "lost" });
	});

	it("resolves lost for a line that is no JSON object of a known type, and hands on nothing after it", async () => {
		for (const bad of [
			"not json\n",
			"[1]\n",
			"null\n",
			`${JSON.stringify({ type: "progress" })}\n`,
			`${JSON.stringify({ type: "stage", stage: "uploading" })}\n`,
			`${JSON.stringify({ type: "files", done: 4, total: 3 })}\n`,
			`${JSON.stringify({ type: "files", done: -1, total: 3 })}\n`,
			`${JSON.stringify({ type: "done" })}\n`,
			`${JSON.stringify({ error: "You don't have edit access." })}\n`,
		]) {
			const { seen, end } = await read(
				responseOf(
					`${bad}${lines(
						{ type: "stage", stage: "connecting" },
						{ type: "done", answer: ANSWER },
					)}`,
					[3],
				),
			);
			expect(seen, bad).toEqual([]);
			expect(end, bad).toEqual({ type: "lost" });
		}
	});

	it("resolves lost where anything follows the last line", async () => {
		const { end } = await read(
			responseOf(
				lines({ type: "done", answer: ANSWER }, { type: "failed" }),
				[10],
			),
		);
		expect(end).toEqual({ type: "lost" });
	});

	it("resolves lost for a response with no body", async () => {
		const { end } = await read(new Response(null));
		expect(end).toEqual({ type: "lost" });
	});
});
