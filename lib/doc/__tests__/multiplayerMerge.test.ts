import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
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
import { mutationTargetsInvalid } from "@/lib/db/commitGuard";
import {
	columnContentSnapshot,
	columnSnapshotMutations,
} from "@/lib/doc/caseListColumnMutations";
import {
	cleanupCaseSearchAfterFinalInputMutation,
	disableUnusedCaseSearchMutation,
	enableCaseSearchMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import {
	caseSearchConfigPatchMutations,
	clearCaseSearchConfigSettingsMutations,
} from "@/lib/doc/caseSearchConfigPatchMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { applyMutations } from "@/lib/doc/mutations";
import {
	declareCaseTypeForField,
	formScaffoldMutations,
} from "@/lib/doc/scaffolds";
import { searchInputUpdateMutation } from "@/lib/doc/searchInputMutations";
import type { Mutation, Uuid } from "@/lib/doc/types";
import { updateUserTypeValueMutations } from "@/lib/doc/userMutations";
import {
	type BlueprintDoc,
	calculatedColumn,
	emptyCaseListConfig,
	type Field,
	fieldCaseWrite,
	proseTemplateText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { input, literal, term } from "@/lib/domain/predicate";

// ── Helpers ────────────────────────────────────────────────────────────

function apply(doc: BlueprintDoc, ...batches: Mutation[][]): BlueprintDoc {
	return produce(doc, (draft) => {
		for (const batch of batches) applyMutations(draft, batch);
	});
}

function canonicalFixture(doc: BlueprintDoc): BlueprintDoc {
	return doc;
}

function byId(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find((fl) => fl.id === id);
	if (!field) throw new Error(`no field "${id}"`);
	return field;
}

function fieldDisplayIds(doc: BlueprintDoc, formUuid: Uuid): string[] {
	return orderedFieldUuids(doc, formUuid).map((u) => doc.fields[u]?.id ?? "");
}

/** A three-field survey form whose fixture entities are all keyed. */
function twoFieldForm(): { doc: BlueprintDoc; formUuid: Uuid } {
	const doc = canonicalFixture(
		buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q1", label: proseText("Q1") }),
								f({ kind: "text", id: "q2", label: proseText("Q2") }),
								f({ kind: "text", id: "q3", label: proseText("Q3") }),
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
		const doc = canonicalFixture(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "FA",
								type: "survey",
								fields: [
									f({ kind: "text", id: "a1", label: proseText("A1") }),
									f({ kind: "text", id: "a2", label: proseText("A2") }),
								],
							},
							{
								name: "FB",
								type: "survey",
								fields: [
									f({ kind: "text", id: "b1", label: proseText("B1") }),
									f({ kind: "text", id: "b2", label: proseText("B2") }),
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
		// of FB — disjoint sequences, so neither move can see the other.
		const batchA: Mutation[] = [
			{ kind: "moveField", uuid: a2, toParentUuid: formA, after: null },
		];
		const batchB: Mutation[] = [
			{ kind: "moveField", uuid: b2, toParentUuid: formB, after: null },
		];
		const ab = apply(doc, batchA, batchB);
		const ba = apply(doc, batchB, batchA);
		expect(fieldDisplayIds(ab, formA)).toEqual(["a2", "a1"]);
		expect(fieldDisplayIds(ab, formB)).toEqual(["b2", "b1"]);
		// Order-independent: both interleavings produce the same display order.
		expect(fieldDisplayIds(ba, formA)).toEqual(fieldDisplayIds(ab, formA));
		expect(fieldDisplayIds(ba, formB)).toEqual(fieldDisplayIds(ab, formB));
	});

	it("a reorder is emitted by the diff and persists", () => {
		const { doc, formUuid } = twoFieldForm();
		// Move q3 to the very front by putting it first in the membership array,
		// which IS the sequence.
		const q3 = byId(doc, "q3").uuid;
		const next = produce(doc, (draft) => {
			draft.fieldOrder[formUuid] = [
				q3,
				...draft.fieldOrder[formUuid].filter((uuid) => uuid !== q3),
			];
		});
		const diff = diffDocsToMutations(doc, next);
		const move = diff.find((m) => m.kind === "moveField");
		expect(move).toBeDefined();
		expect(move && "after" in move && move.after).toBe(null);
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
				property: { name: "age", label: proseText("Age") },
			},
		];
		const batchB: Mutation[] = [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "village", label: proseText("Village") },
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
		const doc = canonicalFixture(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Name") },
							{ name: "age", label: proseText("Age") },
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
										label: proseText("Name"),
										caseWrite: {
											caseType: "patient",
											property: "case_name",
										},
									}),
									f({
										kind: "int",
										id: "age",
										label: proseText("Age"),
										caseWrite: { caseType: "patient", property: "age" },
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
				column: { kind: "plain", field: "age", header: "Years" },
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
				column: expect.objectContaining({ header: "Patient name" }),
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
				column: expect.objectContaining({ header: "Patient name" }),
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

	it("sort and column-content edits commute without restoring stale slots", () => {
		const { doc, moduleUuid, colA } = moduleWithTwoColumns();
		const current = doc.modules[moduleUuid].caseListConfig?.columns.find(
			(candidate) => candidate.uuid === colA,
		);
		if (!current) throw new Error("fixture column missing");
		const sorted = {
			...current,
			sort: { direction: "desc" as const, priority: 0 },
		};
		const formatted = { ...current, header: "Peer patient name" };
		const sortBatch = columnSnapshotMutations(moduleUuid, current, sorted);
		const formatBatch = columnSnapshotMutations(moduleUuid, current, formatted);

		expect(sortBatch).toEqual([
			expect.objectContaining({
				kind: "updateColumn",
				sortPatch: { direction: "desc", priority: 0 },
			}),
		]);
		expect(formatBatch).toEqual([
			expect.objectContaining({
				kind: "updateColumn",
				column: expect.objectContaining({ header: "Peer patient name" }),
			}),
		]);

		for (const merged of [
			apply(doc, sortBatch, formatBatch),
			apply(doc, formatBatch, sortBatch),
		]) {
			const column = merged.modules[moduleUuid].caseListConfig?.columns.find(
				(candidate) => candidate.uuid === colA,
			);
			expect(column?.header).toBe("Peer patient name");
			expect(column?.sort).toEqual({ direction: "desc", priority: 0 });
		}
	});

	it("Results and Details reorders commute and survive a stale content edit", () => {
		const { doc, moduleUuid, colA, colB } = moduleWithTwoColumns();
		const original = doc.modules[moduleUuid].caseListConfig?.columns.find(
			(c) => c.uuid === colA,
		);
		if (!original) throw new Error("fixture column missing");

		const moveList: Mutation[] = [
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: colA,
				surface: "list",
				after: colB,
			},
		];
		const moveDetail: Mutation[] = [
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: colB,
				surface: "detail",
				after: null,
			},
		];
		const staleContentEdit: Mutation[] = [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: colA,
				// Captured before either reorder. Sequence lives in the config's
				// ordering arrays rather than on the column, so a stale BODY has
				// nothing to say about where either surface shows it.
				column: columnContentSnapshot({
					...original,
					header: "Patient",
				}),
			},
		];

		const listThenDetail = apply(doc, moveList, moveDetail, staleContentEdit);
		const detailThenList = apply(doc, staleContentEdit, moveDetail, moveList);
		for (const merged of [listThenDetail, detailThenList]) {
			const config = merged.modules[moduleUuid].caseListConfig;
			expect(config?.columns.find((c) => c.uuid === colA)?.header).toBe(
				"Patient",
			);
			expect(config?.listColumnOrder).toEqual([colB, colA]);
			expect(config?.detailColumnOrder).toEqual([colB, colA]);
		}
	});

	it("two same-Results gestures write one moved row each and commute", () => {
		const { doc, moduleUuid, colA, colB } = moduleWithTwoColumns();
		// A move names ONE uuid and ONE anchor, so it writes only the row it
		// moved. Two authors dragging different rows on the same screen
		// therefore commute — neither batch can reach the other's row.
		const moveA: Mutation = {
			kind: "moveColumn",
			moduleUuid,
			uuid: colA,
			surface: "list",
			after: colB,
		};
		const moveB: Mutation = {
			kind: "moveColumn",
			moduleUuid,
			uuid: colB,
			surface: "list",
			after: null,
		};

		const aThenB = apply(doc, [moveA], [moveB]);
		const bThenA = apply(doc, [moveB], [moveA]);
		expect(aThenB).toEqual(bThenA);
		expect(aThenB.modules[moduleUuid].caseListConfig?.listColumnOrder).toEqual([
			colB,
			colA,
		]);
		// Details never heard about either gesture.
		expect(
			aThenB.modules[moduleUuid].caseListConfig?.detailColumnOrder,
		).toEqual([colA, colB]);
	});

	it("two search-order gestures write one moved field each and commute", () => {
		const inputA = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000321"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const inputB = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000322"),
			"external_id",
			"External ID",
			"text",
			"external_id",
		);
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [inputA, inputB];
		const doc = canonicalFixture(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Name") },
							{ name: "external_id", label: proseText("External ID") },
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
		const moveA: Mutation = {
			kind: "moveSearchInput",
			moduleUuid,
			uuid: inputA.uuid,
			after: inputB.uuid,
		};
		const moveB: Mutation = {
			kind: "moveSearchInput",
			moduleUuid,
			uuid: inputB.uuid,
			after: null,
		};

		const aThenB = apply(doc, [moveA], [moveB]);
		const bThenA = apply(doc, [moveB], [moveA]);
		expect(aThenB).toEqual(bThenA);
		expect(
			aThenB.modules[moduleUuid].caseListConfig?.searchInputs.map(
				(input) => input.uuid,
			),
		).toEqual([inputB.uuid, inputA.uuid]);
	});

	it("diff emits independent surface moves without a content update", () => {
		const { doc, moduleUuid, colA, colB } = moduleWithTwoColumns();
		const next = produce(doc, (draft) => {
			const config = draft.modules[moduleUuid].caseListConfig;
			if (config) {
				config.listColumnOrder = [colB, colA];
				config.detailColumnOrder = [colB, colA];
			}
		});

		const diff = diffDocsToMutations(doc, next);
		expect(
			diff.filter((m) => m.kind === "moveColumn" && m.surface === "list"),
		).toHaveLength(1);
		expect(
			diff.filter((m) => m.kind === "moveColumn" && m.surface === "detail"),
		).toHaveLength(1);
		expect(diff.some((m) => m.kind === "updateColumn")).toBe(false);

		const replayed = apply(doc, diff);
		const config = replayed.modules[moduleUuid].caseListConfig;
		expect(config?.listColumnOrder).toEqual([colB, colA]);
		expect(config?.detailColumnOrder).toEqual([colB, colA]);
	});

	it("two members editing different options of one field merge", () => {
		const doc = canonicalFixture(
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
										label: proseText("Color"),
										optionsSource: {
											kind: "inline",
											options: [
												{
													uuid: testUuid("color-red"),
													value: "r",
													label: proseText("Red"),
												},
												{
													uuid: testUuid("color-green"),
													value: "g",
													label: proseText("Green"),
												},
											],
										},
									}),
								],
							},
						],
					},
				],
			}),
		);
		const field = byId(doc, "color");
		if (
			(field.kind !== "single_select" && field.kind !== "multi_select") ||
			field.optionsSource.kind !== "inline"
		) {
			throw new Error("expected inline select field");
		}
		const optR = field.optionsSource.options[0].uuid;
		const optG = field.optionsSource.options[1].uuid;
		const batchA: Mutation[] = [
			{
				kind: "updateOption",
				fieldUuid: field.uuid,
				uuid: optR,
				option: { uuid: optR, value: "r", label: proseText("Crimson") },
			},
		];
		const batchB: Mutation[] = [
			{
				kind: "updateOption",
				fieldUuid: field.uuid,
				uuid: optG,
				option: { uuid: optG, value: "g", label: proseText("Emerald") },
			},
		];
		const merged = apply(doc, batchA, batchB);
		const mergedField = merged.fields[field.uuid];
		if (
			(mergedField.kind !== "single_select" &&
				mergedField.kind !== "multi_select") ||
			mergedField.optionsSource.kind !== "inline"
		) {
			throw new Error("expected inline select field");
		}
		const opts = mergedField.optionsSource.options;
		const labelByUuid = new Map(opts.map((o) => [o.uuid, o.label]));
		const redLabel = labelByUuid.get(optR);
		const greenLabel = labelByUuid.get(optG);
		if (!redLabel || !greenLabel) {
			throw new Error("expected both concurrently updated options");
		}
		expect(proseTemplateText(redLabel)).toBe("Crimson");
		expect(proseTemplateText(greenLabel)).toBe("Emerald");
	});

	it("removeOption below two options is gate-rejected (SELECT_TOO_FEW_OPTIONS)", () => {
		const doc = canonicalFixture(
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
										label: proseText("Color"),
										optionsSource: {
											kind: "inline",
											options: [
												{
													uuid: testUuid("color-red"),
													value: "r",
													label: proseText("Red"),
												},
												{
													uuid: testUuid("color-green"),
													value: "g",
													label: proseText("Green"),
												},
											],
										},
									}),
								],
							},
						],
					},
				],
			}),
		);
		const field = byId(doc, "color");
		if (
			(field.kind !== "single_select" && field.kind !== "multi_select") ||
			field.optionsSource.kind !== "inline"
		) {
			throw new Error("expected inline select field");
		}
		const batch: Mutation[] = [
			{
				kind: "removeOption",
				fieldUuid: field.uuid,
				uuid: field.optionsSource.options[0].uuid,
			},
		];
		const verdict = mutationCommitVerdict(
			doc,
			batch,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(
				verdict.findings.some((e) => e.code === "SELECT_TOO_FEW_OPTIONS"),
			).toBe(true);
		}
	});
});

