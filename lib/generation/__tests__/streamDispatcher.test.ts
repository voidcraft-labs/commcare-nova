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
import { createWiredStores, hydrateDoc } from "./testHelpers";

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

/** Edited version of MINIMAL_DOC — app renamed, form renamed, one field
 *  added. Same uuids on the carry-over entities so the load path exercises
 *  a real reconciliation, not a wholesale swap. */
const EDITED_DOC: PersistableDoc = {
	appId: "test-app-id",
	appName: "Test App v2",
	connectType: null,
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name" },
				{ name: "age", label: "Age" },
			],
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
			name: "Register Patient (Edited)",
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
		[asUuid("q-uuid-2")]: {
			uuid: asUuid("q-uuid-2"),
			id: "age",
			kind: "int",
			label: "Age",
		},
	},
	moduleOrder: [asUuid("mod-uuid-1")],
	formOrder: { [asUuid("mod-uuid-1")]: [asUuid("form-uuid-1")] },
	fieldOrder: {
		[asUuid("form-uuid-1")]: [asUuid("q-uuid-1"), asUuid("q-uuid-2")],
	},
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
		it("loads final doc; does NOT end the run (chat-status effect owns that)", () => {
			/* Simulate a generation session active at data-done. Start a run
			 * so we can verify no sneaky endRun happens in the dispatcher. */
			sessionStore.getState().beginRun();

			applyStreamEvent(
				"data-done",
				{ doc: MINIMAL_DOC as unknown as Record<string, unknown> },
				docStore,
				sessionStore,
			);

			/* Doc should have the payload's content. */
			const doc = docStore.getState();
			expect(doc.appName).toBe("Test App");
			expect(doc.moduleOrder).toHaveLength(1);

			/* Run lifecycle is still active — the chat transport status effect
			 * is what transitions agentActive + runCompletedAt. The dispatcher
			 * must NOT double-stamp. */
			const session = sessionStore.getState();
			expect(session.agentActive).toBe(true);
			expect(session.runCompletedAt).toBeUndefined();
		});
	});

	describe("data-blueprint-updated", () => {
		it("loads updated doc and resumes doc undo tracking", () => {
			hydrateDoc(docStore, MINIMAL_DOC);
			sessionStore.getState().setAppId("test-app-id");

			applyStreamEvent(
				"data-blueprint-updated",
				{ doc: EDITED_DOC as unknown as Record<string, unknown> },
				docStore,
				sessionStore,
			);

			expect(docStore.getState().appName).toBe("Test App v2");
			/* Doc undo tracking should be resumed (endAgentWrite on doc). */
			expect(docStore.temporal.getState().isTracking).toBe(true);
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

		it("injects 100 energy for data-blueprint-updated", () => {
			hydrateDoc(docStore, MINIMAL_DOC);

			applyStreamEvent(
				"data-blueprint-updated",
				{ doc: EDITED_DOC as unknown as Record<string, unknown> },
				docStore,
				sessionStore,
			);

			expect(signalGrid.drainEnergy()).toBe(100);
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
