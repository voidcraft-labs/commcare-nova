/**
 * Reconciler state-machine tests.
 *
 * The reconciler is a headless state machine (every side effect is injected),
 * so these tests drive it against a real BlueprintDoc store with FAKE deps —
 * no network, no timers, no React. They assert the load-bearing invariant
 * (`displayed === fold(confirmedDoc, [...sentPending, humanUncommitted])`) and
 * the echo / remote / gap / reload / 409-loop / two-tab / bootstrap / data-done
 * paths across orderings.
 *
 * Per repo convention (UI is `f(state)`; test the state MODEL, never DOM),
 * there are no RTL/jsdom component tests here — the reconciler is designed to be
 * exercised purely as a state machine, which is exactly what this file does.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReconciler,
	type MutationFrame,
	type PutOutcome,
	type Reconciler,
	type ReconcilerDeps,
	type SaveSignal,
} from "@/lib/collab/reconciler";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import {
	type BuilderSessionStoreApi,
	createBuilderSessionStore,
} from "@/lib/session/store";

// ── Fixtures ─────────────────────────────────────────────────────────────

const MOD = asUuid("mod-1");
const FORM = asUuid("form-1");
const F_A = asUuid("field-a");
const F_B = asUuid("field-b");

/** A doc with one module, one form, two text fields — enough surface for
 *  scalar (`setAppName`) and structural (field label / reorder) merges. */
function makeDoc(appName = "App"): BlueprintDoc {
	return {
		appId: "app-1",
		appName,
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD]: { uuid: MOD, id: "m", name: "Module" },
		},
		forms: {
			[FORM]: { uuid: FORM, id: "f", name: "Form", moduleUuid: MOD },
		},
		fields: {
			[F_A]: {
				uuid: F_A,
				id: "a",
				kind: "text",
				label: "A",
				formUuid: FORM,
			},
			[F_B]: {
				uuid: F_B,
				id: "b",
				kind: "text",
				label: "B",
				formUuid: FORM,
			},
		},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [F_A, F_B] },
		fieldParent: { [F_A]: null, [F_B]: null },
	} as unknown as BlueprintDoc;
}

/** A frame carrying an autosave-kind (no runId) batch from `actorId`. */
function autosaveFrame(
	seq: number,
	batchId: string,
	actorId: string,
	mutations: Mutation[],
): MutationFrame {
	return { seq, batchId, actorId, kind: "autosave", mutations };
}

/** A frame carrying a chat-kind (with runId) batch from `actorId`. */
function chatFrame(
	seq: number,
	batchId: string,
	actorId: string,
	runId: string,
	mutations: Mutation[],
): MutationFrame {
	return { seq, batchId, actorId, kind: "chat", runId, mutations };
}

// ── Fake deps harness ──────────────────────────────────────────────────────

interface Harness {
	reconciler: Reconciler;
	docStore: BlueprintDocStoreApi;
	sessionApi: BuilderSessionStoreApi;
	/** Every PUT the reconciler dispatched, in order. */
	puts: Array<{ batchId: string; mutations: Mutation[] }>;
	/** Resolve the Nth pending PUT with a 200 at `seq` (or a failure). */
	resolvePut: (index: number, outcome: PutOutcome) => Promise<void>;
	/** Fire the pending retry callback (the reconciler scheduled one). Returns
	 *  a promise so awaiting it lets any reload the tick kicked off settle. */
	runScheduledRetry: () => Promise<void>;
	/** Whether a retry tick is currently scheduled. */
	hasScheduledRetry: () => boolean;
	/** Reload responses the AUTO-resolve `reload` fake returns, FIFO. */
	reloadQueue: Array<{ blueprint: BlueprintDoc; seq: number }>;
	reloadCalls: number;
	resubscribeCursors: number[];
	/** Every `onSaveError` detail the reconciler reported. */
	saveErrors: string[];
	/** MANUAL reload mode: when enabled, `reload()` returns a pending promise the
	 *  test resolves with `resolveReload` / `failReload` — so a frame/dispose can
	 *  land WHILE the reload GET is in flight. */
	enableManualReload: () => void;
	resolveReload: (doc: {
		blueprint: BlueprintDoc;
		seq: number;
	}) => Promise<void>;
	failReload: (err?: Error) => Promise<void>;
	/** Number of manual reload GETs currently awaiting resolution. */
	pendingReloads: () => number;
	/** Settle every still-pending PUT / reload promise + dispose the reconciler
	 *  so no promise leaks past the test (the async-leak detector flags a pending
	 *  promise). Called from `afterEach`. */
	settle: () => void;
}

/** Live harnesses this test-run created — drained in `afterEach` so no pending
 *  fake-dep promise leaks. */
const liveHarnesses = new Set<Harness>();

/** Build a reconciler wired to fake, manually-driven deps. */
function makeHarness(init: {
	appId?: string;
	baseSeq: number;
	baseDoc: BlueprintDoc;
	userId: string;
}): Harness {
	const docStore = createBlueprintDocStore();
	// Seed the store with the base doc and start tracking (live-builder depth 0).
	docStore.getState().load(toPersistableDoc(init.baseDoc));
	docStore.getState().startTracking();
	const sessionApi = createBuilderSessionStore();
	// The reconciler is seeded with the HYDRATED store doc (order keys backfilled),
	// exactly as the provider does (`baseDoc: docStore.getState()`), so the
	// reconciler's confirmedDoc and the store's displayed doc agree on order keys.
	const seededInit = { ...init, baseDoc: docStore.getState() };

	const puts: Harness["puts"] = [];
	const pendingResolvers: Array<(o: PutOutcome) => void> = [];
	let retryCb: (() => void) | undefined;
	const reloadQueue: Harness["reloadQueue"] = [];
	const resubscribeCursors: number[] = [];
	const saveErrors: string[] = [];
	const state = { reloadCalls: 0, manual: false };
	/** Manual-mode reload resolvers/rejecters, FIFO. */
	const reloadResolvers: Array<{
		resolve: (
			d: ReturnType<ReconcilerDeps["reload"]> extends Promise<infer R>
				? R
				: never,
		) => void;
		reject: (e: Error) => void;
	}> = [];

	const deps: ReconcilerDeps = {
		put: (batchId, mutations) => {
			puts.push({ batchId, mutations });
			return new Promise<PutOutcome>((resolve) => {
				pendingResolvers.push(resolve);
			});
		},
		reload: () => {
			state.reloadCalls += 1;
			if (state.manual) {
				return new Promise((resolve, reject) => {
					reloadResolvers.push({ resolve, reject });
				});
			}
			const next = reloadQueue.shift();
			if (!next) return Promise.reject(new Error("reloadQueue empty"));
			return Promise.resolve({
				blueprint: toPersistableDoc(next.blueprint),
				seq: next.seq,
			});
		},
		resubscribe: (cursor) => resubscribeCursors.push(cursor),
		scheduleRetry: (_attempt, run) => {
			retryCb = run;
			return () => {
				retryCb = undefined;
			};
		},
		onSaveError: (detail) => saveErrors.push(detail),
	};

	const reconciler = createReconciler(docStore, sessionApi, seededInit, deps);

	async function flush(): Promise<void> {
		// Drain the microtask queue so awaited `sendBatch` / `runReload`
		// continuations settle before the test asserts.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	return {
		reconciler,
		docStore,
		sessionApi,
		puts,
		resolvePut: async (index, outcome) => {
			const resolve = pendingResolvers[index];
			if (!resolve) throw new Error(`no pending PUT at ${index}`);
			resolve(outcome);
			await flush();
		},
		runScheduledRetry: async () => {
			const cb = retryCb;
			retryCb = undefined;
			cb?.();
			await flush();
		},
		hasScheduledRetry: () => retryCb !== undefined,
		get reloadQueue() {
			return reloadQueue;
		},
		get reloadCalls() {
			return state.reloadCalls;
		},
		resubscribeCursors,
		saveErrors,
		enableManualReload: () => {
			state.manual = true;
		},
		resolveReload: async (doc) => {
			const r = reloadResolvers.shift();
			if (!r) throw new Error("no pending reload");
			r.resolve({ blueprint: toPersistableDoc(doc.blueprint), seq: doc.seq });
			await flush();
		},
		failReload: async (err = new Error("reload GET failed")) => {
			const r = reloadResolvers.shift();
			if (!r) throw new Error("no pending reload");
			r.reject(err);
			await flush();
		},
		pendingReloads: () => reloadResolvers.length,
		settle: () => {
			// Dispose first so the reconciler ignores the late resolutions
			// (`inert()`), then drain every pending fake-dep promise so none leaks.
			reconciler.dispose();
			for (const resolve of pendingResolvers.splice(0)) {
				resolve({ ok: false, kind: "network" });
			}
			for (const r of reloadResolvers.splice(0)) {
				r.reject(new Error("harness torn down"));
			}
		},
	};
}

