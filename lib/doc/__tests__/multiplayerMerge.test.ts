/**
 * Phase 2 — merge-by-construction state-model tests.
 *
 * Every structural / collection / catalog edit is identity-keyed and carries an
 * absolute fractional `order` key, so two members editing DIFFERENT entities,
 * properties, list items, or reordering different things converge on the
 * guarded re-apply. These tests exercise the convergence purely (apply the two
 * batches in either order → same result) plus the gate rejections the new
 * granular reducers make reachable. No DOM — the state model + diff only.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { updateColumnMutation } from "@/lib/agent/blueprintHelpers";
import { assembleFieldMutations } from "@/lib/agent/tools/shared/fieldAssembly";
import { batchTargetsMissing } from "@/lib/db/commitGuard";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { applyMutations } from "@/lib/doc/mutations";
import {
	backfillOptionUuids,
	backfillOrderKeys,
} from "@/lib/doc/order/backfill";
import { columnSurfaceMoveMutation } from "@/lib/doc/order/columnSurface";
import { byListColumnOrder, bySortKey } from "@/lib/doc/order/compare";
import { keyBetween } from "@/lib/doc/order/keys";
import { searchInputMoveMutation } from "@/lib/doc/order/searchInput";
import {
	declareCaseTypeForField,
	formScaffoldMutations,
} from "@/lib/doc/scaffolds";
import type { Mutation, Uuid } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type Module,
	simpleSearchInputDef,
} from "@/lib/domain";

// ── Helpers ────────────────────────────────────────────────────────────

function apply(doc: BlueprintDoc, ...batches: Mutation[][]): BlueprintDoc {
	return produce(doc, (draft) => {
		for (const batch of batches) applyMutations(draft, batch);
	});
}

/** The pre-visibility-patch updateColumn reducer kept for rolling-deploy proof. */
function applyWithLegacyColumnReducer(
	doc: BlueprintDoc,
	batch: Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		for (const mutation of batch) {
			if (mutation.kind !== "updateColumn") {
				throw new Error(`legacy receiver cannot dispatch ${mutation.kind}`);
			}
			const config = draft.modules[mutation.moduleUuid]?.caseListConfig;
			const index = config?.columns.findIndex(
				(column) => column.uuid === mutation.uuid,
			);
			if (!config || index === undefined || index < 0) continue;
			const current = config.columns[index];
			const replacement = { ...mutation.column, uuid: mutation.uuid };
			for (const key of ["order", "listOrder", "detailOrder"] as const) {
				if (current[key] === undefined) delete replacement[key];
				else replacement[key] = current[key];
			}
			config.columns[index] = replacement;
		}
	});
}

function backfilled(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (d) => {
		backfillOrderKeys(d);
		backfillOptionUuids(d);
	});
}

function byId(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find((fl) => fl.id === id);
	if (!field) throw new Error(`no field "${id}"`);
	return field;
}

function fieldDisplayIds(doc: BlueprintDoc, formUuid: Uuid): string[] {
	return orderedFieldUuids(doc, formUuid).map((u) => doc.fields[u]?.id ?? "");
}

/** A two-field survey form (q1, q2) — backfilled so every entity is keyed. */
function twoFieldForm(): { doc: BlueprintDoc; formUuid: Uuid } {
	const doc = backfilled(
		buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q1", label: "Q1" }),
								f({ kind: "text", id: "q2", label: "Q2" }),
								f({ kind: "text", id: "q3", label: "Q3" }),
							],
						},
					],
				},
			],
		}),
	);
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	return { doc, formUuid };
}

// ── Concurrent disjoint reorders converge ──────────────────────────────

describe("concurrent disjoint reorders converge", () => {
	it("two members reordering different forms' fields both land", () => {
		const doc = backfilled(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "FA",
								type: "survey",
								fields: [
									f({ kind: "text", id: "a1", label: "A1" }),
									f({ kind: "text", id: "a2", label: "A2" }),
								],
							},
							{
								name: "FB",
								type: "survey",
								fields: [
									f({ kind: "text", id: "b1", label: "B1" }),
									f({ kind: "text", id: "b2", label: "B2" }),
								],
							},
						],
					},
				],
			}),
		);
		const formA = doc.formOrder[doc.moduleOrder[0]][0];
		const formB = doc.formOrder[doc.moduleOrder[0]][1];
		const a2 = byId(doc, "a2").uuid;
		const b2 = byId(doc, "b2").uuid;
		// Member 1 moves a2 to the front of FA; member 2 moves b2 to the front
		// of FB — disjoint order-key edits.
		const batchA: Mutation[] = [
			{ kind: "moveField", uuid: a2, toParentUuid: formA, order: "0" },
		];
		const batchB: Mutation[] = [
			{ kind: "moveField", uuid: b2, toParentUuid: formB, order: "0" },
		];
		const ab = apply(doc, batchA, batchB);
		const ba = apply(doc, batchB, batchA);
		expect(fieldDisplayIds(ab, formA)).toEqual(["a2", "a1"]);
		expect(fieldDisplayIds(ab, formB)).toEqual(["b2", "b1"]);
		// Order-independent: both interleavings produce the same display order.
		expect(fieldDisplayIds(ba, formA)).toEqual(fieldDisplayIds(ab, formA));
		expect(fieldDisplayIds(ba, formB)).toEqual(fieldDisplayIds(ab, formB));
	});

	it("a same-position order-key-only reorder is emitted by the diff and persists", () => {
		const { doc, formUuid } = twoFieldForm();
		// Move q3 to the very front by keying it strictly before q1.
		const q1Order = byId(doc, "q1").order ?? null;
		const next = produce(doc, (draft) => {
			const q3 = Object.values(draft.fields).find((fl) => fl.id === "q3");
			if (q3) q3.order = keyBetween(null, q1Order);
		});
		// The membership array is UNCHANGED — only the order key moved.
		expect(next.fieldOrder[formUuid]).toEqual(doc.fieldOrder[formUuid]);
		const diff = diffDocsToMutations(doc, next);
		const move = diff.find((m) => m.kind === "moveField");
		expect(move).toBeDefined();
		expect(move && "order" in move).toBe(true);
		// Replaying the diff reproduces the new DISPLAY order.
		const replayed = apply(doc, diff);
		expect(fieldDisplayIds(replayed, formUuid)).toEqual(
			fieldDisplayIds(next, formUuid),
		);
		expect(fieldDisplayIds(replayed, formUuid)[0]).toBe("q3");
	});
});

