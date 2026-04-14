/**
 * Tests for `applyStreamEvent` — the stream event dispatcher that replaces
 * the legacy `applyDataPart` function.
 *
 * Uses real stores (BlueprintDocStore + BuilderSessionStore) wired together
 * via `_setDocStore`, mirroring the runtime SyncBridge setup. Each test
 * exercises one event category: doc mutations, doc lifecycle, or session-only.
 */

import { assert, beforeEach, describe, expect, it } from "vitest";
import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { AppBlueprint, BlueprintForm } from "@/lib/schemas/blueprint";
import {
	type BuilderSessionStoreApi,
	createBuilderSessionStore,
} from "@/lib/session/store";
import { signalGrid } from "@/lib/signalGrid/store";
import { applyStreamEvent } from "../streamDispatcher";

// ── Fixture blueprints ──────────────────────────────────────────────────

/** Minimal blueprint with one module, one form, one question. */
const MINIMAL_BP: AppBlueprint = {
	app_name: "Test App",
	modules: [
		{
			uuid: "mod-uuid-1",
			name: "Registration",
			case_type: "patient",
			forms: [
				{
					uuid: "form-uuid-1",
					name: "Register Patient",
					type: "registration",
					questions: [
						{
							uuid: "q-uuid-1",
							id: "case_name",
							type: "text",
							label: "Patient Name",
						},
					],
				},
			],
		},
	],
	case_types: [
		{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
	],
};

/** Edited version of MINIMAL_BP — form name changed, new question added. */
const EDITED_BP: AppBlueprint = {
	app_name: "Test App v2",
	modules: [
		{
			uuid: "mod-uuid-1",
			name: "Registration",
			case_type: "patient",
			forms: [
				{
					uuid: "form-uuid-1",
					name: "Register Patient (Edited)",
					type: "registration",
					questions: [
						{
							uuid: "q-uuid-1",
							id: "case_name",
							type: "text",
							label: "Patient Name",
						},
						{
							uuid: "q-uuid-2",
							id: "age",
							type: "int",
							label: "Age",
						},
					],
				},
			],
		},
	],
	case_types: [
		{
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name" },
				{ name: "age", label: "Age" },
			],
		},
	],
};

// ── Scaffold fixture ────────────────────────────────────────────────────

/** Scaffold payload with top-level keys (matches the wire format). */
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

// ── Test helpers ────────────────────────────────────────────────────────

/** Wire up a fresh pair of stores like SyncBridge does at runtime. */
function createWiredStores(): {
	docStore: BlueprintDocStoreApi;
	sessionStore: BuilderSessionStoreApi;
} {
	const docStore = createBlueprintDocStore();
	const sessionStore = createBuilderSessionStore();
	sessionStore.getState()._setDocStore(docStore);
	return { docStore, sessionStore };
}

/** Load an initial blueprint into the doc store and resume undo tracking. */
function hydrateDoc(docStore: BlueprintDocStoreApi, bp: AppBlueprint): void {
	docStore.getState().load(bp, "test-app-id");
	docStore.temporal.getState().resume();
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

			/* The form should now have 2 questions. */
			const doc = docStore.getState();
			const questionUuids = doc.questionOrder[formUuid];
			assert(questionUuids);
			expect(questionUuids).toHaveLength(2);
			expect(doc.questions[questionUuids[0]].id).toBe("patient_name");
			expect(doc.questions[questionUuids[1]].id).toBe("patient_age");
		});
	});

	// ── Category 2: Doc lifecycle events ────────────────────────────────

	describe("data-done", () => {
		it("loads final blueprint, sets justCompleted=true, clears agentActive", () => {
			/* Simulate a generation session: start build, then done. */
			applyStreamEvent("data-start-build", {}, docStore, sessionStore);

			applyStreamEvent(
				"data-done",
				{ blueprint: MINIMAL_BP as unknown as Record<string, unknown> },
				docStore,
				sessionStore,
			);

			/* Doc should have the blueprint's content. */
			const doc = docStore.getState();
			expect(doc.appName).toBe("Test App");
			expect(doc.moduleOrder).toHaveLength(1);

			/* Session should be in post-generation state. */
			const session = sessionStore.getState();
			expect(session.justCompleted).toBe(true);
			expect(session.agentActive).toBe(false);

			/* Doc undo tracking should be resumed — endAgentWrite on the session
			 * store cascades to docStore.endAgentWrite() which resumes temporal. */
			expect(docStore.temporal.getState().isTracking).toBe(true);
		});
	});

	describe("data-blueprint-updated", () => {
		it("loads updated blueprint, does NOT set justCompleted", () => {
			/* Pre-load an initial blueprint (simulates an existing app). */
			hydrateDoc(docStore, MINIMAL_BP);
			sessionStore.getState().setAppId("test-app-id");

			applyStreamEvent(
				"data-blueprint-updated",
				{
					blueprint: EDITED_BP as unknown as Record<string, unknown>,
				},
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
			hydrateDoc(docStore, MINIMAL_BP);

			applyStreamEvent(
				"data-blueprint-updated",
				{
					blueprint: EDITED_BP as unknown as Record<string, unknown>,
				},
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
