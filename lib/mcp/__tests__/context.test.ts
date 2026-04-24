/**
 * McpContext unit tests.
 *
 * Covers the three behaviors that distinguish this context from its
 * chat-side sibling:
 *   - Every mutation produces exactly one log-writer call, seq advances
 *     monotonically, `source: "mcp"` is stamped inline on the returned
 *     envelopes (the writer re-stamps authoritatively — that path is
 *     covered in `lib/log/__tests__`; here we only verify the in-memory
 *     shape adapters will see).
 *   - `recordMutations` is async specifically because it awaits the
 *     Firestore save; a pending `updateAppForRun` must hold the returned
 *     promise open.
 *   - Empty batches short-circuit without touching the writer or the DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateAppForRun } from "@/lib/db/apps";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";
import type { ProgressEmitter } from "../progress";

/* Mock the apps module wholesale so no Firestore client is ever needed.
 * `vi.mock` hoists above imports, so the mock is installed before
 * `../context` resolves `@/lib/db/apps`. Individual tests tweak the
 * implementation via `mockImplementationOnce` as needed. */
vi.mock("@/lib/db/apps", () => ({
	updateAppForRun: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Minimal `LogWriter` mock — only the two methods `McpContext` actually
 * touches. `as unknown as LogWriter` is the narrow cast: we assert the
 * caller-visible surface without pulling in the real writer's Firestore
 * sink / batching state.
 */
function mockLogWriter(): LogWriter {
	return {
		logEvent: vi.fn(),
		flush: vi.fn(),
	} as unknown as LogWriter;
}

/** No-op progress emitter — progress semantics are tested in progress.test.ts. */
function mockProgress(): ProgressEmitter {
	return { notify: vi.fn() };
}

/**
 * Produce a minimal valid `BlueprintDoc` for tests that only need an
 * "empty" blueprint to hand to `saveBlueprint`. Every required key from
 * `blueprintDocSchema` is populated so the `PersistableDoc` cast inside
 * `saveBlueprint` doesn't surface a TypeScript error; `fieldParent` is
 * included because the in-memory `BlueprintDoc` extends
 * `PersistableDoc` with it (it's stripped on save).
 */
function mockDoc(): BlueprintDoc {
	return {
		appId: "a",
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/* Reset the hoisted `updateAppForRun` mock between tests so `mockImplementationOnce`
 * chains in one test don't bleed into the next. */
beforeEach(() => {
	vi.mocked(updateAppForRun).mockReset();
	vi.mocked(updateAppForRun).mockResolvedValue(undefined);
});

describe("McpContext", () => {
	it("writes one log event per mutation, advances seq, stamps source=mcp", async () => {
		const logWriter = mockLogWriter();
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter,
			progress: mockProgress(),
		});
		const muts: Mutation[] = [
			{ kind: "setAppName", name: "x" },
			{ kind: "setAppName", name: "y" },
		];
		const events = await ctx.recordMutations(muts, mockDoc(), "scaffold");
		expect(events).toHaveLength(2);
		expect(events[0]?.seq).toBe(0);
		expect(events[1]?.seq).toBe(1);
		expect(events.every((e) => e.source === "mcp")).toBe(true);
		expect(events.every((e) => e.stage === "scaffold")).toBe(true);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});

	it("awaits updateAppForRun before resolving", async () => {
		/* Arrange: stub updateAppForRun with a deferred promise so we can assert
		 * the caller's await chain blocks until we resolve it ourselves. */
		let resolveSave: () => void = () => {};
		vi.mocked(updateAppForRun).mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					resolveSave = r;
				}),
		);
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter: mockLogWriter(),
			progress: mockProgress(),
		});

		let settled = false;
		const p = ctx
			.recordMutations([{ kind: "setAppName", name: "x" }], mockDoc())
			.then(() => {
				settled = true;
			});
		/* Flush microtasks + one macrotask tick — `setImmediate` drains
		 * more aggressively than `await Promise.resolve()`, which only
		 * covers a single microtask. If `recordMutations` had fired the
		 * save and-forgotten, the returned promise would have settled by
		 * the time this tick completes. */
		await new Promise((r) => setImmediate(r));
		/* Assert both facts together: the save WAS dispatched (so the
		 * writer isn't short-circuiting on some unrelated branch) AND the
		 * outer promise is still pending on it. Together these prove the
		 * fail-closed await is load-bearing. */
		expect(updateAppForRun).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		resolveSave();
		await p;
		expect(settled).toBe(true);
	});

	it("no-ops on empty mutation batch", async () => {
		const logWriter = mockLogWriter();
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter,
			progress: mockProgress(),
		});
		expect(await ctx.recordMutations([], mockDoc())).toEqual([]);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(0);
		expect(vi.mocked(updateAppForRun)).not.toHaveBeenCalled();
	});
});