// ── Concurrent catalog edits ───────────────────────────────────────────

describe("granular catalog merges", () => {
	it("two concurrent addCaseProperty to one type both materialize", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [{ name: "M", caseType: "patient" }],
		});
		const batchA: Mutation[] = [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "age", label: "Age" },
			},
		];
		const batchB: Mutation[] = [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "village", label: "Village" },
			},
		];
		const merged = apply(doc, batchA, batchB);
		const names = merged.caseTypes
			?.find((ct) => ct.name === "patient")
			?.properties.map((p) => p.name);
		expect(names).toEqual(["age", "village"]);
		// Either order yields the same set (order within differs, content same).
		const reverse = apply(doc, batchB, batchA);
		const reverseNames = reverse.caseTypes
			?.find((ct) => ct.name === "patient")
			?.properties.map((p) => p.name)
			.sort();
		expect(reverseNames).toEqual(["age", "village"]);
	});

	it("a field on a concurrently-retired type is 409'd via CASE_PROPERTY_ON_UNKNOWN_TYPE", () => {
		// `prev` has the type declared with a writer; a peer retired it. Re-apply
		// the writer-add batch on the retired `freshDoc` → the field points at an
		// absent type → the gate rejects.
		const freshDoc = buildDoc({
			caseTypes: null,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "F", type: "survey", fields: [] }],
				},
			],
		});
		const formUuid = freshDoc.formOrder[freshDoc.moduleOrder[0]][0];
		const batch: Mutation[] = [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: f({
					kind: "text",
					id: "age",
					label: "Age",
					case_property_on: "patient",
				}) as unknown as Field,
			},
		];
		const verdict = mutationCommitVerdict(freshDoc, batch);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(
				verdict.introduced.some(
					(e) => e.code === "CASE_PROPERTY_ON_UNKNOWN_TYPE",
				),
			).toBe(true);
		}
	});

	it("the diff emits setCaseTypeMeta with ONLY the changed ancestry slot", () => {
		const prev = buildDoc({
			caseTypes: [
				{
					name: "child",
					properties: [],
					parent_type: "parent",
					relationship: "child",
				},
				{ name: "parent", properties: [] },
			],
			modules: [{ name: "M", caseType: "child" }],
		});
		// Only `relationship` changes (child → extension); `parent_type` is untouched.
		const next = produce(prev, (draft) => {
			const ct = draft.caseTypes?.find((c) => c.name === "child");
			if (ct) ct.relationship = "extension";
		});
		const diff = diffDocsToMutations(prev, next);
		const meta = diff.find((m) => m.kind === "setCaseTypeMeta");
		expect(meta).toBeDefined();
		if (meta && meta.kind === "setCaseTypeMeta") {
			// The untouched slot is NOT re-emitted (undefined = unchanged), so a
			// concurrent edit to `parent_type` can't be clobbered.
			expect(meta.relationship).toBe("extension");
			expect("parent_type" in meta).toBe(false);
		}
	});

	it("concurrent edits to DIFFERENT ancestry slots both survive the merge", () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "visit", properties: [] },
				{ name: "patient", properties: [] },
				{ name: "clinic", properties: [] },
			],
			modules: [{ name: "M", caseType: "visit" }],
		});
		// Member A sets `parent_type` on `visit`; member B sets `relationship` on
		// `visit` — DIFFERENT slots of the same case type. Under the always-both
		// emission each carried the other slot pinned to its own snapshot, so the
		// second commit clobbered the first. Granular per-slot emission fixes it.
		const batchA: Mutation[] = [
			{ kind: "setCaseTypeMeta", caseType: "visit", parent_type: "patient" },
		];
		const batchB: Mutation[] = [
			{ kind: "setCaseTypeMeta", caseType: "visit", relationship: "extension" },
		];
		const ab = apply(doc, batchA, batchB);
		const ba = apply(doc, batchB, batchA);
		for (const merged of [ab, ba]) {
			const ct = merged.caseTypes?.find((c) => c.name === "visit");
			expect(ct?.parent_type).toBe("patient");
			expect(ct?.relationship).toBe("extension");
		}
	});
});

// ── Concurrent collection edits ────────────────────────────────────────

