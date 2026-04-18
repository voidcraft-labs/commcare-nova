/**
 * End-to-end generation lifecycle test.
 *
 * Replays the exact event sequence the server emits during a real
 * generation run, verifying phase transitions, stage progression, doc
 * state, and undo behavior at each step. This is the test that would
 * have caught the missing data-model stage, the endAgentWrite race,
 * and any future regression in the generation→builder handshake.
 *
 * Uses real stores (doc + session) wired together, no mocks. Doc-state
 * deltas flow through `data-mutations` — the canonical Phase 3+ live
 * emission path — so this suite exercises the same code path the server
 * runs in production.
 */

import { assert, describe, expect, it } from "vitest";
import { docHasData } from "@/lib/doc/predicates";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type PersistableDoc } from "@/lib/domain";
import { BuilderPhase } from "@/lib/services/builder";
import { derivePhase } from "@/lib/session/hooks";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { GenerationStage } from "@/lib/session/types";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

// ── Test helpers ───────────────────────────────────────────────────────

/**
 * Derive a `PersistableDoc` snapshot from the current doc-store state —
 * strips the in-memory `fieldParent` reverse-index (rebuilt on load) so
 * the snapshot matches the wire shape the SA emits in `data-done` and
 * `data-blueprint-updated` events.
 */
function snapshotDoc(docStore: BlueprintDocStoreApi): PersistableDoc {
	const { fieldParent: _fp, ...persistable } = docStore.getState();
	return persistable;
}

/**
 * Derive the current builder phase from the wired stores — identical
 * logic to `useBuilderPhase`, sharing the same `docHasData` predicate so
 * the test can't drift from the hook's definition of "has data".
 */
function phase(
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
): BuilderPhase {
	return derivePhase(sessionStore.getState(), docHasData(docStore.getState()));
}

/** Fire an event through the dispatcher. */
function emit(
	type: string,
	data: Record<string, unknown>,
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
) {
	applyStreamEvent(type, data, docStore, sessionStore);
}

/** Emit a `data-mutations` batch — shorthand wrapper. */
function emitMutations(
	mutations: Mutation[],
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
) {
	emit("data-mutations", { mutations }, docStore, sessionStore);
}

// ── Fixture data ──────────────────────────────────────────────────────

/** Stable UUIDs used across the tests so mutations target deterministic
 *  entities and assertions can key off known ids. */
const MOD_UUID = asUuid("mod-registration");
const FORM_UUID = asUuid("form-register");
const Q_NAME_UUID = asUuid("q-patient-name");
const Q_AGE_UUID = asUuid("q-patient-age");

const CASE_TYPES = [
	{ name: "patient", properties: [{ name: "name", label: "Name" }] },
];

/**
 * Scaffold mutation batch — the server emits these atomically during
 * the structure stage: app name + one module + one form.
 */
const SCAFFOLD_MUTATIONS: Mutation[] = [
	{ kind: "setAppName", name: "Health App" },
	{
		kind: "addModule",
		module: {
			uuid: MOD_UUID,
			id: "registration",
			name: "Registration",
			caseType: "patient",
		},
	},
	{
		kind: "addForm",
		moduleUuid: MOD_UUID,
		form: {
			uuid: FORM_UUID,
			id: "register",
			name: "Register",
			type: "registration",
		},
	},
];

/**
 * Form-content mutation batch — two `addField` mutations land the
 * question content inside the scaffolded form during the forms stage.
 */
const FORM_CONTENT_MUTATIONS: Mutation[] = [
	{
		kind: "addField",
		parentUuid: FORM_UUID,
		field: {
			uuid: Q_NAME_UUID,
			id: "patient_name",
			kind: "text",
			label: "Patient Name",
		},
	},
	{
		kind: "addField",
		parentUuid: FORM_UUID,
		field: {
			uuid: Q_AGE_UUID,
			id: "patient_age",
			kind: "int",
			label: "Age",
		},
	},
];

// ── Tests ──────────────────────────────────────────────────────────────