/** Build a harness and register it for `afterEach` teardown. */
function harness(init: {
	appId?: string;
	baseSeq: number;
	baseDoc: BlueprintDoc;
	userId: string;
}): Harness {
	const h = makeHarness(init);
	liveHarnesses.add(h);
	return h;
}

/** Apply a batch to a doc off-store (for building expected values). Returns a
 *  clean `PersistableDoc` (store-only action keys + derived fields stripped). */
function fold(doc: BlueprintDoc, batches: Mutation[][]): BlueprintDoc {
	// Reuse the reducer's own fold semantics via a throwaway store so we never
	// mutate `doc`.
	const tmp = createBlueprintDocStore();
	tmp.getState().load(toPersistableDoc(doc));
	for (const b of batches) if (b.length) tmp.getState().applyMany(b);
	return docData(tmp.getState());
}

/** The comparable doc-data of a store state / working doc: `toPersistableDoc`
 *  drops `fieldParent`/`refIndex`; this also drops the store-only action
 *  closures + `remoteFrameApplyInProgress` so two folds compare cleanly. */
function docData(doc: BlueprintDoc): BlueprintDoc {
	const persistable = toPersistableDoc(doc) as unknown as Record<
		string,
		unknown
	>;
	const clean: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(persistable)) {
		if (typeof v === "function") continue;
		if (k === "remoteFrameApplyInProgress") continue;
		clean[k] = v;
	}
	return clean as unknown as BlueprintDoc;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("reconciler", () => {
	afterEach(() => {
		// Settle every harness's outstanding fake-dep promises + dispose its
		// reconciler so nothing leaks past the test (the async-leak detector flags
		// a pending promise). A test that deliberately leaves a PUT/reload pending
		// (to assert an in-flight state) relies on this teardown.
		for (const h of liveHarnesses) h.settle();
		liveHarnesses.clear();
		vi.clearAllTimers();
	});

	// ── Dispatch + echo ─────────────────────────────────────────────────
	describe("dispatch + echo", () => {
		it("registers a batch on dispatch and echoes it back without double-apply", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 5,
				baseDoc: base,
				userId: "u1",
			});
			// A human edit lands in the store.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Edited" }]);
			const batchId = h.reconciler.dispatchHumanBatch();
			expect(batchId).toBeDefined();
			expect(h.puts).toHaveLength(1);
			expect(h.puts[0].mutations).toEqual([
				{ kind: "setAppName", name: "Edited" },
			]);
			const snap = h.reconciler.getSnapshot();
			expect(snap.sentPending).toHaveLength(1);
			expect(snap.awaitingEcho.has(batchId as string)).toBe(true);

			// 200 records the seq but does NOT advance confirmedDoc.
			await h.resolvePut(0, { ok: true, seq: 6 });
			expect(h.reconciler.getSnapshot().baseSeq).toBe(5);
			expect(h.reconciler.getSnapshot().sentPending[0].ackedSeq).toBe(6);

			// The echo frame advances confirmedDoc + drops the batch, no double-apply.
			h.reconciler.onFrame(
				autosaveFrame(6, batchId as string, "u1", [
					{ kind: "setAppName", name: "Edited" },
				]),
			);
			const after = h.reconciler.getSnapshot();
			expect(after.baseSeq).toBe(6);
			expect(after.sentPending).toHaveLength(0);
			expect(after.confirmedDoc.appName).toBe("Edited");
			// Displayed unchanged (no double-apply).
			expect(h.docStore.getState().appName).toBe("Edited");
		});

		it("no dispatch for an empty delta", () => {
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: makeDoc("Same"),
				userId: "u1",
			});
			expect(h.reconciler.dispatchHumanBatch()).toBeUndefined();
			expect(h.puts).toHaveLength(0);
		});
	});

	// ── Stale / gap frames ──────────────────────────────────────────────
	describe("inbound frame ordering", () => {
		it("drops a stale seq <= baseSeq frame (no reload, no apply)", () => {
			const h = harness({
				appId: "app-1",
				baseSeq: 10,
				baseDoc: makeDoc("Base"),
				userId: "u1",
			});
			h.reconciler.onFrame(
				autosaveFrame(10, "old-batch", "peer", [
					{ kind: "setAppName", name: "Stale" },
				]),
			);
			expect(h.reconciler.getSnapshot().baseSeq).toBe(10);
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe("Base");
			expect(h.reloadCalls).toBe(0);
		});

		it("treats seq > baseSeq + 1 as a gap → reload", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			const reloaded = makeDoc("Reloaded");
			h.reloadQueue.push({ blueprint: reloaded, seq: 4 });
			h.reconciler.onFrame(
				autosaveFrame(4, "far-batch", "peer", [
					{ kind: "setAppName", name: "Far" },
				]),
			);
			// Reload runs (no PUT in flight).
			await Promise.resolve();
			await Promise.resolve();
			expect(h.reloadCalls).toBe(1);
			expect(h.reconciler.getSnapshot().baseSeq).toBe(4);
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe("Reloaded");
			expect(h.resubscribeCursors).toEqual([4]);
		});
	});

	// ── Remote merge ────────────────────────────────────────────────────
	describe("remote frame", () => {
		it("a disjoint remote batch advances confirmed + re-folds pending, keeping the human edit", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 3,
				baseDoc: base,
				userId: "u1",
			});
			// A local human edit renames field A's label; PUT in flight.
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "A2" },
				},
			]);
			const batchId = h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: true, seq: 4 });

			// A peer edits field B's label — disjoint. Arrives as a remote frame.
			h.reconciler.onFrame(
				autosaveFrame(4, "peer-batch", "u2", [
					{
						kind: "updateField",
						uuid: F_B,
						targetKind: "text",
						patch: { label: "B2" },
					},
				]),
			);
			const snap = h.reconciler.getSnapshot();
			// confirmed advanced with the peer's change.
			expect(snap.baseSeq).toBe(4);
			expect((snap.confirmedDoc.fields[F_B] as { label: string }).label).toBe(
				"B2",
			);
			// The human edit to A is still pending (not yet echoed).
			expect(snap.sentPending).toHaveLength(1);
			// Displayed shows BOTH — the merge.
			const displayed = h.docStore.getState();
			expect((displayed.fields[F_A] as { label: string }).label).toBe("A2");
			expect((displayed.fields[F_B] as { label: string }).label).toBe("B2");
			expect(batchId).toBeDefined();
		});

		it("folds a remote batch through the undo stack so an undo target keeps the peer's change", () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// A local edit to field A — recorded as an undo entry (tracking is live).
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "A-local" },
				},
			]);
			expect(h.docStore.temporal.getState().pastStates.length).toBeGreaterThan(
				0,
			);
			// A peer edits field B — a remote frame; `rebaseHistory` must fold it
			// through the undo stack so an undo doesn't snap the peer's change out.
			h.reconciler.onFrame(
				autosaveFrame(1, "peer", "u2", [
					{
						kind: "updateField",
						uuid: F_B,
						targetKind: "text",
						patch: { label: "B-peer" },
					},
				]),
			);
			// Undo the local A edit. The restored state must still carry B-peer.
			h.docStore.temporal.getState().undo();
			const afterUndo = h.docStore.getState();
			expect((afterUndo.fields[F_A] as { label: string }).label).toBe("A");
			expect((afterUndo.fields[F_B] as { label: string }).label).toBe("B-peer");
		});
	});

	// ── Two-tab / echo classification ───────────────────────────────────
	describe("echo vs remote classification", () => {
		it("a runId-less frame from another tab of the SAME user is REMOTE, not a self-echo", () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// A peer TAB of the same user (u1) autosaves — actorId is u1 but NO runId,
			// and its batchId is NOT in this tab's awaitingEcho.
			h.reconciler.onFrame(
				autosaveFrame(1, "other-tab-batch", "u1", [
					{ kind: "setAppName", name: "FromOtherTab" },
				]),
			);
			// It advanced confirmed as a REMOTE change (applied to the doc).
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe(
				"FromOtherTab",
			);
			expect(h.docStore.getState().appName).toBe("FromOtherTab");
		});

		it("a chat frame with this tab's actorId + active runId is a self-echo", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.reconciler.setSelfActiveRunId("run-1");
			// Register a chat batch (server committed it) as the SA would via the
			// data-mutations handler.
			h.reconciler.registerChatBatch({
				batchId: "chat-batch",
				runId: "run-1",
				mutations: [{ kind: "setAppName", name: "SAEdit" }],
				seq: 1,
			});
			// Apply it to the store like the dispatcher does.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "SAEdit" }]);

			// The echo arrives with actorId=self, runId=selfActiveRunId → echo, drops.
			h.reconciler.onFrame(
				chatFrame(1, "chat-batch", "u1", "run-1", [
					{ kind: "setAppName", name: "SAEdit" },
				]),
			);
			const snap = h.reconciler.getSnapshot();
			expect(snap.baseSeq).toBe(1);
			expect(snap.sentPending).toHaveLength(0);
			expect(snap.confirmedDoc.appName).toBe("SAEdit");
		});

		it("an MCP frame carrying this tab's actorId + run id is REMOTE (rebases undo), never an echo", () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// A chat run set the tab's active run id and ENDED without clearing it
			// (or a frame races the clear). MCP's deriveRunId CONTINUES the app's
			// stored run_id in a sliding window, so a same-user MCP edit arrives
			// with actorId=self AND runId=selfActiveRunId — but kind "mcp".
			h.reconciler.setSelfActiveRunId("run-1");
			// A local edit — recorded as an undo entry (tracking is live).
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "A-local" },
				},
			]);
			// The MCP frame must take the REMOTE branch: its mutations were never
			// applied to this tab's store, and the undo stack must absorb them.
			h.reconciler.onFrame({
				seq: 1,
				batchId: "mcp-batch",
				actorId: "u1",
				runId: "run-1",
				kind: "mcp",
				mutations: [
					{
						kind: "updateField",
						uuid: F_B,
						targetKind: "text",
						patch: { label: "B-mcp" },
					},
				],
			});
			expect(
				(h.docStore.getState().fields[F_B] as { label: string }).label,
			).toBe("B-mcp");
			// Undo the local A edit — the restored state must still carry the MCP
			// change (an echo-classification would have skipped the rebase, and
			// this undo would silently revert the committed MCP edit).
			h.docStore.temporal.getState().undo();
			const afterUndo = h.docStore.getState();
			expect((afterUndo.fields[F_A] as { label: string }).label).toBe("A");
			expect((afterUndo.fields[F_B] as { label: string }).label).toBe("B-mcp");
		});
	});

	// ── Chat-batch registration ordering ────────────────────────────────
	describe("registerChatBatch echo-vs-register ordering", () => {
		const NEW_MOD = asUuid("mod-new");
		const addModuleBatch: Mutation[] = [
			{
				kind: "addModule",
				module: { uuid: NEW_MOD, id: "m2", name: "Added" } as never,
			},
		];

		// The common ordering: the chat chunk registers the batch, THEN its echo
		// arrives and drops it. No duplication — the guardrail must not disturb this.
		it("register-BEFORE-echo (the common case) drops the batch on echo, no duplicate", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.reconciler.setSelfActiveRunId("run-1");
			// data-mutations lands first: register + apply to the store (as the
			// dispatcher does). The batch is NOT yet confirmed, so the dispatcher
			// must applyMany (alreadyConfirmed === false).
			const reg = h.reconciler.registerChatBatch({
				batchId: "chat-1",
				runId: "run-1",
				mutations: addModuleBatch,
				seq: 1,
			});
			expect(reg.alreadyConfirmed).toBe(false);
			h.docStore.getState().applyMany(addModuleBatch);
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(1);

			// Then the echo arrives (actorId=self, runId=active) → drops the batch.
			h.reconciler.onFrame(
				chatFrame(1, "chat-1", "u1", "run-1", addModuleBatch),
			);

			const snap = h.reconciler.getSnapshot();
			expect(snap.baseSeq).toBe(1);
			expect(snap.sentPending).toHaveLength(0);
			// The module appears EXACTLY once in the confirmed order array, and
			// localBase (confirmed ⊕ the now-empty pending) carries no re-fold.
			expect(snap.confirmedDoc.moduleOrder).toEqual([MOD, NEW_MOD]);
			expect(h.reconciler.localBase().moduleOrder).toEqual([MOD, NEW_MOD]);
		});

		// The race: the echo frame beats the `data-mutations` chunk (two independent
		// transports — the commit writes Firestore → /stream echo BEFORE the chat
		// chunk is written). The echo applies the batch to confirmedDoc and advances
		// baseSeq; the late registration must NOT re-register (its seq is already
		// confirmed) or the non-dedup addModule reducer splices the uuid TWICE.
		it("echo-BEFORE-register drops the stale registration — the uuid is not duplicated", () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.reconciler.setSelfActiveRunId("run-1");

			// The echo lands FIRST — classified as an echo (actorId=self + active
			// runId) even though the batch isn't registered yet. applyEcho folds the
			// addModule into confirmedDoc and advances baseSeq to 1; dropBatch no-ops
			// (nothing registered).
			h.reconciler.onFrame(
				chatFrame(1, "chat-1", "u1", "run-1", addModuleBatch),
			);
			expect(h.reconciler.getSnapshot().baseSeq).toBe(1);
			expect(h.reconciler.getSnapshot().confirmedDoc.moduleOrder).toEqual([
				MOD,
				NEW_MOD,
			]);

			// NOW the late data-mutations chunk registers the same batch at seq 1.
			// Its seq (1) <= baseSeq (1) → the batch is already in confirmedDoc, so
			// the guard MUST drop it rather than push it into sentPending (a re-fold
			// would splice NEW_MOD into moduleOrder a SECOND time), and it reports
			// `alreadyConfirmed` so the dispatcher skips its store applyMany too.
			const reg = h.reconciler.registerChatBatch({
				batchId: "chat-1",
				runId: "run-1",
				mutations: addModuleBatch,
				seq: 1,
			});
			expect(reg.alreadyConfirmed).toBe(true);

			const snap = h.reconciler.getSnapshot();
			// Nothing re-registered — no double-apply.
			expect(snap.sentPending).toHaveLength(0);
			expect(snap.awaitingEcho.has("chat-1")).toBe(false);
			// The module appears EXACTLY once — without the guard the late
			// registration re-folds the addModule and moduleOrder becomes
			// [MOD, NEW_MOD, NEW_MOD] (the non-dedup splice), duplicating the entity.
			expect(snap.confirmedDoc.moduleOrder).toEqual([MOD, NEW_MOD]);
			// localBase carries no re-fold (empty pending), so it too holds one module.
			expect(h.reconciler.localBase().moduleOrder).toEqual([MOD, NEW_MOD]);
		});
	});

	// ── 409 loop protection ─────────────────────────────────────────────
	describe("409 conflict", () => {
		it("drops the rejected batchId on reload so it is not re-sent (no infinite loop)", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 2,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore
				.getState()
				.applyMany([{ kind: "setAppName", name: "Conflicting" }]);
			const batchId = h.reconciler.dispatchHumanBatch();
			expect(batchId).toBeDefined();

			// The reload the 409 triggers returns fresh state at seq 3.
			h.reloadQueue.push({ blueprint: makeDoc("ServerWins"), seq: 3 });
			await h.resolvePut(0, { ok: false, kind: "conflict" });
			// Let the deferred reload run.
			await Promise.resolve();
			await Promise.resolve();

			const snap = h.reconciler.getSnapshot();
			expect(snap.baseSeq).toBe(3);
			// The rejected batch is GONE from sentPending — not re-folded, not re-sent.
			expect(snap.sentPending).toHaveLength(0);
			expect(snap.awaitingEcho.has(batchId as string)).toBe(false);
			// Confirmed is the server's version; no extra PUT was issued.
			expect(snap.confirmedDoc.appName).toBe("ServerWins");
			expect(h.puts).toHaveLength(1); // only the original, never re-sent
		});
	});

	// ── Reload drop rules ───────────────────────────────────────────────
	describe("reload reconciliation", () => {
		it("drops batches acked <= M and re-folds the un-acked ones", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 5,
				baseDoc: base,
				userId: "u1",
			});
			// Batch 1: acked at seq 6 (will be <= M).
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "A6" },
				},
			]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: true, seq: 6 });
			// Batch 2: acked at seq 8 (will be > M) — must survive the reload.
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_B,
					targetKind: "text",
					patch: { label: "B8" },
				},
			]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(1, { ok: true, seq: 8 });

			// A reload at M=7 arrives (a retention sentinel). Fresh doc has A6 folded
			// (acked <=7) but not B8.
			const reloaded = fold(base, [
				[
					{
						kind: "updateField",
						uuid: F_A,
						targetKind: "text",
						patch: { label: "A6" },
					},
				],
			]);
			h.reloadQueue.push({ blueprint: reloaded, seq: 7 });
			h.reconciler.onReloadEvent();
			await Promise.resolve();
			await Promise.resolve();

			const snap = h.reconciler.getSnapshot();
			expect(snap.baseSeq).toBe(7);
			// Batch 1 (acked 6 <= 7) dropped; batch 2 (acked 8 > 7) kept.
			expect(snap.sentPending).toHaveLength(1);
			expect(snap.sentPending[0].ackedSeq).toBe(8);
			// Displayed carries the reloaded A6 AND the still-pending B8.
			const displayed = h.docStore.getState();
			expect((displayed.fields[F_A] as { label: string }).label).toBe("A6");
			expect((displayed.fields[F_B] as { label: string }).label).toBe("B8");
		});

		it("defers a reload until no PUT is in flight", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore
				.getState()
				.applyMany([{ kind: "setAppName", name: "Pending" }]);
			h.reconciler.dispatchHumanBatch();
			// A reload event arrives WHILE the PUT is still un-resolved.
			h.reloadQueue.push({ blueprint: makeDoc("Fresh"), seq: 2 });
			h.reconciler.onReloadEvent();
			await Promise.resolve();
			// The reload is deferred — putsInFlight > 0.
			expect(h.reloadCalls).toBe(0);
			expect(h.reconciler.getSnapshot().reloadPending).toBe(true);

			// The PUT resolves → the deferred reload now runs.
			await h.resolvePut(0, { ok: true, seq: 2 });
			await Promise.resolve();
			await Promise.resolve();
			expect(h.reloadCalls).toBe(1);
		});
	});

	// ── Retry loop (network failure) ────────────────────────────────────
	describe("network-failure retry loop", () => {
		it("re-sends an un-acked batch via the retry loop until its echo arrives", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Retry" }]);
			const batchId = h.reconciler.dispatchHumanBatch();
			// The first PUT fails with a network error.
			await h.resolvePut(0, { ok: false, kind: "network" });
			// The batch stays in sentPending; a retry is scheduled.
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(1);

			// Fire the retry — it re-PUTs the SAME batchId (idempotent via batchDedup).
			await h.runScheduledRetry();
			expect(h.puts).toHaveLength(2);
			expect(h.puts[1].batchId).toBe(batchId);
			// This time the PUT succeeds.
			await h.resolvePut(1, { ok: true, seq: 1 });
			// The echo drops the batch and no further retry is scheduled.
			h.reconciler.onFrame(
				autosaveFrame(1, batchId as string, "u1", [
					{ kind: "setAppName", name: "Retry" },
				]),
			);
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(0);
			await h.runScheduledRetry(); // no-op — nothing scheduled
			expect(h.puts).toHaveLength(2);
		});
	});

	// ── Recovery-path hardening (reload/retry/dispose) ────
	describe("recovery-path hardening", () => {
		// [1] — a failed reload GET with NO pending batch must recover on the
		// retry tick (there is nothing to re-send, so the tick must re-attempt
		// the reload itself; otherwise a quiet tab is frozen at a stale baseSeq).
		it("[1] a failed reload GET with no pending batch recovers on the retry tick", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			// A gap frame with no local edit → reload. The GET fails.
			h.reconciler.onFrame(
				autosaveFrame(5, "peer", "u2", [{ kind: "setAppName", name: "Far" }]),
			);
			expect(h.pendingReloads()).toBe(1);
			await h.failReload();
			// No un-acked batch exists, but the reload re-armed + scheduled a tick.
			expect(h.reconciler.getSnapshot().reloadPending).toBe(true);
			expect(h.hasScheduledRetry()).toBe(true);

			// The retry tick re-attempts the reload (NOT just a batch re-send).
			await h.runScheduledRetry();
			expect(h.pendingReloads()).toBe(1);
			await h.resolveReload({ blueprint: makeDoc("Recovered"), seq: 5 });
			expect(h.reconciler.getSnapshot().baseSeq).toBe(5);
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe("Recovered");
			expect(h.saveErrors.length).toBeGreaterThan(0); // [7] outage reported
		});

		// [2] — a reload deferred behind an in-flight PUT runs when that PUT
		// FAILS (not only when it 200s).
		it("[2] a deferred reload runs when its blocking PUT fails (network)", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore
				.getState()
				.applyMany([{ kind: "setAppName", name: "Pending" }]);
			h.reconciler.dispatchHumanBatch();
			// A reload event arrives WHILE the PUT is un-resolved → deferred.
			h.reloadQueue.push({ blueprint: makeDoc("Fresh"), seq: 2 });
			h.reconciler.onReloadEvent();
			expect(h.reloadCalls).toBe(0);
			expect(h.reconciler.getSnapshot().reloadPending).toBe(true);

			// The PUT FAILS (network) — the deferred reload must still run now that
			// no PUT is in flight, not wait for a later re-send to 200.
			await h.resolvePut(0, { ok: false, kind: "network" });
			expect(h.reloadCalls).toBe(1);
			expect(h.reconciler.getSnapshot().baseSeq).toBe(2);
		});

		// [3] — dispose() during an in-flight reload makes the resolution a
		// no-op: no resubscribe (a leaked EventSource), no store write.
		it("[3] dispose() during an in-flight reload is a no-op (no resubscribe)", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			h.reconciler.onFrame(
				autosaveFrame(5, "peer", "u2", [{ kind: "setAppName", name: "X" }]),
			);
			expect(h.pendingReloads()).toBe(1);
			// Unmount while the reload GET is still awaiting.
			h.reconciler.dispose();
			expect(h.reconciler.getSnapshot().disposed).toBe(true);
			// The GET resolves AFTER dispose — must not resubscribe or advance base.
			await h.resolveReload({ blueprint: makeDoc("Late"), seq: 5 });
			expect(h.resubscribeCursors).toEqual([]);
			expect(h.reconciler.getSnapshot().baseSeq).toBe(1);
		});

		// [4] — two overlapping reload triggers run EXACTLY ONE reload at a time
		// and the 409's rejectedBatchId survives the coalesce.
		it("[4] overlapping reload triggers coalesce into one reload; rejected batch stays dropped", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 2,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			// A local edit that will 409 (its batchId must be dropped on reload).
			h.docStore
				.getState()
				.applyMany([{ kind: "setAppName", name: "Conflicting" }]);
			const rejected = h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "conflict" });
			// The 409 kicked off a reload (manual — pending).
			expect(h.pendingReloads()).toBe(1);
			expect(h.reconciler.getSnapshot().reloadInFlight).toBe(true);

			// A SECOND reload trigger (a retention sentinel — bypasses `onFrame`'s
			// own guard and hits `maybeRunDeferredReload` directly) arrives
			// mid-reload. The coalesce guard must NOT start a second concurrent
			// reload — that would double-resubscribe + clear `rejectedBatchId` out
			// from under the first, weakening the 409-loop break.
			h.reconciler.onReloadEvent();
			expect(h.pendingReloads()).toBe(1); // still exactly one

			// The first reload resolves at seq 4; the coalesced follow-up runs once.
			await h.resolveReload({ blueprint: makeDoc("ServerWins"), seq: 4 });
			// The rejected batch was dropped (not re-sent into a fresh 409).
			const snap = h.reconciler.getSnapshot();
			expect(snap.sentPending.some((b) => b.batchId === rejected)).toBe(false);
			expect(h.puts).toHaveLength(1); // the rejected batch never re-sent
			// Exactly one follow-up reload runs for the coalesced re-arm.
			expect(h.pendingReloads()).toBe(1);
			await h.resolveReload({ blueprint: makeDoc("Latest"), seq: 4 });
			expect(h.reconciler.getSnapshot().baseSeq).toBe(4);
		});

		// [5] — a CONTIGUOUS frame arriving DURING the reload GET isn't applied
		// (which would advance baseSeq ABOVE the reload's M, so the reload would
		// then regress baseSeq BACKWARD and discard the frame's committed change).
		it("[5] a contiguous frame during the reload GET isn't lost; baseSeq stays monotonic", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			// A retention sentinel → reload; baseSeq stays 1 (no seq applied).
			h.reconciler.onReloadEvent();
			expect(h.pendingReloads()).toBe(1);

			// CONTIGUOUS frames arrive WHILE the GET is in flight. Applying seq 2
			// then 3 would push baseSeq to 3; the reload (M=2) would then set
			// baseSeq back to 2 — a regression that discards the seq-3 change.
			// With the guard they re-arm a follow-up reload instead of applying.
			h.reconciler.onFrame(
				autosaveFrame(2, "peer", "u2", [{ kind: "setAppName", name: "Two" }]),
			);
			h.reconciler.onFrame(
				autosaveFrame(3, "peer", "u2", [{ kind: "setAppName", name: "Three" }]),
			);
			// The reload resolves at M=2 — baseSeq lands at 2 authoritatively, never
			// regressing from a frame that was (wrongly) applied to 3.
			await h.resolveReload({ blueprint: makeDoc("At2"), seq: 2 });
			expect(h.reconciler.getSnapshot().baseSeq).toBe(2);
			// The frames weren't discarded: they re-armed a follow-up reload that
			// picks up everything past M (seq 3+).
			expect(h.reconciler.getSnapshot().reloadInFlight).toBe(true);
			expect(h.pendingReloads()).toBe(1);
			await h.resolveReload({ blueprint: makeDoc("At3"), seq: 3 });
			expect(h.reconciler.getSnapshot().baseSeq).toBe(3);
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe("At3");
		});

		// [6] — the retry tick does NOT re-send a batch whose first PUT is still
		// in flight (no redundant concurrent PUT).
		it("[6] the retry tick doesn't double-send a batch whose PUT is still in flight", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// Batch A fails → schedules a retry, and A is now awaiting its re-send.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "A" }]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network" });
			// The retry re-sends A (PUT #2), which stays IN FLIGHT (unresolved).
			await h.runScheduledRetry();
			expect(h.puts).toHaveLength(2);
			expect(h.reconciler.getSnapshot().sentPending[0].putInFlight).toBe(true);

			// A second retry tick fires while A's re-send is still open — it must
			// NOT fire a third concurrent PUT for the same in-flight batch.
			await h.runScheduledRetry();
			expect(h.puts).toHaveLength(2);
		});

		// [2] — a PERMANENT rejection (400/401) is TERMINAL: it FREEZES the
		// reconciler (no more PUTs, ignore frames), stops the retry loop, and
		// surfaces + reports — never a retry-forever wedge.
		it("[2] a permanent (400) rejection freezes the reconciler and reports (no retry)", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// A local edit whose PUT the server permanently rejects (a 400).
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Bad" }]);
			const observed: string[] = [];
			h.reconciler.dispatchHumanBatch((s) => observed.push(s.kind));
			await h.resolvePut(0, {
				ok: false,
				kind: "permanent",
				detail: "HTTP 400",
			});

			const snap = h.reconciler.getSnapshot();
			// TERMINAL: frozen (no more PUTs), retry stopped, surfaced + reported.
			expect(snap.revoked).toBe(true);
			expect(h.reconciler.canPut()).toBe(false);
			expect(h.hasScheduledRetry()).toBe(false);
			expect(observed).toContain("permanent");
			expect(h.saveErrors.length).toBeGreaterThan(0);
			// A later frame is ignored (frozen) — no further mutation.
			h.reconciler.onFrame(
				autosaveFrame(1, "peer", "u2", [{ kind: "setAppName", name: "Late" }]),
			);
			expect(h.reconciler.getSnapshot().baseSeq).toBe(0);
		});

		// [C2] — a permanent rejection with a DEPENDENT stacked batch does NOT
		// silently lose it: the terminal freeze discards the whole local stack at
		// once (the user reloads), rather than dropping B1 and no-op-losing B2.
		it("[C2] a permanent rejection with a dependent stacked batch loses nothing silently", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// B1 renames field A; B2 (stacked after) renames it again — B2 depends
			// on B1's base. Two dispatches.
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "A1" },
				},
			]);
			h.reconciler.dispatchHumanBatch();
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "A2" },
				},
			]);
			h.reconciler.dispatchHumanBatch();
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(2);

			// B1's PUT is permanently rejected → terminal freeze. B2 is NOT silently
			// applied-or-lost; the whole stack is frozen for the user to reload.
			await h.resolvePut(0, {
				ok: false,
				kind: "permanent",
				detail: "HTTP 400",
			});
			const snap = h.reconciler.getSnapshot();
			expect(snap.revoked).toBe(true);
			expect(h.reconciler.canPut()).toBe(false);
			// No further PUT is attempted for B2 (frozen).
			await h.runScheduledRetry();
			expect(h.reconciler.canPut()).toBe(false);
		});

		// The send pipeline is SINGLE-FLIGHT and IN-ORDER: stacked batches are
		// dependent by construction (each is diffed against a localBase that
		// already folds its predecessors), so a successor never races its
		// predecessor over the wire — two PUTs landing on different instances
		// commit in arbitrary order and the later-diffed batch 409s on entities
		// its predecessor hadn't created yet (a silent drop with no real
		// conflict). An ACKED head releases the pipeline; its echo isn't needed.
		it("[C6] a batch dispatched behind an un-acked predecessor waits for its ack (ordered pipeline)", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// B1 in flight.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "One" }]);
			const b1 = h.reconciler.dispatchHumanBatch();
			expect(h.puts).toHaveLength(1);
			// B2 dispatched while B1 is un-acked — queued, NOT sent.
			h.docStore
				.getState()
				.applyMany([{ kind: "setConnectType", connectType: "learn" }]);
			const b2 = h.reconciler.dispatchHumanBatch();
			expect(b2).toBeDefined();
			expect(h.puts).toHaveLength(1);
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(2);
			// B1 acks → the pipeline releases B2 immediately (no echo needed —
			// the server already holds B1, so B2's PUT builds on committed state).
			await h.resolvePut(0, { ok: true, seq: 1 });
			expect(h.puts).toHaveLength(2);
			expect(h.puts[0]?.batchId).toBe(b1);
			expect(h.puts[1]?.batchId).toBe(b2);
			await h.resolvePut(1, { ok: true, seq: 2 });
		});

		it("[C7] a re-send after a network failure targets the pipeline HEAD, and a new dispatch never overtakes it", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// B1 fails on the network — kept, retry scheduled.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "One" }]);
			const b1 = h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network" });
			// The user keeps editing; B2's dispatch pumps the pipeline — which
			// re-sends the HEAD (B1), never B2 ahead of it.
			h.docStore
				.getState()
				.applyMany([{ kind: "setConnectType", connectType: "learn" }]);
			const b2 = h.reconciler.dispatchHumanBatch();
			expect(h.puts).toHaveLength(2);
			expect(h.puts[1]?.batchId).toBe(b1); // the head re-sent, not B2
			// B1's re-send acks → B2 follows, strictly ordered.
			await h.resolvePut(1, { ok: true, seq: 1 });
			expect(h.puts).toHaveLength(3);
			expect(h.puts[2]?.batchId).toBe(b2);
			await h.resolvePut(2, { ok: true, seq: 2 });
		});

		// The provider's effect cleanup clears its backing timers DIRECTLY, so it
		// must also drop the reconciler's scheduled-tick latch (suspendRecovery)
		// and re-arm outstanding work on the replayed setup (resumeRecovery) — or
		// a StrictMode suspend→start cycle wedges the retry loop forever
		// (`scheduleRetryLoop` early-returns on the stale truthy latch).
		it("[C8] suspendRecovery + resumeRecovery re-arm a retry that spanned the suspend window", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// A network-failed batch — a retry tick is scheduled.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Edit" }]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network" });
			expect(h.hasScheduledRetry()).toBe(true);

			// The mount effect's cleanup fires (StrictMode replay): the provider
			// cancels the timer and drops the reconciler's latch…
			h.reconciler.suspendRecovery();
			expect(h.hasScheduledRetry()).toBe(false);
			// …and the replayed setup re-arms the outstanding work.
			h.reconciler.resumeRecovery();
			expect(h.hasScheduledRetry()).toBe(true);
			await h.runScheduledRetry();
			expect(h.puts).toHaveLength(2); // the batch re-sent
			await h.resolvePut(1, { ok: true, seq: 1 });
		});

		it("[C8b] resumeRecovery with nothing outstanding stays idle", () => {
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: makeDoc("Base"),
				userId: "u1",
			});
			h.reconciler.suspendRecovery();
			h.reconciler.resumeRecovery();
			expect(h.hasScheduledRetry()).toBe(false);
		});

		// [2b] — a 401 (session lapsed) is RECOVERABLE, not permanent: the batch is
		// KEPT (not frozen, not discarded) and retried, so a cookie refresh /
		// re-login saves the work. (The provider maps 401 → network; here we inject
		// that outcome to assert the reconciler keeps the batch for retry.)
		it("[2b] a recoverable 401 (mapped to network) keeps the batch and retries — no discard", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Edit" }]);
			const batchId = h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network", detail: "HTTP 401" });
			const snap = h.reconciler.getSnapshot();
			// NOT frozen, NOT discarded — kept for retry.
			expect(snap.revoked).toBe(false);
			expect(h.reconciler.canPut()).toBe(true);
			expect(snap.sentPending).toHaveLength(1);
			expect(snap.awaitingEcho.has(batchId as string)).toBe(true);
			expect(h.hasScheduledRetry()).toBe(true);
			// The retry re-sends it (a re-auth would let it succeed).
			await h.runScheduledRetry();
			expect(h.puts).toHaveLength(2);
			expect(h.puts[1].batchId).toBe(batchId);
		});

		// [3b] — a 413 (delta too large) STOPS the retry loop (no storm) but KEEPS
		// the edits (no freeze, no discard). Surfaced + reported.
		it("[3b] a 413 (tooLarge) stops the retry loop without discarding or freezing", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Big" }]);
			const observed: string[] = [];
			const batchId = h.reconciler.dispatchHumanBatch((s) =>
				observed.push(s.kind),
			);
			await h.resolvePut(0, {
				ok: false,
				kind: "tooLarge",
				detail: "HTTP 413",
			});
			const snap = h.reconciler.getSnapshot();
			// NOT frozen (canPut still true), NOT discarded (batch kept), NO retry.
			expect(snap.revoked).toBe(false);
			expect(snap.sentPending).toHaveLength(1);
			expect(snap.awaitingEcho.has(batchId as string)).toBe(true);
			expect(h.hasScheduledRetry()).toBe(false); // no 413-storm
			// Surfaced + reported.
			expect(observed).toContain("tooLarge");
			expect(h.saveErrors.length).toBeGreaterThan(0);
		});

		it("[3c] a 413 landing under a deferred reload still runs the reload — frames don't freeze", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Big" }]);
			h.reconciler.dispatchHumanBatch();
			// A GAP frame arrives while the PUT is in flight → a reload is armed,
			// deferred behind the in-flight PUT.
			h.reconciler.onFrame(
				autosaveFrame(5, "peer", "u2", [{ kind: "setAppName", name: "Peer" }]),
			);
			expect(h.reconciler.getSnapshot().reloadPending).toBe(true);
			expect(h.pendingReloads()).toBe(0);
			// The PUT resolves 413 — a LIVE (non-frozen) resolution, so the
			// deferred reload MUST run now; stranding it would leave `reloadPending`
			// armed forever and `onFrame` swallowing every subsequent peer frame.
			await h.resolvePut(0, { ok: false, kind: "tooLarge" });
			expect(h.pendingReloads()).toBe(1);
			await h.resolveReload({ blueprint: makeDoc("Fresh"), seq: 5 });
			const snap = h.reconciler.getSnapshot();
			expect(snap.baseSeq).toBe(5);
			// The 413 batch is KEPT (un-acked, not rejected) and re-folded.
			expect(snap.sentPending).toHaveLength(1);
		});

		it("[3d] a dispatch while a 413 batch is stuck mints nothing and re-surfaces `tooLarge`", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Big" }]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "tooLarge" });
			// The user keeps editing behind the stuck batch. Minting more batches
			// would 409-churn (each is diffed against a base the server can't
			// reach), so the delta stays human-uncommitted and the indicator is
			// re-told the terminal state.
			h.docStore
				.getState()
				.applyMany([{ kind: "setConnectType", connectType: "learn" }]);
			const signals: SaveSignal[] = [];
			expect(
				h.reconciler.dispatchHumanBatch((s) => signals.push(s)),
			).toBeUndefined();
			expect(h.puts).toHaveLength(1); // nothing new sent
			expect(signals).toEqual([{ kind: "tooLarge" }]);
		});

		// [1](a) — a pending reload is the send pipeline's BARRIER: the retry tick
		// never launches a PUT while a reload is pending or in flight (a PUT
		// mid-reload would race the very reconciliation the reload performs), and
		// the surviving un-acked batch re-sends in order once the reload lands.
		it("[1a] the retry tick holds the send pipeline behind a pending reload, resuming after it", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			// A network-failed batch (stays for re-send).
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Edit" }]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network" });
			// A reload whose GET FAILS — re-arms `reloadPending` WITHOUT running (so
			// the retry tick, not the frame path, is what drives it).
			h.reconciler.onReloadEvent();
			expect(h.pendingReloads()).toBe(1);
			await h.failReload();
			expect(h.reconciler.getSnapshot().reloadPending).toBe(true);
			expect(h.pendingReloads()).toBe(0);

			// The retry tick fires: the reload barrier holds the pipeline (no PUT
			// launches) and the stranded reload GET runs with no PUT in the air.
			await h.runScheduledRetry();
			expect(h.puts).toHaveLength(1); // no re-send behind the barrier
			expect(h.pendingReloads()).toBe(1); // the reload GET runs first

			// The reload lands → the un-acked batch survived it (re-folded, not
			// dropped) and the pipeline resumes: the batch re-sends promptly.
			await h.resolveReload({ blueprint: makeDoc("Fresh"), seq: 6 });
			expect(h.reconciler.getSnapshot().baseSeq).toBe(6);
			expect(h.puts).toHaveLength(2); // the survivor re-sent post-reload
			await h.resolvePut(1, { ok: true, seq: 7 });
			expect(h.reconciler.getSnapshot().sentPending[0]?.ackedSeq).toBe(7);
		});

		// [1](b) — a false-network re-send of an ALREADY-committed batch (dedup
		// returns the original seq ≤ baseSeq) is DROPPED, not left double-folding.
		it("[1b] a false-network-committed batch (ackedSeq <= baseSeq) is dropped, not double-folded", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 5,
				baseDoc: base,
				userId: "u1",
			});
			// A batch whose PUT actually committed at seq 3 but the client saw a
			// network error (a false failure). It stays for re-send.
			h.docStore
				.getState()
				.applyMany([{ kind: "setAppName", name: "Committed" }]);
			const batchId = h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network" });
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(1);

			// The retry re-sends; the idempotent dedup returns the ORIGINAL seq 3,
			// which is ≤ baseSeq (5) — the batch is already in confirmedDoc. It must
			// be DROPPED (its echo, seq 3 ≤ baseSeq, was already dropped by onFrame,
			// so no future echo will drop it → it would double-fold forever).
			await h.runScheduledRetry();
			expect(h.puts).toHaveLength(2);
			await h.resolvePut(1, { ok: true, seq: 3 });
			const snap = h.reconciler.getSnapshot();
			expect(snap.sentPending).toHaveLength(0);
			expect(snap.awaitingEcho.has(batchId as string)).toBe(false);
		});

		// [3] — onDataDone does not regress baseSeq past an in-flight reload, and a
		// reload resolving after a higher data-done doesn't reseed backward.
		it("[3] onDataDone↔reload race keeps baseSeq monotonic", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 2,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			// A reload GET is in flight (targeting an older M).
			h.reconciler.onReloadEvent();
			expect(h.pendingReloads()).toBe(1);

			// A chat run's data-done lands at seq 8 (higher) WHILE the reload GET is
			// in flight — it reseeds baseSeq forward to 8.
			h.reconciler.onDataDone({
				doc: toPersistableDoc(makeDoc("Final")),
				seq: 8,
			});
			expect(h.reconciler.getSnapshot().baseSeq).toBe(8);
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe("Final");

			// The older reload now resolves at M=4 (< 8) — the monotonic guard must
			// DISCARD it (no regression to 4, no overwrite of the data-done state).
			await h.resolveReload({ blueprint: makeDoc("Stale"), seq: 4 });
			expect(h.reconciler.getSnapshot().baseSeq).toBe(8);
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe("Final");
		});

		// [3] mirror — a stale data-done (seq below baseSeq) is ignored.
		it("[3] a stale data-done (seq below baseSeq) does not regress baseSeq", () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 10,
				baseDoc: base,
				userId: "u1",
			});
			h.reconciler.onDataDone({
				doc: toPersistableDoc(makeDoc("Old")),
				seq: 4,
			});
			// Ignored — baseSeq stays at 10, confirmedDoc unchanged.
			expect(h.reconciler.getSnapshot().baseSeq).toBe(10);
			expect(h.reconciler.getSnapshot().confirmedDoc.appName).toBe("Base");
		});

		// [C1] — the false-network drop REFOLDS: A's edit false-network-fails, a
		// peer's newer value lands via reload, and the drop must NOT leave A's
		// stale local value in `displayed` (which the next autosave would re-PUT,
		// clobbering the peer + inverting commit order). End: displayed === peer.
		it("[C1] a false-network drop refolds so it can't re-PUT a stale value over a peer's edit", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			// A edits field A's label to "Mine"; the PUT actually committed at seq 2
			// but the client saw a network error.
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "Mine" },
				},
			]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network" });

			// A peer's newer edit to the SAME slot lands via a reload at seq 3 (the
			// server's last-writer). The reloaded confirmedDoc holds "Peer".
			const peerDoc = fold(base, [
				[
					{
						kind: "updateField",
						uuid: F_A,
						targetKind: "text",
						patch: { label: "Peer" },
					},
				],
			]);
			h.reloadQueue.push({ blueprint: peerDoc, seq: 3 });
			h.reconciler.onReloadEvent();
			await Promise.resolve();
			await Promise.resolve();
			// After the reload, confirmedDoc is "Peer" but A's batch is still pending
			// (not acked ≤ 3 — its ackedSeq is undefined). displayed folds it → "Mine".
			// Now the retry re-sends A; the dedup returns the ORIGINAL seq 2 (≤ 3) →
			// false-network drop fires. It MUST refold so displayed becomes "Peer".
			await h.runScheduledRetry();
			const idx = h.puts.length - 1;
			await h.resolvePut(idx, { ok: true, seq: 2 });

			const displayed = h.docStore.getState();
			expect((displayed.fields[F_A] as { label: string }).label).toBe("Peer");
			// The batch is gone — nothing left to re-PUT the stale "Mine".
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(0);
		});

		// [C3] — a 200 with NO parseable seq is treated as transient (retry), never
		// a fabricated mount-time baseSeq (which would trip the false-network drop
		// on a fresh accepted batch). Here the reconciler just keeps the batch.
		it("[C3] a seq-less 200 is transient (retry), not a fabricated stale seq", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 5,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Fresh" }]);
			const batchId = h.reconciler.dispatchHumanBatch();
			// The provider maps a seq-less 200 to a transient network failure; here
			// we inject that outcome directly (the provider's job is tested by its
			// own logic — the reconciler must treat it as retryable, keeping the
			// batch, NOT drop it on a fabricated stale seq).
			await h.resolvePut(0, {
				ok: false,
				kind: "network",
				detail: "200 without seq",
			});
			const snap = h.reconciler.getSnapshot();
			// The batch is KEPT for retry (not dropped, not acked at a bogus seq).
			expect(snap.sentPending).toHaveLength(1);
			expect(snap.sentPending[0].ackedSeq).toBeUndefined();
			expect(snap.awaitingEcho.has(batchId as string)).toBe(true);
			expect(h.hasScheduledRetry()).toBe(true);
		});

		// [C4] — a dormant data-done reconciles WITHOUT throwing the open-bracket
		// assert (the old `load()` fallback crashed the build finalize).
		it("[C4] a dormant data-done reconciles bracket-safe without throwing", () => {
			const h = harness({
				appId: undefined,
				baseSeq: 0,
				baseDoc: makeDoc("Empty"),
				userId: "u1",
			});
			expect(h.reconciler.getSnapshot().dormant).toBe(true);
			// Open the agent suppression bracket, as beginRun does during a build —
			// this is the state at data-done that made load() throw.
			h.docStore.getState().beginAgentWrite();
			expect(() => {
				h.reconciler.onDataDone({
					doc: toPersistableDoc(makeDoc("Built")),
					seq: 2,
				});
			}).not.toThrow();
			// The store reconciled to the final snapshot (bracket-safe commitDoc).
			expect(h.docStore.getState().appName).toBe("Built");
		});

		// [C5] — a 409-rejected batch is never re-sent while its reload is
		// pending (re-sending would just re-409 in a storm), and the reload's
		// barrier holds the whole pipeline until it drops the rejected batch.
		it("[C5] a 409 with an active retry loop does not re-send the rejected batch", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 1,
				baseDoc: base,
				userId: "u1",
			});
			h.enableManualReload();
			// Batch A 409s → rejectedBatchId = A, a reload is requested + starts.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "A" }]);
			const aId = h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "conflict" });
			expect(h.pendingReloads()).toBe(1);

			// A second edit dispatches B behind the barrier — nothing sends.
			h.docStore
				.getState()
				.applyMany([{ kind: "setConnectType", connectType: "learn" }]);
			const bId = h.reconciler.dispatchHumanBatch();
			expect(h.puts).toHaveLength(1);

			// The reload lands: A (rejected) is dropped, B survives and re-sends.
			const putsBefore = h.puts.length;
			await h.resolveReload({ blueprint: makeDoc("Fresh"), seq: 6 });
			const sentAfter = h.puts.slice(putsBefore).map((p) => p.batchId);
			expect(sentAfter).not.toContain(aId);
			expect(sentAfter).toContain(bId);
		});
	});

	// ── Bootstrap ───────────────────────────────────────────────────────
	describe("new-build bootstrap", () => {
		it("mounts dormant with no appId, disables PUTs, and applies chat batches directly", () => {
			const h = harness({
				appId: undefined,
				baseSeq: 0,
				baseDoc: makeDoc("Empty"),
				userId: "u1",
			});
			expect(h.reconciler.getSnapshot().dormant).toBe(true);
			expect(h.reconciler.canPut()).toBe(false);
			// A human edit while dormant does not PUT.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "X" }]);
			expect(h.reconciler.dispatchHumanBatch()).toBeUndefined();
			expect(h.puts).toHaveLength(0);
			// A chat batch registration is a no-op while dormant (applies direct).
			h.reconciler.registerChatBatch({
				batchId: "b",
				runId: "r",
				mutations: [{ kind: "setAppName", name: "Y" }],
				seq: 1,
			});
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(0);
		});

		it("activate seeds appId/baseSeq/baseDoc and un-dormants", () => {
			const h = harness({
				appId: undefined,
				baseSeq: 0,
				baseDoc: makeDoc("Empty"),
				userId: "u1",
			});
			// The store now holds the built doc (the SA streamed into it).
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Built" }]);
			h.reconciler.activate({
				appId: "app-1",
				baseDoc: h.docStore.getState(),
			});
			const snap = h.reconciler.getSnapshot();
			expect(snap.dormant).toBe(false);
			expect(snap.appId).toBe("app-1");
			expect(snap.baseSeq).toBe(0);
			expect(snap.confirmedDoc.appName).toBe("Built");
			expect(h.reconciler.canPut()).toBe(true);
		});
	});

	// ── data-done reseed ────────────────────────────────────────────────
	describe("data-done reseed", () => {
		it("drops batches acked <= carried seq and reseeds confirmed without double-apply", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// A chat batch committed at seq 2.
			h.reconciler.registerChatBatch({
				batchId: "chat-1",
				runId: "run-1",
				mutations: [{ kind: "setAppName", name: "Mid" }],
				seq: 2,
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Mid" }]);

			// data-done carries the final doc at seq 2.
			const finalDoc = makeDoc("Final");
			h.reconciler.onDataDone({ doc: toPersistableDoc(finalDoc), seq: 2 });
			const snap = h.reconciler.getSnapshot();
			expect(snap.baseSeq).toBe(2);
			// The committed chat batch (acked 2 <= 2) is dropped.
			expect(snap.sentPending).toHaveLength(0);
			expect(snap.confirmedDoc.appName).toBe("Final");
			expect(h.docStore.getState().appName).toBe("Final");
		});
	});

	// ── Revocation ──────────────────────────────────────────────────────
	describe("revocation", () => {
		it("freezes: ignores frames and cancels a pending retry", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Edit" }]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "network" });
			// Revoke — a retry was scheduled; it must be cancelled.
			h.reconciler.onRevoked();
			expect(h.reconciler.getSnapshot().revoked).toBe(true);
			// A later frame is ignored (frozen).
			h.reconciler.onFrame(
				autosaveFrame(1, "peer", "u2", [{ kind: "setAppName", name: "Late" }]),
			);
			expect(h.reconciler.getSnapshot().baseSeq).toBe(0);
			expect(h.reconciler.canPut()).toBe(false);
		});

		// The frame-revoked-then-edit path: `onRevoked()` fires no SaveSignal (no PUT
		// ever 403s), so a later edit that hits `canPut() === false` must NOT return
		// silently — it emits `reauth` so `useAutoSave` surfaces the "not saving"
		// toast + error indicator instead of the member editing into the void.
		it("a human edit AFTER a frame-revocation emits `reauth` (not a silent no-op)", () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// Revoked via the cadence frame — no PUT happened, so no 403/`reauth` yet.
			h.reconciler.onRevoked();
			// The member keeps editing; there IS an unsaved delta.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Edit" }]);
			const signals: SaveSignal[] = [];
			const batchId = h.reconciler.dispatchHumanBatch((s) => signals.push(s));
			// No PUT (frozen), but the observer is told edit access is gone.
			expect(batchId).toBeUndefined();
			expect(h.puts).toHaveLength(0);
			expect(signals).toEqual([{ kind: "reauth" }]);
		});

		it("a human edit AFTER a permanent (400) freeze emits `permanent`, never the false `reauth`", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "Bad" }]);
			h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: false, kind: "permanent" });
			// The member keeps editing behind the freeze; there IS an unsaved delta.
			h.docStore
				.getState()
				.applyMany([{ kind: "setConnectType", connectType: "learn" }]);
			const signals: SaveSignal[] = [];
			expect(
				h.reconciler.dispatchHumanBatch((s) => signals.push(s)),
			).toBeUndefined();
			// The 400 freeze rides the same no-more-PUTs flag as a revocation, but
			// the terminal signal must stay `permanent` ("reload to continue") — a
			// `reauth` here would send the user chasing phantom permission loss.
			expect(signals).toEqual([{ kind: "permanent" }]);
		});

		it("a revoked dispatch with NO unsaved delta stays a clean no-op (no `reauth`)", () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.reconciler.onRevoked();
			// No local edit → nothing to save → nothing to warn about.
			const signals: SaveSignal[] = [];
			expect(
				h.reconciler.dispatchHumanBatch((s) => signals.push(s)),
			).toBeUndefined();
			expect(signals).toEqual([]);
		});

		it("a DORMANT dispatch (no appId) never emits `reauth` — it's a legitimate silent no-op", () => {
			const h = harness({
				appId: undefined,
				baseSeq: 0,
				baseDoc: makeDoc("Empty"),
				userId: "u1",
			});
			// A dormant new-build with a pending human edit and no app id.
			h.docStore.getState().applyMany([{ kind: "setAppName", name: "X" }]);
			const signals: SaveSignal[] = [];
			expect(
				h.reconciler.dispatchHumanBatch((s) => signals.push(s)),
			).toBeUndefined();
			// Dormant is not revoked — a new build applies edits directly, no warning.
			expect(signals).toEqual([]);
		});
	});

	// ── The invariant across orderings ──────────────────────────────────
	describe("invariant", () => {
		/** Assert the reconciler's `localBase() === fold(confirmedDoc, sentPending)`
		 *  (the load-bearing half of the invariant that the reconciler owns; the
		 *  human delta beyond it is the store's live doc). */
		function assertInvariant(h: Harness): void {
			const snap = h.reconciler.getSnapshot();
			const pending = snap.sentPending.map((b) => b.mutations);
			const rebuilt = fold(snap.confirmedDoc, pending);
			expect(docData(h.reconciler.localBase())).toEqual(rebuilt);
		}

		it("holds across a relay-first ordering (remote before local ack)", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			// Local edit dispatched.
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "LA" },
				},
			]);
			h.reconciler.dispatchHumanBatch();
			assertInvariant(h);
			// A peer frame arrives BEFORE our ack (relay-first).
			h.reconciler.onFrame(
				autosaveFrame(1, "peer", "u2", [
					{
						kind: "updateField",
						uuid: F_B,
						targetKind: "text",
						patch: { label: "PB" },
					},
				]),
			);
			assertInvariant(h);
			// Now our ack lands.
			await h.resolvePut(0, { ok: true, seq: 2 });
			assertInvariant(h);
			// Then our echo.
			const pendingBatchId = h.reconciler.getSnapshot().sentPending[0].batchId;
			h.reconciler.onFrame(
				autosaveFrame(2, pendingBatchId, "u1", [
					{
						kind: "updateField",
						uuid: F_A,
						targetKind: "text",
						patch: { label: "LA" },
					},
				]),
			);
			assertInvariant(h);
			// End state: both edits present, no pending.
			const displayed = h.docStore.getState();
			expect((displayed.fields[F_A] as { label: string }).label).toBe("LA");
			expect((displayed.fields[F_B] as { label: string }).label).toBe("PB");
			expect(h.reconciler.getSnapshot().sentPending).toHaveLength(0);
		});

		it("holds across a local-first ordering (ack + echo before remote)", async () => {
			const base = makeDoc("Base");
			const h = harness({
				appId: "app-1",
				baseSeq: 0,
				baseDoc: base,
				userId: "u1",
			});
			h.docStore.getState().applyMany([
				{
					kind: "updateField",
					uuid: F_A,
					targetKind: "text",
					patch: { label: "LA" },
				},
			]);
			const batchId = h.reconciler.dispatchHumanBatch();
			await h.resolvePut(0, { ok: true, seq: 1 });
			// Our echo first.
			h.reconciler.onFrame(
				autosaveFrame(1, batchId as string, "u1", [
					{
						kind: "updateField",
						uuid: F_A,
						targetKind: "text",
						patch: { label: "LA" },
					},
				]),
			);
			assertInvariant(h);
			// Then a peer frame.
			h.reconciler.onFrame(
				autosaveFrame(2, "peer", "u2", [
					{
						kind: "updateField",
						uuid: F_B,
						targetKind: "text",
						patch: { label: "PB" },
					},
				]),
			);
			assertInvariant(h);
			const displayed = h.docStore.getState();
			expect((displayed.fields[F_A] as { label: string }).label).toBe("LA");
			expect((displayed.fields[F_B] as { label: string }).label).toBe("PB");
		});
	});
});
