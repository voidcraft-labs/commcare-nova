/**
 * End-to-end generation lifecycle test.
 *
 * Replays the event sequence the server emits during a real generation
 * run — stage-tagged mutation batches + validation-attempt conversation
 * events — and verifies that:
 *   - The doc state advances as mutations land.
 *   - The session events buffer mirrors the wire envelopes.
 *   - Run boundaries (`beginRun` / `endRun` / `markRunCompleted`)
 *     transition the buffer + `runCompletedAt` correctly.
 *   - Derived lifecycle (phase / stage / status) matches the emissions.
 *
 * Uses real stores wired together and drives them through the
 * `data-mutations` + `data-conversation-event` dispatcher paths — the
 * same paths the live server exercises. Phase derivation is the real
 * `derivePhase` from `lib/session/hooks`. Priority chain:
 *   Loading > Completed > Generating > Ready > Idle.
 */

import { assert, describe, expect, it } from "vitest";
import { docHasData } from "@/lib/doc/predicates";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { derivePhase } from "@/lib/session/hooks";
import { deriveAgentStage } from "@/lib/session/lifecycle";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { GenerationStage } from "@/lib/session/types";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

// ── Test helpers ───────────────────────────────────────────────────────

/**
 * Wrapper around the real `derivePhase` — reads the wired stores and
 * returns the phase. Kept as a helper (rather than inlining at each
 * call site) because the test file already had the name and it's a
 * simple pass-through.
 */
function derivePhaseLocal(
	sessionStore: BuilderSessionStoreApi,
	docStore: BlueprintDocStoreApi,
): BuilderPhase {
	const s = sessionStore.getState();
	return derivePhase(
		{
			loading: s.loading,
			runCompletedAt: s.runCompletedAt,
			events: s.events,
		},
		docHasData(docStore.getState()),
	);
}

/** Build MutationEvent envelopes. Mirrors the shape the server emits. */
function envelopes(mutations: Mutation[], stage: string): MutationEvent[] {
	return mutations.map((mutation, i) => ({
		kind: "mutation",
		runId: "test-run",
		ts: 0,
		seq: i,
		actor: "agent",
		stage,
		mutation,
	}));
}

/** Build a ConversationEvent envelope. */
function convEvent(payload: ConversationPayload, seq = 0): ConversationEvent {
	return { kind: "conversation", runId: "test-run", ts: 0, seq, payload };
}

/** Emit a data-mutations batch via the dispatcher (includes the
 *  envelopes alongside the raw mutations, matching server shape). */
function emitMutations(
	mutations: Mutation[],
	stage: string,
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
): void {
	applyStreamEvent(
		"data-mutations",
		{ mutations, events: envelopes(mutations, stage), stage },
		docStore,
		sessionStore,
	);
}

/** Emit a data-conversation-event via the dispatcher. */
function emitConversation(
	payload: ConversationPayload,
	seq: number,
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
): void {
	applyStreamEvent(
		"data-conversation-event",
		convEvent(payload, seq) as unknown as Record<string, unknown>,
		docStore,
		sessionStore,
	);
}

// ── Fixture data ──────────────────────────────────────────────────────

const MOD_UUID = asUuid("mod-registration");
const FORM_UUID = asUuid("form-register");
const Q_NAME_UUID = asUuid("q-patient-name");
const Q_AGE_UUID = asUuid("q-patient-age");

