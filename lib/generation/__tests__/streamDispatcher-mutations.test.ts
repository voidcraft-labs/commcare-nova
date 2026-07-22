/**
 * Tests for the `data-mutations` dispatch branch in `applyStreamEvent`.
 *
 * The live server emits fine-grained `Mutation[]` batches directly via
 * `GenerationContext.emitMutations()` and now also ships the matching
 * `MutationEvent[]` envelopes in the same payload so the client can
 * mirror the persisted log into its session events buffer. These tests
 * verify that the dispatcher:
 *
 *   - applies single mutations and multi-mutation atomic batches,
 *   - appends the envelopes to the session events buffer,
 *   - gracefully ignores empty or missing payloads (neither store
 *     changes), and
 *   - carries the optional `stage` tag on each envelope.
 *
 * We use real wired stores (BlueprintDocStore + BuilderSessionStore) so
 * reducers and selectors run exactly as in production.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createReconciler } from "@/lib/collab/reconciler";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type { MutationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

/** Build MutationEvent envelopes for each mutation, stamping the
 *  optional stage tag — mirrors what `GenerationContext.emitMutations`
 *  now produces on the server. */
function envelopes(mutations: Mutation[], stage?: string): MutationEvent[] {
	return mutations.map((mutation, i) => ({
		kind: "mutation",
		runId: "test-run",
		ts: 0,
		seq: i,
		source: "chat",
		actor: "agent",
		...(stage && { stage }),
		mutation,
	}));
}

// ── Test suite ──────────────────────────────────────────────────────────

