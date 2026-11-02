import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { placementTargetKey } from "@/lib/doc/placementHolds";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type {
	BlueprintDoc,
	Mutation,
	PlacementHoldEntry,
} from "@/lib/doc/types";
import { blueprintDocSchema } from "@/lib/domain";
import { APP_GENESIS_FALLBACK_NAME } from "@/lib/domain/blueprint";
import { literal, term, today } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";
import { datetimeSplitOriginal } from "./datetimeSplitFixture";
import {
	COMPUTED_REMARK,
	commitWithMoves,
	FOLLOWUP,
	heldStore,
	holdEntries,
	ownHold,
	ownOf,
	read,
	recordCurrentHolds,
	setRemark,
} from "./heldHistoryFixture";
import { DISCHARGE } from "./placementMoveFixture";

// ── Fixtures ────────────────────────────────────────────────────────────

/** Real admitted survey used for lifecycle transitions. */
function makeDoc(
	opts: { appId?: string; appName?: string } = {},
): BlueprintDoc {
	const doc = buildDoc({
		appId: opts.appId ?? "app-1",
		appName: opts.appName ?? "Test",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "name" }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function apply(
	store: ReturnType<typeof createBlueprintDocStore>,
	mutations: readonly Mutation[],
) {
	const verdict = mutationCommitVerdict(
		store.getState(),
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	if (!verdict.ok) throw new Error("Fixture edit must be admitted");
	store.getState().applyMany(verdict.mutations);
}

function makeCatalogDoc(): BlueprintDoc {
	return {
		...makeDoc(),
		caseTypes: [
			{
				name: "patient",
				properties: ["a", "b", "c"].map((name) => ({
					name,
					label: proseText(name.toUpperCase()),
				})),
			},
		],
	};
}

const CASE_WRITE_OWN = testUuid("case-write-own");

/** The own case's write of `property`, saving the answer `fieldUuid`. */
function ownWriteOf(fieldUuid: string, property: string) {
	return {
		property,
		value: {
			kind: "term" as const,
			term: { kind: "field" as const, uuid: testUuid(fieldUuid) },
		},
	};
}

/** The own case's property writes, in order. */
function ownWrittenProperties(
	doc: Pick<BlueprintDoc, "forms">,
	formUuid: string,
) {
	return (
		doc.forms[formUuid]?.caseOperations?.[0]?.writes?.map(
			(write) => write.property,
		) ?? []
	);
}

/** Replace the own case's write of `from` with one of `to`. */
function retargetOwnWrite(
	formUuid: string,
	fieldUuid: string,
	from: string,
	to: string,
): Mutation[] {
	return [
		{
			kind: "updateForm",
			uuid: testUuid(formUuid),
			patch: {},
			caseOperationPatch: {
				operation: "remove-write",
				uuid: CASE_WRITE_OWN,
				key: { property: from },
			},
		},
		{
			kind: "updateForm",
			uuid: testUuid(formUuid),
			patch: {},
			caseOperationPatch: {
				operation: "add-write",
				uuid: CASE_WRITE_OWN,
				value: ownWriteOf(fieldUuid, to),
			},
		},
	];
}

function makeCaseWriteDoc(): {
	doc: BlueprintDoc;
	fieldUuid: string;
	formUuid: string;
} {
	const moduleUuid = testUuid("case-write-module");
	const formUuid = testUuid("case-write-form");
	const fieldUuid = testUuid("case-write-field");
	return {
		fieldUuid,
		formUuid,
		doc: {
			...makeDoc({ appName: "Case writes" }),
			caseTypes: [
				{
					name: "patient",
					properties: ["old_value", "new_value"].map((name) => ({
						name,
						label: proseText(name),
					})),
				},
			],
			modules: {
				[moduleUuid]: {
					uuid: moduleUuid,
					id: "patients",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			},
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "visit",
					name: "Visit",
					type: "followup",
					caseOperations: [
						{
							uuid: CASE_WRITE_OWN,
							id: "patient",
							action: "own",
							writes: [ownWriteOf(fieldUuid, "old_value")],
						},
					],
				},
			},
			fields: {
				[testUuid("spare")]: {
					uuid: testUuid("spare"),
					id: "spare",
					kind: "text",
					label: proseText("Spare"),
				},
				[fieldUuid]: {
					uuid: fieldUuid,
					kind: "text",
					id: "answer",
					label: proseText("Answer"),
				},
			},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [fieldUuid, testUuid("spare")] },
			fieldParent: { [fieldUuid]: formUuid, [testUuid("spare")]: formUuid },
		},
	};
}

function persistedSnapshot(doc: BlueprintDoc) {
	return blueprintDocSchema.parse(toPersistableDoc(doc));
}

describe("the command queue is current when the write is announced", () => {
	// `useAutoSave` subscribes to the store and dispatches the save SYNCHRONOUSLY
	// from the write that changed the document, so the queue has to already hold
	// the command by then. A queue filled after the `set()` leaves every save one
	// edit behind — the first edit's PUT sees an empty queue and sends nothing,
	// its command riding out later on the back of a SECOND edit — and a lone
	// edit, the last one before the author stops typing, never goes out at all.
	function subscriberSeesQueue(
		write: (store: ReturnType<typeof createBlueprintDocStore>) => void,
	): number {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc());
		store.getState().startTracking();
		let seen = -1;
		const unsubscribe = store.subscribe(() => {
			if (seen === -1) seen = store.getState().peekCommandBatches().length;
		});
		write(store);
		unsubscribe();
		return seen;
	}

	it("applyMany records before it notifies", () => {
		expect(
			subscriberSeesQueue((store) => {
				apply(store, [{ kind: "setAppName", name: "Renamed" }]);
			}),
		).toBe(1);
	});

	it("commitDoc records before it notifies", () => {
		expect(
			subscriberSeesQueue((store) => {
				const next = {
					...store.getState(),
					appName: "Renamed",
				};
				store
					.getState()
					.commitDoc(
						next,
						admitMutationBatch([{ kind: "setAppName", name: "Renamed" }]),
					);
			}),
		).toBe(1);
	});

	it("publishes a frozen validated candidate directly without losing store actions", () => {
		const { doc, fieldUuid } = makeCaseWriteDoc();
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		const mutations = admitMutationBatch([
			{
				kind: "updateField",
				uuid: testUuid(fieldUuid),
				targetKind: "text",
				patch: { label: proseText("Updated answer") },
			},
		]);
		const prepared = prepareMutationCandidate(store.getState(), mutations);
		expect(prepared.nextDoc).toBeDefined();
		if (prepared.nextDoc === undefined) throw new Error("Expected candidate");
		expect(Object.isFrozen(prepared.nextDoc)).toBe(true);

		store.getState().commitDoc(prepared.nextDoc, mutations);

		expect(store.getState().fields).toBe(prepared.nextDoc.fields);
		expect(typeof store.getState().applyMany).toBe("function");
		expect(store.getState().peekCommandBatches()).toEqual([mutations]);
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().fields[fieldUuid]).toMatchObject({
			kind: "text",
			label: proseText("Answer"),
		});
	});

	it("rename then undo wakes the queue although the optimistic Blueprint returns byte-identical", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeCatalogDoc());
		store.getState().startTracking();
		const before = persistedSnapshot(store.getState());
		const rename = admitMutationBatch([
			{
				kind: "renameCaseProperties",
				renames: [{ caseType: "patient", from: "a", to: "fresh" }],
			},
		]);
		let notifications = 0;
		const unsubscribe = store.subscribe(() => {
			notifications += 1;
		});

		apply(store, rename);
		store.getState().undo();
		unsubscribe();

		expect(persistedSnapshot(store.getState())).toEqual(before);
		expect(notifications).toBeGreaterThan(0);
		expect(store.getState().peekCommandBatches()).toEqual([
			rename,
			admitMutationBatch([
				{
					kind: "renameCaseProperties",
					renames: [{ caseType: "patient", from: "fresh", to: "a" }],
				},
			]),
		]);
		expect(store.getState().commandQueueRevision).toBe(2);
	});
});

