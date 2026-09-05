/**
 * The cold-resume window, client half: the full-log replay is filtered down
 * to the steps the client's hydrated transcript doesn't hold, keyed on the
 * message IDENTITY the replay's `start` chunk declares plus the stream's own
 * `data-seed-steps` offset. Pure chunk-type mechanics — these tests pin the
 * pass/drop classes, the identity keying, and the offset arithmetic.
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

function start(messageId?: string): UIMessageChunk {
	return {
		type: "start",
		...(messageId !== undefined ? { messageId } : {}),
	} as UIMessageChunk;
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

function assistant(id: string, steps: number): unknown {
	return {
		id,
		role: "assistant",
		parts: Array.from({ length: steps }, () => ({ type: "step-start" })),
	};
}

const user = (id: string): unknown => ({
	id,
	role: "user",
	parts: [{ type: "text", text: "hi" }],
});

/** Drive the pure window over a chunk sequence; the TransformStream wrapper
 *  is exercised end-to-end (real transport, real route) by
 *  `transportContract.postgres.test.ts`. */
function runThrough(
	messages: readonly unknown[],
	chunks: UIMessageChunk[],
): string[] {
	const passes = createHydratedStepWindow(() => messages);
	return chunks
		.filter((chunk) => passes(chunk))
		.map((chunk) => (chunk as { type: string }).type);
}

describe("countHydratedSteps", () => {
	it("counts the identified message's step-start parts wherever it sits", () => {
		const messages = [assistant("a", 2), user("u")];
		expect(countHydratedSteps(messages, "a")).toBe(2);
	});

	it("is zero for an absent id, an undefined id, and a non-assistant match", () => {
		const messages = [user("u"), assistant("a", 2)];
		expect(countHydratedSteps(messages, "missing")).toBe(0);
		expect(countHydratedSteps(messages, undefined)).toBe(0);
		expect(countHydratedSteps(messages, "u")).toBe(0);
	});
});

describe("createHydratedStepWindow", () => {
	it("passes everything when the client holds nothing of the stream's message (a fresh turn's refresh)", () => {
		const out = runThrough(
			[user("u")],
			[
				seedChunk(0),
				{ type: "data-run-id", data: {}, transient: true } as UIMessageChunk,
				start("a"),
				...step(1),
				{ type: "finish" } as UIMessageChunk,
			],
		);
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
		const out = runThrough(
			[user("u"), assistant("a", 1)],
			[
				seedChunk(0),
				start("a"),
				...step(1),
				...step(2),
				{
					type: "finish",
				} as UIMessageChunk,
			],
		);
		expect(out).toEqual([
			SEED_STEPS_CHUNK_TYPE,
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"finish",
		]);
	});

	it("maps the transcript's step count onto the stream via the seed offset (continuation)", () => {
		/* The client hydrated 3 steps of message `a`, 2 of which predate this
		 * stream — only the stream's first step is hydrated, so its second
		 * replays. */
		const out = runThrough(
			[assistant("a", 3)],
			[
				seedChunk(2),
				start("a"),
				...step(1),
				...step(2),
				{
					type: "finish",
				} as UIMessageChunk,
			],
		);
		expect(out.filter((t) => t === "start-step")).toHaveLength(1);
		expect(out).toContain("finish");
	});

	it("passes everything when the whole transcript predates the stream (an attach racing hydration)", () => {
		const out = runThrough(
			[assistant("a", 2)],
			[seedChunk(2), start("a"), ...step(1)],
		);
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

	it("windows on identity, not position: a locally appended trailing user message can't zero the count", () => {
		/* The Project-move reload seam appends a retained user text AFTER the
		 * hydrated partial. The stream still grows message `a`, and its one
		 * hydrated step must still be skipped. */
		const out = runThrough(
			[assistant("a", 1), user("retained")],
			[
				seedChunk(0),
				start("a"),
				...step(1),
				...step(2),
				{
					type: "finish",
				} as UIMessageChunk,
			],
		);
		expect(out.filter((t) => t === "start-step")).toHaveLength(1);
		expect(out.filter((t) => t === "text-delta")).toHaveLength(1);
	});

	it("windows nothing for a stream growing a message the client has never seen (a newer turn claimed in between)", () => {
		/* The client hydrated run A's partial; the GET resolved run B's fresh
		 * stream. B's opening steps must all render. */
		const out = runThrough(
			[assistant("a", 3)],
			[seedChunk(0), start("b"), ...step(1), ...step(2)],
		);
		expect(out.filter((t) => t === "start-step")).toHaveLength(2);
	});

	it("always passes transient data chunks and terminal chunks, mid-skip included", () => {
		const out = runThrough(
			[assistant("a", 2)],
			[
				seedChunk(0),
				start("a"),
				{
					type: "data-conversation-event",
					data: {},
					transient: true,
				} as UIMessageChunk,
				...step(1),
				{ type: "data-mutations", data: {}, transient: true } as UIMessageChunk,
				{ type: "error", errorText: "boom" } as UIMessageChunk,
				{ type: "finish" } as UIMessageChunk,
			],
		);
		expect(out).toEqual([
			SEED_STEPS_CHUNK_TYPE,
			"start",
			"data-conversation-event",
			"data-mutations",
			"error",
			"finish",
		]);
	});

	it("passes everything on a pre-protocol stream (no seed statement)", () => {
		/* A stream written by a server without the seed chunk also wrote no
		 * mid-run transcript — there is no hydrated partial to collide with,
		 * so the full replay is exactly correct. */
		const out = runThrough(
			[assistant("a", 2)],
			[start("a"), ...step(1), { type: "finish" } as UIMessageChunk],
		);
		expect(out).toEqual([
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"finish",
		]);
	});

	it("replays everything when the start chunk names no message (a pre-identity logged stream)", () => {
		const out = runThrough(
			[assistant("a", 2)],
			[seedChunk(0), start(), ...step(1), { type: "finish" } as UIMessageChunk],
		);
		expect(out.filter((t) => t === "start-step")).toHaveLength(1);
		expect(out).toContain("text-delta");
	});
});
