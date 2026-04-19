/**
 * End-to-end generation lifecycle test.
 *
 * Replays the event sequence the server emits during a real generation
 * run — stage-tagged mutation batches + validation-attempt conversation
 * events — and verifies that:
 *   - The doc state advances as mutations land.
 *   - The session events buffer mirrors the wire envelopes.
 *   - Run lifecycle (agentActive / runCompletedAt) transitions correctly.
 *   - Derived lifecycle (phase / stage / status message) matches the
 *     emissions shape.
 *
 * Uses real stores wired together and drives them through the
 * `data-mutations` + `data-conversation-event` dispatcher paths — the
 * same paths the live server exercises.
 *
 * Lifecycle derivation is stubbed locally against `session.events` +
 * `agentActive` + `runCompletedAt` to decouple from the Task 4
 * `derivePhase` rewrite. The derivation rules mirror the final
 * implementation: Loading > Completed > Generating > Ready > Idle.
 */

import { assert, describe, expect, it } from "vitest";
import { docHasData } from "@/lib/doc/predicates";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type PersistableDoc } from "@/lib/domain";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import { BuilderPhase } from "@/lib/services/builder";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { GenerationStage } from "@/lib/session/types";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

// ── Test helpers ───────────────────────────────────────────────────────

function snapshotDoc(docStore: BlueprintDocStoreApi): PersistableDoc {
	const { fieldParent: _fp, ...persistable } = docStore.getState();
	return persistable;
}

/**
 * Local `derivePhase` shim — matches the Task 4 contract so these tests
 * stay useful through the transition. Reads session.events for stage
 * derivation (latest mutation event with a generation-stage tag) and
 * session state for the active/completed flags.
 */
function derivePhaseLocal(
	sessionStore: BuilderSessionStoreApi,
	docStore: BlueprintDocStoreApi,
): BuilderPhase {
	const s = sessionStore.getState();
	const hasData = docHasData(docStore.getState());

	if (s.loading) return BuilderPhase.Loading;
	if (s.runCompletedAt !== undefined) return BuilderPhase.Completed;

	const stage = latestGenerationStage(s.events);
	const postBuild = derivePostBuildEditLocal(s.events, s.agentActive, hasData);
	if (s.agentActive && !postBuild && stage !== null) {
		return BuilderPhase.Generating;
	}
	if (hasData) return BuilderPhase.Ready;
	return BuilderPhase.Idle;
}

function latestGenerationStage(
	events:
		| readonly MutationEvent[]
		| readonly ConversationEvent[]
		| readonly unknown[],
): GenerationStage | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i] as { kind: string; stage?: string };
		if (e.kind !== "mutation" || !e.stage) continue;
		if (e.stage === "schema") return GenerationStage.DataModel;
		if (e.stage === "scaffold") return GenerationStage.Structure;
		if (e.stage === "module:create") continue;
		if (e.stage.startsWith("module:remove:")) continue;
		if (e.stage.startsWith("module:")) return GenerationStage.Modules;
		if (e.stage.startsWith("form:")) return GenerationStage.Forms;
		if (e.stage.startsWith("fix")) return GenerationStage.Fix;
	}
	return null;
}

function derivePostBuildEditLocal(
	events: readonly unknown[],
	agentActive: boolean,
	hasData: boolean,
): boolean {
	if (!agentActive) return false;
	for (const e of events) {
		const ev = e as { kind: string; stage?: string };
		if (ev.kind !== "mutation" || !ev.stage) continue;
		if (ev.stage === "schema" || ev.stage === "scaffold") return false;
	}
	return hasData;
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
		expect(s().agentActive).toBe(true);
		expect(docStore.temporal.getState().isTracking).toBe(false);

		// ── Schema mutation lands → stage = DataModel ──
		emitMutations(
			[{ kind: "setCaseTypes", caseTypes: CASE_TYPES }],
			"schema",
			docStore,
			sessionStore,
		);
		expect(doc().caseTypes).toEqual(CASE_TYPES);
		expect(latestGenerationStage(s().events)).toBe(GenerationStage.DataModel);
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(
			BuilderPhase.Generating,
		);

		// ── Scaffold mutations → stage = Structure ──
		emitMutations(SCAFFOLD_MUTATIONS, "scaffold", docStore, sessionStore);
		expect(doc().moduleOrder).toEqual([MOD_UUID]);
		expect(latestGenerationStage(s().events)).toBe(GenerationStage.Structure);

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
		expect(latestGenerationStage(s().events)).toBe(GenerationStage.Modules);

		// ── Form-content mutations → stage = Forms ──
		emitMutations(FORM_CONTENT_MUTATIONS, "form:0-0", docStore, sessionStore);
		expect(doc().fieldOrder[FORM_UUID]).toEqual([Q_NAME_UUID, Q_AGE_UUID]);
		expect(latestGenerationStage(s().events)).toBe(GenerationStage.Forms);

		// ── End run (chat status effect's responsibility live) ──
		s().endRun(true);
		expect(s().runCompletedAt).toEqual(expect.any(Number));
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(
			BuilderPhase.Completed,
		);
		/* Doc undo resumed. */
		expect(docStore.temporal.getState().isTracking).toBe(true);

		// ── Chat status effect clears agentActive ──
		s().setAgentActive(false);
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(
			BuilderPhase.Completed,
		);

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
		expect(latestGenerationStage(s().events)).toBe(GenerationStage.Fix);

		// ── Done ──
		s().endRun(true);
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
		/* agentActive remains true — the chat status effect is what
		 * transitions the run lifecycle based on SSE stream closure. */
		expect(s().agentActive).toBe(true);
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
		s().endRun(true);
		s().setAgentActive(false);
		s().acknowledgeCompletion();
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Ready);

		// ── Post-build edit: new run opens on an app with data ──
		s().beginRun();
		/* Buffer has been cleared by beginRun; no schema/scaffold events yet
		 * in this new run → derivePostBuildEdit returns true → phase stays
		 * Ready (suppresses Generating). */
		expect(derivePhaseLocal(sessionStore, docStore)).toBe(BuilderPhase.Ready);

		// Edit-tool replacement lands a renamed doc.
		const editedDoc: PersistableDoc = {
			...snapshotDoc(docStore),
			appName: "Edited App",
		};
		applyStreamEvent(
			"data-blueprint-updated",
			{ doc: editedDoc as unknown as Record<string, unknown> },
			docStore,
			sessionStore,
		);
		expect(docStore.getState().appName).toBe("Edited App");
		/* Still Ready (no runCompletedAt stamp from the dispatcher). */
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
		s().endRun(true);

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
