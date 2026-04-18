/**
 * Tests for the event reader. We stub Firestore reads by monkey-patching
 * `collections.events` via vitest's `vi.mock` — the alternative (spinning
 * the emulator) is heavier than the reader logic warrants. Tests cover:
 *
 *   - ordering: events return sorted by (ts, seq)
 *   - empty result: returns []
 *   - runId filter: when omitted, reader resolves the most recent run
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../types";

const mockDocs: Event[] = [];
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockGet = vi.fn();

vi.mock("@/lib/db/firestore", () => ({
	collections: {
		events: vi.fn(() => ({
			where: mockWhere,
			orderBy: mockOrderBy,
		})),
	},
}));

// Simple chainable mock implementation
beforeEach(() => {
	mockDocs.length = 0;
	mockWhere.mockImplementation(() => ({ orderBy: mockOrderBy }));
	mockOrderBy.mockImplementation(() => ({
		orderBy: mockOrderBy,
		limit: vi.fn(() => ({ get: mockGet })),
		get: mockGet,
	}));
	mockGet.mockResolvedValue({
		empty: mockDocs.length === 0,
		docs: mockDocs.map((d) => ({ data: () => d })),
	});
});

describe("readEvents", () => {
	it("returns events sorted by ts then seq", async () => {
		const events: Event[] = [
			{
				kind: "mutation",
				runId: "r",
				ts: 10,
				seq: 0,
				actor: "agent",
				mutation: { kind: "setAppName", name: "a" },
			},
			{
				kind: "mutation",
				runId: "r",
				ts: 10,
				seq: 1,
				actor: "agent",
				mutation: { kind: "setAppName", name: "b" },
			},
			{
				kind: "mutation",
				runId: "r",
				ts: 11,
				seq: 2,
				actor: "agent",
				mutation: { kind: "setAppName", name: "c" },
			},
		];
		mockDocs.push(...events);
		mockGet.mockResolvedValue({
			empty: false,
			docs: events.map((d) => ({ data: () => d })),
		});

		const { readEvents } = await import("../reader");
		const result = await readEvents("app-1", "r");

		expect(result).toEqual(events);
		expect(mockOrderBy).toHaveBeenCalledWith("ts");
		expect(mockOrderBy).toHaveBeenCalledWith("seq");
	});

	it("returns [] on empty query", async () => {
		mockGet.mockResolvedValue({ empty: true, docs: [] });
		const { readEvents } = await import("../reader");
		expect(await readEvents("app-1", "r")).toEqual([]);
	});
});

describe("readLatestRunId", () => {
	it("returns the runId of the most recent event by ts", async () => {
		mockGet.mockResolvedValue({
			empty: false,
			docs: [
				{
					data: () => ({
						kind: "mutation",
						runId: "latest",
						ts: 999,
						seq: 0,
						actor: "agent",
						mutation: { kind: "setAppName", name: "x" },
					}),
				},
			],
		});
		const { readLatestRunId } = await import("../reader");
		expect(await readLatestRunId("app-1")).toBe("latest");
	});

	it("returns null when no events exist", async () => {
		mockGet.mockResolvedValue({ empty: true, docs: [] });
		const { readLatestRunId } = await import("../reader");
		expect(await readLatestRunId("app-1")).toBeNull();
	});
});