describe("disjoint collection edits merge", () => {
	function moduleWithTwoColumns(): {
		doc: BlueprintDoc;
		moduleUuid: Uuid;
		colA: Uuid;
		colB: Uuid;
	} {
		const doc = backfilled(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: "Name" },
							{ name: "age", label: "Age" },
						],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
							{ field: "age", header: "Age" },
						]),
						forms: [
							{
								name: "F",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "case_name",
										label: "Name",
										case_property_on: "patient",
									}),
									f({
										kind: "int",
										id: "age",
										label: "Age",
										case_property_on: "patient",
									}),
								],
							},
						],
					},
				],
			}),
		);
		const moduleUuid = doc.moduleOrder[0];
		const cols = doc.modules[moduleUuid].caseListConfig?.columns ?? [];
		return { doc, moduleUuid, colA: cols[0].uuid, colB: cols[1].uuid };
	}

	it("two members editing different columns merge", () => {
		const { doc, moduleUuid, colA, colB } = moduleWithTwoColumns();
		const batchA: Mutation[] = [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: colA,
				column: {
					uuid: colA,
					kind: "plain",
					field: "case_name",
					header: "Patient name",
				},
			},
		];
		const batchB: Mutation[] = [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: colB,
				column: { uuid: colB, kind: "plain", field: "age", header: "Years" },
			},
		];
		const merged = apply(doc, batchA, batchB);
		const cols = merged.modules[moduleUuid].caseListConfig?.columns ?? [];
		const headerByUuid = new Map(cols.map((c) => [c.uuid, c.header]));
		// Both edits survive — neither clobbers the other.
		expect(headerByUuid.get(colA)).toBe("Patient name");
		expect(headerByUuid.get(colB)).toBe("Years");
	});

	it("a Results hide and a stale inspector edit merge in either order", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const hidden = produce(doc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) column.visibleInList = false;
		});
		const formatted = produce(doc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) column.header = "Patient name";
		});
		const hideBatch = diffDocsToMutations(doc, hidden);
		const formatBatch = diffDocsToMutations(doc, formatted);

		expect(hideBatch).toContainEqual(
			expect.objectContaining({
				kind: "updateColumn",
				moduleUuid,
				uuid: colA,
				visibilityPatch: { surface: "list", visible: false },
			}),
		);
		expect(
			hideBatch.some(
				(mutation) =>
					mutation.kind === "updateColumn" &&
					mutation.visibilityPatch === undefined,
			),
		).toBe(false);
		expect(formatBatch).toContainEqual(
			expect.objectContaining({
				kind: "updateColumn",
				preserveVisibility: true,
			}),
		);

		for (const merged of [
			apply(doc, hideBatch, formatBatch),
			apply(doc, formatBatch, hideBatch),
		]) {
			const column = merged.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			expect(column?.header).toBe("Patient name");
			expect(column?.visibleInList).toBe(false);
		}
	});

	it("an SA/MCP visibility-only replacement omits stale column content", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const current = doc.modules[moduleUuid].caseListConfig?.columns.find(
			(candidate) => candidate.uuid === colA,
		);
		if (!current) throw new Error("fixture column missing");
		const visibilityPlan = updateColumnMutation(doc.modules[moduleUuid], colA, {
			...current,
			visibleInList: false,
		});
		if ("error" in visibilityPlan) throw new Error(visibilityPlan.error);
		expect(visibilityPlan.mutations).toHaveLength(1);
		expect(visibilityPlan.mutations[0]).toEqual(
			expect.objectContaining({
				kind: "updateColumn",
				visibilityPatch: { surface: "list", visible: false },
			}),
		);

		const formatted = produce(doc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) column.header = "Peer format";
		});
		const formatBatch = diffDocsToMutations(doc, formatted);
		for (const merged of [
			apply(doc, visibilityPlan.mutations, formatBatch),
			apply(doc, formatBatch, visibilityPlan.mutations),
		]) {
			const column = merged.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			expect(column?.header).toBe("Peer format");
			expect(column?.visibleInList).toBe(false);
		}
	});

	it("a Results restore and a stale inspector edit merge in either order", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const hiddenDoc = produce(doc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) column.visibleInList = false;
		});
		const shown = produce(hiddenDoc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) delete column.visibleInList;
		});
		const formatted = produce(hiddenDoc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) column.header = "Patient name";
		});
		const showBatch = diffDocsToMutations(hiddenDoc, shown);
		const formatBatch = diffDocsToMutations(hiddenDoc, formatted);

		expect(showBatch).toContainEqual(
			expect.objectContaining({
				kind: "updateColumn",
				moduleUuid,
				uuid: colA,
				visibilityPatch: { surface: "list", visible: true },
			}),
		);
		expect(
			showBatch.some(
				(mutation) =>
					mutation.kind === "updateColumn" &&
					mutation.visibilityPatch === undefined,
			),
		).toBe(false);
		expect(formatBatch).toContainEqual(
			expect.objectContaining({
				kind: "updateColumn",
				preserveVisibility: true,
			}),
		);

		for (const merged of [
			apply(hiddenDoc, showBatch, formatBatch),
			apply(hiddenDoc, formatBatch, showBatch),
		]) {
			const column = merged.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			expect(column?.header).toBe("Patient name");
			expect(column?.visibleInList).toBeUndefined();
		}
	});

	it("unmarked updateColumn events retain legacy visibility semantics", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const current = doc.modules[moduleUuid].caseListConfig?.columns.find(
			(candidate) => candidate.uuid === colA,
		);
		if (!current) throw new Error("fixture column missing");

		const hidden = apply(doc, [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: colA,
				column: { ...current, visibleInList: false },
			},
		]);
		expect(
			hidden.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			)?.visibleInList,
		).toBe(false);

		const { visibleInList: _visibility, ...shownColumn } = current;
		const shown = apply(hidden, [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: colA,
				column: shownColumn,
			},
		]);
		expect(
			shown.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			)?.visibleInList,
		).toBeUndefined();
	});

	it("new visibility patches remain effective on a pre-deploy receiver", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const hiddenDoc = produce(doc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) column.visibleInList = false;
		});
		const hideBatch = diffDocsToMutations(doc, hiddenDoc);
		expect(
			hideBatch.every((mutation) => mutation.kind === "updateColumn"),
		).toBe(true);
		const legacyHidden = applyWithLegacyColumnReducer(doc, hideBatch);
		expect(
			legacyHidden.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			)?.visibleInList,
		).toBe(false);

		const shownDoc = produce(hiddenDoc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			if (column) delete column.visibleInList;
		});
		const showBatch = diffDocsToMutations(hiddenDoc, shownDoc);
		expect(
			showBatch.every((mutation) => mutation.kind === "updateColumn"),
		).toBe(true);
		const legacyShown = applyWithLegacyColumnReducer(legacyHidden, showBatch);
		expect(
			legacyShown.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			)?.visibleInList,
		).toBeUndefined();
	});

	it("Results and Details reorders commute and survive a stale content edit", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const original = doc.modules[moduleUuid].caseListConfig?.columns.find(
			(c) => c.uuid === colA,
		);
		if (!original) throw new Error("fixture column missing");

		const moveList: Mutation[] = [
			{
				kind: "moveColumnInList",
				moduleUuid,
				uuid: colA,
				order: "list-z",
			},
		];
		const moveDetail: Mutation[] = [
			{
				kind: "moveColumnInDetail",
				moduleUuid,
				uuid: colA,
				order: "detail-a",
			},
		];
		const staleContentEdit: Mutation[] = [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: colA,
				// Captured before either reorder: it carries neither new surface key.
				column: { ...original, header: "Patient" },
			},
		];

		const listThenDetail = apply(doc, moveList, moveDetail, staleContentEdit);
		const detailThenList = apply(doc, staleContentEdit, moveDetail, moveList);
		for (const merged of [listThenDetail, detailThenList]) {
			const column = merged.modules[moduleUuid].caseListConfig?.columns.find(
				(c) => c.uuid === colA,
			);
			expect(column?.header).toBe("Patient");
			expect(column?.order).toBe(original.order);
			expect(column?.listOrder).toBe("list-z");
			expect(column?.detailOrder).toBe("detail-a");
		}
	});

	it("two same-Results gestures write one moved row each and commute", () => {
		const { doc, moduleUuid, colA, colB } = moduleWithTwoColumns();
		const columns = doc.modules[moduleUuid].caseListConfig?.columns ?? [];
		const moveA = columnSurfaceMoveMutation({
			moduleUuid,
			columns,
			surface: "list",
			uuid: colA,
			toIndex: 1,
		});
		const moveB = columnSurfaceMoveMutation({
			moduleUuid,
			columns,
			surface: "list",
			uuid: colB,
			toIndex: 0,
		});
		if (moveA === undefined || moveB === undefined) {
			throw new Error("expected both gestures to plan a move");
		}

		// This is the regression: the old workspace resequenced BOTH rows for
		// either gesture, so each autosave batch overwrote its peer's order key.
		expect(moveA).toMatchObject({ kind: "moveColumnInList", uuid: colA });
		expect(moveB).toMatchObject({ kind: "moveColumnInList", uuid: colB });

		const aThenB = apply(doc, [moveA], [moveB]);
		const bThenA = apply(doc, [moveB], [moveA]);
		expect(aThenB).toEqual(bThenA);
		const visible = [
			...(aThenB.modules[moduleUuid].caseListConfig?.columns ?? []),
		].sort(byListColumnOrder);
		expect(visible.map((column) => column.uuid)).toEqual([colB, colA]);
	});

	it("two search-order gestures write one moved field each and commute", () => {
		const inputA = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000321"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const inputB = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000322"),
			"external_id",
			"External ID",
			"text",
			"external_id",
		);
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [inputA, inputB];
		const doc = backfilled(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: "Name" },
							{ name: "external_id", label: "External ID" },
						],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: config,
					},
				],
			}),
		);
		const moduleUuid = doc.moduleOrder[0];
		const inputs = doc.modules[moduleUuid].caseListConfig?.searchInputs ?? [];
		const moveA = searchInputMoveMutation({
			moduleUuid,
			inputs,
			uuid: inputA.uuid,
			toIndex: 1,
		});
		const moveB = searchInputMoveMutation({
			moduleUuid,
			inputs,
			uuid: inputB.uuid,
			toIndex: 0,
		});
		if (moveA === undefined || moveB === undefined) {
			throw new Error("expected both search gestures to plan a move");
		}

		expect(moveA).toMatchObject({
			kind: "moveSearchInput",
			uuid: inputA.uuid,
		});
		expect(moveB).toMatchObject({
			kind: "moveSearchInput",
			uuid: inputB.uuid,
		});

		const aThenB = apply(doc, [moveA], [moveB]);
		const bThenA = apply(doc, [moveB], [moveA]);
		expect(aThenB).toEqual(bThenA);
		const ordered = [
			...(aThenB.modules[moduleUuid].caseListConfig?.searchInputs ?? []),
		].sort(bySortKey);
		expect(ordered.map((input) => input.uuid)).toEqual([
			inputB.uuid,
			inputA.uuid,
		]);
	});

	it("diff emits independent surface moves without a content update", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const next = produce(doc, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(c) => c.uuid === colA,
			);
			if (column) {
				column.listOrder = "list-z";
				column.detailOrder = "detail-a";
			}
		});

		const diff = diffDocsToMutations(doc, next);
		expect(diff.filter((m) => m.kind === "moveColumnInList")).toHaveLength(1);
		expect(diff.filter((m) => m.kind === "moveColumnInDetail")).toHaveLength(1);
		expect(diff.some((m) => m.kind === "updateColumn")).toBe(false);

		const replayed = apply(doc, diff);
		const replayedColumn = replayed.modules[
			moduleUuid
		].caseListConfig?.columns.find((c) => c.uuid === colA);
		expect(replayedColumn?.listOrder).toBe("list-z");
		expect(replayedColumn?.detailOrder).toBe("detail-a");

		// Undo/reset removes the optional overrides so each surface falls back to
		// generic `order`. The diff must carry explicit nulls across JSON; omitting
		// these moves would leave the confirmed/server doc stuck on stale keys.
		const reset = produce(next, (draft) => {
			const column = draft.modules[moduleUuid].caseListConfig?.columns.find(
				(c) => c.uuid === colA,
			);
			if (column) {
				delete column.listOrder;
				delete column.detailOrder;
			}
		});
		const resetDiff = diffDocsToMutations(next, reset);
		expect(resetDiff.find((m) => m.kind === "moveColumnInList")).toMatchObject({
			order: null,
		});
		expect(
			resetDiff.find((m) => m.kind === "moveColumnInDetail"),
		).toMatchObject({ order: null });
		const resetReplayed = apply(next, resetDiff);
		const resetColumn = resetReplayed.modules[
			moduleUuid
		].caseListConfig?.columns.find((c) => c.uuid === colA);
		expect(resetColumn?.listOrder).toBeUndefined();
		expect(resetColumn?.detailOrder).toBeUndefined();
	});

	it("two members editing different options of one field merge", () => {
		const doc = backfilled(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "color",
										label: "Color",
										options: [
											{ value: "r", label: "Red" },
											{ value: "g", label: "Green" },
										],
									}),
								],
							},
						],
					},
				],
			}),
		);
		const field = byId(doc, "color") as Field & {
			options: Array<{ uuid?: Uuid; value: string; label: string }>;
		};
		const optR = asUuid(field.options[0].uuid as string);
		const optG = asUuid(field.options[1].uuid as string);
		const batchA: Mutation[] = [
			{
				kind: "updateOption",
				fieldUuid: field.uuid,
				uuid: optR,
				option: { uuid: optR, value: "r", label: "Crimson" },
			},
		];
		const batchB: Mutation[] = [
			{
				kind: "updateOption",
				fieldUuid: field.uuid,
				uuid: optG,
				option: { uuid: optG, value: "g", label: "Emerald" },
			},
		];
		const merged = apply(doc, batchA, batchB);
		const opts = (
			merged.fields[field.uuid] as Field & {
				options: Array<{ uuid?: Uuid; label: string }>;
			}
		).options;
		const labelByUuid = new Map(opts.map((o) => [o.uuid, o.label]));
		expect(labelByUuid.get(optR)).toBe("Crimson");
		expect(labelByUuid.get(optG)).toBe("Emerald");
	});

	it("removeOption below two options is gate-rejected (SELECT_TOO_FEW_OPTIONS)", () => {
		const doc = backfilled(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "color",
										label: "Color",
										options: [
											{ value: "r", label: "Red" },
											{ value: "g", label: "Green" },
										],
									}),
								],
							},
						],
					},
				],
			}),
		);
		const field = byId(doc, "color") as Field & {
			options: Array<{ uuid?: Uuid }>;
		};
		const batch: Mutation[] = [
			{
				kind: "removeOption",
				fieldUuid: field.uuid,
				uuid: asUuid(field.options[0].uuid as string),
			},
		];
		const verdict = mutationCommitVerdict(doc, batch);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(
				verdict.introduced.some((e) => e.code === "SELECT_TOO_FEW_OPTIONS"),
			).toBe(true);
		}
	});
});

