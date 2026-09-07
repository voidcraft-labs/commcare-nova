/**
 * Tests for `applyStreamEvent` — the stream event dispatcher.
 *
 * Uses real stores (BlueprintDocStore + BuilderSessionStore) wired together
 * via `_setDocStore`, mirroring the runtime SyncBridge setup. Each test
 * exercises one event category: mutation batch, conversation event, or
 * doc lifecycle.
 *
 * The live `data-mutations` doc-apply path is covered in more detail in
 * `streamDispatcher-mutations.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	createReconciler,
	type Reconciler,
	type ReconcilerDeps,
} from "@/lib/collab/reconciler";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import { blueprintDocSchema } from "@/lib/domain";
import type { ConversationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { READ_ENERGY_PER_CHAR, signalGrid } from "@/lib/signalGrid/store";
import { toastStore } from "@/lib/ui/toastStore";
import { applyStreamEvent, conversationEventError } from "../streamDispatcher";
import { createWiredStores, hydrateDoc } from "./testHelpers";

/** Inert deps — this suite drives the dispatcher, not the reconciler's
 *  network, so the PUT/reload/retry side effects are no-ops. */
const INERT_DEPS: ReconcilerDeps = {
	put: async () => ({ ok: true, seq: 0 }),
	reload: async () => ({
		kind: "authorized",
		blueprint: MINIMAL_DOC,
		seq: 0,
		projectId: "project-1",
		role: "editor",
		canEdit: true,
	}),
	canEdit: () => true,
	resubscribe: () => {},
	scheduleRetry: () => () => {},
};

/** Build a reconciler seeded on the store's current doc, mirroring an active
 *  builder session so a `data-done` reseeds via `onDataDone` (not `load()`). */
function makeReconciler(docStore: BlueprintDocStoreApi): Reconciler {
	const reconciler = createReconciler(
		docStore,
		{
			appId: "test-app-id",
			baseSeq: 0,
			baseDoc: docStore.getState(),
			userId: "u1",
		},
		INERT_DEPS,
	);
	ownedReconciler.push(reconciler);
	return reconciler;
}

// ── Fixture docs (normalized domain shape) ─────────────────────────────
//
// These are the shape the dispatcher consumes — a `PersistableDoc` with
// three UUID-keyed entity tables and three order arrays. We construct
// them directly rather than round-tripping through the wire format so
// the tests can't accidentally depend on any wire-side conversion.

const MINIMAL_DOC = toPersistableDoc(
	buildDoc({
		appId: "test-app-id",
		appName: "Test App",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "text", id: "name" })],
					},
				],
			},
		],
	}),
);
blueprintDocSchema.parse(MINIMAL_DOC);
const ownedReconciler: Reconciler[] = [];
const ownedRuns: BuilderSessionStoreApi[] = [];
afterEach(() => {
	for (const session of ownedRuns.splice(0)) session.getState().endRun();
	for (const reconciler of ownedReconciler.splice(0)) reconciler.dispose();
	toastStore.clear();
	signalGrid.reset();
});

// Test helpers live in ./testHelpers — shared with other generation tests.

// Small factory for conversation-event payloads used below.
function convEvent(
	payload: ConversationEvent["payload"],
	seq = 0,
): ConversationEvent {
	return {
		kind: "conversation",
		runId: "test-run",
		ts: 0,
		seq,
		source: "chat",
		payload,
	};
}

// ── Test suite ──────────────────────────────────────────────────────────