// ── setCaseListMeta does not resurrect a peer-removed config ────────────

describe("setCaseListMeta on a peer-removed config", () => {
	/** A case-list module whose config carries a filter — the slot a
	 *  concurrent `setCaseListMeta` edits. */
	function moduleWithFilter(): { doc: BlueprintDoc; moduleUuid: Uuid } {
		const doc = canonicalFixture(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
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
				patch: { caseListConfig: null },
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
		expect(mutationTargetsInvalid(aCommitted, bBatch)).toBe(true);
	});

	it("reducer does not resurrect the config even if the guard is bypassed", () => {
		const { doc, moduleUuid } = moduleWithFilter();
		const aCommitted = apply(doc, [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: null },
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
		expect(mutationTargetsInvalid(doc, batch)).toBe(false);
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
				patch: { caseListConfig: null },
			},
		]);
		const rebirth: Mutation[] = [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {},
				ensureCaseListConfig: true,
			},
			{
				kind: "addColumn",
				moduleUuid,
				column: caseListConfig([{ field: "case_name", header: "Name" }])
					.columns[0],
				afterInList: null,
				afterInDetail: null,
			},
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { filter: { kind: "match-all" } },
			},
		];
		expect(mutationTargetsInvalid(cleared, rebirth)).toBe(false);
	});
});

