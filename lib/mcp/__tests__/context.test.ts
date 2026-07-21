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
 *     blueprint save; a pending `applyBlueprintChange` (which routes
 *     the cross-store saga) must hold the returned promise open.
 *   - Empty batches short-circuit without touching the writer or the
 *     saga.
 *
 * Both `recordMutations` and `recordMutationStages` now return
 * `{ events, committedDoc }` — the guarded writer's hydrated `nextDoc`.
 * The saga mock resolves `{}` (no `committedDoc`), so `saveBlueprint`
 * coalesces `result.committedDoc ?? doc` to the passed-in post-mutation
 * doc; these tests read `.events` off the result and assert the coalesced
 * `committedDoc` is that doc.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";
import type { ProgressEmitter } from "../progress";

/* Mock the saga module wholesale so no Postgres client is
 * ever needed. `vi.mock` hoists above imports, so the mock is installed
 * before `../context` resolves `@/lib/db/applyBlueprintChange`.
 * Individual tests tweak the implementation via `mockImplementationOnce`
 * as needed. */
/* The saga mock resolves a `seq`-only result (a top-level dedup-shape return:
 * no `committedDoc`), so `saveBlueprint` coalesces `result.committedDoc ?? doc`
 * to the passed post-mutation doc — the shape these tests assert on. */
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn().mockResolvedValue({ seq: 0 }),
}));

/**
 * Minimal `LogWriter` mock — only the two methods `McpContext` actually
 * touches. `as unknown as LogWriter` is the narrow cast: we assert the
 * caller-visible surface without pulling in the real writer's persistence
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

/* Reset the hoisted `applyBlueprintChange` mock between tests so
 * `mockImplementationOnce` chains in one test don't bleed into the
 * next. */
beforeEach(() => {
	vi.mocked(applyBlueprintChange).mockReset();
	vi.mocked(applyBlueprintChange).mockResolvedValue({ seq: 0 });
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
			conversionImpact: async () => ({
				totalWithValue: 0,
				uncastable: 0,
				alreadyHeld: 0,
				samples: [],
			}),
		});
		const muts: Mutation[] = [
			{ kind: "setAppName", name: "x" },
			{ kind: "setAppName", name: "y" },
		];
		const doc = mockDoc();
		const { events, committedDoc } = await ctx.recordMutations(
			muts,
			doc,
			"scaffold",
		);
		expect(events).toHaveLength(2);
		expect(events[0]?.seq).toBe(0);
		expect(events[1]?.seq).toBe(1);
		expect(events.every((e) => e.source === "mcp")).toBe(true);
		expect(events.every((e) => e.stage === "scaffold")).toBe(true);
		// The saga mock returns `{}` (no committedDoc → a top-level dedup-shape
		// return), so `saveBlueprint` coalesces to the passed post-mutation doc.
		expect(committedDoc).toBe(doc);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});

	it("awaits applyBlueprintChange before resolving", async () => {
		/* Arrange: stub applyBlueprintChange with a deferred promise so we
		 * can assert the caller's await chain blocks until we resolve it
		 * ourselves. */
		let resolveSave: () => void = () => {};
		vi.mocked(applyBlueprintChange).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveSave = () => r({ seq: 0 });
				}),
		);
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter: mockLogWriter(),
			progress: mockProgress(),
			conversionImpact: async () => ({
				totalWithValue: 0,
				uncastable: 0,
				alreadyHeld: 0,
				samples: [],
			}),
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
		expect(applyBlueprintChange).toHaveBeenCalledTimes(1);
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
			conversionImpact: async () => ({
				totalWithValue: 0,
				uncastable: 0,
				alreadyHeld: 0,
				samples: [],
			}),
		});
		const doc = mockDoc();
		const result = await ctx.recordMutations([], doc);
		expect(result.events).toEqual([]);
		// The empty-batch short-circuit surfaces the passed doc verbatim as the
		// current committed state — no save, so nothing to hydrate from.
		expect(result.committedDoc).toBe(doc);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(0);
		expect(vi.mocked(applyBlueprintChange)).not.toHaveBeenCalled();
	});

	it("recordMutationStages persists the whole sequence as ONE guarded save with per-stage tags", async () => {
		const logWriter = mockLogWriter();
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter,
			progress: mockProgress(),
			conversionImpact: async () => ({
				totalWithValue: 0,
				uncastable: 0,
				alreadyHeld: 0,
				samples: [],
			}),
		});
		const renameMut: Mutation = { kind: "setAppName", name: "renamed" };
		const patchMut: Mutation = { kind: "setAppName", name: "patched" };
		const midDoc = { ...mockDoc(), appName: "renamed" };
		const finalDoc = { ...mockDoc(), appName: "patched" };

		const { events, committedDoc } = await ctx.recordMutationStages([
			{ mutations: [renameMut], doc: midDoc, stage: "rename:0-0" },
			{ mutations: [patchMut], doc: finalDoc, stage: "edit:0-0" },
		]);

		// ONE transactional save for the whole sequence: the guard carries
		// the CONCATENATED batch (one fresh-doc re-verdict over the whole
		// edit) and the prospective snapshot is the FINAL stage's doc.
		expect(vi.mocked(applyBlueprintChange)).toHaveBeenCalledTimes(1);
		const args = vi.mocked(applyBlueprintChange).mock.calls[0]?.[0];
		expect(args?.guard?.mutations).toEqual([renameMut, patchMut]);
		expect(args?.prospective?.appName).toBe("patched");
		// One batchId + kind:'mcp' for the whole staged sequence.
		expect(args?.batchId).toEqual(expect.any(String));
		expect(args?.kind).toBe("mcp");

		// The envelopes keep each stage's own tag, in order.
		expect(events.map((e) => e.stage)).toEqual(["rename:0-0", "edit:0-0"]);
		expect(events.map((e) => e.seq)).toEqual([0, 1]);
		// The saga mock returns no `committedDoc`, so the stages path coalesces
		// to the FINAL stage's doc — what the tool continues against.
		expect(committedDoc).toBe(finalDoc);
	});

	it("recordMutationStages logs nothing when the guarded save rejects", async () => {
		vi.mocked(applyBlueprintChange).mockRejectedValueOnce(
			new Error("guarded commit rejected"),
		);
		const logWriter = mockLogWriter();
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter,
			progress: mockProgress(),
			conversionImpact: async () => ({
				totalWithValue: 0,
				uncastable: 0,
				alreadyHeld: 0,
				samples: [],
			}),
		});

		await expect(
			ctx.recordMutationStages([
				{
					mutations: [{ kind: "setAppName", name: "x" }],
					doc: mockDoc(),
					stage: "rename:0-0",
				},
			]),
		).rejects.toThrow("guarded commit rejected");

		// Persist-first/log-second: a rejected save leaves the event log
		// empty, so replay can never record a batch the blueprint refused.
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(0);
	});
});
