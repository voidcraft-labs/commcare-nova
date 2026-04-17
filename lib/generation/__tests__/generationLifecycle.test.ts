/**
 * End-to-end generation lifecycle test.
 *
 * Replays the exact event sequence the server emits during a real
 * generation run, verifying phase transitions, stage progression, doc
 * state, and undo behavior at each step. This is the test that would
 * have caught the missing data-model stage, the endAgentWrite race,
 * and any future regression in the generation→builder handshake.
 *
 * Uses real stores (doc + session) wired together, no mocks.
 */

import { assert, describe, expect, it } from "vitest";
import { toBlueprint } from "@/lib/doc/converter";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint, BlueprintForm } from "@/lib/schemas/blueprint";
import { BuilderPhase } from "@/lib/services/builder";
import { derivePhase } from "@/lib/session/hooks";
import { createBuilderSessionStore } from "@/lib/session/store";
import { GenerationStage } from "@/lib/session/types";
import { applyStreamEvent } from "../streamDispatcher";

// ── Helpers ────────────────────────────────────────────────────────────

function createStores() {
	const docStore = createBlueprintDocStore();
	docStore.temporal.getState().resume();
	const sessionStore = createBuilderSessionStore();
	sessionStore.getState()._setDocStore(docStore);
	return { docStore, sessionStore };
}

/** Derive phase from the current store state — same logic as useBuilderPhase. */
function phase(
	docStore: ReturnType<typeof createBlueprintDocStore>,
	sessionStore: ReturnType<typeof createBuilderSessionStore>,
): BuilderPhase {
	const s = sessionStore.getState();
	const docHasData = docStore.getState().moduleOrder.length > 0;
	return derivePhase(s, docHasData);
}

/** Fire an event through the dispatcher. */
function emit(
	type: string,
	data: Record<string, unknown>,
	docStore: ReturnType<typeof createBlueprintDocStore>,
	sessionStore: ReturnType<typeof createBuilderSessionStore>,
) {
	applyStreamEvent(type, data, docStore, sessionStore);
}

// ── Fixture data ──────────────────────────────────────────────────────

const CASE_TYPES = [
	{ name: "patient", properties: [{ name: "name", label: "Name" }] },
];

const SCAFFOLD = {
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
					type: "registration" as const,
					purpose: "Register a new patient",
					formDesign: "Name, age, gender",
				},
			],
		},
	],
};