describe("case-write projection watermark", () => {
	it("advances from the admitted batch without scanning ordinary field edits", () => {
		const { doc, fieldUuid, formUuid } = makeCaseWriteDoc();
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		const baseline = store.getState().caseWriteProjectionRevision;

		apply(store, [
			{
				kind: "updateField",
				uuid: testUuid(fieldUuid),
				targetKind: "text",
				patch: { label: proseText("Updated answer") },
			},
		]);
		expect(store.getState().caseWriteProjectionRevision).toBe(baseline);

		apply(
			store,
			retargetOwnWrite(formUuid, fieldUuid, "old_value", "new_value"),
		);
		expect(store.getState().caseWriteProjectionRevision).toBe(baseline + 1);

		apply(store, [
			{
				kind: "updateForm",
				uuid: testUuid(formUuid),
				patch: { purpose: "Routine followup" },
			},
		]);
		expect(store.getState().caseWriteProjectionRevision).toBe(baseline + 1);
	});

	it("advances for a Hidden Value's value, which types what an operation reading it saves", () => {
		const { doc, fieldUuid } = makeCaseWriteDoc();
		doc.fields[fieldUuid] = {
			uuid: testUuid(fieldUuid),
			kind: "hidden",
			id: "answer",
			calculate: term(literal("initial")),
		};
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		const baseline = store.getState().caseWriteProjectionRevision;

		apply(store, [
			{
				kind: "updateField",
				uuid: testUuid(fieldUuid),
				targetKind: "hidden",
				patch: { calculate: today() },
			},
		]);

		expect(store.getState().caseWriteProjectionRevision).toBe(baseline + 1);
	});

	it("ignores a stale hidden-field update after the displayed field was removed", () => {
		const { doc, fieldUuid } = makeCaseWriteDoc();
		doc.fields[fieldUuid] = {
			uuid: testUuid(fieldUuid),
			kind: "hidden",
			id: "answer",
			calculate: term(literal("initial")),
		};
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		store
			.getState()
			.applyMany([{ kind: "removeField", uuid: testUuid(fieldUuid) }]);
		const baseline = store.getState().caseWriteProjectionRevision;

		// Deliberately exercise stale replay reduction below author admission.
		expect(() =>
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: testUuid(fieldUuid),
					targetKind: "hidden",
					patch: {
						calculate: today(),
					},
				},
			]),
		).not.toThrow();
		expect(store.getState().fields[fieldUuid]).toBeUndefined();
		expect(store.getState().caseWriteProjectionRevision).toBe(baseline);
	});

	it("advances for a whole-document reseed with no mutation proof", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc());
		const baseline = store.getState().caseWriteProjectionRevision;
		store.getState().commitDoc({
			...makeDoc(),
			appName: "Reseeded",
		});
		expect(store.getState().caseWriteProjectionRevision).toBe(baseline + 1);
	});
});

