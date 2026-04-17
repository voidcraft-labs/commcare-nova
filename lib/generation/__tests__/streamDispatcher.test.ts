/**
 * Tests for `applyStreamEvent` — the stream event dispatcher that replaces
 * the legacy `applyDataPart` function.
 *
 * Uses real stores (BlueprintDocStore + BuilderSessionStore) wired together
 * via `_setDocStore`, mirroring the runtime SyncBridge setup. Each test
 * exercises one event category: doc mutations, doc lifecycle, or session-only.
 */

import { assert, beforeEach, describe, expect, it } from "vitest";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import { asUuid, type PersistableDoc } from "@/lib/domain";
import type { BlueprintForm } from "@/lib/schemas/blueprint";
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

// ── Scaffold fixture ────────────────────────────────────────────────────

/** Scaffold payload with top-level keys (matches the wire format the SA
 *  emits for `data-scaffold`). This event still uses wire-style snake_case
 *  fields because it carries the SA tool's raw input — the mutation mapper
 *  translates at ingress. */
const SCAFFOLD_DATA = {
	app_name: "Health App",
	description: "A health monitoring app",
	connect_type: "",
	modules: [
		{
			name: "Registration",
			case_type: "patient",
			case_list_only: false,
			purpose: "Register patients",
			forms: [
				{
					name: "Register",
					type: "registration",
					purpose: "Register a new patient",
					formDesign: "Name, age, gender",
				},
			],
		},
	],
};

