/** Admitted server batches through the actual receiver, stores and reconciler. */
import { afterEach, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	availableLookupContext,
	lookupTableDefinition,
} from "@/lib/__tests__/lookupFixtures";
import { createReconciler, type Reconciler } from "@/lib/collab/reconciler";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import {
	blueprintDocSchema,
	lookupOptionsSourceSchema,
	type SelectOptionsSource,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { MutationEvent } from "@/lib/log/types";
import { signalGrid } from "@/lib/signalGrid/store";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores, hydrateDoc } from "./testHelpers";

const FORM = testUuid("receiver-form");
const FIELD = testUuid("receiver-field");
const EXTRA = testUuid("receiver-extra");
const INLINE: SelectOptionsSource = {
	kind: "inline",
	options: [
		{ uuid: testUuid("option"), value: "active", label: proseText("Active") },
		{
			uuid: testUuid("option-closed"),
			value: "closed",
			label: proseText("Closed"),
		},
	],
};
const sources = ["a", "b"].map((key) =>
	lookupOptionsSourceSchema.parse({
		kind: "lookup",
		tableId: `01912d68-783e-7000-8000-00000000${key}001`,
		valueColumnId: `01912d68-783e-7000-8000-00000000${key}002`,
		labelColumnId: `01912d68-783e-7000-8000-00000000${key}003`,
	}),
);
const catalog = availableLookupContext(
	sources.map((source, index) =>
		lookupTableDefinition({
			id: source.tableId,
			name: `Table ${index}`,
			tag: `table_${index}`,
			columns: [
				{ id: source.valueColumnId, wireName: "code", label: "Code" },
				{ id: source.labelColumnId, wireName: "name", label: "Name" },
			],
		}),
	),
);
const owned: Reconciler[] = [];
afterEach(() => {
	for (const reconciler of owned.splice(0)) reconciler.dispose();
	signalGrid.reset();
});
function setup() {
	const stores = createWiredStores();
	const base = buildDoc({
		appId: "receiver",
		appName: "Receiver",
		modules: [
			{
				name: "Intake",
				forms: [
					{
						uuid: FORM,
						name: "Intake",
						type: "survey",
						fields: [
							f({
								uuid: FIELD,
								id: "status",
								kind: "single_select",
								optionsSource: INLINE,
							}),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(base));
	expect(mutationCommitVerdict(base, [], catalog).ok).toBe(true);
	hydrateDoc(stores.docStore, toPersistableDoc(base));
	signalGrid.reset();
	return stores;
}
function payload(mutations: readonly Mutation[], seq = 2) {
	const events: MutationEvent[] = mutations.map((mutation, index) => ({
		kind: "mutation",
		runId: "run",
		ts: seq,
		seq: index,
		source: "chat",
		actor: "agent",
		stage: "form:0-0",
		mutation,
	}));
	return JSON.parse(
		JSON.stringify({ mutations, events, batchId: `batch-${seq}`, seq }),
	);
}
function admitted(
	stores: ReturnType<typeof setup>,
	mutations: readonly Mutation[],
) {
	const verdict = mutationCommitVerdict(
		stores.docStore.getState(),
		mutations,
		catalog,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	blueprintDocSchema.parse(toPersistableDoc(verdict.nextDoc));
	return verdict;
}
it("commits one atomic receiver notification and preserves server event envelopes", () => {
	const stores = setup();
	const mutations: readonly Mutation[] = [
		{ kind: "setAppName", name: "Renamed" },
		{
			kind: "addField",
			parentUuid: FORM,
			field: {
				uuid: EXTRA,
				id: "extra",
				kind: "text",
				label: proseText("Extra"),
			},
		},
	];
	const verdict = admitted(stores, mutations);
	const notifications: unknown[] = [];
	const unsubscribe = stores.docStore.subscribe((state, previous) => {
		if (
			state.appName !== previous.appName ||
			state.fieldOrder[FORM] !== previous.fieldOrder[FORM]
		) {
			notifications.push({
				name: state.appName,
				order: state.fieldOrder[FORM],
			});
		}
	});
	const frame = payload(verdict.mutations);
	try {
		applyStreamEvent(
			"data-mutations",
			frame,
			stores.docStore,
			stores.sessionStore,
			null,
			"run",
		);
	} finally {
		unsubscribe();
	}
	expect(notifications).toEqual([{ name: "Renamed", order: [FIELD, EXTRA] }]);
	expect(stores.sessionStore.getState().events).toEqual(frame.events);
	expect(stores.docStore.getState().canUndo).toBe(false);
});
it("rejects a noncanonical batch before touching the document, event buffer or energy", () => {
	const stores = setup();
	const before = stores.docStore.getState();
	const events = stores.sessionStore.getState().events;
	expect(() =>
		applyStreamEvent(
			"data-mutations",
			{},
			stores.docStore,
			stores.sessionStore,
			null,
			"run",
		),
	).toThrow(
		expect.objectContaining({ code: "MUTATION_WIRE_CANONICALITY_INVALID" }),
	);
	expect(stores.docStore.getState()).toBe(before);
	expect(stores.sessionStore.getState().events).toBe(events);
	expect(signalGrid.drainEnergy()).toBe(0);
	applyStreamEvent(
		"data-mutations",
		{ mutations: [], events: [] },
		stores.docStore,
		stores.sessionStore,
		null,
		"run",
	);
	expect(stores.docStore.getState()).toBe(before);
	expect(stores.sessionStore.getState().events).toBe(events);
});
it("receives admitted inline-to-lookup, table replacement and return-to-inline JSON frames", () => {
	const stores = setup();
	for (const [index, source] of [...sources, INLINE].entries()) {
		const mutation: Mutation = {
			kind: "updateField",
			uuid: FIELD,
			targetKind: "single_select",
			patch: { optionsSource: source },
		};
		const verdict = admitted(stores, [mutation]);
		applyStreamEvent(
			"data-mutations",
			payload(verdict.mutations, index + 2),
			stores.docStore,
			stores.sessionStore,
			null,
			"run",
		);
		const field = stores.docStore.getState().fields[FIELD];
		expect(field.kind).toBe("single_select");
		if (field.kind !== "single_select")
			throw new Error("Receiver changed field kind");
		expect(field.optionsSource).toEqual(source);
	}
	expect(stores.sessionStore.getState().events).toHaveLength(3);
});
it.each(["echo-first", "chat-first"] as const)(
	"%s delivers one committed field through both transports exactly once",
	(order) => {
		const stores = setup();
		const mutations: readonly Mutation[] = [
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: EXTRA,
					id: "extra",
					kind: "text",
					label: proseText("Extra"),
				},
			},
		];
		const verdict = admitted(stores, mutations);
		const reconciler = createReconciler(
			stores.docStore,
			{
				appId: "receiver",
				baseSeq: 1,
				baseDoc: stores.docStore.getState(),
				userId: "actor",
			},
			{
				put: async () => {
					throw new Error("Receiver must not PUT committed server edits");
				},
				reload: async () => {
					throw new Error("No sequence gap to reload");
				},
				canEdit: () => true,
				resubscribe: () => {
					throw new Error("Unexpected reconnect");
				},
				scheduleRetry: () => () => {},
			},
		);
		owned.push(reconciler);
		reconciler.setSelfActiveRunId("run");
		const echo = () =>
			reconciler.onFrame({
				seq: 2,
				batchId: "batch-2",
				actorId: "actor",
				runId: "run",
				kind: "chat",
				mutations: admitMutationBatch(verdict.mutations),
			});
		const chat = () =>
			applyStreamEvent(
				"data-mutations",
				payload(verdict.mutations),
				stores.docStore,
				stores.sessionStore,
				reconciler,
				"run",
			);
		for (const deliver of order === "echo-first"
			? [echo, chat]
			: [chat, echo]) {
			deliver();
			expect(stores.docStore.getState().fieldOrder[FORM]).toEqual([
				FIELD,
				EXTRA,
			]);
		}
		expect(reconciler.getSnapshot().sentPending).toEqual([]);
		expect(reconciler.getSnapshot().baseSeq).toBe(2);
		expect(stores.docStore.getState().canUndo).toBe(false);
	},
);
