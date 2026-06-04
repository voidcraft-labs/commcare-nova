/**
 * Tests for the event reader. We stub Firestore reads via `vi.mock` — the
 * alternative (spinning the emulator) is heavier than the reader logic
 * warrants.
 *
 * Two mock surfaces are stubbed:
 *
 *   - `collections.events(appId)` — chainable query builder
 *     (`where` / `orderBy` / `limit` / `get`). Used by `readEvents`.
 *   - `getDb()` — raw (un-converter'd) handle, used by `readLatestRunId`
 *     to read `runId` off the newest event without the strict converter.
 *   - `docs.run(appId, runId)` — document reference with `get()`. Used by
 *     `readRunSummary`.
 *
 * Each `describe` covers the reader's contract (filters, ordering, empty
 * handling, error cases), not just the happy path — the ordering test in
 * particular asserts that `.where("runId", "==", runId)` was actually
 * passed through, so a broken reader that dropped the filter would fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummaryDoc } from "@/lib/db/types";
import type { Event } from "../types";

const mockDocs: Event[] = [];
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockGet = vi.fn();

// Per-run summary doc mock — independent chain (docs.run(...).get()).
const mockRunDocGet = vi.fn();

vi.mock("@/lib/db/firestore", () => ({
	collections: {
		events: vi.fn(() => ({
			where: mockWhere,
			orderBy: mockOrderBy,
		})),
	},
	// `readLatestRunId` reads raw (no converter): getDb().collection("apps")
	// .doc(id).collection("events").orderBy(...).limit(1).get(). The inner
	// `collection()` returns the shared `{ orderBy: mockOrderBy }` chain so
	// the orderBy → limit → get path resolves to the same `mockGet`.
	getDb: vi.fn(() => ({
		collection: vi.fn(() => ({
			doc: vi.fn(() => ({
				collection: vi.fn(() => ({ orderBy: mockOrderBy })),
			})),
		})),
	})),
	docs: {
		run: vi.fn(() => ({
			get: mockRunDocGet,
		})),
	},
}));

// Simple chainable mock implementation
beforeEach(() => {
	mockDocs.length = 0;
	mockWhere.mockReset();
	mockOrderBy.mockReset();
	mockGet.mockReset();
	mockRunDocGet.mockReset();

	// Rebuild the chain after reset so each test gets a fresh, consistent
	// stub. The `where → orderBy → orderBy → get` and
	// `orderBy → limit → get` shapes both need to resolve.
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
	/**
	 * Asserts the reader's contract, not just the mock's behavior: the
	 * runId filter must reach Firestore via `.where`, and the sort keys
	 * must reach it via two chained `.orderBy` calls. A reader that
	 * accidentally dropped `.where("runId", "==", runId)` would fetch
	 * every event in the app — this test would catch that regression.
	 */
	it("passes runId filter and ts/seq orderBy to Firestore", async () => {
		const events: Event[] = [
			{
				kind: "mutation",
				runId: "r",
				ts: 10,
				seq: 0,
				source: "chat",
				actor: "agent",
				mutation: { kind: "setAppName", name: "a" },
			},
			{
				kind: "mutation",
				runId: "r",
				ts: 10,
				seq: 1,
				source: "chat",
				actor: "agent",
				mutation: { kind: "setAppName", name: "b" },
			},
			{
				kind: "mutation",
				runId: "r",
				ts: 11,
				seq: 2,
				source: "chat",
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
		expect(mockWhere).toHaveBeenCalledWith("runId", "==", "r");
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
						source: "chat",
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

describe("decodeEventsLenient", () => {
	/**
	 * The core resilience contract: a doc whose converter `.data()` throws
	 * (forward-version payload / schema drift) is dropped and counted, while
	 * the valid docs around it still load. Before this, one bad doc aborted
	 * the entire stream read (the failure that crashed `inspect-logs` on
	 * `attachment-prep` events).
	 */
	it("drops docs whose data() throws and keeps the valid ones", async () => {
		const goodEvent: Event = {
			kind: "mutation",
			runId: "r",
			ts: 1,
			seq: 0,
			source: "chat",
			actor: "agent",
			mutation: { kind: "setAppName", name: "a" },
		};
		// QueryDocumentSnapshot is structurally just `{ data(): Event }` here.
		const goodDoc = { data: () => goodEvent };
		const badDoc = {
			data: () => {
				throw new Error("Unrecognized payload type 'attachment-prep'");
			},
		};
		const { decodeEventsLenient } = await import("../reader");
		const { events, skipped, sample } = decodeEventsLenient([
			goodDoc,
			badDoc,
			goodDoc,
			// biome-ignore lint/suspicious/noExplicitAny: structural snapshot stub
		] as any);
		expect(events).toEqual([goodEvent, goodEvent]);
		expect(skipped).toBe(1);
		expect(sample).toContain("attachment-prep");
	});
});

describe("readRunSummary", () => {
	/**
	 * Minimal-but-complete `RunSummaryDoc` fixture. Every required field is
	 * present so this doubles as a schema-shape smoke test if the type
	 * evolves — a future required field would show up as a TS error here.
	 */
	const fixture: RunSummaryDoc = {
		runId: "r-1",
		startedAt: "2026-04-18T00:00:00Z",
		finishedAt: "2026-04-18T00:01:00Z",
		promptMode: "build",
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
		stepCount: 3,
		model: "claude-opus-4-7",
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 800,
		cacheWriteTokens: 100,
		costEstimate: 0.0125,
		toolCallCount: 2,
	};

	it("returns the parsed RunSummaryDoc when the doc exists", async () => {
		mockRunDocGet.mockResolvedValue({
			exists: true,
			data: () => fixture,
		});
		const { readRunSummary } = await import("../reader");
		expect(await readRunSummary("app-1", "r-1")).toEqual(fixture);
	});

	it("returns null when the doc doesn't exist", async () => {
		mockRunDocGet.mockResolvedValue({
			exists: false,
			data: () => undefined,
		});
		const { readRunSummary } = await import("../reader");
		expect(await readRunSummary("app-1", "r-1")).toBeNull();
	});

	/**
	 * Contract guard: if Firestore ever violates `exists=true → data()
	 * returns a parsed doc`, the reader must throw rather than silently
	 * coerce to `null`. Silent coercion would mask a converter regression
	 * and produce misleading "no summary" states in admin tooling.
	 */
	it("throws when exists=true but data() returns undefined", async () => {
		mockRunDocGet.mockResolvedValue({
			exists: true,
			data: () => undefined,
		});
		const { readRunSummary } = await import("../reader");
		await expect(readRunSummary("app-1", "r-1")).rejects.toThrow(
			/converter contract violated/,
		);
	});
});
