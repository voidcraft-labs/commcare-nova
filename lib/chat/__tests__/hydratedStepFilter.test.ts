/**
 * The cold-resume window, client half: the full-log replay is filtered down
 * to the steps the client's hydrated transcript doesn't hold, keyed on the
 * stream's own `data-seed-steps` statement. Pure chunk-type mechanics — these
 * tests pin the pass/drop classes and the offset arithmetic.
 */

import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import {
	countHydratedSteps,
	createHydratedStepWindow,
	SEED_STEPS_CHUNK_TYPE,
} from "../hydratedStepFilter";

function seedChunk(steps: number): UIMessageChunk {
	return {
		type: SEED_STEPS_CHUNK_TYPE,
		data: { steps },
		transient: true,
	} as unknown as UIMessageChunk;
}

function step(n: number): UIMessageChunk[] {
	return [
		{ type: "start-step" },
		{ type: "text-start", id: `t${n}` },
		{ type: "text-delta", id: `t${n}`, delta: `step ${n}` },
		{ type: "text-end", id: `t${n}` },
		{ type: "finish-step" },
	] as UIMessageChunk[];
}

/** Drive the pure window over a chunk sequence; the TransformStream wrapper
 *  is exercised end-to-end (real transport, real route) by
 *  `transportContract.integration.test.ts`. */
function runThrough(hydratedSteps: number, chunks: UIMessageChunk[]): string[] {
	const passes = createHydratedStepWindow(hydratedSteps);
	return chunks
		.filter((chunk) => passes(chunk))
		.map((chunk) => (chunk as { type: string }).type);
}

describe("countHydratedSteps", () => {
	it("counts the trailing assistant message's step-start parts", () => {
		expect(
			countHydratedSteps([
				{ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] },
				{
					id: "a",
					role: "assistant",
					parts: [
						{ type: "step-start" },
						{ type: "text", text: "one" },
						{ type: "step-start" },
						{ type: "text", text: "two" },
					],
				},
			]),
		).toBe(2);
	});

	it("is zero for a trailing user message and for no messages", () => {
		expect(countHydratedSteps([{ id: "u", role: "user", parts: [] }])).toBe(0);
		expect(countHydratedSteps([])).toBe(0);
	});
});

describe("createHydratedStepSkipFilter", () => {
	it("passes everything when nothing is hydrated (a fresh turn's refresh)", () => {
		const out = runThrough(0, [
			seedChunk(0),
			{ type: "data-run-id", data: {}, transient: true } as UIMessageChunk,
			{ type: "start" } as UIMessageChunk,
			...step(1),
			{ type: "finish" } as UIMessageChunk,
		]);
		expect(out).toEqual([
			SEED_STEPS_CHUNK_TYPE,
			"data-run-id",
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"finish",
		]);
	});

	it("drops hydrated steps' content and passes from the first un-hydrated step", () => {
		const out = runThrough(1, [
			seedChunk(0),
			{ type: "start" } as UIMessageChunk,
			...step(1),
			...step(2),
			{ type: "finish" } as UIMessageChunk,
		]);
		expect(out).toEqual([
			SEED_STEPS_CHUNK_TYPE,
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"finish",
		]);
	});

	it("maps the transcript's step count onto the stream via the seed offset (continuation)", async () => {
		/* The client hydrated 3 steps, 2 of which predate this stream — only
		 * the stream's first step is hydrated, so its second replays. */
		const out = runThrough(3, [
			seedChunk(2),
			...step(1),
			...step(2),
			{ type: "finish" } as UIMessageChunk,
		]);
		expect(out.filter((t) => t === "start-step")).toHaveLength(1);
		expect(out).toContain("finish");
	});

	it("passes everything when the whole transcript predates the stream (an attach racing hydration)", () => {
		const out = runThrough(2, [
			seedChunk(2),
			{ type: "start" } as UIMessageChunk,
			...step(1),
		]);
		expect(out).toEqual([
			SEED_STEPS_CHUNK_TYPE,
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
		]);
	});

	it("always passes transient data chunks and terminal chunks, mid-skip included", () => {
		const out = runThrough(2, [
			seedChunk(0),
			{ type: "start" } as UIMessageChunk,
			{
				type: "data-conversation-event",
				data: {},
				transient: true,
			} as UIMessageChunk,
			...step(1),
			{ type: "data-mutations", data: {}, transient: true } as UIMessageChunk,
			{ type: "error", errorText: "boom" } as UIMessageChunk,
			{ type: "finish" } as UIMessageChunk,
		]);
		expect(out).toEqual([
			SEED_STEPS_CHUNK_TYPE,
			"data-conversation-event",
			"data-mutations",
			"error",
			"finish",
		]);
	});

	it("passes from the first step of a pre-protocol stream (no seed statement)", async () => {
		/* A stream written by a server without the seed chunk also wrote no
		 * mid-run transcript — there is no hydrated partial to collide with,
		 * so the full replay is exactly correct. */
		const out = runThrough(2, [
			{ type: "start" } as UIMessageChunk,
			...step(1),
			{ type: "finish" } as UIMessageChunk,
		]);
		expect(out).toEqual([
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"finish",
		]);
	});
});