describe("generation lifecycle (end-to-end)", () => {
	/* Every test opts into active undo tracking — the suite verifies
	 * pause-on-beginAgentWrite / resume-on-endAgentWrite transitions, which
	 * require temporal to start in the tracking state. */
	const createStores = () => createWiredStores({ resumeUndo: true });

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

		// ── data-mutations: setCaseTypes ──
		// The data-model stage emits the case-type schema as a single
		// `setCaseTypes` mutation.
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			docStore,
			sessionStore,
		);
		expect(doc().caseTypes).toEqual(CASE_TYPES);
		// Still in DataModel stage
		expect(s().agentStage).toBe(GenerationStage.DataModel);

		// ── data-phase: structure ──
		// (emitted by generateScaffold's onInputStart)
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Structure);
		expect(s().statusMessage).toBe("Designing app structure");

		// ── data-mutations: scaffold ──
		// Atomic batch of `setAppName` + `addModule` + `addForm` drops the
		// module + form shell onto the doc.
		emitMutations(SCAFFOLD_MUTATIONS, docStore, sessionStore);
		// Doc now has modules and forms
		expect(doc().moduleOrder).toEqual([MOD_UUID]);
		expect(doc().modules[MOD_UUID].name).toBe("Registration");
		expect(doc().formOrder[MOD_UUID]).toEqual([FORM_UUID]);

		// ── data-phase: modules ──
		emit("data-phase", { phase: "modules" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Modules);
		expect(s().statusMessage).toBe("Building app content");

		// ── data-mutations: module details (caseListColumns) ──
		// Module-stage output — `updateModule` patches the case-list UI.
		const columns = [{ field: "name", header: "Name" }];
		emitMutations(
			[
				{
					kind: "updateModule",
					uuid: MOD_UUID,
					patch: { caseListColumns: columns },
				},
			],
			docStore,
			sessionStore,
		);
		expect(doc().modules[MOD_UUID].caseListColumns).toEqual(columns);

		// ── data-phase: forms ──
		emit("data-phase", { phase: "forms" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Forms);

		// ── data-mutations: form content ──
		// Two `addField` mutations land the question content inside the
		// scaffolded form.
		emitMutations(FORM_CONTENT_MUTATIONS, docStore, sessionStore);
		// Form should have questions now
		const topQuestions = doc().fieldOrder[FORM_UUID] ?? [];
		expect(topQuestions).toEqual([Q_NAME_UUID, Q_AGE_UUID]);

		// ── data-phase: validate ──
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Validate);
		expect(s().statusMessage).toBe("Validating blueprint");

		// ── data-app-saved ──
		emit("data-app-saved", { appId: "app-123" }, docStore, sessionStore);
		expect(s().appId).toBe("app-123");

		// ── data-done (with final doc snapshot) ──
		emit("data-done", { doc: snapshotDoc(docStore) }, docStore, sessionStore);

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

	it("fix loop: Validate → Fix → data-fix-attempt → fix mutation → Validate → Done", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		// Fast-forward to a state with scaffold + forms via mutation batches.
		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emitMutations(SCAFFOLD_MUTATIONS, docStore, sessionStore);
		emit("data-phase", { phase: "modules" }, docStore, sessionStore);
		emit("data-phase", { phase: "forms" }, docStore, sessionStore);
		emitMutations(FORM_CONTENT_MUTATIONS, docStore, sessionStore);

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

		// ── Fix mutation — fix loop emits targeted `updateField` to
		// re-label the first question (mimicking a validator fix). */
		emitMutations(
			[
				{
					kind: "updateField",
					uuid: Q_NAME_UUID,
					patch: { label: "Patient Full Name" },
				},
			],
			docStore,
			sessionStore,
		);
		/* Narrow by kind so the discriminated field union exposes `label`
		 * (hidden fields omit it). The fixture creates a text field. */
		const nameField = docStore.getState().fields[Q_NAME_UUID];
		assert(nameField && nameField.kind === "text");
		expect(nameField.label).toBe("Patient Full Name");

		// ── Back to validate ──
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		expect(s().agentStage).toBe(GenerationStage.Validate);

		// ── Done ──
		emit("data-done", { doc: snapshotDoc(docStore) }, docStore, sessionStore);
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Completed);
	});

	it("mid-stream error preserves partial doc state", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emitMutations(SCAFFOLD_MUTATIONS, docStore, sessionStore);

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

		// Set up a completed app via mutation batches.
		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emitMutations(SCAFFOLD_MUTATIONS, docStore, sessionStore);
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		emit("data-done", { doc: snapshotDoc(docStore) }, docStore, sessionStore);
		s().setAgentActive(false);
		s().acknowledgeCompletion();
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Ready);

		// ── Post-build edit: SA modifies the app ──
		// Chat status effect fires setAgentActive(true) — doc has data
		s().setAgentActive(true);
		expect(s().postBuildEdit).toBe(true);
		// Phase stays Ready for post-build edits
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Ready);

		// SA sends a blueprint-updated event (coarse edit tool) carrying a
		// renamed doc. Build the edited payload from the current snapshot so
		// all uuids + relationships remain coherent.
		const editedDoc: PersistableDoc = {
			...snapshotDoc(docStore),
			appName: "Edited App",
		};
		emit("data-blueprint-updated", { doc: editedDoc }, docStore, sessionStore);
		expect(docStore.getState().appName).toBe("Edited App");
		// Still Ready (no justCompleted for edit-tool responses)
		expect(s().justCompleted).toBe(false);
		expect(phase(docStore, sessionStore)).toBe(BuilderPhase.Ready);
	});

	it("undo after generation reverses the entire build", () => {
		const { docStore, sessionStore } = createStores();

		// Full generation driven by mutation batches.
		emit("data-start-build", {}, docStore, sessionStore);
		emit("data-phase", { phase: "data-model" }, docStore, sessionStore);
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			docStore,
			sessionStore,
		);
		emit("data-phase", { phase: "structure" }, docStore, sessionStore);
		emitMutations(SCAFFOLD_MUTATIONS, docStore, sessionStore);
		emit("data-phase", { phase: "modules" }, docStore, sessionStore);
		emit("data-phase", { phase: "forms" }, docStore, sessionStore);
		emitMutations(FORM_CONTENT_MUTATIONS, docStore, sessionStore);
		emit("data-phase", { phase: "validate" }, docStore, sessionStore);
		emit("data-done", { doc: snapshotDoc(docStore) }, docStore, sessionStore);

		// Doc has data
		expect(docStore.getState().moduleOrder).toHaveLength(1);
		expect(docStore.getState().appName).toBe("Health App");

		// Undo tracking was paused during generation, resumed on data-done.
		// The entire generation is NOT in undo history — load() cleared it.
		// User edits AFTER this point are undoable.
		expect(docStore.temporal.getState().isTracking).toBe(true);

		// Make a user edit (this enters undo history)
		docStore.getState().applyMany([{ kind: "setAppName", name: "Renamed" }]);
		expect(docStore.getState().appName).toBe("Renamed");

		// Undo the user edit
		docStore.temporal.getState().undo();
		expect(docStore.getState().appName).toBe("Health App");

		// Can't undo further — generation is not in history
		docStore.temporal.getState().undo();
		expect(docStore.getState().appName).toBe("Health App");
	});
});