describe("applyStreamEvent", () => {
	let docStore: BlueprintDocStoreApi;
	let sessionStore: BuilderSessionStoreApi;

	beforeEach(() => {
		const stores = createWiredStores();
		docStore = stores.docStore;
		sessionStore = stores.sessionStore;
		hydrateDoc(docStore, { ...MINIMAL_DOC, appName: "Before" });
		expect(
			mutationCommitVerdict(docStore.getState(), [], LOOKUP_CONTEXT_UNAVAILABLE)
				.ok,
		).toBe(true);
		signalGrid.reset();
	});

	// ── Doc lifecycle (full-doc replacements) ───────────────────────────

	describe("data-done", () => {
		it("reseeds the doc AND stamps runCompletedAt (whole-build completion)", () => {
			/* Begin a run to simulate a live session — this opens the agent
			 * suppression bracket (via `beginAgentWrite`), still open at
			 * data-done, so the reconciler reseeds via a suppressed `commitDoc`
			 * (not `load()`, which asserts inside an open bracket). */
			const reconciler = makeReconciler(docStore);
			sessionStore.getState().beginRun();
			ownedRuns.push(sessionStore);
			expect(sessionStore.getState().runCompletedAt).toBeUndefined();

			applyStreamEvent(
				"data-done",
				{
					doc: MINIMAL_DOC,
					seq: 3,
				},
				docStore,
				sessionStore,
				reconciler,
				undefined,
			);

			/* Doc reseeded to the authoritative snapshot. */
			const doc = docStore.getState();
			expect(doc.appName).toBe("Test App");
			expect(doc.moduleOrder).toHaveLength(1);

			/* `data-done` IS the completion signal — the dispatcher stamps
			 * runCompletedAt. Stream-close is orthogonal (owned by the
			 * ChatContainer status effect via `endRun`). */
			const session = sessionStore.getState();
			expect(session.runCompletedAt).toEqual(expect.any(Number));
		});

		it("[C4] a DORMANT reconciler data-done reconciles bracket-safe (no load() crash)", () => {
			/* A brand-new build whose `data-app-id` hasn't activated the reconciler
			 * yet: the reconciler is DORMANT and the agent suppression bracket is
			 * open (beginRun). `docStore.load()` asserts inside an open bracket, so
			 * the dispatcher must route through `onDataDone` (bracket-safe). */
			const reconciler = createReconciler(
				docStore,
				{
					appId: undefined,
					baseSeq: 0,
					baseDoc: docStore.getState(),
					userId: "u1",
				},
				INERT_DEPS,
			);
			ownedReconciler.push(reconciler);
			sessionStore.getState().beginRun();
			ownedRuns.push(sessionStore); // opens the agent bracket
			expect(() => {
				applyStreamEvent(
					"data-done",
					{ doc: MINIMAL_DOC, seq: 2 },
					docStore,
					sessionStore,
					reconciler,
					undefined,
				);
			}).not.toThrow();
			expect(docStore.getState().appName).toBe("Test App");
		});
	});

	// ── Conversation events ──────────────────────────────────────────────

	describe("data-conversation-event", () => {
		it("pushes the event onto the session buffer", () => {
			const event = convEvent({ type: "assistant-text", text: "hello" }, 0);

			applyStreamEvent(
				"data-conversation-event",
				event as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
				null,
				undefined,
			);

			expect(sessionStore.getState().events).toEqual([event]);
		});

		it("pushes an error event and emits its error-severity notification", () => {
			const event = convEvent(
				{
					type: "error",
					error: { type: "internal", message: "boom", fatal: true },
				},
				0,
			);

			applyStreamEvent(
				"data-conversation-event",
				event as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
				null,
				undefined,
			);

			expect(sessionStore.getState().events).toHaveLength(1);
			expect(sessionStore.getState().events[0]).toEqual(event);
			expect(toastStore.toasts).toMatchObject([
				{ severity: "error", title: "Generation error", message: "boom" },
			]);
		});

		it("distinguishes an in-flight retry warning from a terminal stop", () => {
			const retrying = convEvent(
				{
					type: "error",
					error: {
						type: "api_server",
						message: "Trying again",
						fatal: false,
						runContinues: true,
					},
				},
				0,
			);

			expect(
				conversationEventError(retrying as unknown as Record<string, unknown>)
					?.runContinues,
			).toBe(true);
		});

		it("pushes a validation-attempt event onto the buffer", () => {
			const event = convEvent(
				{
					type: "validation-attempt",
					attempt: 2,
					errors: ["missing xpath", "invalid ref"],
				},
				0,
			);

			applyStreamEvent(
				"data-conversation-event",
				event as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
				null,
				undefined,
			);

			expect(sessionStore.getState().events).toEqual([event]);
		});
	});

	// ── Signal grid energy injection ────────────────────────────────────

	describe("signal grid energy injection", () => {
		it("injects 50 energy for data-conversation-event", () => {
			applyStreamEvent(
				"data-conversation-event",
				convEvent(
					{ type: "assistant-text", text: "..." },
					0,
				) as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
				null,
				undefined,
			);

			expect(signalGrid.drainEnergy()).toBe(50);
		});

		it("injects 200 energy for data-mutations", () => {
			applyStreamEvent(
				"data-mutations",
				{
					mutations: [{ kind: "setAppName", name: "x" }] as unknown as Record<
						string,
						unknown
					>[],
					events: [],
				},
				docStore,
				sessionStore,
				null,
				undefined,
			);

			expect(signalGrid.drainEnergy()).toBe(200);
		});

		it("injects THINK energy from a data-extract-progress char delta", () => {
			// The send-time backstop's streamed read-progress pulses the grid's think
			// channel (not the burst channel), scaled by READ_ENERGY_PER_CHAR.
			applyStreamEvent(
				"data-extract-progress",
				{ delta: 10 },
				docStore,
				sessionStore,
				null,
				undefined,
			);

			expect(signalGrid.drainThinkEnergy()).toBe(10 * READ_ENERGY_PER_CHAR);
			// It's the think channel — the burst channel stays untouched.
			expect(signalGrid.drainEnergy()).toBe(0);
		});
	});

	// ── Unknown event types ─────────────────────────────────────────────

	describe("unknown event type", () => {
		it("does not throw for unrecognized event types", () => {
			expect(() => {
				applyStreamEvent(
					"data-unknown",
					{ foo: "bar" },
					docStore,
					sessionStore,
					null,
					undefined,
				);
			}).not.toThrow();
		});
	});
});
