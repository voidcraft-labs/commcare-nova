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
import {
	asUuid,
	type LookupOptionsSource,
	lookupOptionsSourceSchema,
	type PersistableDoc,
} from "@/lib/domain";
import type { MutationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores, hydrateDoc } from "./testHelpers";

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

const LOOKUP_MODULE = asUuid("10000000-0000-4000-8000-000000000000");
const LOOKUP_FORM = asUuid("20000000-0000-4000-8000-000000000000");
const LOOKUP_FIELD = asUuid("30000000-0000-4000-8000-000000000000");
const LOOKUP_OPTION_A = asUuid("40000000-0000-4000-8000-000000000000");
const LOOKUP_OPTION_B = asUuid("50000000-0000-4000-8000-000000000000");
const LOOKUP_SOURCE_A = lookupOptionsSourceSchema.parse({
	kind: "lookup-table",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
});
const LOOKUP_SOURCE_B = lookupOptionsSourceSchema.parse({
	kind: "lookup-table",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ac",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890af",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890b0",
});

function lookupSourceMutation(
	optionsSource: LookupOptionsSource | null,
): Mutation {
	return {
		kind: "updateField",
		uuid: LOOKUP_FIELD,
		targetKind: "single_select",
		patch: {},
		optionsSource,
	};
}

function lookupReceiverDoc(): PersistableDoc {
	return {
		appId: "lookup-dispatch",
		appName: "Lookup dispatch",
		connectType: null,
		caseTypes: null,
		modules: {
			[LOOKUP_MODULE]: {
				uuid: LOOKUP_MODULE,
				id: "lookups",
				name: "Lookups",
			},
		},
		forms: {
			[LOOKUP_FORM]: {
				uuid: LOOKUP_FORM,
				id: "intake",
				name: "Intake",
				type: "survey",
			},
		},
		fields: {
			[LOOKUP_FIELD]: {
				uuid: LOOKUP_FIELD,
				id: "status",
				kind: "single_select",
				label: "Status",
				options: [
					{
						uuid: LOOKUP_OPTION_A,
						value: "active",
						label: "Active",
					},
					{
						uuid: LOOKUP_OPTION_B,
						value: "closed",
						label: "Closed",
					},
				],
			},
		},
		moduleOrder: [LOOKUP_MODULE],
		formOrder: { [LOOKUP_MODULE]: [LOOKUP_FORM] },
		fieldOrder: { [LOOKUP_FORM]: [LOOKUP_FIELD] },
	};
}

/** Mirror the generation SSE payload's JSON encode/decode before onData calls
 * `applyStreamEvent`. */
function rawLookupPayload(
	mutation: Mutation,
	seq: number,
): Record<string, unknown> {
	const event: MutationEvent = {
		kind: "mutation",
		runId: "lookup-run",
		ts: 1_000 + seq,
		seq,
		source: "chat",
		actor: "agent",
		stage: "lookup",
		mutation,
	};
	return JSON.parse(
		JSON.stringify({
			mutations: [mutation],
			events: [event],
			seq: seq + 1,
			batchId: `lookup-batch-${seq}`,
			stage: "lookup",
		}),
	) as Record<string, unknown>;
}

function owns(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
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

	it("replays lookup-source set, replace, and explicit-null clear from raw generation SSE payloads", () => {
		hydrateDoc(docStore, lookupReceiverDoc());
		const setSource = lookupSourceMutation(LOOKUP_SOURCE_A);
		const replaceSource = lookupSourceMutation(LOOKUP_SOURCE_B);
		const clearSource = lookupSourceMutation(null);

		expect(owns(clearSource, "optionsSource")).toBe(true);
		expect(clearSource).toHaveProperty("optionsSource", null);

		const payloads = [setSource, replaceSource, clearSource].map(
			rawLookupPayload,
		);
		for (const [index, expectedSource] of [
			LOOKUP_SOURCE_A,
			LOOKUP_SOURCE_B,
			null,
		].entries()) {
			const payload = payloads[index];
			if (!payload) throw new Error(`missing raw lookup payload ${index}`);
			const rawMutation = (
				payload.mutations as Record<string, unknown>[] | undefined
			)?.[0];
			const rawEvent = (
				payload.events as
					| Array<{ mutation?: Record<string, unknown> }>
					| undefined
			)?.[0];
			if (!rawMutation || !rawEvent?.mutation) {
				throw new Error(`malformed raw lookup payload ${index}`);
			}

			/* Both copies in the SSE payload survive JSON whole. The origin-shape
			 * nested patch stays empty/carrier-blind; only the current receiver
			 * consumes the top-level semantic extension. */
			expect(owns(rawMutation, "optionsSource")).toBe(true);
			expect(rawMutation.optionsSource).toEqual(expectedSource);
			expect(rawMutation.patch).toEqual({});
			expect(rawMutation.patch).not.toHaveProperty("optionsSource");
			expect(owns(rawEvent.mutation, "optionsSource")).toBe(true);
			expect(rawEvent.mutation.optionsSource).toEqual(expectedSource);

			applyStreamEvent(
				"data-mutations",
				payload,
				docStore,
				sessionStore,
				null,
				"lookup-run",
			);

			const field = docStore.getState().fields[LOOKUP_FIELD];
			if (field?.kind !== "single_select") {
				throw new Error("lookup receiver field is missing");
			}
			expect(field.optionsSource).toEqual(expectedSource ?? undefined);
			expect(
				field.options.map(({ value, label }) => ({ value, label })),
			).toEqual([
				{ value: "active", label: "Active" },
				{ value: "closed", label: "Closed" },
			]);
		}

		const rawClear = payloads[2]?.mutations as
			| Record<string, unknown>[]
			| undefined;
		const rawClearEvent = payloads[2]?.events as
			| Array<{ mutation?: Record<string, unknown> }>
			| undefined;
		expect(owns(rawClear?.[0] ?? {}, "optionsSource")).toBe(true);
		expect(rawClear?.[0]?.optionsSource).toBeNull();
		expect(owns(rawClearEvent?.[0]?.mutation ?? {}, "optionsSource")).toBe(
			true,
		);
		expect(rawClearEvent?.[0]?.mutation?.optionsSource).toBeNull();

		const bufferedClear = sessionStore.getState().events.at(-1);
		expect(bufferedClear?.kind).toBe("mutation");
		if (bufferedClear?.kind !== "mutation") {
			throw new Error("clear MutationEvent was not buffered");
		}
		expect(owns(bufferedClear.mutation, "optionsSource")).toBe(true);
		expect(bufferedClear.mutation).toHaveProperty("optionsSource", null);
		expect(sessionStore.getState().events).toHaveLength(3);
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