// ── setCaseListMeta does not resurrect a peer-removed config ────────────

describe("setCaseListMeta on a peer-removed config", () => {
	/** A case-list module whose config carries a filter — the slot a
	 *  concurrent `setCaseListMeta` edits. */
	function moduleWithFilter(): { doc: BlueprintDoc; moduleUuid: Uuid } {
		const doc = backfilled(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: "Name" }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: {
							...caseListConfig([{ field: "case_name", header: "Name" }]),
							filter: { kind: "match-all" },
						},
					},
				],
			}),
		);
		return { doc, moduleUuid: doc.moduleOrder[0] };
	}

	it("guard rejects a setCaseListMeta whose config a peer cleared (409, not resurrection)", () => {
		const { doc, moduleUuid } = moduleWithFilter();
		// Member A cleared the WHOLE case-list config (the presence transition the
		// diff emits as a wholesale `updateModule{caseListConfig:null}`).
		const aCommitted = apply(doc, [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: null } as unknown as Partial<Module>,
			},
		]);
		expect(aCommitted.modules[moduleUuid].caseListConfig).toBeUndefined();

		// Member B, against the pre-clear doc, edits the always-on filter.
		const bBatch: Mutation[] = [
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { filter: { kind: "match-none" } },
			},
		];

		// On the guarded re-apply against A's committed doc, B's edit targets a
		// config that no longer exists → a conflict (→ BlueprintCommitRejectedError
		// → 409 reload), NOT a silent no-op that resurrects the case list.
		expect(batchTargetsMissing(aCommitted, bBatch)).toBe(true);
	});

	it("reducer does not resurrect the config even if the guard is bypassed", () => {
		const { doc, moduleUuid } = moduleWithFilter();
		const aCommitted = apply(doc, [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: null } as unknown as Partial<Module>,
			},
		]);
		// Apply B's setCaseListMeta directly (bypassing the guard): the reducer
		// reads the config directly and no-ops — the removed case list stays
		// removed rather than reappearing as an empty-but-present config.
		const merged = apply(aCommitted, [
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { filter: { kind: "match-none" } },
			},
		]);
		expect(merged.modules[moduleUuid].caseListConfig).toBeUndefined();
	});

	it("a setCaseListMeta on a live config still applies (guard passes, filter lands)", () => {
		const { doc, moduleUuid } = moduleWithFilter();
		const batch: Mutation[] = [
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { filter: { kind: "match-none" } },
			},
		];
		expect(batchTargetsMissing(doc, batch)).toBe(false);
		const merged = apply(doc, batch);
		expect(merged.modules[moduleUuid].caseListConfig?.filter).toEqual({
			kind: "match-none",
		});
	});

	it("a same-batch config birth then setCaseListMeta is not falsely rejected", () => {
		const { doc, moduleUuid } = moduleWithFilter();
		// Peer cleared the config; a later batch idempotently re-creates it AND
		// edits its metadata in the same batch — the guard must see the
		// intra-batch birth.
		const cleared = apply(doc, [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: null } as unknown as Partial<Module>,
			},
		]);
		const rebirth: Mutation[] = [
			{
				kind: "ensureCaseListConfig",
				uuid: moduleUuid,
			},
			{
				kind: "addColumn",
				moduleUuid,
				column: caseListConfig([{ field: "case_name", header: "Name" }])
					.columns[0],
			},
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { filter: { kind: "match-all" } },
			},
		];
		expect(batchTargetsMissing(cleared, rebirth)).toBe(false);
	});
});

