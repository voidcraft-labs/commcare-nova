/** Client integration of admitted server edits, real reconciliation, and session lifecycle. */
import { afterEach, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { createReconciler, type Reconciler } from "@/lib/collab/reconciler";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { docHasData } from "@/lib/doc/predicates";
import type { Mutation } from "@/lib/doc/types";
import { blueprintDocSchema } from "@/lib/domain";
import type { MutationEvent } from "@/lib/log/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { deriveChatAppReady, derivePhase } from "@/lib/session/hooks";
import { deriveAgentError, deriveAgentStage } from "@/lib/session/lifecycle";
import { GenerationStage } from "@/lib/session/types";
import { signalGrid } from "@/lib/signalGrid/store";
import { toastStore } from "@/lib/ui/toastStore";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores, hydrateDoc } from "./testHelpers";

const owned: Array<{ reconciler: Reconciler; endRun: () => void }> = [];
afterEach(() => {
	for (const owner of owned.splice(0)) {
		owner.endRun();
		owner.reconciler.dispose();
	}
	toastStore.clear();
	signalGrid.reset();
});
function setup(initialBuild = false) {
	const { docStore, sessionStore } = createWiredStores();
	const base = buildDoc({
		appId: "app-1",
		appName: "Health visits",
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
	});
	blueprintDocSchema.parse(toPersistableDoc(base));
	expect(mutationCommitVerdict(base, [], LOOKUP_CONTEXT_UNAVAILABLE).ok).toBe(
		true,
	);
	hydrateDoc(docStore, toPersistableDoc(base));
	const reconciler = createReconciler(
		docStore,
		{ appId: "app-1", baseSeq: 1, baseDoc: base, userId: "actor" },
		{
			put: async () => {
				throw new Error("A persisted chat edit must not issue an author PUT");
			},
			reload: async () => {
				throw new Error("This ordered server stream must not need a reload");
			},
			canEdit: () => true,
			resubscribe: () => {
				throw new Error("Unexpected reconnect");
			},
			scheduleRetry: () => {
				throw new Error("Unexpected retry");
			},
		},
	);
	if (initialBuild) sessionStore.getState().markBuildUnfinished();
	sessionStore.getState().beginRun({ startedWithData: !initialBuild });
	reconciler.setSelfActiveRunId("run-1");
	let running = true;
	const endRun = () => {
		if (running) {
			running = false;
			sessionStore.getState().endRun();
		}
	};
	owned.push({ reconciler, endRun });
	function deliver(mutations: readonly Mutation[], stage: string, seq: number) {
		const verdict = mutationCommitVerdict(
			docStore.getState(),
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
		blueprintDocSchema.parse(toPersistableDoc(verdict.nextDoc));
		const events: MutationEvent[] = mutations.map((mutation, index) => ({
			kind: "mutation",
			runId: "run-1",
			ts: seq,
			seq: index,
			source: "chat",
			actor: "agent",
			stage,
			mutation,
		}));
		const payload = JSON.parse(
			JSON.stringify({
				mutations: verdict.mutations,
				events,
				batchId: `batch-${seq}`,
				seq,
			}),
		);
		applyStreamEvent(
			"data-mutations",
			payload,
			docStore,
			sessionStore,
			reconciler,
			"run-1",
		);
		expect(sessionStore.getState().events.slice(-events.length)).toEqual(
			events,
		);
		return verdict.nextDoc;
	}
	const phase = () =>
		derivePhase(sessionStore.getState(), docHasData(docStore.getState()));
	return { docStore, sessionStore, reconciler, phase, endRun, deliver };
}

it("materialized build stays locked between slices, then actual data-done seeds the final snapshot and completion", () => {
	const { docStore, sessionStore, reconciler, phase, endRun, deliver } =
		setup(true);
	expect(phase()).toBe(BuilderPhase.Generating);
	expect(deriveChatAppReady(sessionStore.getState(), true)).toBe(false);
	const finalDoc = deliver(
		[{ kind: "setAppName", name: "Completed visits" }],
		"form:0-0",
		2,
	);
	expect(deriveAgentStage(sessionStore.getState().events)).toBe(
		GenerationStage.Build,
	);
	expect(docStore.getState().canUndo).toBe(false);
	applyStreamEvent(
		"data-done",
		{ doc: toPersistableDoc(finalDoc), seq: 2 },
		docStore,
		sessionStore,
		reconciler,
		"run-1",
	);
	expect(phase()).toBe(BuilderPhase.Completed);
	expect(deriveChatAppReady(sessionStore.getState(), true)).toBe(true);
	expect(reconciler.getSnapshot().baseSeq).toBe(2);
	expect(reconciler.getSnapshot().sentPending).toEqual([]);
	sessionStore.getState().markBuildFinished();
	endRun();
	expect(sessionStore.getState().events).toEqual([]);
	expect(phase()).toBe(BuilderPhase.Completed);
	sessionStore.getState().acknowledgeCompletion();
	expect(phase()).toBe(BuilderPhase.Ready);
	docStore.getState().applyMany([{ kind: "setAppName", name: "User rename" }]);
	docStore.getState().undo();
	expect(docStore.getState().appName).toBe("Completed visits");
	expect(docStore.getState().canUndo).toBe(false);
});

it("an edit stays ready and a terminal conversation error preserves the admitted document without completion", () => {
	const { docStore, sessionStore, reconciler, phase, endRun, deliver } =
		setup();
	const doc = deliver(
		[{ kind: "setAppName", name: "Edited visits" }],
		"app",
		2,
	);
	expect(phase()).toBe(BuilderPhase.Ready);
	applyStreamEvent(
		"data-conversation-event",
		{
			kind: "conversation",
			runId: "run-1",
			ts: 3,
			seq: 3,
			source: "chat",
			payload: {
				type: "error",
				error: {
					type: "rate_limit",
					message: "Provider unavailable",
					fatal: true,
				},
			},
		},
		docStore,
		sessionStore,
		reconciler,
		"run-1",
	);
	expect(deriveAgentError(sessionStore.getState().events)).toEqual({
		message: "Provider unavailable",
		severity: "failed",
	});
	expect(toPersistableDoc(docStore.getState())).toEqual(toPersistableDoc(doc));
	endRun();
	expect(sessionStore.getState().runCompletedAt).toBeUndefined();
	expect(phase()).toBe(BuilderPhase.Ready);
});