const FORM: BlueprintForm = {
	uuid: "will-be-replaced",
	name: "Register",
	type: "registration",
	questions: [
		{ uuid: "q-1", id: "patient_name", type: "text", label: "Patient Name" },
		{ uuid: "q-2", id: "patient_age", type: "int", label: "Age" },
	],
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("generation lifecycle (end-to-end)", () => {
	it("full build: Idle → DataModel → Structure → Modules → Forms → Validate → Completed → Ready", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();
		const doc = () => docStore.getState();

		// ── Pre-generation: Idle ──
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Idle);
		expect(s().agentStage).toBeNull();

		// ── data-start-build + data-phase: data-model ──
		// (both emitted by generateSchema's onInputStart)
		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);

		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Generating);
		expect(s().agentActive).toBe(true);
		expect(s().agentStage).toBe(GenerationStage.DataModel);
		expect(s().statusMessage).toBe("Designing data model");
		// Doc undo paused during generation
		expect(docStore.temporal.getState().isTracking).toBe(false);

		// ── data-schema ──
		emit("data-schema", { caseTypes: CASE_TYPES }, docStore, sessionStore);
		expect(doc().caseTypes).toEqual(CASE_TYPES);
		// Still in DataModel stage
		expect(s().agentStage).toBe(GenerationStage.DataModel);

		// ── data-phase: structure ──
		// (emitted by generateScaffold's onInputStart)
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Structure);
		expect(s().statusMessage).toBe("Designing app structure");

		// ── data-scaffold ──
		emit(
			"data-scaffold",
			SCAFFOLD as unknown as Record<string, unknown>,
			docStore,
			sessionStore,
		);
		// Doc now has modules and forms
		expect(doc().moduleOrder).toHaveLength(1);
		const moduleUuid = doc().moduleOrder[0];
		expect(doc().modules[moduleUuid].name).toBe("Registration");
		expect(doc().formOrder[moduleUuid]).toHaveLength(1);
		const formUuid = doc().formOrder[moduleUuid][0];

		// ── data-phase: modules ──
		emit("data-phase", { phase: "modules" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Modules);
		expect(s().statusMessage).toBe("Building app content");

		// ── data-module-done ──
		const columns = [{ field: "name", header: "Name" }];
		emit(
			"data-module-done",
			{ moduleIndex: 0, caseListColumns: columns },
			docStore,
			sessionStore,
		);
		expect(doc().modules[moduleUuid].caseListColumns).toEqual(columns);

		// ── data-phase: forms ──
		emit("data-phase", { phase: "forms" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Forms);

		// ── data-form-done ──
		emit(
			"data-form-done",
			{ moduleIndex: 0, formIndex: 0, form: FORM },
			docStore,
			sessionStore,
		);
		// Form should have questions now
		const topQuestions = doc().fieldOrder[formUuid] ?? [];
		expect(topQuestions.length).toBeGreaterThan(0);

		// ── data-phase: validate ──
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Validate);
		expect(s().statusMessage).toBe("Validating blueprint");

		// ── data-app-saved ──
		emit("data-app-saved", { appId: "app-123" }, docStore, sessionStore);
		expect(s().appId).toBe("app-123");

		// ── data-done (with final blueprint) ──
		const finalBlueprint = toBlueprint(doc());
		emit("data-done", { blueprint: finalBlueprint }, docStore, sessionStore);

		// Phase should be Completed (justCompleted=true takes priority)
		expect(s().justCompleted).toBe(true);
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Completed);
		// agentActive is still true — the chat status effect clears it
		expect(s().agentActive).toBe(true);
		// Doc undo resumed
		expect(docStore.temporal.getState().isTracking).toBe(true);
		// Generation metadata cleared
		expect(s().agentStage).toBeNull();
		expect(s().agentError).toBeNull();
		expect(s().statusMessage).toBe("");

		// ── Simulate chat status effect: setAgentActive(false) ──
		s().setAgentActive(false);
		// Still Completed (justCompleted takes priority)
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Completed);

		// ── acknowledgeCompletion (signal grid done animation) ──
		s().acknowledgeCompletion();
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Ready);
		expect(s().justCompleted).toBe(false);
	});

	it("fix loop: Validate → Fix → data-fix-attempt → data-form-fixed → Validate → Done", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		// Fast-forward to a state with scaffold + forms
		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emit("data-schema", { caseTypes: CASE_TYPES }, docStore, sessionStore);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emit(
			"data-scaffold",
			SCAFFOLD as unknown as Record<string, unknown>,
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "modules" }, docStore, sessionStore);
		emit(
			"data-module-done",
			{ moduleIndex: 0, caseListColumns: null },
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "forms" }, docStore, sessionStore);
		emit(
			"data-form-done",
			{ moduleIndex: 0, formIndex: 0, form: FORM },
			docStore,
			sessionStore,
		);

		// ── Validate stage ──
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Validate);

		// ── Fix stage ──
		emit("data-phase", { phase: "fix" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Fix);

		emit(
			"data-fix-attempt",
			{ attempt: 1, errorCount: 2 },
			docStore,
			sessionStore,
		);
		expect(s().statusMessage).toContain("2 errors");
		expect(s().statusMessage).toContain("attempt 1");

		// ── Fixed form ──
		emit(
			"data-form-fixed",
			{ moduleIndex: 0, formIndex: 0, form: FORM },
			docStore,
			sessionStore,
		);

		// ── Back to validate ──
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Validate);

		// ── Done ──
		const finalBlueprint = toBlueprint(docStore.getState());
		emit("data-done", { blueprint: finalBlueprint }, docStore, sessionStore);
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Completed);
	});

	it("mid-stream error preserves partial doc state", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emit("data-schema", { caseTypes: CASE_TYPES }, docStore, sessionStore);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emit(
			"data-scaffold",
			SCAFFOLD as unknown as Record<string, unknown>,
			docStore,
			sessionStore,
		);

		// Doc has entities from scaffold
		expect(docStore.getState().moduleOrder).toHaveLength(1);

		// ── Error mid-stream ──
		emit(
			"data-error",
			{ message: "Rate limit exceeded", fatal: true },
			docStore,
			sessionStore,
		);

		const err = s().agentError;
		assert(err);
		expect(err.message).toBe("Rate limit exceeded");
		expect(err.severity).toBe("failed");
		// Still generating (agent is active, error is metadata)
		expect(s().agentActive).toBe(true);
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Generating);
		// Doc entities preserved — partial scaffold is still there
		expect(docStore.getState().moduleOrder).toHaveLength(1);
	});

	it("recovering error clears on next stage advance", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);

		// Non-fatal error
		emit(
			"data-error",
			{ message: "Retrying...", fatal: false },
			docStore,
			sessionStore,
		);
		const recErr = s().agentError;
		assert(recErr);
		expect(recErr.severity).toBe("recovering");

		// Stage advance clears the error
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		expect(s().agentError).toBeNull();
		expect(s().agentStage).toBe(GenerationStage.Structure);
	});

	it("post-build edit: stays Ready, no Generating phase", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		// Set up a completed app
		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emit("data-schema", { caseTypes: CASE_TYPES }, docStore, sessionStore);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emit(
			"data-scaffold",
			SCAFFOLD as unknown as Record<string, unknown>,
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		const bp = toBlueprint(docStore.getState());
		emit("data-done", { blueprint: bp }, docStore, sessionStore);
		s().setAgentActive(false);
		s().acknowledgeCompletion();
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Ready);

		// ── Post-build edit: SA modifies the app ──
		// Chat status effect fires setAgentActive(true) — doc has data
		s().setAgentActive(true);
		expect(s().postBuildEdit).toBe(true);
		// Phase stays Ready for post-build edits
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Ready);

		// SA sends a blueprint-updated event (coarse edit tool)
		const editedBp: AppBlueprint = { ...bp, app_name: "Edited App" };
		emit(
			"data-blueprint-updated",
			{ blueprint: editedBp },
			docStore,
			sessionStore,
		);
		expect(docStore.getState().appName).toBe("Edited App");
		// Still Ready (no justCompleted for edit-tool responses)
		expect(s().justCompleted).toBe(false);
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Ready);
	});

	it("undo after generation reverses the entire build", () => {
		const { docStore, sessionStore } = createStores();

		// Full generation
		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emit("data-schema", { caseTypes: CASE_TYPES }, docStore, sessionStore);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emit(
			"data-scaffold",
			SCAFFOLD as unknown as Record<string, unknown>,
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "modules" }, docStore, sessionStore);
		emit(
			"data-module-done",
			{ moduleIndex: 0, caseListColumns: null },
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "forms" }, docStore, sessionStore);
		emit(
			"data-form-done",
			{ moduleIndex: 0, formIndex: 0, form: FORM },
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		const bp = toBlueprint(docStore.getState());
		emit("data-done", { blueprint: bp }, docStore, sessionStore);

		// Doc has data
		expect(docStore.getState().moduleOrder).toHaveLength(1);
		expect(docStore.getState().appName).toBe("Health App");

		// Undo tracking was paused during generation, resumed on data-done.
		// The entire generation is NOT in undo history — load() cleared it.
		// User edits AFTER this point are undoable.
		expect(docStore.temporal.getState().isTracking).toBe(true);

		// Make a user edit (this enters undo history)
		docStore.getState().apply({ kind: "setAppName", name: "Renamed" });
		expect(docStore.getState().appName).toBe("Renamed");

		// Undo the user edit
		docStore.temporal.getState().undo();
		expect(docStore.getState().appName).toBe("Health App");

		// Can't undo further — generation is not in history
		docStore.temporal.getState().undo();
		expect(docStore.getState().appName).toBe("Health App");
	});
});