// ── Diff: case-list birth / case-type flip stay granular ───────────────

describe("diff — case-list presence transition", () => {
	it("emits an idempotent ensure for an empty absent→present transition", () => {
		const prev = backfilled(
			buildDoc({
				modules: [{ name: "M", caseType: "patient" }],
			}),
		);
		const moduleUuid = prev.moduleOrder[0];
		const next = produce(prev, (draft) => {
			draft.modules[moduleUuid].caseListConfig = {
				columns: [],
				searchInputs: [],
			};
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff).toContainEqual({
			kind: "ensureCaseListConfig",
			uuid: moduleUuid,
		});
		expect(
			diff.some(
				(m) =>
					m.kind === "updateModule" && Object.hasOwn(m.patch, "caseListConfig"),
			),
		).toBe(false);
		expect(apply(prev, diff).modules[moduleUuid].caseListConfig).toEqual(
			next.modules[moduleUuid].caseListConfig,
		);
	});

	it("replays a populated birth over a peer config without losing peer items", () => {
		const prev = backfilled(
			buildDoc({
				modules: [{ name: "M", caseType: "patient" }],
			}),
		);
		const moduleUuid = prev.moduleOrder[0];
		const localColumnUuid = asUuid("00000000-0000-4000-8000-000000000061");
		const peerColumnUuid = asUuid("00000000-0000-4000-8000-000000000062");
		const next = produce(prev, (draft) => {
			draft.modules[moduleUuid].caseListConfig = {
				columns: [
					{
						uuid: localColumnUuid,
						kind: "plain",
						field: "case_name",
						header: "Name",
					},
				],
				searchInputs: [],
				filter: { kind: "match-all" },
			};
		});
		const localBatch = diffDocsToMutations(prev, next);
		expect(localBatch).toContainEqual({
			kind: "ensureCaseListConfig",
			uuid: moduleUuid,
		});
		expect(
			localBatch.some(
				(m) =>
					m.kind === "updateModule" && Object.hasOwn(m.patch, "caseListConfig"),
			),
		).toBe(false);

		const peerFresh = apply(prev, [
			{
				kind: "addColumn",
				moduleUuid,
				column: {
					uuid: peerColumnUuid,
					kind: "plain",
					field: "external_id",
					header: "External ID",
				},
			},
		]);
		expect(batchTargetsMissing(peerFresh, localBatch)).toBe(false);
		const merged = apply(peerFresh, localBatch);
		expect(
			merged.modules[moduleUuid].caseListConfig?.columns
				.map((column) => column.uuid)
				.sort(),
		).toEqual([localColumnUuid, peerColumnUuid].sort());
		expect(merged.modules[moduleUuid].caseListConfig?.filter).toEqual({
			kind: "match-all",
		});
	});

	it("keeps a case-type flip granular so a peer search input survives", () => {
		const prev = backfilled(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: "Name" }],
					},
					{
						name: "visit",
						properties: [{ name: "case_name", label: "Name" }],
					},
				],
				modules: [
					{
						name: "M",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
					},
				],
			}),
		);
		const moduleUuid = prev.moduleOrder[0];
		const localColumnUuid = asUuid("00000000-0000-4000-8000-000000000063");
		const peerInputUuid = asUuid("00000000-0000-4000-8000-000000000064");
		const next = produce(prev, (draft) => {
			draft.modules[moduleUuid].caseType = "visit";
			draft.modules[moduleUuid].caseListConfig?.columns.push({
				uuid: localColumnUuid,
				kind: "plain",
				field: "case_name",
				header: "Visit name",
			});
		});
		const localBatch = diffDocsToMutations(prev, next);
		expect(
			localBatch.some(
				(m) =>
					m.kind === "updateModule" && Object.hasOwn(m.patch, "caseListConfig"),
			),
		).toBe(false);
		expect(localBatch).toContainEqual(
			expect.objectContaining({
				kind: "addColumn",
				moduleUuid,
				column: expect.objectContaining({ uuid: localColumnUuid }),
			}),
		);

		const peerFresh = apply(prev, [
			{
				kind: "addSearchInput",
				moduleUuid,
				searchInput: {
					uuid: peerInputUuid,
					kind: "simple",
					name: "peer_name",
					label: "Peer name",
					type: "text",
					property: "case_name",
				},
			},
		]);
		expect(batchTargetsMissing(peerFresh, localBatch)).toBe(false);
		const merged = apply(peerFresh, localBatch);
		expect(merged.modules[moduleUuid].caseType).toBe("visit");
		expect(
			merged.modules[moduleUuid].caseListConfig?.columns.some(
				(column) => column.uuid === localColumnUuid,
			),
		).toBe(true);
		expect(
			merged.modules[moduleUuid].caseListConfig?.searchInputs.map(
				(input) => input.uuid,
			),
		).toContain(peerInputUuid);
	});
});