describe("createBlueprintDocStore", () => {
	it("starts with an empty doc that still carries a name", () => {
		const store = createBlueprintDocStore();
		const doc = store.getState();
		// The pre-load scaffold is intentionally incomplete until load/genesis.
		expect(doc.appName).toBe(APP_GENESIS_FALLBACK_NAME);
		expect(doc.moduleOrder).toEqual([]);
	});

	it("load() hydrates the doc from a normalized BlueprintDoc", () => {
		const store = createBlueprintDocStore();
		const doc = makeDoc({ appName: "Loaded" });
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		const state = store.getState();
		expect(state.appName).toBe("Loaded");
		expect(state.appId).toBe("app-1");
		expect(state.moduleOrder).toHaveLength(1);
	});

	it("load() preserves every field of the input doc, including the app logo", () => {
		// `logo` is an optional top-level slot that lives outside the entity
		// maps — exactly the kind of field a hand-listed hydration drops. Load
		// a doc with every field set and assert the store reflects each one, so
		// the hydration can't silently lose a slot (it lost `logo` before).
		const store = createBlueprintDocStore();
		const doc: BlueprintDoc = {
			...makeDoc({ appName: "Loaded" }),
			logo: testMediaAssetId("logo"),
		};
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		const state = store.getState();

		expect(state.logo).toBe(testMediaAssetId("logo"));
		for (const key of Object.keys(doc) as (keyof BlueprintDoc)[]) {
			expect(state[key]).toEqual(doc[key]);
		}
	});

	it("bounds the history, dropping the oldest step", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "n0" }));
		store.getState().startTracking();
		// One past the cap, so exactly the first step falls off.
		for (let i = 1; i <= 101; i++) {
			apply(store, [{ kind: "setAppName", name: `n${i}` }]);
		}
		for (let i = 0; i < 100; i++) store.getState().undo();
		// Back to the first RETAINED step's starting point, not to `n0`.
		expect(store.getState().appName).toBe("n1");
		expect(store.getState().canUndo).toBe(false);
	});

	it("an inbound frame's overlay leaves the history flags alone", () => {
		// `overlayDoc` blanks every DOC key the incoming document does not carry,
		// and an incoming document never carries bookkeeping. A bookkeeping field
		// missing from `isDocDataKey` therefore reads as `undefined` the moment a
		// peer's edit or the author's own echo arrives — the toolbar's Undo goes
		// dead while the history behind it is intact.
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "Base" }));
		store.getState().startTracking();
		apply(store, [{ kind: "setAppName", name: "Mine" }]);
		expect(store.getState().canUndo).toBe(true);

		// The reconciler folding a frame: a suppressed whole-document commit.
		store.getState().beginRemoteApply();
		store.getState().commitDoc({
			...store.getState(),
			appName: "Peer",
		});
		store.getState().endRemoteApply();

		expect(store.getState().appName).toBe("Peer");
		expect(store.getState().canUndo).toBe(true);
		expect(store.getState().canRedo).toBe(false);
	});

	it("load() is not a step the author can take back", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc());
		expect(store.getState().canUndo).toBe(false);
	});

	it("applyMany() records a step, and undo returns the prior value", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "Before" }));
		store.getState().startTracking();
		apply(store, [{ kind: "setAppName", name: "After" }]);
		expect(store.getState().appName).toBe("After");
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).toBe("Before");
		expect(store.getState().canUndo).toBe(false);
		expect(store.getState().canRedo).toBe(true);
		store.getState().redo();
		expect(store.getState().appName).toBe("After");
	});

	it("undoes and redoes a retargeted write of the form's own case", () => {
		const { doc, fieldUuid, formUuid } = makeCaseWriteDoc();
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		apply(
			store,
			admitMutationBatch(
				retargetOwnWrite(formUuid, fieldUuid, "old_value", "new_value"),
			),
		);
		expect(ownWrittenProperties(store.getState(), formUuid)).toEqual([
			"new_value",
		]);
		store.getState().undo();
		expect(ownWrittenProperties(store.getState(), formUuid)).toEqual([
			"old_value",
		]);
		store.getState().redo();
		expect(ownWrittenProperties(store.getState(), formUuid)).toEqual([
			"new_value",
		]);
	});

	it("undoes a write that declared its property together with the declaration", () => {
		const { doc, fieldUuid, formUuid } = makeCaseWriteDoc();
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		apply(store, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "brand_new", label: proseText("Brand new") },
			},
			...retargetOwnWrite(formUuid, fieldUuid, "old_value", "brand_new"),
		]);
		expect(
			store
				.getState()
				.caseTypes?.[0]?.properties.some(({ name }) => name === "brand_new"),
		).toBe(true);

		store.getState().undo();
		expect(ownWrittenProperties(store.getState(), formUuid)).toEqual([
			"old_value",
		]);
		expect(
			store
				.getState()
				.caseTypes?.[0]?.properties.some(({ name }) => name === "brand_new"),
		).toBe(false);
	});

	it("undoes and redoes a module reparent with exact preorder", () => {
		const parentUuid = testUuid("undo-module-parent");
		const childUuid = testUuid("undo-module-child");
		const store = createBlueprintDocStore();
		const doc = buildDoc({
			appName: "Menus",
			modules: [
				{
					uuid: parentUuid,
					name: "Parent",
					forms: [
						{
							name: "Parent survey",
							type: "survey",
							fields: [{ kind: "text", id: "name" }],
						},
					],
				},
				{
					uuid: childUuid,
					name: "Child",
					forms: [
						{
							name: "Child survey",
							type: "survey",
							fields: [{ kind: "text", id: "name" }],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		apply(store, [
			{
				kind: "moveModule",
				uuid: childUuid,
				parentModuleUuid: parentUuid,
				after: null,
			},
		]);
		expect(store.getState().modules[childUuid]?.parentModuleUuid).toBe(
			parentUuid,
		);
		expect(store.getState().moduleOrder).toEqual([parentUuid, childUuid]);

		store.getState().undo();
		expect(
			store.getState().modules[childUuid]?.parentModuleUuid,
		).toBeUndefined();
		expect(store.getState().moduleOrder).toEqual([parentUuid, childUuid]);

		store.getState().redo();
		expect(store.getState().modules[childUuid]?.parentModuleUuid).toBe(
			parentUuid,
		);
		expect(store.getState().moduleOrder).toEqual([parentUuid, childUuid]);
	});

	it("applyMany() batches multiple mutations into ONE step", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "A" }));
		store.getState().startTracking();
		apply(store, [
			{ kind: "setAppName", name: "B" },
			{
				kind: "updateForm",
				uuid: store.getState().formOrder[store.getState().moduleOrder[0]][0],
				patch: { purpose: "Edited purpose" },
			},
		]);
		expect(store.getState().appName).toBe("B");
		expect(Object.values(store.getState().forms)[0].purpose).toBe(
			"Edited purpose",
		);
		// One undo takes back the whole batch, and there is nothing behind it.
		store.getState().undo();
		expect(store.getState().appName).toBe("A");
		expect(Object.values(store.getState().forms)[0].purpose).toBeUndefined();
		expect(store.getState().canUndo).toBe(false);
	});

	it.each([
		["beginning", "a", ["b", "c", "fresh"]],
		["middle", "b", ["a", "c", "fresh"]],
		["end", "c", ["a", "b", "fresh"]],
	] as const)(
		"undoes an exact non-rename catalog replacement at the %s and redoes the original batch",
		(_position, removed, replacedOrder) => {
			const store = createBlueprintDocStore();
			store.getState().load(makeCatalogDoc());
			store.getState().startTracking();
			const initial = persistedSnapshot(store.getState());
			const forward = admitMutationBatch([
				{
					kind: "removeCaseProperty",
					caseType: "patient",
					property: removed,
				},
				{
					kind: "addCaseProperty",
					caseType: "patient",
					property: { name: "fresh", label: proseText("Fresh") },
				},
			]);

			apply(store, forward);
			expect(
				store.getState().caseTypes?.[0]?.properties.map(({ name }) => name),
			).toEqual(replacedOrder);
			const replaced = persistedSnapshot(store.getState());
			expect(store.getState().takeCommandBatches()).toEqual([forward]);

			store.getState().undo();
			expect(persistedSnapshot(store.getState())).toEqual(initial);
			const [inverse] = store.getState().takeCommandBatches();
			expect(inverse).not.toContainEqual(
				expect.objectContaining({ kind: "renameCaseProperties" }),
			);

			store.getState().redo();
			expect(persistedSnapshot(store.getState())).toEqual(replaced);
			expect(store.getState().takeCommandBatches()).toEqual([forward]);
		},
	);

	it("agent writes are excluded from author history", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "A" }));
		store.getState().startTracking();
		store.getState().beginAgentWrite();
		apply(store, [{ kind: "setAppName", name: "During Agent" }]);
		expect(store.getState().canUndo).toBe(false);
		store.getState().endAgentWrite();
		apply(store, [{ kind: "setAppName", name: "After Agent" }]);
		// Undo takes back the author's edit, not the run's.
		store.getState().undo();
		expect(store.getState().appName).toBe("During Agent");
		expect(store.getState().canUndo).toBe(false);
	});

	it("startTracking() releases the birth pause once", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "A" }));
		// Before startTracking the store is paused (birth base) — no step recorded.
		apply(store, [{ kind: "setAppName", name: "B" }]);
		expect(store.getState().canUndo).toBe(false);
		store.getState().startTracking();
		apply(store, [{ kind: "setAppName", name: "C" }]);
		// Idempotent — a second call doesn't unbalance the counter.
		store.getState().startTracking();
		apply(store, [{ kind: "setAppName", name: "D" }]);
		// Both post-release edits are their own step; the pre-release one is not.
		store.getState().undo();
		expect(store.getState().appName).toBe("C");
		store.getState().undo();
		expect(store.getState().appName).toBe("B");
		expect(store.getState().canUndo).toBe(false);
	});

	it("undo works after a fresh build: mount paused → run → startTracking (the [4] regression)", () => {
		// Simulate a FRESH BUILD: mount paused (no startTracking at mount), open
		// the agent bracket (beginRun), edit during the run, then close the bracket
		// (endRun) followed by startTracking() — the prod flow ChatContainer drives.
		// Without startTracking the birth pause never releases (depth stuck at 1),
		// so undo was permanently DEAD after a build until a page reload.
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "New" }));
		// No startTracking at mount — a fresh build generates first.
		store.getState().beginAgentWrite(); // beginRun
		apply(store, [{ kind: "setAppName", name: "Generated" }]);
		expect(store.getState().canUndo).toBe(false);
		store.getState().endAgentWrite(); // endRun closes the agent bracket
		// ChatContainer calls startTracking() after endRun — bracket already closed,
		// so it releases the birth pause immediately.
		store.getState().startTracking();
		// A subsequent human edit IS recorded — undo works, no page reload needed.
		apply(store, [{ kind: "setAppName", name: "HumanEdit" }]);
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).toBe("Generated");
	});

	it("startTracking() DURING an open bracket defers the birth-pause release to the bracket close", () => {
		// The defensive deferral: if startTracking arrives while a suppression
		// bracket is open, the release must ride the bracket close (never unbalance
		// the depth counter).
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "New" }));
		store.getState().beginAgentWrite(); // bracket open
		store.getState().startTracking(); // deferred — bracket still open
		apply(store, [{ kind: "setAppName", name: "InBracket" }]);
		expect(store.getState().canUndo).toBe(false);
		store.getState().endAgentWrite(); // bracket closes → deferred release fires
		apply(store, [{ kind: "setAppName", name: "After" }]);
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).toBe("InBracket");
	});
});

