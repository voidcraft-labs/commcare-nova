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
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import { asUuid, type PersistableDoc } from "@/lib/domain";
import type { ConversationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { signalGrid } from "@/lib/signalGrid/store";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

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
	return { kind: "conversation", runId: "test-run", ts: 0, seq, payload };
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
		it("loads final doc AND stamps runCompletedAt (whole-build completion)", () => {
			/* Begin a run to simulate a live session. */
			sessionStore.getState().beginRun();
			expect(sessionStore.getState().runCompletedAt).toBeUndefined();

			applyStreamEvent(
				"data-done",
				{ doc: MINIMAL_DOC as unknown as Record<string, unknown> },
				docStore,
				sessionStore,
			);

			/* Doc replaced with the authoritative snapshot. */
			const doc = docStore.getState();
			expect(doc.appName).toBe("Test App");
			expect(doc.moduleOrder).toHaveLength(1);

			/* `data-done` IS the completion signal — the dispatcher stamps
			 * runCompletedAt. Stream-close is orthogonal (owned by the
			 * ChatContainer status effect via `endRun`). */
			const session = sessionStore.getState();
			expect(session.runCompletedAt).toEqual(expect.any(Number));
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
			);

			expect(signalGrid.drainEnergy()).toBe(200);
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
				);
			}).not.toThrow();
		});
	});
});