// ── Declaration chokepoint ─────────────────────────────────────────────

describe("every case_property_on surface declares the type", () => {
	const baseDoc = () =>
		buildDoc({
			caseTypes: null,
			modules: [
				{
					name: "M",
					caseType: "patient",
					forms: [{ name: "F", type: "survey", fields: [] }],
				},
			],
		});

	it("declareCaseTypeForField (the builder add/edit chokepoint) prepends declareCaseType", () => {
		const doc = baseDoc();
		const writer = f({
			kind: "text",
			id: "age",
			label: "Age",
			case_property_on: "patient",
		}) as unknown as Field;
		const muts = declareCaseTypeForField(doc, writer);
		expect(muts).toEqual([{ kind: "declareCaseType", caseType: "patient" }]);
		// No-op when the type is already declared, or the field writes no case.
		const declared = produce(doc, (d) => {
			d.caseTypes = [{ name: "patient", properties: [] }];
		});
		expect(declareCaseTypeForField(declared, writer)).toEqual([]);
		const noCase = f({ kind: "text", id: "note", label: "Note" }) as Field;
		expect(declareCaseTypeForField(doc, noCase)).toEqual([]);
	});

	it("assembleFieldMutations (the SA add path) prepends declareCaseType before the addField", () => {
		const doc = baseDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const out = assembleFieldMutations({
			doc,
			formUuid,
			items: [
				{
					kind: "text",
					id: "age",
					label: "Age",
					case_property_on: "patient",
				},
			] as never,
		});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		const declareIdx = out.mutations.findIndex(
			(m) => m.kind === "declareCaseType",
		);
		const addIdx = out.mutations.findIndex((m) => m.kind === "addField");
		expect(declareIdx).toBeGreaterThanOrEqual(0);
		// Declaration BEFORE the add so the field's catalog sync can append.
		expect(declareIdx).toBeLessThan(addIdx);
	});

	it("formScaffoldMutations (the builder add-form path) declares an absent module case type", () => {
		// A viewer whose case type was dropped from the catalog while the module
		// kept its `caseType` (a data-model edit, or a retire-vs-add race). Adding
		// a registration form births a `case_name` writer on `patient`; without a
		// prepended declare that trips CASE_PROPERTY_ON_UNKNOWN_TYPE and the form
		// is silently not created.
		const doc = produce(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: "Name" }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListOnly: true,
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
					},
				],
			}),
			(d) => {
				d.caseTypes = null;
			},
		);
		const moduleUuid = doc.moduleOrder[0];
		const scaffold = formScaffoldMutations(doc, moduleUuid, "registration");
		expect(scaffold).not.toBeNull();
		if (!scaffold) return;

		const declareIdx = scaffold.mutations.findIndex(
			(m) => m.kind === "declareCaseType",
		);
		const writerIdx = scaffold.mutations.findIndex(
			(m) =>
				m.kind === "addField" &&
				(m.field as { case_property_on?: string }).case_property_on ===
					"patient",
		);
		expect(declareIdx).toBeGreaterThanOrEqual(0);
		expect(writerIdx).toBeGreaterThanOrEqual(0);
		// Declared BEFORE the writer so the field's catalog sync can append to it.
		expect(declareIdx).toBeLessThan(writerIdx);

		// Stripping the declare from the SAME batch reproduces the bug: the
		// case_name writer targets an absent type → gate-rejected.
		const withoutDeclare = scaffold.mutations.filter(
			(m) => m.kind !== "declareCaseType",
		);
		const rejected = mutationCommitVerdict(doc, withoutDeclare);
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) {
			expect(
				rejected.introduced.some(
					(e) => e.code === "CASE_PROPERTY_ON_UNKNOWN_TYPE",
				),
			).toBe(true);
		}

		// The shipped builder batch (declare included) passes the gate — the form
		// is created, not 409'd.
		expect(mutationCommitVerdict(doc, scaffold.mutations).ok).toBe(true);
	});
});