const CASE_TYPES = [
	{ name: "patient", properties: [{ name: "name", label: "Name" }] },
];

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
	 * pause-on-beginRun / resume-on-endRun transitions, which require
	 * temporal to start in the tracking state. */
	const createStores = () => createWiredStores({ resumeUndo: true });

	it("full build: Idle → Generating → Ready via stage-tagged mutations", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();
		const doc = () => docStore.getState();

		// ── Pre-generation: Idle ──
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Idle);
		expect(s().events).toHaveLength(0);

		// ── Begin run (chat status effect's responsibility live) ──
		s().beginRun();
		/* beginRun pauses doc undo. The events buffer — which drives
		 * lifecycle derivations — is empty at this instant but will fill
		 * as the stream dispatcher pushes events. */
		expect(docStore.temporal.getState().isTracking).toBe(false);

		// ── Schema mutation lands → stage = DataModel ──
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			"schema",
			docStore,
			sessionStore,
		);
		expect(doc().caseTypes).toEqual(CASE_TYPES);
		expect(deriveAgentStage(s().events)).toBe(GenerationStage.DataModel);
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(
			BuilderPhase.Generating,
		);

		// ── Scaffold mutations → stage = Structure ──
		emitMutations(SCAFFOLD_MUTATIONS, "scaffold", docStore, sessionStore);
		expect(doc().moduleOrder).toEqual([MOD_UUID]);
		expect(deriveAgentStage(s().events)).toBe(GenerationStage.Structure);

		// ── Module-detail mutation → stage = Modules ──
		const columns = [{ field: "name", header: "Name" }];
		emitMutations(
			[
				{
					kind: "updateModule",
					uuid: MOD_UUID,
					patch: { caseListColumns: columns },
				},
			],
			"module:0",
			docStore,
			sessionStore,
		);
		expect(doc().modules[MOD_UUID].caseListColumns).toEqual(columns);
		expect(deriveAgentStage(s().events)).toBe(GenerationStage.Modules);

		// ── Form-content mutations → stage = Forms ──
		emitMutations(FORM_CONTENT_MUTATIONS, "form:0-0", docStore, sessionStore);
		expect(doc().fieldOrder[FORM_UUID]).toEqual([Q_NAME_UUID, Q_AGE_UUID]);
		expect(deriveAgentStage(s().events)).toBe(GenerationStage.Forms);

		// ── data-done arrives (models the dispatcher's markRunCompleted) ──
		s().markRunCompleted();
		expect(s().runCompletedAt).toEqual(expect.any(Number));
		// ── Stream closes (models the chat status effect's endRun) ──
		s().endRun();
		/* endRun clears the events buffer + resumes doc undo. The
		 * celebration stamp survives — it's orthogonal to stream close. */
		expect(s().events).toEqual([]);
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(
			BuilderPhase.Completed,
		);
		expect(docStore.temporal.getState().isTracking).toBe(true);

		// ── acknowledgeCompletion (celebration animation settled) ──
		s().acknowledgeCompletion();
		expect(s().runCompletedAt).toBeUndefined();
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Ready);
	});

	it("fix loop: validation-attempt conversation event + fix:attempt-N mutations", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		s().beginRun();
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			"schema",
			docStore,
			sessionStore,
		);
		emitMutations(SCAFFOLD_MUTATIONS, "scaffold", docStore, sessionStore);
		emitMutations(FORM_CONTENT_MUTATIONS, "form:0-0", docStore, sessionStore);

		// ── First validation round finds 2 errors ──
		emitConversation(
			{
				type: "validation-attempt",
				attempt: 1,
				errors: ["bad xpath", "missing label"],
			},
			10,
			docStore,
			sessionStore,
		);

		/* The validation-attempt event lands on the buffer; a reader
		 * projects "Fixing 2 errors, attempt 1" as the status message. */
		const attemptEv = s().events.at(-1);
		assert(
			attemptEv?.kind === "conversation" &&
				attemptEv.payload.type === "validation-attempt",
		);
		expect(attemptEv.payload.attempt).toBe(1);
		expect(attemptEv.payload.errors).toHaveLength(2);

		// ── Fix mutations land with fix:attempt-1 stage tag ──
		emitMutations(
			[
				{
					kind: "updateField",
					uuid: Q_NAME_UUID,
					patch: { label: "Patient Full Name" },
				},
			],
			"fix:attempt-1",
			docStore,
			sessionStore,
		);
		const nameField = docStore.getState().fields[Q_NAME_UUID];
		assert(nameField && nameField.kind === "text");
		expect(nameField.label).toBe("Patient Full Name");
		expect(deriveAgentStage(s().events)).toBe(GenerationStage.Fix);

		// ── Done ──
		s().markRunCompleted();
		s().endRun();
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(
			BuilderPhase.Completed,
		);
	});

	it("mid-stream error: doc state preserved, error appended to buffer", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		s().beginRun();
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			"schema",
			docStore,
			sessionStore,
		);
		emitMutations(SCAFFOLD_MUTATIONS, "scaffold", docStore, sessionStore);

		expect(docStore.getState().moduleOrder).toHaveLength(1);

		// ── Error arrives as a conversation event ──
		emitConversation(
			{
				type: "error",
				error: {
					type: "rate_limit",
					message: "Rate limit exceeded",
					fatal: true,
				},
			},
			10,
			docStore,
			sessionStore,
		);

		const errEv = s().events.at(-1);
		assert(errEv?.kind === "conversation" && errEv.payload.type === "error");
		expect(errEv.payload.error.fatal).toBe(true);
		/* Buffer still holds the run's events (endRun hasn't fired). */
		expect(s().events.length).toBeGreaterThan(0);
		/* Doc entities preserved. */
		expect(docStore.getState().moduleOrder).toHaveLength(1);
	});

	it("post-build edit: stays Ready, no Generating phase", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		// Full completed build.
		s().beginRun();
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			"schema",
			docStore,
			sessionStore,
		);
		emitMutations(SCAFFOLD_MUTATIONS, "scaffold", docStore, sessionStore);
		s().markRunCompleted();
		s().endRun();
		s().acknowledgeCompletion();
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Ready);

		// ── Post-build edit: new run opens on an app with data ──
		s().beginRun();
		/* Buffer has been cleared by beginRun; no schema/scaffold events yet
		 * in this new run → no build foundation → phase stays Ready
		 * (suppresses Generating) even once edit-tool mutations land. */
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Ready);

		// Edit-tool mutation — `updateForm` emits `form:M-F` stage. This
		// stage tag matches initial-build `addQuestions`, but with no
		// schema/scaffold foundation in the buffer, derivePhase stays
		// Ready.
		emitMutations(
			[
				{
					kind: "updateForm",
					uuid: FORM_UUID,
					patch: { name: "Register (Edited)" },
				},
			],
			"form:0-0",
			docStore,
			sessionStore,
		);
		expect(docStore.getState().forms[FORM_UUID].name).toBe("Register (Edited)");
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Ready);

		// Stream closes.
		s().endRun();
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Ready);
	});

	it("undo after generation: generation not in history, user edits are", () => {
		const { docStore, sessionStore } = createStores();
		const s = () => sessionStore.getState();

		s().beginRun();
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			"schema",
			docStore,
			sessionStore,
		);
		emitMutations(SCAFFOLD_MUTATIONS, "scaffold", docStore, sessionStore);
		emitMutations(FORM_CONTENT_MUTATIONS, "form:0-0", docStore, sessionStore);
		s().markRunCompleted();
		s().endRun();

		expect(docStore.getState().appName).toBe("Health App");
		/* Undo was paused by beginRun → resumed by endRun. User edits now
		 * enter history; the generation itself did not. */
		expect(docStore.temporal.getState().isTracking).toBe(true);

		docStore.getState().applyMany([{ kind: "setAppName", name: "Renamed" }]);
		expect(docStore.getState().appName).toBe("Renamed");

		docStore.temporal.getState().undo();
		expect(docStore.getState().appName).toBe("Health App");

		/* Can't undo further — generation mutations never entered history. */
		docStore.temporal.getState().undo();
		expect(docStore.getState().appName).toBe("Health App");
	});
});