describe("nested suppression ownership", () => {
	it("keeps remote suppression until the outer replay bracket closes", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "Base" }));
		store.getState().startTracking();
		store.getState().beginRemoteApply();
		store.getState().beginRemoteApply();
		store.getState().endRemoteApply();
		expect(store.getState().remoteFrameApplyInProgress).toBe(true);
		store.getState().endRemoteApply();
		expect(store.getState().remoteFrameApplyInProgress).toBe(false);
	});
	it("releases deferred birth tracking only after every nested bracket closes", () => {
		const store = createBlueprintDocStore();
		store.getState().load(makeDoc({ appName: "Base" }));
		store.getState().beginAgentWrite();
		store.getState().beginRemoteApply();
		store.getState().startTracking();
		store.getState().endRemoteApply();
		store.getState().endAgentWrite();
		apply(store, [{ kind: "setAppName", name: "Author" }]);
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).toBe("Base");
	});
});

describe("undo of a conversion to a hidden value", () => {
	// The store's undo applies `deltaBetween(after, before)`, the diff back to
	// the prior document, so a conversion's undo is the inverse conversion,
	// which must be representable and carry the label the question had.
	it("restores a text question exactly", () => {
		const doc = buildDoc({
			appId: "app-undo-hidden",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								{
									kind: "text",
									id: "name",
									uuid: "undo-hidden-name",
									label: proseText("Name"),
									hint: proseText("As it is written"),
									default_value: "'unnamed'",
								},
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		const before = persistedSnapshot(store.getState());
		apply(store, [
			{
				kind: "convertField",
				uuid: testUuid("undo-hidden-name"),
				toKind: "hidden",
			},
		]);
		expect(store.getState().fields[testUuid("undo-hidden-name")]?.kind).toBe(
			"hidden",
		);
		store.getState().undo();
		expect(persistedSnapshot(store.getState())).toEqual(before);
	});

	it("restores a split date-and-time question exactly", () => {
		const doc = datetimeSplitOriginal();
		assertAdmittedDoc(doc);
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		const before = persistedSnapshot(store.getState());
		const plan = planDatetimeSplits(store.getState());
		if (!plan.ok) throw new Error(plan.message);
		apply(store, plan.mutations);
		expect(persistedSnapshot(store.getState())).not.toEqual(before);
		store.getState().undo();
		expect(persistedSnapshot(store.getState())).toEqual(before);
	});
});

describe("history steps over held placements", () => {
	it("keeps the undo's restore of the recorded hold, and the redo replays the recorded step", () => {
		const store = heldStore();
		const published = ownHold(store.getState());
		commitWithMoves(store, [setRemark(store.getState(), COMPUTED_REMARK)]);
		const moved = toPersistableDoc(store.getState());
		const forward = store.getState().peekCommandBatches().at(-1);

		const step = store.getState().historyStepBatch("undo");
		expect(step?.droppedHoldChange).toBe(false);
		expect(holdEntries(step?.batch ?? [])).toEqual([
			expect.objectContaining({ placement: published }),
		]);
		if (step === undefined) return;
		expect(store.getState().applyHistoryStep("undo", step.batch)).toEqual({
			restoredHold: true,
			droppedHoldChange: false,
		});
		expect(ownHold(store.getState())).toEqual(published);
		// The step applied the recorded batch, so the redo is the recorded
		// forward.
		expect(store.getState().redoBatch()).toEqual(forward);

		const redo = store.getState().historyStepBatch("redo");
		if (redo === undefined) throw new Error("The undo is redoable.");
		store.getState().applyHistoryStep("redo", redo.batch);
		expect(toPersistableDoc(store.getState())).toEqual(moved);
	});

	it("drops a hold change a later publish replaced, keeps the content, and records the inverse of what it applied", () => {
		const store = heldStore();
		commitWithMoves(store, [setRemark(store.getState(), COMPUTED_REMARK)]);
		const moved = toPersistableDoc(store.getState());
		const movedHold = ownHold(store.getState());
		recordCurrentHolds(store);

		const step = store.getState().historyStepBatch("undo");
		if (step === undefined) throw new Error("The move is undoable.");
		expect(step.droppedHoldChange).toBe(true);
		expect(holdEntries(step.batch)).toEqual([]);
		expect(store.getState().applyHistoryStep("undo", step.batch)).toEqual({
			restoredHold: false,
			droppedHoldChange: true,
		});
		// The content is back, and the answers stay where the publish put them.
		expect(
			store
				.getState()
				.forms[FOLLOWUP].caseOperations?.find((op) => op.action === "own")
				?.writes?.find((write) => write.property === "remark")?.value,
		).toEqual(read("remark"));
		expect(ownHold(store.getState())).toEqual(movedHold);

		// The redo replays exactly what the undo took back: the content alone.
		const redo = store.getState().historyStepBatch("redo");
		if (redo === undefined) throw new Error("The undo is redoable.");
		expect(holdEntries(redo.batch)).toEqual([]);
		expect(redo.droppedHoldChange).toBe(false);
		store.getState().applyHistoryStep("redo", redo.batch);
		expect(toPersistableDoc(store.getState())).toEqual(moved);
		// And its undo is the batch the first undo applied.
		expect(store.getState().undoBatch()).toEqual(step.batch);
	});

	it("applies nothing when that history is empty", () => {
		const store = heldStore();
		expect(store.getState().historyStepBatch("undo")).toBeUndefined();
		expect(
			store.getState().applyHistoryStep("redo", admitMutationBatch([])),
		).toBeUndefined();
	});

	it("keeps the recorded holds out of the document a reseed overlays", () => {
		const store = heldStore();
		const recorded = store.getState().recordedHolds;
		expect(recorded.size).toBeGreaterThan(0);
		store.getState().beginRemoteApply();
		try {
			store
				.getState()
				.commitDoc(toPersistableDoc(store.getState()) as BlueprintDoc);
		} finally {
			store.getState().endRemoteApply();
		}
		expect(store.getState().recordedHolds).toBe(recorded);
		expect(Object.keys(toPersistableDoc(store.getState()))).not.toContain(
			"recordedHolds",
		);
	});
});

describe("the recorded holds a folded publish advances", () => {
	it("sets each recorded hold, forgets each cleared one, and keeps the rest", () => {
		const store = heldStore();
		const before = store.getState().recordedHolds;
		const ownKey = placementTargetKey({
			target: "case-operation",
			formUuid: FOLLOWUP,
			operationUuid: ownOf(store.getState()),
		});
		const closeKey = placementTargetKey({
			target: "own-close",
			formUuid: DISCHARGE,
		});
		expect(before.has(ownKey)).toBe(true);
		expect(before.has(closeKey)).toBe(true);
		const moved: PlacementHoldEntry = {
			target: "case-operation",
			formUuid: FOLLOWUP,
			operationUuid: ownOf(store.getState()),
			placement: {
				kind: "save-to-case",
				path: ["nova_operations", "nova_own"],
			},
		};
		store
			.getState()
			.recordPlacementHolds([
				moved,
				{ target: "own-close", formUuid: DISCHARGE, placement: null },
			]);
		const after = store.getState().recordedHolds;
		expect(after.get(ownKey)).toEqual(moved);
		expect(after.has(closeKey)).toBe(false);
		for (const [key, hold] of before)
			if (key !== ownKey && key !== closeKey)
				expect(after.get(key)).toEqual(hold);
		expect(after.size).toBe(before.size - 1);
		// The record the store held before is a value, never changed in place.
		expect(before.get(ownKey)).not.toEqual(moved);
		// A recording of nothing leaves the record as it is.
		store.getState().recordPlacementHolds([]);
		expect(store.getState().recordedHolds).toBe(after);
	});
});

describe("the queued commands a placement conflict hands back", () => {
	it("are the queue's mutations in the order they were made, and stay queued", () => {
		const store = heldStore();
		const first = setRemark(store.getState(), read("age"));
		apply(store, [first]);
		const second = setRemark(store.getState(), read("status"));
		apply(store, [second]);
		const queued = store.getState().peekCommandBatches();
		expect(queued).toHaveLength(2);
		expect(store.getState().queuedCommandMutations()).toEqual(queued.flat());
		expect(store.getState().peekCommandBatches()).toHaveLength(2);
		store.getState().discardUncommittedCommandState();
		expect(store.getState().queuedCommandMutations()).toEqual([]);
	});
});
