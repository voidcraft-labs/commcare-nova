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

		emit("design", 100);
		expect(writer.chunks).toHaveLength(1);
		expect(writer.chunks[0]).toMatchObject({
			type: "data-design-pulse",
			transient: true,
			data: {
				eventVersion: 1,
				designSessionId: SESSION,
				data: { phase: "design", chars: 100 },
			},
		});

		// Inside the throttle window: counted, not emitted.
		emit("design", 50);
		emit("design", 50);
		expect(writer.chunks).toHaveLength(1);

		// Past the window: one pulse carrying the cumulative count.
		vi.setSystemTime(1_000_000 + DESIGN_PULSE_INTERVAL_MS);
		emit("design", 25);
		expect(writer.chunks).toHaveLength(2);
		expect(writer.chunks[1]?.data).toMatchObject({
			data: { phase: "design", chars: 225 },
		});
	});

	it("resets the count and emits immediately when the phase changes", () => {
		const writer = makeWriter();
		const emit = createDesignPulseEmitter(writer, SESSION, () => null);

		emit("design", 400);
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
	it("announces step changes immediately, retains the step for volume, and reads the latest head", () => {
		const writer = makeWriter();
		let revision = 1;
		const emit = createDesignPulseEmitter(writer, SESSION, () => ({
			revision,
			eventId: `event-${revision}`,
			digest: "d".repeat(64),
			state: {
				kind: "designing",
				designSessionId: SESSION,
				sourcePackageDigest: "a".repeat(64),
			},
		}));
		emit("design", 3, "First step");
		vi.advanceTimersByTime(DESIGN_PULSE_INTERVAL_MS - 1);
		emit("design", 5);
		expect(writer.chunks).toHaveLength(1);
		revision = 2;
		emit("design", 7, "Second step");
		emit("design", 11, "Second step");
		vi.advanceTimersByTime(DESIGN_PULSE_INTERVAL_MS);
		emit("design", 13);
		expect(writer.chunks).toEqual([
			{
				type: "data-design-pulse",
				transient: true,
				data: {
					eventVersion: 1,
					designSessionId: SESSION,
					orchestrationEventId: "event-1",
					orchestrationRevision: 1,
					data: { phase: "design", chars: 3, step: "First step" },
				},
			},
			{
				type: "data-design-pulse",
				transient: true,
				data: {
					eventVersion: 1,
					designSessionId: SESSION,
					orchestrationEventId: "event-2",
					orchestrationRevision: 2,
					data: { phase: "design", chars: 15, step: "Second step" },
				},
			},
			{
				type: "data-design-pulse",
				transient: true,
				data: {
					eventVersion: 1,
					designSessionId: SESSION,
					orchestrationEventId: "event-2",
					orchestrationRevision: 2,
					data: { phase: "design", chars: 39, step: "Second step" },
				},
			},
		]);
		emit("review", 0);
		expect(writer.chunks.at(-1)?.data).toEqual({
			eventVersion: 1,
			designSessionId: SESSION,
			orchestrationEventId: "event-2",
			orchestrationRevision: 2,
			data: { phase: "review", chars: 0 },
		});
		vi.advanceTimersByTime(60_000);
		expect(writer.chunks).toHaveLength(4);
		expect(vi.getTimerCount()).toBe(0);
	});
});