// ── Diff: case-list birth / case-type flip stay granular ───────────────

describe("diff — case-list presence transition", () => {
	it("emits an idempotent ensure for an empty absent→present transition", () => {
		const prev = canonicalFixture(
			buildDoc({
				modules: [{ name: "M", caseType: "patient" }],
			}),
		);
		const moduleUuid = prev.moduleOrder[0];
		const next = produce(prev, (draft) => {
			draft.modules[moduleUuid].caseListConfig = emptyCaseListConfig();
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff).toContainEqual({
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {},
			ensureCaseListConfig: true,
		});
		expect(apply(prev, diff).modules[moduleUuid].caseListConfig).toEqual(
			next.modules[moduleUuid].caseListConfig,
		);
	});

	it("replays a populated birth over a peer config without losing peer items", () => {
		const prev = canonicalFixture(
			buildDoc({
				modules: [{ name: "M", caseType: "patient" }],
			}),
		);
		const moduleUuid = prev.moduleOrder[0];
		const localColumnUuid = testUuid("00000000-0000-4000-8000-000000000061");
		const peerColumnUuid = testUuid("00000000-0000-4000-8000-000000000062");
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
				listColumnOrder: [localColumnUuid],
				detailColumnOrder: [localColumnUuid],
				searchInputs: [],
				filter: { kind: "match-all" },
			};
		});
		const localBatch = diffDocsToMutations(prev, next);
		expect(localBatch).toContainEqual({
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {},
			ensureCaseListConfig: true,
		});

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
				afterInList: null,
				afterInDetail: null,
			},
		]);
		expect(mutationTargetsInvalid(peerFresh, localBatch)).toBe(false);
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
		const prev = canonicalFixture(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
					{
						name: "visit",
						properties: [{ name: "case_name", label: proseText("Name") }],
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
		const localColumnUuid = testUuid("00000000-0000-4000-8000-000000000063");
		const peerInputUuid = testUuid("00000000-0000-4000-8000-000000000064");
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
		expect(mutationTargetsInvalid(peerFresh, localBatch)).toBe(false);
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

describe("every caseWrite surface declares the type", () => {
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
			label: proseText("Age"),
			caseWrite: { caseType: "patient", property: "age" },
		}) as unknown as Field;
		const muts = declareCaseTypeForField(doc, writer);
		expect(muts).toEqual([{ kind: "declareCaseType", caseType: "patient" }]);
		// No-op when the type is already declared, or the field writes no case.
		const declared = produce(doc, (d) => {
			d.caseTypes = [{ name: "patient", properties: [] }];
		});
		expect(declareCaseTypeForField(declared, writer)).toEqual([]);
		const noCase = f({
			kind: "text",
			id: "note",
			label: proseText("Note"),
		}) as Field;
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
					label: proseText("Age"),
					caseWrite: { caseType: "patient", property: "age" },
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
		// prepended declaration that makes both the viewer column and born field
		// resolvable; without it the absolute gate rejects the whole candidate.
		const doc = produce(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
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
				fieldCaseWrite(m.field)?.caseType === "patient",
		);
		expect(declareIdx).toBeGreaterThanOrEqual(0);
		expect(writerIdx).toBeGreaterThanOrEqual(0);
		// Declared BEFORE the writer so the field's catalog sync can append to it.
		expect(declareIdx).toBeLessThan(writerIdx);

		// Stripping the declare from the SAME batch reproduces the bug: the
		// case_name writer and Name column target an absent type → gate-rejected.
		const withoutDeclare = scaffold.mutations.filter(
			(m) => m.kind !== "declareCaseType",
		);
		const rejected = mutationCommitVerdict(
			doc,
			withoutDeclare,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) {
			expect(
				rejected.findings.some(
					(e) => e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD",
				),
				JSON.stringify(rejected.findings),
			).toBe(true);
		}

		// The shipped builder batch (declare included) passes the gate — the form
		// is created, not 409'd.
		expect(
			mutationCommitVerdict(doc, scaffold.mutations, LOOKUP_CONTEXT_UNAVAILABLE)
				.ok,
		).toBe(true);
	});
});