// ── Diff round-trip over granular catalog + collection + option edits ──

describe("diff round-trip — granular edits", () => {
	it("replaying a catalog + column + option diff reproduces the display state", () => {
		const prev = backfilled(
			buildDoc({
				caseTypes: [
					{ name: "patient", properties: [{ name: "age", label: "Age" }] },
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([{ field: "age", header: "Age" }]),
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "color",
										label: "Color",
										options: [
											{ value: "r", label: "Red" },
											{ value: "g", label: "Green" },
										],
									}),
								],
							},
						],
					},
				],
			}),
		);
		const moduleUuid = prev.moduleOrder[0];
		const next = produce(prev, (draft) => {
			// Catalog: add a property + set meta.
			const ct = draft.caseTypes?.find((c) => c.name === "patient");
			if (ct) {
				ct.properties.push({ name: "village", label: "Village" });
				ct.parent_type = "household";
			}
			// Column: edit the header.
			const col = draft.modules[moduleUuid].caseListConfig?.columns[0];
			if (col) col.header = "Age in years";
			// Option: edit a label.
			const color = Object.values(draft.fields).find((fl) => fl.id === "color");
			if (color && "options" in color) {
				(color as { options: Array<{ label: string }> }).options[1].label =
					"Emerald";
			}
		});
		const diff = diffDocsToMutations(prev, next);
		// Granular kinds, no wholesale catalog/config.
		expect(diff.some((m) => m.kind === "addCaseProperty")).toBe(true);
		expect(diff.some((m) => m.kind === "setCaseTypeMeta")).toBe(true);
		expect(diff.some((m) => m.kind === "updateColumn")).toBe(true);
		expect(diff.some((m) => m.kind === "updateOption")).toBe(true);
		expect(diff.some((m) => m.kind === "setCaseTypes")).toBe(false);
		const replayed = apply(prev, diff);
		// Catalog + config + options reproduced.
		expect(
			replayed.caseTypes
				?.find((c) => c.name === "patient")
				?.properties.map((p) => p.name)
				.sort(),
		).toEqual(["age", "village"]);
		expect(
			replayed.caseTypes?.find((c) => c.name === "patient")?.parent_type,
		).toBe("household");
		expect(replayed.modules[moduleUuid].caseListConfig?.columns[0].header).toBe(
			"Age in years",
		);
		const opts = (
			Object.values(replayed.fields).find((fl) => fl.id === "color") as {
				options: Array<{ label: string }>;
			}
		).options.map((o) => o.label);
		expect(opts).toContain("Emerald");
	});
});

