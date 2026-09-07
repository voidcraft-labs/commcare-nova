import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { blueprintDocSchema, fieldCaseWrite } from "@/lib/domain";
import { APP_GENESIS_FALLBACK_NAME } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

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
					caseWrite: { caseType: "patient", property: "old_value" },
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

		apply(store, [
			{
				kind: "updateField",
				uuid: testUuid(fieldUuid),
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "new_value" },
				},
			},
		]);
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

	it("ignores hidden expressions on a field that does not write case data", () => {
		const { doc, fieldUuid } = makeCaseWriteDoc();
		doc.fields[fieldUuid] = {
			uuid: testUuid(fieldUuid),
			kind: "hidden",
			id: "answer",
			calculate: { parts: [{ kind: "text", text: "'initial'" }] },
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
				patch: { calculate: { parts: [{ kind: "text", text: "today()" }] } },
			},
		]);

		expect(store.getState().caseWriteProjectionRevision).toBe(baseline);
	});

	it("ignores a stale hidden-field update after the displayed field was removed", () => {
		const { doc, fieldUuid } = makeCaseWriteDoc();
		doc.fields[fieldUuid] = {
			uuid: testUuid(fieldUuid),
			kind: "hidden",
			id: "answer",
			calculate: { parts: [{ kind: "text", text: "'initial'" }] },
			caseWrite: { caseType: "patient", property: "old_value" },
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
						calculate: { parts: [{ kind: "text", text: "today()" }] },
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

	it("undoes and redoes an existing case destination with the scalar inverse", () => {
		const { doc, fieldUuid } = makeCaseWriteDoc();
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		const forward = admitMutationBatch([
			{
				kind: "updateField",
				uuid: testUuid(fieldUuid),
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "new_value" },
				},
			},
		]);

		apply(store, forward);
		expect(fieldCaseWrite(store.getState().fields[fieldUuid])).toEqual({
			caseType: "patient",
			property: "new_value",
		});
		store.getState().undo();
		expect(fieldCaseWrite(store.getState().fields[fieldUuid])).toEqual({
			caseType: "patient",
			property: "old_value",
		});
		store.getState().redo();
		expect(fieldCaseWrite(store.getState().fields[fieldUuid])).toEqual({
			caseType: "patient",
			property: "new_value",
		});
	});

	it("uses the complete inverse when a case destination adds catalog structure", () => {
		const { doc, fieldUuid } = makeCaseWriteDoc();
		const store = createBlueprintDocStore();
		assertAdmittedDoc(doc);
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		apply(store, [
			{
				kind: "updateField",
				uuid: testUuid(fieldUuid),
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "brand_new" },
				},
			},
		]);
		expect(
			store
				.getState()
				.caseTypes?.[0]?.properties.some(({ name }) => name === "brand_new"),
		).toBe(true);

		store.getState().undo();
		expect(fieldCaseWrite(store.getState().fields[fieldUuid])).toEqual({
			caseType: "patient",
			property: "old_value",
		});
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