// ── Diff round-trip over granular catalog + collection + option edits ──

describe("diff round-trip — granular edits", () => {
	it("replaying a catalog + column + option diff reproduces the display state", () => {
		const prev = canonicalFixture(
			buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "age", label: proseText("Age") }],
					},
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
										label: proseText("Color"),
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
				ct.properties.push({ name: "village", label: proseText("Village") });
				ct.parent_type = "household";
			}
			// Column: edit the header.
			const col = draft.modules[moduleUuid].caseListConfig?.columns[0];
			if (col) col.header = "Age in years";
			// Option: edit a label.
			const color = Object.values(draft.fields).find((fl) => fl.id === "color");
			if (
				color?.kind === "single_select" &&
				color.optionsSource.kind === "inline"
			) {
				color.optionsSource.options[1].label = proseText("Emerald");
			}
		});
		const diff = diffDocsToMutations(prev, next);
		// Granular kinds, no wholesale catalog/config.
		expect(diff.some((m) => m.kind === "addCaseProperty")).toBe(true);
		expect(diff.some((m) => m.kind === "setCaseTypeMeta")).toBe(true);
		expect(diff.some((m) => m.kind === "updateColumn")).toBe(true);
		expect(diff.some((m) => m.kind === "updateOption")).toBe(true);
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
		const color = Object.values(replayed.fields).find(
			(field) => field.id === "color",
		);
		if (
			color?.kind !== "single_select" ||
			color.optionsSource.kind !== "inline"
		) {
			throw new Error("missing inline color options");
		}
		const opts = color.optionsSource.options.map((option) =>
			proseTemplateText(option.label),
		);
		expect(opts).toContain("Emerald");
	});
});

