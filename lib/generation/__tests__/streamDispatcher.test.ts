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

import { beforeEach, describe, expect, it } from "vitest";
import {
	createReconciler,
	type Reconciler,
	type ReconcilerDeps,
} from "@/lib/collab/reconciler";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import { asUuid, type PersistableDoc } from "@/lib/domain";
import type { ConversationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { READ_ENERGY_PER_CHAR, signalGrid } from "@/lib/signalGrid/store";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

/** Inert deps — this suite drives the dispatcher, not the reconciler's
 *  network, so the PUT/reload/retry side effects are no-ops. */
const INERT_DEPS: ReconcilerDeps = {
	put: async () => ({ ok: true, seq: 0 }),
	reload: async () => ({ blueprint: MINIMAL_DOC, seq: 0 }),
	resubscribe: () => {},
	scheduleRetry: () => () => {},
};

/** Build a reconciler seeded on the store's current doc, mirroring an active
 *  builder session so a `data-done` reseeds via `onDataDone` (not `load()`). */
function makeReconciler(
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
): Reconciler {
	return createReconciler(
		docStore,
		sessionStore,
		{
			appId: "test-app-id",
			baseSeq: 0,
			baseDoc: docStore.getState(),
			userId: "u1",
		},
		INERT_DEPS,
	);
}

// ── Fixture docs (normalized domain shape) ─────────────────────────────
//
// These are the shape the dispatcher consumes — a `PersistableDoc` with
// three UUID-keyed entity tables and three order arrays. We construct
// them directly rather than round-tripping through the wire format so
// the tests can't accidentally depend on any wire-side conversion.

/** Minimal doc with one module, one form, one field. */
const MINIMAL_DOC: PersistableDoc = {
	appId: "test-app-id",
	appName: "Test App",
	connectType: null,
	caseTypes: [
		{
			name: "patient",
			properties: [{ name: "case_name", label: "Name" }],
		},
	],
	modules: {
		[asUuid("mod-uuid-1")]: {
			uuid: asUuid("mod-uuid-1"),
			id: "registration",
			name: "Registration",
			caseType: "patient",
		},
	},
	forms: {
		[asUuid("form-uuid-1")]: {
			uuid: asUuid("form-uuid-1"),
			id: "register_patient",
			name: "Register Patient",
			type: "registration",
		},
	},
	fields: {
		[asUuid("q-uuid-1")]: {
			uuid: asUuid("q-uuid-1"),
			id: "case_name",
			kind: "text",
			label: "Patient Name",
		},
	},
	moduleOrder: [asUuid("mod-uuid-1")],
	formOrder: { [asUuid("mod-uuid-1")]: [asUuid("form-uuid-1")] },
	fieldOrder: { [asUuid("form-uuid-1")]: [asUuid("q-uuid-1")] },
};

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
		signalGrid.reset();
	});

	// ── Doc lifecycle (full-doc replacements) ───────────────────────────

	describe("data-done", () => {
		it("reseeds the doc AND stamps runCompletedAt (whole-build completion)", () => {
			/* Begin a run to simulate a live session — this opens the agent
			 * suppression bracket (via `beginAgentWrite`), still open at
			 * data-done, so the reconciler reseeds via a suppressed `commitDoc`
			 * (not `load()`, which asserts inside an open bracket). */
			const reconciler = makeReconciler(docStore, sessionStore);
			sessionStore.getState().beginRun();
			expect(sessionStore.getState().runCompletedAt).toBeUndefined();

			applyStreamEvent(
				"data-done",
				{
					doc: MINIMAL_DOC as unknown as Record<string, unknown>,
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
			 * open (beginRun). The old dispatcher fell back to `docStore.load()`,
			 * which now THROWS inside an open bracket — crashing the build finalize.
			 * The dispatcher must route through `onDataDone` (bracket-safe) instead. */
			const reconciler = createReconciler(
				docStore,
				sessionStore,
				{
					appId: undefined,
					baseSeq: 0,
					baseDoc: docStore.getState(),
					userId: "u1",
				},
				INERT_DEPS,
			);
			sessionStore.getState().beginRun(); // opens the agent bracket
			expect(() => {
				applyStreamEvent(
					"data-done",
					{ doc: MINIMAL_DOC as unknown as Record<string, unknown>, seq: 2 },
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

		it("pushes an error event onto the buffer (and toast is UI-only)", () => {
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