describe("case-search marker merges", () => {
	function searchDoc(): {
		doc: BlueprintDoc;
		moduleUuid: Uuid;
		inputUuid: Uuid;
	} {
		const inputUuid = asUuid("00000000-0000-4000-8000-000000000051");
		const doc = buildDoc({
			appName: "Search merge",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						columns: caseListConfig([{ field: "case_name", header: "Name" }])
							.columns,
						searchInputs: [
							{
								uuid: inputUuid,
								kind: "simple",
								name: "case_name",
								label: "Name",
								type: "text",
								property: "case_name",
							},
						],
					},
					caseSearchConfig: {},
				},
			],
		});
		return { doc, moduleUuid: doc.moduleOrder[0], inputUuid };
	}

	it("a stale enable never overwrites settings a peer authored", () => {
		const { doc, moduleUuid } = searchDoc();
		const markerless = produce(doc, (draft) => {
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		const peerInputUuid = asUuid("00000000-0000-4000-8000-000000000052");
		const peerBatch: Mutation[] = [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseSearchConfig: { searchScreenTitle: "Find a patient" } },
			},
			{
				kind: "addSearchInput",
				moduleUuid,
				searchInput: {
					uuid: peerInputUuid,
					kind: "simple",
					name: "other_name",
					label: "Other name",
					type: "text",
					property: "case_name",
				},
			},
		];
		const staleEnable: Mutation[] = [
			{ kind: "setCaseSearchMarker", uuid: moduleUuid, enabled: true },
		];
		const merged = apply(markerless, peerBatch, staleEnable);
		expect(merged.modules[moduleUuid].caseSearchConfig).toEqual({
			searchScreenTitle: "Find a patient",
		});
	});

	it("a stale disable preserves peer settings and their newly-added input", () => {
		const { doc, moduleUuid, inputUuid } = searchDoc();
		const peerInputUuid = asUuid("00000000-0000-4000-8000-000000000053");
		const peerBatch: Mutation[] = [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseSearchConfig: { searchButtonLabel: "Find" } },
			},
			{
				kind: "addSearchInput",
				moduleUuid,
				searchInput: {
					uuid: peerInputUuid,
					kind: "simple",
					name: "peer_name",
					label: "Peer name",
					type: "text",
					property: "case_name",
				},
			},
		];
		const staleDisable: Mutation[] = [
			{ kind: "removeSearchInput", moduleUuid, uuid: inputUuid },
			{ kind: "setCaseSearchMarker", uuid: moduleUuid, enabled: false },
		];
		const merged = apply(doc, peerBatch, staleDisable);
		expect(merged.modules[moduleUuid].caseSearchConfig).toEqual({
			searchButtonLabel: "Find",
		});
		expect(
			merged.modules[moduleUuid].caseListConfig?.searchInputs.map(
				(s) => s.uuid,
			),
		).toEqual([peerInputUuid]);
		expect(mutationCommitVerdict(apply(doc, peerBatch), staleDisable).ok).toBe(
			true,
		);
	});

	it("the diff emits semantic marker transitions instead of wholesale writes", () => {
		const { doc, moduleUuid, inputUuid } = searchDoc();
		const markerless = produce(doc, (draft) => {
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		expect(diffDocsToMutations(markerless, doc)).toContainEqual({
			kind: "setCaseSearchMarker",
			uuid: moduleUuid,
			enabled: true,
		});

		const disabled = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0, 1);
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		const diff = diffDocsToMutations(doc, disabled);
		expect(diff).toContainEqual({
			kind: "removeSearchInput",
			moduleUuid,
			uuid: inputUuid,
		});
		expect(diff).toContainEqual({
			kind: "setCaseSearchMarker",
			uuid: moduleUuid,
			enabled: false,
		});
		expect(
			diff.some(
				(m) =>
					m.kind === "updateModule" &&
					Object.hasOwn(m.patch, "caseSearchConfig"),
			),
		).toBe(false);
	});
});

describe("diff — evacuation into a same-diff-added container", () => {
	it("hoists the added destination before the evacuation so the batch replays in order", () => {
		// One accumulated save (in-flight PUT / retry backoff) carrying three
		// gestures: create group G, drag X out of group H into G, delete H.
		const G = asUuid("44444444-4444-4444-4444-444444444444");
		const prev = backfilled(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({
										kind: "group",
										id: "h",
										label: "H",
										children: [f({ kind: "text", id: "x", label: "X" })],
									}),
								],
							},
						],
					},
				],
			}),
		);
		const formUuid = prev.formOrder[prev.moduleOrder[0]][0];
		const hUuid = byId(prev, "h").uuid;
		const xUuid = byId(prev, "x").uuid;
		const next = apply(prev, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: G,
					id: "g",
					kind: "group",
					label: "G",
					order: "zz",
				} as Field,
			},
			{ kind: "moveField", uuid: xUuid, toParentUuid: G, order: "a1" },
			{ kind: "removeField", uuid: hUuid },
		]);

		const diff = diffDocsToMutations(prev, next);
		// The evacuation (moveField X→G) must not precede the addField that
		// creates G: the server-side guard walks the batch in order, and a
		// move into a not-yet-existing container reads as a phantom conflict
		// (409 → the reload silently drops the user's create+move+delete).
		expect(batchTargetsMissing(prev, diff)).toBe(false);
		// The add of G comes before the move of X, which precedes H's remove
		// (the evacuation contract) — assert the actual order.
		const addG = diff.findIndex(
			(m) => m.kind === "addField" && m.field.uuid === G,
		);
		const moveX = diff.findIndex(
			(m) => m.kind === "moveField" && m.uuid === xUuid,
		);
		const removeH = diff.findIndex(
			(m) => m.kind === "removeField" && m.uuid === hUuid,
		);
		expect(addG).toBeGreaterThanOrEqual(0);
		expect(moveX).toBeGreaterThan(addG);
		expect(removeH).toBeGreaterThan(moveX);
		// An unguarded replay preserves the survivor under its new parent.
		const replayed = apply(prev, diff);
		expect(replayed.fields[xUuid]).toBeDefined();
		expect(replayed.fields[hUuid]).toBeUndefined();
		expect(replayed.fieldParent[xUuid]).toBe(G);
	});
});