describe("applyStreamEvent — data-mutations", () => {
	let docStore: BlueprintDocStoreApi;
	let sessionStore: BuilderSessionStoreApi;

	beforeEach(() => {
		const stores = createWiredStores();
		docStore = stores.docStore;
		sessionStore = stores.sessionStore;
	});

	it("applies a single mutation AND appends its envelope to the buffer", () => {
		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Clinical Trial App" },
		];
		const events = envelopes(mutations, "schema");

		applyStreamEvent(
			"data-mutations",
			{ mutations, events, stage: "schema" },
			docStore,
			sessionStore,
			null,
			undefined,
		);

		expect(docStore.getState().appName).toBe("Clinical Trial App");
		expect(sessionStore.getState().events).toEqual(events);
	});

	it("applies a multi-mutation batch atomically AND appends all envelopes", () => {
		const moduleUuid = asUuid("mod-live-1");
		const formUuid = asUuid("form-live-1");

		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Field Survey" },
			{
				kind: "addModule",
				module: {
					uuid: moduleUuid,
					id: "intake",
					name: "Intake",
					caseType: "participant",
				},
			},
			{
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: formUuid,
					id: "enroll",
					name: "Enroll Participant",
					type: "registration",
				},
			},
		];
		const events = envelopes(mutations, "scaffold");

		applyStreamEvent(
			"data-mutations",
			{ mutations, events, stage: "scaffold" },
			docStore,
			sessionStore,
			null,
			undefined,
		);

		const doc = docStore.getState();
		expect(doc.appName).toBe("Field Survey");
		expect(doc.moduleOrder).toEqual([moduleUuid]);
		expect(doc.modules[moduleUuid]?.name).toBe("Intake");
		expect(doc.formOrder[moduleUuid]).toEqual([formUuid]);
		expect(doc.forms[formUuid]?.name).toBe("Enroll Participant");

		expect(sessionStore.getState().events).toHaveLength(3);
	});

	it("ignores an empty mutations array — neither store changes", () => {
		const docBefore = docStore.getState();
		const eventsBefore = sessionStore.getState().events;

		applyStreamEvent(
			"data-mutations",
			{ mutations: [] as Mutation[], events: [] as MutationEvent[] },
			docStore,
			sessionStore,
			null,
			undefined,
		);

		expect(docStore.getState().appName).toBe(docBefore.appName);
		expect(docStore.getState().moduleOrder).toBe(docBefore.moduleOrder);
		/* Reference-preserving on empty push. */
		expect(sessionStore.getState().events).toBe(eventsBefore);
	});

	it("ignores a payload with missing keys (no throw, no changes)", () => {
		const appNameBefore = docStore.getState().appName;
		const eventsBefore = sessionStore.getState().events;

		expect(() => {
			applyStreamEvent(
				"data-mutations",
				{},
				docStore,
				sessionStore,
				null,
				undefined,
			);
		}).not.toThrow();

		expect(docStore.getState().appName).toBe(appNameBefore);
		expect(sessionStore.getState().events).toBe(eventsBefore);
	});

	it("stamps the optional `stage` tag onto every envelope", () => {
		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Staged Build" },
		];
		const events = envelopes(mutations, "scaffold");

		applyStreamEvent(
			"data-mutations",
			{ mutations, events, stage: "scaffold" },
			docStore,
			sessionStore,
			null,
			undefined,
		);

		expect(docStore.getState().appName).toBe("Staged Build");
		const bufferEvent = sessionStore.getState().events[0];
		expect(bufferEvent?.kind).toBe("mutation");
		expect(bufferEvent?.kind === "mutation" && bufferEvent.stage).toBe(
			"scaffold",
		);
	});

	// The end-to-end echo-vs-register race across the two transports. The chat
	// commit writes Postgres (→ the /stream echo frame) BEFORE the
	// `data-mutations` chunk is written. When the echo lands FIRST, the reconciler
	// folds the batch into `displayed`; the late `data-mutations` chunk must NOT
	// re-apply it to the store, or the non-dedup `addModule` reducer splices the
	// module uuid twice and the builder tree renders it DUPLICATED for the rest of
	// the run (the P6/P7 bug, healed only at data-done).
	describe("echo-before-data-mutations race (no store duplication)", () => {
		const MOD = asUuid("mod-base");
		const NEW_MOD = asUuid("mod-added");

		/** A base doc with one module, hydrated + tracking (a live builder). */
		function seedDoc(store: BlueprintDocStoreApi): void {
			store.getState().load(
				toPersistableDoc({
					appId: "app-1",
					appName: "Base",
					connectType: null,
					caseTypes: null,
					modules: { [MOD]: { uuid: MOD, id: "m", name: "Module" } },
					forms: {},
					fields: {},
					moduleOrder: [MOD],
					formOrder: { [MOD]: [] },
					fieldOrder: {},
					fieldParent: {},
				} as never),
			);
			store.getState().startTracking();
		}

		const addModuleBatch: Mutation[] = [
			{
				kind: "addModule",
				module: { uuid: NEW_MOD, id: "m2", name: "Added" } as never,
			},
		];

		it("the echo folds the module in, the late data-mutations chunk does NOT re-apply it", () => {
			seedDoc(docStore);
			const reconciler = createReconciler(
				docStore,
				{
					appId: "app-1",
					baseSeq: 0,
					baseDoc: docStore.getState(),
					userId: "u1",
				},
				{
					put: async () => ({ ok: true, seq: 1 }),
					canEdit: () => true,
					reload: async () => {
						throw new Error("no reload in this test");
					},
					resubscribe: () => {},
					scheduleRetry: () => () => {},
				},
			);
			reconciler.setSelfActiveRunId("run-1");

			// ECHO FIRST — the /stream frame beats the chat chunk. The reconciler
			// classifies it (self actor + active runId), folds it into confirmedDoc
			// AND displayed. The store now shows exactly one added module.
			reconciler.onFrame({
				seq: 1,
				batchId: "chat-1",
				actorId: "u1",
				runId: "run-1",
				kind: "chat",
				mutations: addModuleBatch,
			});
			expect(docStore.getState().moduleOrder).toEqual([MOD, NEW_MOD]);

			// THEN the late data-mutations chunk. registerChatBatch reports
			// `alreadyConfirmed`, so the dispatcher SKIPS applyMany — no second splice.
			applyStreamEvent(
				"data-mutations",
				{ mutations: addModuleBatch, events: [], batchId: "chat-1", seq: 1 },
				docStore,
				sessionStore,
				reconciler,
				"run-1",
			);

			// The module appears EXACTLY once — no duplicate. Before the fix this was
			// [MOD, NEW_MOD, NEW_MOD].
			expect(docStore.getState().moduleOrder).toEqual([MOD, NEW_MOD]);
			expect(reconciler.getSnapshot().sentPending).toHaveLength(0);
			reconciler.dispose();
		});

		it("the common ordering (data-mutations before echo) still applies once", () => {
			seedDoc(docStore);
			const reconciler = createReconciler(
				docStore,
				{
					appId: "app-1",
					baseSeq: 0,
					baseDoc: docStore.getState(),
					userId: "u1",
				},
				{
					put: async () => ({ ok: true, seq: 1 }),
					canEdit: () => true,
					reload: async () => {
						throw new Error("no reload in this test");
					},
					resubscribe: () => {},
					scheduleRetry: () => () => {},
				},
			);
			reconciler.setSelfActiveRunId("run-1");

			// data-mutations FIRST: registerChatBatch reports NOT alreadyConfirmed, so
			// the dispatcher DOES applyMany — the store gains the module once.
			applyStreamEvent(
				"data-mutations",
				{ mutations: addModuleBatch, events: [], batchId: "chat-1", seq: 1 },
				docStore,
				sessionStore,
				reconciler,
				"run-1",
			);
			expect(docStore.getState().moduleOrder).toEqual([MOD, NEW_MOD]);
			expect(reconciler.getSnapshot().sentPending).toHaveLength(1);

			// The echo then drops the batch; the store is untouched (one module).
			reconciler.onFrame({
				seq: 1,
				batchId: "chat-1",
				actorId: "u1",
				runId: "run-1",
				kind: "chat",
				mutations: addModuleBatch,
			});
			expect(docStore.getState().moduleOrder).toEqual([MOD, NEW_MOD]);
			expect(reconciler.getSnapshot().sentPending).toHaveLength(0);
			reconciler.dispose();
		});
	});
});
