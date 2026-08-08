/**
 * The live-activity pulse emitter: phase announcement is immediate, repeat
 * pulses are throttled, the character count is cumulative per phase, and
 * every frame rides the versioned envelope for the session that owns it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDesignPulseEmitter,
	DESIGN_PULSE_INTERVAL_MS,
} from "@/lib/agent/build/progress";

const SESSION = "11111111-1111-4111-8111-111111111111";

interface WrittenChunk {
	type: string;
	data: unknown;
	transient?: boolean;
}

function makeWriter() {
	const chunks: WrittenChunk[] = [];
	return { chunks, write: (chunk: WrittenChunk) => chunks.push(chunk) };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createDesignPulseEmitter", () => {
	it("announces a phase immediately, throttles repeats, and accumulates chars", () => {
		const writer = makeWriter();
		const emit = createDesignPulseEmitter(writer, SESSION, () => null);

		emit("author", 100);
		expect(writer.chunks).toHaveLength(1);
		expect(writer.chunks[0]).toMatchObject({
			type: "data-design-pulse",
			transient: true,
			data: {
				eventVersion: 1,
				designSessionId: SESSION,
				data: { phase: "author", chars: 100 },
			},
		});

		// Inside the throttle window: counted, not emitted.
		emit("author", 50);
		emit("author", 50);
		expect(writer.chunks).toHaveLength(1);

		// Past the window: one pulse carrying the cumulative count.
		vi.setSystemTime(1_000_000 + DESIGN_PULSE_INTERVAL_MS);
		emit("author", 25);
		expect(writer.chunks).toHaveLength(2);
		expect(writer.chunks[1]?.data).toMatchObject({
			data: { phase: "author", chars: 225 },
		});
	});

	it("resets the count and emits immediately when the phase changes", () => {
		const writer = makeWriter();
		const emit = createDesignPulseEmitter(writer, SESSION, () => null);

		emit("author", 400);
		emit("review", 10);
		expect(writer.chunks).toHaveLength(2);
		expect(writer.chunks[1]?.data).toMatchObject({
			data: { phase: "review", chars: 10 },
		});
	});

	it("stamps the current orchestration head on each pulse", () => {
		const writer = makeWriter();
		const head = {
			revision: 3,
			eventId: "event-3",
			digest: "d".repeat(64),
			state: {
				kind: "designing",
				designSessionId: SESSION,
				sourcePackageDigest: "a".repeat(64),
			},
		} as const;
		const emit = createDesignPulseEmitter(writer, SESSION, () => head);
		emit("plan", 1);
		expect(writer.chunks[0]?.data).toMatchObject({
			orchestrationEventId: "event-3",
			orchestrationRevision: 3,
		});
	});
});