// Test helpers live in ./testHelpers — shared with other generation tests.

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

	// ── Category 3: Session-only events ─────────────────────────────────

	describe("data-start-build", () => {
		it("sets session.agentActive=true and pauses doc undo", () => {
			/* Resume tracking first so we can verify the pause. */
			docStore.temporal.getState().resume();
			expect(docStore.temporal.getState().isTracking).toBe(true);

			applyStreamEvent("data-start-build", {}, docStore, sessionStore);

			expect(sessionStore.getState().agentActive).toBe(true);
			/* Doc undo should be paused — `beginAgentWrite` on the session store
			 * cascades to `docStore.beginAgentWrite()` which pauses temporal. */
			expect(docStore.temporal.getState().isTracking).toBe(false);
		});
	});

	// ── Category 1: Doc mutation events ─────────────────────────────────

	describe("data-schema", () => {
		it("updates doc.caseTypes via mutation mapper", () => {
			const caseTypes = [
				{
					name: "patient",
					properties: [{ name: "first_name", label: "First Name" }],
				},
			];

			applyStreamEvent("data-schema", { caseTypes }, docStore, sessionStore);

			expect(docStore.getState().caseTypes).toEqual(caseTypes);
		});
	});

	describe("data-scaffold", () => {
		it("creates modules and forms on the doc", () => {
			applyStreamEvent(
				"data-scaffold",
				SCAFFOLD_DATA as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
			);

			const doc = docStore.getState();
			expect(doc.appName).toBe("Health App");
			expect(doc.moduleOrder).toHaveLength(1);

			const moduleUuid = doc.moduleOrder[0];
			expect(doc.modules[moduleUuid].name).toBe("Registration");
			expect(doc.formOrder[moduleUuid]).toHaveLength(1);
		});
	});

	describe("data-module-done", () => {
		it("updates module caseListColumns (needs scaffold first)", () => {
			/* Apply scaffold to create the module structure. */
			applyStreamEvent(
				"data-scaffold",
				SCAFFOLD_DATA as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
			);

			const moduleUuid = docStore.getState().moduleOrder[0];
			const columns = [
				{ field: "name", header: "Name" },
				{ field: "age", header: "Age" },
			];

			applyStreamEvent(
				"data-module-done",
				{ moduleIndex: 0, caseListColumns: columns },
				docStore,
				sessionStore,
			);

			expect(docStore.getState().modules[moduleUuid].caseListColumns).toEqual(
				columns,
			);
		});
	});

	describe("data-form-done", () => {
		it("replaces form with full question content (needs scaffold first)", () => {
			/* Apply scaffold to create module + form shell. */
			applyStreamEvent(
				"data-scaffold",
				SCAFFOLD_DATA as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
			);

			const moduleUuid = docStore.getState().moduleOrder[0];
			const formUuid = docStore.getState().formOrder[moduleUuid][0];

			const incomingForm: BlueprintForm = {
				uuid: "ignored-uuid",
				name: "Register Patient",
				type: "registration",
				questions: [
					{
						uuid: "q-new-1",
						id: "patient_name",
						type: "text",
						label: "Patient Name",
					},
					{
						uuid: "q-new-2",
						id: "patient_age",
						type: "int",
						label: "Age",
					},
				],
			};

			applyStreamEvent(
				"data-form-done",
				{ moduleIndex: 0, formIndex: 0, form: incomingForm },
				docStore,
				sessionStore,
			);

			/* The form should now have 2 fields. */
			const doc = docStore.getState();
			const fieldUuids = doc.fieldOrder[formUuid];
			assert(fieldUuids);
			expect(fieldUuids).toHaveLength(2);
			expect(doc.fields[fieldUuids[0]].id).toBe("patient_name");
			expect(doc.fields[fieldUuids[1]].id).toBe("patient_age");
		});
	});

	// ── Category 2: Doc lifecycle events ────────────────────────────────

	describe("data-done", () => {
		it("loads final doc, sets justCompleted=true, clears agentActive", () => {
			/* Simulate a generation session: start build, then done. */
			applyStreamEvent("data-start-build", {}, docStore, sessionStore);

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

			/* Session should be in post-generation state. agentActive stays true —
			 * the chat status effect clears it when status transitions to "ready",
			 * which also stamps lastResponseAtRef for Anthropic cache warmth. */
			const session = sessionStore.getState();
			expect(session.justCompleted).toBe(true);
			expect(session.agentActive).toBe(true);

			/* Doc undo tracking should be resumed — endAgentWrite on the session
			 * store cascades to docStore.endAgentWrite() which resumes temporal. */
			expect(docStore.temporal.getState().isTracking).toBe(true);
		});
	});

	describe("data-blueprint-updated", () => {
		it("loads updated doc, does NOT set justCompleted", () => {
			/* Pre-load an initial doc (simulates an existing app). */
			hydrateDoc(docStore, MINIMAL_DOC);
			sessionStore.getState().setAppId("test-app-id");

			applyStreamEvent(
				"data-blueprint-updated",
				{ doc: EDITED_DOC as unknown as Record<string, unknown> },
				docStore,
				sessionStore,
			);

			/* Doc should reflect the edit. */
			expect(docStore.getState().appName).toBe("Test App v2");

			/* justCompleted must NOT be set — edit-tool responses skip celebration. */
			expect(sessionStore.getState().justCompleted).toBe(false);

			/* Doc undo tracking should be resumed (endAgentWrite on doc). */
			expect(docStore.temporal.getState().isTracking).toBe(true);
		});
	});

	// ── Category 3: Session-only events (continued) ─────────────────────

	describe("data-error", () => {
		it("sets agentError with correct severity on session store", () => {
			applyStreamEvent(
				"data-error",
				{ message: "Validation failed", fatal: false },
				docStore,
				sessionStore,
			);

			const err = sessionStore.getState().agentError;
			assert(err);
			expect(err.message).toBe("Validation failed");
			expect(err.severity).toBe("recovering");
		});

		it("uses 'failed' severity when fatal is true", () => {
			applyStreamEvent(
				"data-error",
				{ message: "Stream crashed", fatal: true },
				docStore,
				sessionStore,
			);

			const err = sessionStore.getState().agentError;
			assert(err);
			expect(err.severity).toBe("failed");
		});
	});

	describe("data-app-saved", () => {
		it("sets session.appId", () => {
			applyStreamEvent(
				"data-app-saved",
				{ appId: "app-123" },
				docStore,
				sessionStore,
			);

			expect(sessionStore.getState().appId).toBe("app-123");
		});
	});

	describe("data-phase", () => {
		it("updates session.agentStage", () => {
			applyStreamEvent(
				"data-phase",
				{ phase: "structure" },
				docStore,
				sessionStore,
			);

			expect(sessionStore.getState().agentStage).toBe("structure");
		});
	});

	describe("data-fix-attempt", () => {
		it("sets statusMessage with error info", () => {
			applyStreamEvent(
				"data-fix-attempt",
				{ attempt: 2, errorCount: 3 },
				docStore,
				sessionStore,
			);

			expect(sessionStore.getState().statusMessage).toBe(
				"Fixing 3 errors, attempt 2",
			);
		});

		it("uses singular 'error' for count of 1", () => {
			applyStreamEvent(
				"data-fix-attempt",
				{ attempt: 1, errorCount: 1 },
				docStore,
				sessionStore,
			);

			expect(sessionStore.getState().statusMessage).toBe(
				"Fixing 1 error, attempt 1",
			);
		});
	});

	describe("data-partial-scaffold", () => {
		it("sets session.partialScaffold with parsed data", () => {
			applyStreamEvent(
				"data-partial-scaffold",
				{
					app_name: "Health App",
					modules: [
						{
							name: "Registration",
							case_type: "patient",
							purpose: "Register patients",
							forms: [
								{
									name: "Register",
									type: "registration",
									purpose: "Register a new patient",
								},
							],
						},
					],
				},
				docStore,
				sessionStore,
			);

			const ps = sessionStore.getState().partialScaffold;
			assert(ps);
			expect(ps.appName).toBe("Health App");
			expect(ps.modules).toHaveLength(1);
			expect(ps.modules[0].name).toBe("Registration");
			expect(ps.modules[0].forms).toHaveLength(1);
			expect(ps.modules[0].forms[0].name).toBe("Register");
		});

		it("filters out modules and forms without names", () => {
			applyStreamEvent(
				"data-partial-scaffold",
				{
					app_name: "Partial",
					modules: [
						{ name: "Valid", forms: [{ name: "", type: "survey" }] },
						{ forms: [] },
					],
				},
				docStore,
				sessionStore,
			);

			const ps = sessionStore.getState().partialScaffold;
			assert(ps);
			/* Only the module with a name survives. */
			expect(ps.modules).toHaveLength(1);
			expect(ps.modules[0].name).toBe("Valid");
			/* The form with empty-string name should be filtered out. */
			expect(ps.modules[0].forms).toHaveLength(0);
		});

		it("sets undefined when no valid modules exist", () => {
			applyStreamEvent(
				"data-partial-scaffold",
				{ modules: [{ forms: [] }] },
				docStore,
				sessionStore,
			);

			expect(sessionStore.getState().partialScaffold).toBeUndefined();
		});
	});

	// ── Signal grid energy injection ────────────────────────────────────

	describe("signal grid energy injection", () => {
		it("injects 200 energy for data-module-done", () => {
			/* Scaffold first so the mutation mapper finds the module. */
			applyStreamEvent(
				"data-scaffold",
				SCAFFOLD_DATA as unknown as Record<string, unknown>,
				docStore,
				sessionStore,
			);
			signalGrid.reset();

			applyStreamEvent(
				"data-module-done",
				{ moduleIndex: 0, caseListColumns: null },
				docStore,
				sessionStore,
			);

			expect(signalGrid.drainEnergy()).toBe(200);
		});

		it("injects 50 energy for data-phase", () => {
			applyStreamEvent(
				"data-phase",
				{ phase: "forms" },
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