describe("case-search marker merges", () => {
	function searchDoc(): {
		doc: BlueprintDoc;
		moduleUuid: Uuid;
		inputUuid: Uuid;
	} {
		const inputUuid = testUuid("00000000-0000-4000-8000-000000000051");
		const doc = buildDoc({
			appName: "Search merge",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
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
		const peerInputUuid = testUuid("00000000-0000-4000-8000-000000000052");
		const peerBatch: Mutation[] = [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {},
				caseSearchConfigPatch: { searchScreenTitle: "Find a patient" },
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
			enableCaseSearchMutation(moduleUuid, undefined),
		];
		const merged = apply(markerless, peerBatch, staleEnable);
		expect(merged.modules[moduleUuid].caseSearchConfig).toEqual({
			searchScreenTitle: "Find a patient",
		});
	});

	it("different enabled Search settings commute as independent slots", () => {
		const { doc, moduleUuid } = searchDoc();
		const titleBatch = caseSearchConfigPatchMutations(
			moduleUuid,
			{},
			{
				searchScreenTitle: "Find a patient",
			},
		);
		const buttonBatch = caseSearchConfigPatchMutations(
			moduleUuid,
			{},
			{
				searchButtonLabel: "Search now",
			},
		);
		expect(titleBatch).toEqual([
			expect.objectContaining({
				caseSearchConfigPatch: { searchScreenTitle: "Find a patient" },
			}),
		]);
		expect(buttonBatch).toEqual([
			expect.objectContaining({
				caseSearchConfigPatch: { searchButtonLabel: "Search now" },
			}),
		]);

		const titleThenButton = apply(doc, titleBatch, buttonBatch);
		const buttonThenTitle = apply(doc, buttonBatch, titleBatch);
		expect(titleThenButton).toEqual(buttonThenTitle);
		expect(titleThenButton.modules[moduleUuid].caseSearchConfig).toEqual({
			searchScreenTitle: "Find a patient",
			searchButtonLabel: "Search now",
		});
	});

	it("a clear-only Search patch does not resurrect an absent config", () => {
		const { doc, moduleUuid } = searchDoc();
		const ownerOnly = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			draft.modules[moduleUuid].caseSearchConfig = {
				searchActionEnabled: false,
				excludedOwnerIds: term(literal("owner-a")),
			};
		});
		const clearBatch = clearCaseSearchConfigSettingsMutations(
			moduleUuid,
			ownerOnly.modules[moduleUuid].caseSearchConfig,
		);
		expect(clearBatch).toContainEqual(
			expect.objectContaining({
				patch: {},
				caseSearchConfigPatch: { excludedOwnerIds: null },
			}),
		);
		expect(clearBatch).toContainEqual(
			expect.objectContaining({
				patch: {},
				caseSearchConfigOperation: "remove-if-no-authored-settings",
			}),
		);

		const alreadyAbsent = produce(ownerOnly, (draft) => {
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		expect(
			apply(alreadyAbsent, clearBatch).modules[moduleUuid].caseSearchConfig,
		).toBeUndefined();
	});

	it("clearing a stale owner-only rule preserves a peer-authored Search title", () => {
		const { doc, moduleUuid } = searchDoc();
		const ownerOnly = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			draft.modules[moduleUuid].caseSearchConfig = {
				searchActionEnabled: false,
				excludedOwnerIds: term(literal("owner-a")),
			};
		});
		const staleClear = clearCaseSearchConfigSettingsMutations(
			moduleUuid,
			ownerOnly.modules[moduleUuid].caseSearchConfig,
		);
		const peerEnabled = produce(ownerOnly, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				searchScreenTitle: "Peer title",
				excludedOwnerIds: term(literal("owner-a")),
			};
		});

		expect(
			apply(peerEnabled, staleClear).modules[moduleUuid].caseSearchConfig,
		).toEqual({ searchScreenTitle: "Peer title" });
	});

	it("whole-doc reconciliation keeps an owner-only clear granular", () => {
		const { doc, moduleUuid } = searchDoc();
		const ownerOnly = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			draft.modules[moduleUuid].caseSearchConfig = {
				searchActionEnabled: false,
				excludedOwnerIds: term(literal("owner-a")),
			};
		});
		const locallyCleared = produce(ownerOnly, (draft) => {
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		// Autosave/reconciliation regenerates the persisted batch from the two
		// whole documents; it must retain the UI helper's per-setting semantics.
		const reconciledBatch = diffDocsToMutations(ownerOnly, locallyCleared);
		expect(reconciledBatch).toContainEqual(
			expect.objectContaining({
				kind: "updateModule",
				patch: {},
				caseSearchConfigPatch: { excludedOwnerIds: null },
			}),
		);
		expect(reconciledBatch).toContainEqual(
			expect.objectContaining({
				caseSearchConfigOperation: "remove-if-no-authored-settings",
			}),
		);
		expect(
			reconciledBatch.some(
				(mutation) =>
					mutation.kind === "updateModule" &&
					Object.hasOwn(mutation.patch, "caseSearchConfig") &&
					mutation.caseSearchConfigPatch === undefined &&
					mutation.caseSearchConfigOperation === undefined,
			),
		).toBe(false);

		const peerEnabled = produce(ownerOnly, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				searchScreenTitle: "Peer title",
				searchButtonLabel: "Peer action",
				excludedOwnerIds: term(literal("owner-a")),
			};
		});
		expect(
			apply(peerEnabled, reconciledBatch).modules[moduleUuid].caseSearchConfig,
		).toEqual({
			searchScreenTitle: "Peer title",
			searchButtonLabel: "Peer action",
		});
	});

	it("whole-doc reconciliation removes ordinary settings only after fresh clears", () => {
		const { doc, moduleUuid } = searchDoc();
		const withSettings = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				searchScreenTitle: "Local title",
				searchButtonLabel: "Local action",
			};
		});
		const locallyAbsent = produce(withSettings, (draft) => {
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		const reconciledBatch = diffDocsToMutations(withSettings, locallyAbsent);
		expect(reconciledBatch).toContainEqual(
			expect.objectContaining({
				caseSearchConfigPatch: {
					searchScreenTitle: null,
					searchButtonLabel: null,
				},
			}),
		);
		expect(reconciledBatch).toContainEqual(
			expect.objectContaining({
				caseSearchConfigOperation: "remove-if-no-authored-settings",
			}),
		);
		expect(
			apply(withSettings, reconciledBatch).modules[moduleUuid].caseSearchConfig,
		).toBeUndefined();

		const peerOwnerRule = produce(withSettings, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				...draft.modules[moduleUuid].caseSearchConfig,
				excludedOwnerIds: term(literal("peer-owner")),
			};
		});
		expect(
			apply(peerOwnerRule, reconciledBatch).modules[moduleUuid]
				.caseSearchConfig,
		).toEqual({ excludedOwnerIds: term(literal("peer-owner")) });
	});

	it("removes an inputs-present empty marker and later cleanup keeps it absent", () => {
		const { doc, moduleUuid, inputUuid } = searchDoc();
		const markerAbsent = produce(doc, (draft) => {
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		const markerRemoval = diffDocsToMutations(doc, markerAbsent);
		expect(markerRemoval).toEqual([
			expect.objectContaining({
				caseSearchConfigOperation: "remove-if-no-authored-settings",
			}),
		]);
		const withoutMarker = apply(doc, markerRemoval);
		expect(withoutMarker.modules[moduleUuid].caseSearchConfig).toBeUndefined();

		const laterFinalInputCleanup: Mutation[] = [
			{ kind: "removeSearchInput", moduleUuid, uuid: inputUuid },
			cleanupCaseSearchAfterFinalInputMutation({
				uuid: moduleUuid,
				config: undefined,
				hasCasesAvailableCondition: false,
			}),
		];
		const cleaned = apply(withoutMarker, laterFinalInputCleanup);
		expect(cleaned.modules[moduleUuid].caseListConfig?.searchInputs).toEqual(
			[],
		);
		expect(cleaned.modules[moduleUuid].caseSearchConfig).toBeUndefined();
	});

	it("slot patches preserve raw authored match-none conditions", () => {
		const { doc, moduleUuid } = searchDoc();
		const rawOwnerRule = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				excludedOwnerIds: term(literal("owner-a")),
				searchButtonDisplayCondition: { kind: "match-none" },
			};
		});
		const rawConfig = rawOwnerRule.modules[moduleUuid].caseSearchConfig;
		if (rawConfig === undefined) throw new Error("missing raw Search config");
		const ownerBatch = caseSearchConfigPatchMutations(moduleUuid, rawConfig, {
			...rawConfig,
			excludedOwnerIds: term(literal("owner-b")),
		});
		expect(ownerBatch).toEqual([
			expect.objectContaining({
				caseSearchConfigPatch: {
					excludedOwnerIds: term(literal("owner-b")),
				},
			}),
		]);
		expect(
			apply(rawOwnerRule, ownerBatch).modules[moduleUuid].caseSearchConfig,
		).toEqual({
			excludedOwnerIds: term(literal("owner-b")),
			searchButtonDisplayCondition: { kind: "match-none" },
		});

		const localTitleBatch = caseSearchConfigPatchMutations(
			moduleUuid,
			{},
			{
				searchScreenTitle: "Local title",
			},
		);
		expect(
			apply(rawOwnerRule, localTitleBatch).modules[moduleUuid].caseSearchConfig,
		).toEqual({
			excludedOwnerIds: term(literal("owner-a")),
			searchButtonDisplayCondition: { kind: "match-none" },
			searchScreenTitle: "Local title",
		});
	});

	it("an explicit enable clears only owner-only no-action provenance", () => {
		const { doc, moduleUuid } = searchDoc();
		const ownerOnly = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			draft.modules[moduleUuid].caseSearchConfig = {
				searchActionEnabled: false,
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner-a" },
				},
			};
		});
		const enabled = apply(ownerOnly, [
			enableCaseSearchMutation(
				moduleUuid,
				ownerOnly.modules[moduleUuid].caseSearchConfig,
			),
		]);
		expect(enabled.modules[moduleUuid].caseSearchConfig).toEqual({
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-a" },
			},
		});
	});

	it("does not diff owner-only no-action provenance as an enabled marker", () => {
		const { doc, moduleUuid } = searchDoc();
		const markerless = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		const ownerOnly = produce(markerless, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				searchActionEnabled: false,
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner-a" },
				},
			};
		});
		const diff = diffDocsToMutations(markerless, ownerOnly);
		const ownerConfig = ownerOnly.modules[moduleUuid].caseSearchConfig;
		if (ownerConfig === undefined || !("searchActionEnabled" in ownerConfig)) {
			throw new Error("expected owner-only Search config");
		}
		expect(diff).toContainEqual(
			setOwnerOnlyCaseSearchMutation(moduleUuid, ownerConfig),
		);
		expect(
			diff.some(
				(mutation) =>
					mutation.kind === "updateModule" &&
					mutation.caseSearchConfigOperation === "enable",
			),
		).toBe(false);
	});

	it("a stale owner-only edit preserves a peer-enabled Search action and settings", () => {
		const { doc, moduleUuid } = searchDoc();
		const markerless = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		const localOwner = {
			searchActionEnabled: false as const,
			excludedOwnerIds: {
				kind: "term" as const,
				term: { kind: "literal" as const, value: "owner-a" },
			},
		};
		const peerEnabled = produce(markerless, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				searchScreenTitle: "Find a client",
				searchButtonLabel: "Look up",
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner-b" },
				},
			};
		});
		const merged = apply(peerEnabled, [
			setOwnerOnlyCaseSearchMutation(moduleUuid, localOwner),
		]);
		expect(merged.modules[moduleUuid].caseSearchConfig).toEqual({
			searchScreenTitle: "Find a client",
			searchButtonLabel: "Look up",
			excludedOwnerIds: localOwner.excludedOwnerIds,
		});
	});

	it("diffs owner-only Search enable semantically and preserves a peer owner edit", () => {
		const { doc, moduleUuid } = searchDoc();
		const ownerOnly = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			draft.modules[moduleUuid].caseSearchConfig = {
				searchActionEnabled: false,
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner-a" },
				},
			};
		});
		const locallyEnabled = produce(ownerOnly, (draft) => {
			const config = draft.modules[moduleUuid].caseSearchConfig;
			if (config === undefined || !("searchActionEnabled" in config)) {
				throw new Error("missing owner-only Search config");
			}
			draft.modules[moduleUuid].caseSearchConfig = {
				excludedOwnerIds: config.excludedOwnerIds,
			};
		});
		const localBatch = diffDocsToMutations(ownerOnly, locallyEnabled);
		expect(localBatch).toEqual([
			enableCaseSearchMutation(
				moduleUuid,
				locallyEnabled.modules[moduleUuid].caseSearchConfig,
			),
		]);

		const peerEdited = produce(ownerOnly, (draft) => {
			const config = draft.modules[moduleUuid].caseSearchConfig;
			if (config === undefined) throw new Error("missing owner rule");
			config.excludedOwnerIds = {
				kind: "term",
				term: { kind: "literal", value: "owner-b" },
			};
		});
		const merged = apply(peerEdited, localBatch);
		expect(merged.modules[moduleUuid].caseSearchConfig).toEqual({
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-b" },
			},
		});
	});

	it("derives conditional final-input cleanup that preserves peer action and owner settings", () => {
		const { doc, moduleUuid, inputUuid } = searchDoc();
		const base = produce(doc, (draft) => {
			draft.modules[moduleUuid].caseSearchConfig = {
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: "Use known information",
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner-a" },
				},
			};
		});
		const localNext = produce(base, (draft) => {
			draft.modules[moduleUuid].caseListConfig?.searchInputs.splice(0);
			draft.modules[moduleUuid].caseSearchConfig = {
				searchActionEnabled: false,
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner-a" },
				},
			};
		});
		const localBatch = diffDocsToMutations(base, localNext);
		expect(localBatch).toContainEqual({
			kind: "removeSearchInput",
			moduleUuid,
			uuid: inputUuid,
		});
		expect(localBatch).toContainEqual({
			...cleanupCaseSearchAfterFinalInputMutation({
				uuid: moduleUuid,
				config: base.modules[moduleUuid].caseSearchConfig,
				hasCasesAvailableCondition: false,
			}),
		});
		expect(
			localBatch.some(
				(mutation) =>
					mutation.kind === "updateModule" &&
					mutation.caseSearchConfigOperation === undefined &&
					Object.hasOwn(mutation.patch, "caseSearchConfig"),
			),
		).toBe(false);

		const peerEdited = produce(base, (draft) => {
			const config = draft.modules[moduleUuid].caseSearchConfig;
			if (config === undefined || "searchActionEnabled" in config) {
				throw new Error("missing ordinary Search config");
			}
			config.searchButtonLabel = "Peer search";
			config.excludedOwnerIds = {
				kind: "term",
				term: { kind: "literal", value: "owner-b" },
			};
		});
		const merged = apply(peerEdited, localBatch);
		expect(merged.modules[moduleUuid].caseListConfig?.searchInputs).toEqual([]);
		expect(merged.modules[moduleUuid].caseSearchConfig).toEqual({
			searchButtonLabel: "Peer search",
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-b" },
			},
		});
	});

	it("a stale disable preserves peer settings and their newly-added input", () => {
		const { doc, moduleUuid, inputUuid } = searchDoc();
		const peerInputUuid = testUuid("00000000-0000-4000-8000-000000000053");
		const peerBatch: Mutation[] = [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {},
				caseSearchConfigPatch: { searchButtonLabel: "Find" },
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
			disableUnusedCaseSearchMutation(moduleUuid),
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
		expect(
			mutationCommitVerdict(
				apply(doc, peerBatch),
				staleDisable,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
	});

	it("the diff emits semantic marker transitions instead of wholesale writes", () => {
		const { doc, moduleUuid, inputUuid } = searchDoc();
		const markerless = produce(doc, (draft) => {
			delete draft.modules[moduleUuid].caseSearchConfig;
		});
		expect(diffDocsToMutations(markerless, doc)).toContainEqual({
			...enableCaseSearchMutation(
				moduleUuid,
				doc.modules[moduleUuid].caseSearchConfig,
			),
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
			...cleanupCaseSearchAfterFinalInputMutation({
				uuid: moduleUuid,
				config: doc.modules[moduleUuid].caseSearchConfig,
				hasCasesAvailableCondition: false,
			}),
		});
		expect(
			diff.some(
				(m) =>
					m.kind === "updateModule" &&
					m.caseSearchConfigOperation === undefined &&
					Object.hasOwn(m.patch, "caseSearchConfig"),
			),
		).toBe(false);
	});
});

describe("Search-input identity merges", () => {
	it("renaming a search input preserves every UUID-backed reference", () => {
		const inputUuid = testUuid("00000000-0000-4000-8000-000000000061");
		const calculatedUuid = testUuid("00000000-0000-4000-8000-000000000064");
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [
			simpleSearchInputDef(
				inputUuid,
				"old_name",
				"Original",
				"text",
				"case_name",
			),
		];
		config.columns.push(
			calculatedColumn(calculatedUuid, "Copied answer", term(input(inputUuid))),
		);
		config.listColumnOrder.push(calculatedUuid);
		config.detailColumnOrder.push(calculatedUuid);
		const doc = buildDoc({
			modules: [{ name: "Patients", caseListConfig: config }],
		});
		const moduleUuid = doc.moduleOrder[0];
		const current = doc.modules[moduleUuid].caseListConfig?.searchInputs[0];
		if (current === undefined) throw new Error("missing target input");

		const renamed = apply(doc, [
			searchInputUpdateMutation(moduleUuid, current, {
				...current,
				name: "new_name",
			}),
		]);
		const renamedConfig = renamed.modules[moduleUuid].caseListConfig;
		expect(renamedConfig?.searchInputs[0]).toEqual(
			expect.objectContaining({ uuid: inputUuid, name: "new_name" }),
		);
		const calculated = renamedConfig?.columns.find(
			(column) => column.uuid === calculatedUuid,
		);
		expect(calculated).toEqual(
			expect.objectContaining({
				kind: "calculated",
				expression: term(input(inputUuid)),
			}),
		);
	});
});

describe("diff — evacuation into a same-diff-added container", () => {
	it("hoists the added destination before the evacuation so the batch replays in order", () => {
		// One accumulated save (in-flight PUT / retry backoff) carrying three
		// gestures: create group G, drag X out of group H into G, delete H.
		const G = testUuid("44444444-4444-4444-4444-444444444444");
		const prev = canonicalFixture(
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
										label: proseText("H"),
										children: [
											f({ kind: "text", id: "x", label: proseText("X") }),
										],
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
					label: proseText("G"),
				} as Field,
			},
			{ kind: "moveField", uuid: xUuid, toParentUuid: G, after: null },
			{ kind: "removeField", uuid: hUuid },
		]);

		const diff = diffDocsToMutations(prev, next);
		// The evacuation (moveField X→G) must not precede the addField that
		// creates G: the server-side guard walks the batch in order, and a
		// move into a not-yet-existing container reads as a phantom conflict
		// (409 → the reload silently drops the user's create+move+delete).
		expect(mutationTargetsInvalid(prev, diff)).toBe(false);
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

describe("user-data value multiplayer convergence", () => {
	it("merges peers editing different role values in either commit order", () => {
		const propertyA = testUuid("property-a");
		const propertyB = testUuid("property-b");
		const roleUuid = testUuid("role");
		const base: BlueprintDoc = {
			...buildDoc(),
			userProperties: {
				[propertyA]: {
					uuid: propertyA,
					slug: "region",
					label: "Region",
				},
				[propertyB]: {
					uuid: propertyB,
					slug: "cadre",
					label: "Cadre",
				},
			},
			userPropertyOrder: [propertyA, propertyB],
			userTypes: {
				[roleUuid]: {
					uuid: roleUuid,
					name: "CHW",
					values: { [propertyA]: "north", [propertyB]: "community" },
				},
			},
			userTypeOrder: [roleUuid],
		};
		const left = apply(
			base,
			updateUserTypeValueMutations(base, roleUuid, propertyA, "south"),
		);
		const right = apply(
			base,
			updateUserTypeValueMutations(base, roleUuid, propertyB, "supervisor"),
		);
		const leftBatch = diffDocsToMutations(base, left);
		const rightBatch = diffDocsToMutations(base, right);

		expect(mutationTargetsInvalid(apply(base, leftBatch), rightBatch)).toBe(
			false,
		);
		expect(mutationTargetsInvalid(apply(base, rightBatch), leftBatch)).toBe(
			false,
		);
		const leftThenRight = apply(base, leftBatch, rightBatch);
		const rightThenLeft = apply(base, rightBatch, leftBatch);
		expect(leftThenRight.userTypes?.[roleUuid]?.values).toEqual({
			[propertyA]: "south",
			[propertyB]: "supervisor",
		});
		expect(rightThenLeft.userTypes).toEqual(leftThenRight.userTypes);
	});
});
