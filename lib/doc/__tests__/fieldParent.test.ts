/**
 * Exhaustive `fieldParent` invariant test suite.
 *
 * `doc.fieldParent: Record<Uuid, Uuid | null>` is the reverse index that maps
 * every field uuid to its parent uuid (either a form uuid for top-level fields,
 * or a container-field uuid for nested fields). It is rebuilt by
 * `rebuildFieldParent(doc)` after every structural mutation in
 * `applyMutation` / `applyMutations`.
 *
 * This suite exercises every mutation kind and load path, asserting three
 * invariants after each operation:
 *
 *   1. Every field uuid in `doc.fields` has an entry in `doc.fieldParent`.
 *   2. For every `(parentUuid, [...childUuids])` pair in `doc.fieldOrder`,
 *      each childUuid's `fieldParent[childUuid] === parentUuid`.
 *   3. No stray keys in `fieldParent` for uuids not in `doc.fields`.
 *
 * Tests use `buildDoc` + `f()` from `lib/__tests__/docHelpers.ts` for fixture
 * construction, and `createBlueprintDocStore` for store-level (load) tests.
 * Mutation tests drive through the store's `applyMany` so they exercise the
 * same code path as production callers.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";

// ── Invariant checker ────────────────────────────────────────────────────────

/**
 * Assert all three `fieldParent` consistency invariants on a doc snapshot.
 *
 * Calling this after every mutation ensures both that `rebuildFieldParent` ran
 * and that it produced a correct result.
 *
 *   Inv 1: Every field in `doc.fields` has an entry in `doc.fieldParent`.
 *   Inv 2: Every child listed in `doc.fieldOrder[parent]` maps back to that
 *           parent in `doc.fieldParent`.
 *   Inv 3: No entry in `doc.fieldParent` references a uuid absent from
 *           `doc.fields` (stray / orphan entries).
 */
function assertFieldParentInvariants(doc: BlueprintDoc): void {
	const allFieldUuids = new Set(Object.keys(doc.fields));
	const parentKeys = new Set(Object.keys(doc.fieldParent));

	// Invariant 1: every field has an entry.
	for (const uuid of allFieldUuids) {
		expect(
			parentKeys.has(uuid),
			`field ${uuid} is present in doc.fields but missing from doc.fieldParent`,
		).toBe(true);
	}

	// Invariant 3: no stray keys.
	for (const key of parentKeys) {
		expect(
			allFieldUuids.has(key),
			`doc.fieldParent has stray entry for uuid "${key}" which is not in doc.fields`,
		).toBe(true);
	}

	// Invariant 2: fieldOrder ↔ fieldParent consistency for every parent entry.
	for (const [parentUuid, childUuids] of Object.entries(doc.fieldOrder)) {
		for (const childUuid of childUuids) {
			expect(
				doc.fieldParent[childUuid as Uuid],
				`fieldParent[${childUuid}] should equal parent "${parentUuid}" per fieldOrder, but got "${doc.fieldParent[childUuid as Uuid]}"`,
			).toBe(parentUuid);
		}
	}
}

// ── Store helpers ────────────────────────────────────────────────────────────

/**
 * Create a store pre-loaded with a blueprint doc and with temporal resumed.
 * Using `load()` followed by `resume()` ensures the doc is fully hydrated
 * (fieldParent rebuilt) before mutations start.
 */
function storeFrom(doc: BlueprintDoc): BlueprintDocStoreApi {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.temporal.getState().resume();
	return store;
}

/**
 * Apply a batch of mutations via the store and return the resulting snapshot.
 * This exercises the same code path as production (`applyMany` → one
 * `rebuildFieldParent` call at the end of the batch).
 */
function applyBatch(
	store: BlueprintDocStoreApi,
	muts: Mutation[],
): BlueprintDoc {
	store.getState().applyMany(muts);
	return store.getState() as unknown as BlueprintDoc;
}

// ── Shared UUID factories ────────────────────────────────────────────────────
// Fixed, readable test UUIDs so failure messages are greppable.
const MOD = asUuid("mod1-0000-0000-0000-000000000000");
const MOD2 = asUuid("mod2-0000-0000-0000-000000000000");
const FRM = asUuid("frm1-0000-0000-0000-000000000000");
const FRM2 = asUuid("frm2-0000-0000-0000-000000000000");
const FLD_A = asUuid("flda-0000-0000-0000-000000000000");
const FLD_B = asUuid("fldb-0000-0000-0000-000000000000");
const FLD_C = asUuid("fldc-0000-0000-0000-000000000000");
const GRP = asUuid("grp0-0000-0000-0000-000000000000");
const GRP2 = asUuid("grp2-0000-0000-0000-000000000000");
const RPT = asUuid("rpt0-0000-0000-0000-000000000000");
const NESTED = asUuid("nst0-0000-0000-0000-000000000000");

// ── addField ─────────────────────────────────────────────────────────────────

describe("after addField", () => {
	it("top of form (index 0)", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [f({ kind: "text", id: "existing" })],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: FLD_A,
					kind: "text",
					id: "first",
					label: "First",
				} as BlueprintDoc["fields"][Uuid],
				index: 0,
			},
		]);
		assertFieldParentInvariants(result);
		// Specific parent-correctness check: the new field should point at the form.
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
	});

	it("end of form (no index = append)", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "a" }),
								f({ kind: "text", id: "b" }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: FLD_A,
					kind: "text",
					id: "last",
					label: "Last",
				} as BlueprintDoc["fields"][Uuid],
			},
		]);
		assertFieldParentInvariants(result);
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
	});

	it("middle of form (index 1 with 2 existing fields)", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "a" }),
								f({ kind: "text", id: "b" }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: FLD_A,
					kind: "text",
					id: "middle",
					label: "Middle",
				} as BlueprintDoc["fields"][Uuid],
				index: 1,
			},
		]);
		assertFieldParentInvariants(result);
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
	});

	it("into a group (depth 2)", () => {
		const doc = buildDoc({
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
									id: "grp",
									uuid: GRP.toString(),
									children: [],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [
			{
				kind: "addField",
				parentUuid: GRP,
				field: {
					uuid: FLD_A,
					kind: "text",
					id: "nested",
					label: "Nested",
				} as BlueprintDoc["fields"][Uuid],
			},
		]);
		assertFieldParentInvariants(result);
		// Field inside group: parent should be the group uuid, not the form.
		expect(result.fieldParent[FLD_A]).toBe(GRP);
	});

	it("into a repeat inside a group (depth 3)", () => {
		const doc = buildDoc({
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
									id: "grp",
									uuid: GRP.toString(),
									children: [
										f({
											kind: "repeat",
											id: "rpt",
											uuid: RPT.toString(),
											children: [],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [
			{
				kind: "addField",
				parentUuid: RPT,
				field: {
					uuid: FLD_A,
					kind: "text",
					id: "deep",
					label: "Deep",
				} as BlueprintDoc["fields"][Uuid],
			},
		]);
		assertFieldParentInvariants(result);
		expect(result.fieldParent[FLD_A]).toBe(RPT);
	});
});

// ── removeField ───────────────────────────────────────────────────────────────

describe("after removeField", () => {
	it("removes a top-level field", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "target", uuid: FLD_A.toString() }),
								f({ kind: "text", id: "sibling" }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [{ kind: "removeField", uuid: FLD_A }]);
		assertFieldParentInvariants(result);
		// Removed field must not appear in fieldParent.
		expect(FLD_A in result.fieldParent).toBe(false);
	});

	it("removes a nested field inside a group", () => {
		const doc = buildDoc({
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
									id: "grp",
									uuid: GRP.toString(),
									children: [
										f({
											kind: "text",
											id: "nested_target",
											uuid: FLD_A.toString(),
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [{ kind: "removeField", uuid: FLD_A }]);
		assertFieldParentInvariants(result);
		expect(FLD_A in result.fieldParent).toBe(false);
	});

	it("removes a group and cascade-deletes all descendants", () => {
		// Group has two children; removing the group should remove all three
		// uuids (the group + both children) from both fields and fieldParent.
		const doc = buildDoc({
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
									id: "grp",
									uuid: GRP.toString(),
									children: [
										f({ kind: "text", id: "c1", uuid: FLD_A.toString() }),
										f({ kind: "text", id: "c2", uuid: FLD_B.toString() }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [{ kind: "removeField", uuid: GRP }]);
		assertFieldParentInvariants(result);
		// Group itself and its two children must be absent everywhere.
		expect(GRP in result.fields).toBe(false);
		expect(FLD_A in result.fields).toBe(false);
		expect(FLD_B in result.fields).toBe(false);
		expect(GRP in result.fieldParent).toBe(false);
		expect(FLD_A in result.fieldParent).toBe(false);
		expect(FLD_B in result.fieldParent).toBe(false);
	});
});

// ── moveField ─────────────────────────────────────────────────────────────────

describe("after moveField", () => {
	it("reorder within same form (parent unchanged)", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "a", uuid: FLD_A.toString() }),
								f({ kind: "text", id: "b", uuid: FLD_B.toString() }),
								f({ kind: "text", id: "c", uuid: FLD_C.toString() }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{ kind: "moveField", uuid: FLD_A, toParentUuid: formUuid, toIndex: 2 },
		]);
		assertFieldParentInvariants(result);
		// After reorder, parent for the moved field should still be the form.
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
	});

	it("move to different top-level position (parent still the form)", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "a", uuid: FLD_A.toString() }),
								f({ kind: "text", id: "b", uuid: FLD_B.toString() }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{ kind: "moveField", uuid: FLD_B, toParentUuid: formUuid, toIndex: 0 },
		]);
		assertFieldParentInvariants(result);
		expect(result.fieldParent[FLD_B]).toBe(formUuid);
	});

	it("move into a group (parent changes from form → group)", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "target", uuid: FLD_A.toString() }),
								f({
									kind: "group",
									id: "grp",
									uuid: GRP.toString(),
									children: [],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [
			{ kind: "moveField", uuid: FLD_A, toParentUuid: GRP, toIndex: 0 },
		]);
		assertFieldParentInvariants(result);
		// Parent must now be the group, not the form.
		expect(result.fieldParent[FLD_A]).toBe(GRP);
	});

	it("move out of a group back to form (parent changes from group → form)", () => {
		const doc = buildDoc({
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
									id: "grp",
									uuid: GRP.toString(),
									children: [
										f({ kind: "text", id: "nested", uuid: FLD_A.toString() }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{ kind: "moveField", uuid: FLD_A, toParentUuid: formUuid, toIndex: 1 },
		]);
		assertFieldParentInvariants(result);
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
	});

	it("move between two different groups", () => {
		const doc = buildDoc({
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
									id: "grp1",
									uuid: GRP.toString(),
									children: [
										f({ kind: "text", id: "field_x", uuid: FLD_A.toString() }),
									],
								}),
								f({
									kind: "group",
									id: "grp2",
									uuid: GRP2.toString(),
									children: [],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [
			{ kind: "moveField", uuid: FLD_A, toParentUuid: GRP2, toIndex: 0 },
		]);
		assertFieldParentInvariants(result);
		expect(result.fieldParent[FLD_A]).toBe(GRP2);
	});
});

// ── renameField / updateField (structural no-ops) ─────────────────────────────

describe("after renameField / updateField (structural noop)", () => {
	it("renameField does not change fieldParent values", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "old_id", uuid: FLD_A.toString() }),
							],
						},
					],
				},
			],
		});
		const before = { ...doc.fieldParent };
		const store = storeFrom(doc);
		const result = applyBatch(store, [
			{ kind: "renameField", uuid: FLD_A, newId: "new_id" },
		]);
		assertFieldParentInvariants(result);
		// fieldParent values should be identical before and after rename.
		expect(result.fieldParent[FLD_A]).toBe(before[FLD_A]);
	});

	it("updateField does not disturb fieldParent", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [f({ kind: "text", id: "q", uuid: FLD_A.toString() })],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const result = applyBatch(store, [
			{
				kind: "updateField",
				uuid: FLD_A,
				patch: { label: "Updated Label" } as Parameters<
					typeof store.getState.arguments
				>[0],
			} as Mutation,
		]);
		assertFieldParentInvariants(result);
	});
});

// ── duplicateField ────────────────────────────────────────────────────────────

describe("after duplicateField", () => {
	it("leaf field: new uuid appears in fieldParent pointing at same parent as source", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "target", uuid: FLD_A.toString() }),
								f({ kind: "text", id: "sibling" }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [{ kind: "duplicateField", uuid: FLD_A }]);
		assertFieldParentInvariants(result);
		// The source must still point at the form.
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
		// There should now be 3 fields under the form (original + duplicate + sibling).
		expect(result.fieldOrder[formUuid]).toHaveLength(3);
		// The duplicated uuid is the one inserted after FLD_A; check its parent too.
		const order = result.fieldOrder[formUuid] ?? [];
		const dupIdx = order.indexOf(FLD_A) + 1;
		const dupUuid = order[dupIdx] as Uuid;
		expect(dupUuid).toBeDefined();
		expect(result.fieldParent[dupUuid]).toBe(formUuid);
	});

	it("group with children: all new uuids appear in fieldParent pointing at correct new parents", () => {
		const doc = buildDoc({
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
									id: "grp",
									uuid: GRP.toString(),
									children: [
										f({ kind: "text", id: "child_a", uuid: FLD_A.toString() }),
										f({ kind: "text", id: "child_b", uuid: FLD_B.toString() }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [{ kind: "duplicateField", uuid: GRP }]);
		assertFieldParentInvariants(result);

		// Original group + 2 children are still intact.
		expect(result.fieldParent[GRP]).toBe(formUuid);
		expect(result.fieldParent[FLD_A]).toBe(GRP);
		expect(result.fieldParent[FLD_B]).toBe(GRP);

		// The form should have 2 groups now.
		const formOrder = result.fieldOrder[formUuid] ?? [];
		expect(formOrder).toHaveLength(2);

		// The duplicate group is right after the original.
		const dupGrpUuid = formOrder[formOrder.indexOf(GRP) + 1] as Uuid;
		expect(dupGrpUuid).toBeDefined();
		// Duplicate group's parent should be the form.
		expect(result.fieldParent[dupGrpUuid]).toBe(formUuid);
		// The duplicate's children should point at the duplicate group.
		const dupChildren = result.fieldOrder[dupGrpUuid] ?? [];
		expect(dupChildren).toHaveLength(2);
		for (const childUuid of dupChildren) {
			expect(result.fieldParent[childUuid as Uuid]).toBe(dupGrpUuid);
		}
	});
});

// ── form-level mutations ───────────────────────────────────────────────────────

describe("after form-level mutations", () => {
	it("addForm: new form exists in fieldOrder but fieldParent is empty (no fields)", () => {
		const doc = buildDoc({
			modules: [{ name: "M", forms: [] }],
		});
		const store = storeFrom(doc);
		const modUuid = Object.keys(doc.modules)[0] as Uuid;
		const result = applyBatch(store, [
			{
				kind: "addForm",
				moduleUuid: modUuid,
				form: { uuid: FRM, id: "new_form", name: "New Form", type: "survey" },
			},
		]);
		assertFieldParentInvariants(result);
		// The form has no fields, so fieldParent remains empty.
		expect(Object.keys(result.fieldParent)).toHaveLength(0);
	});

	it("removeForm: all fields in the form vanish from fieldParent and fields", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q1", uuid: FLD_A.toString() }),
								f({ kind: "text", id: "q2", uuid: FLD_B.toString() }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [{ kind: "removeForm", uuid: formUuid }]);
		assertFieldParentInvariants(result);
		expect(FLD_A in result.fields).toBe(false);
		expect(FLD_B in result.fields).toBe(false);
		expect(FLD_A in result.fieldParent).toBe(false);
		expect(FLD_B in result.fieldParent).toBe(false);
	});
});

// ── replaceForm ───────────────────────────────────────────────────────────────

describe("after replaceForm", () => {
	it("replaces a form with a richer subtree: old fields gone, new fields appear with correct parents", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "old_q", uuid: FLD_A.toString() }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;

		// New subtree: form with a group containing two leaf fields.
		const result = applyBatch(store, [
			{
				kind: "replaceForm",
				uuid: formUuid,
				form: { uuid: formUuid, id: "f", name: "F Updated", type: "survey" },
				fields: [
					{
						uuid: GRP,
						id: "new_grp",
						kind: "group",
						label: "New Group",
					} as BlueprintDoc["fields"][Uuid],
					{
						uuid: FLD_B,
						id: "new_q1",
						kind: "text",
						label: "New Q1",
					} as BlueprintDoc["fields"][Uuid],
					{
						uuid: FLD_C,
						id: "new_q2",
						kind: "text",
						label: "New Q2",
					} as BlueprintDoc["fields"][Uuid],
				],
				fieldOrder: {
					[formUuid]: [GRP] as Uuid[],
					[GRP]: [FLD_B, FLD_C] as Uuid[],
				},
			},
		]);
		assertFieldParentInvariants(result);
		// Old field must be gone.
		expect(FLD_A in result.fields).toBe(false);
		expect(FLD_A in result.fieldParent).toBe(false);
		// New fields must have correct parents.
		expect(result.fieldParent[GRP]).toBe(formUuid);
		expect(result.fieldParent[FLD_B]).toBe(GRP);
		expect(result.fieldParent[FLD_C]).toBe(GRP);
	});

	it("replaces a form with an empty subtree: all old fields vanish", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q1", uuid: FLD_A.toString() }),
								f({ kind: "text", id: "q2", uuid: FLD_B.toString() }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{
				kind: "replaceForm",
				uuid: formUuid,
				form: { uuid: formUuid, id: "f", name: "F Empty", type: "survey" },
				fields: [],
				fieldOrder: { [formUuid]: [] as Uuid[] },
			},
		]);
		assertFieldParentInvariants(result);
		expect(Object.keys(result.fields)).toHaveLength(0);
		expect(Object.keys(result.fieldParent)).toHaveLength(0);
	});
});

// ── applyMany batches ─────────────────────────────────────────────────────────

describe("after applyMany batches", () => {
	it("three addField calls in one batch — invariants hold after the batch", () => {
		const doc = buildDoc({
			modules: [{ name: "M", forms: [{ name: "F", type: "survey" }] }],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const result = applyBatch(store, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: FLD_A,
					kind: "text",
					id: "q1",
					label: "Q1",
				} as BlueprintDoc["fields"][Uuid],
			},
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: FLD_B,
					kind: "text",
					id: "q2",
					label: "Q2",
				} as BlueprintDoc["fields"][Uuid],
			},
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: FLD_C,
					kind: "text",
					id: "q3",
					label: "Q3",
				} as BlueprintDoc["fields"][Uuid],
			},
		]);
		assertFieldParentInvariants(result);
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
		expect(result.fieldParent[FLD_B]).toBe(formUuid);
		expect(result.fieldParent[FLD_C]).toBe(formUuid);
	});

	it("addField + moveField + removeField in one batch — invariants hold", () => {
		const doc = buildDoc({
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
									id: "grp",
									uuid: GRP.toString(),
									children: [],
								}),
								f({ kind: "text", id: "existing", uuid: FLD_B.toString() }),
							],
						},
					],
				},
			],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		// Batch: add FLD_A at form level, move FLD_B into GRP, then remove FLD_B.
		const result = applyBatch(store, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: FLD_A,
					kind: "text",
					id: "new_q",
					label: "New Q",
				} as BlueprintDoc["fields"][Uuid],
			},
			{ kind: "moveField", uuid: FLD_B, toParentUuid: GRP, toIndex: 0 },
			{ kind: "removeField", uuid: FLD_B },
		]);
		assertFieldParentInvariants(result);
		expect(FLD_B in result.fields).toBe(false);
		expect(FLD_B in result.fieldParent).toBe(false);
		expect(result.fieldParent[FLD_A]).toBe(formUuid);
	});

	it("agent-stream shape: 20 addField calls in one batch — invariants hold and completes quickly", () => {
		const doc = buildDoc({
			modules: [{ name: "M", forms: [{ name: "F", type: "survey" }] }],
		});
		const store = storeFrom(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;

		// Build 20 field mutations with distinct UUIDs to simulate a large agent batch.
		const muts: Mutation[] = Array.from({ length: 20 }, (_, i) => {
			const uuid = asUuid(
				`agent${i.toString().padStart(4, "0")}-0000-0000-0000-0000`,
			);
			return {
				kind: "addField" as const,
				parentUuid: formUuid,
				field: {
					uuid,
					kind: "text",
					id: `q${i}`,
					label: `Q${i}`,
				} as BlueprintDoc["fields"][Uuid],
			};
		});

		const start = performance.now();
		const result = applyBatch(store, muts);
		const elapsed = performance.now() - start;

		assertFieldParentInvariants(result);
		expect(Object.keys(result.fields)).toHaveLength(20);
		// Sanity-check performance: a 20-field batch should never take 100ms.
		expect(elapsed).toBeLessThan(100);
	});
});

// ── load() path ───────────────────────────────────────────────────────────────

describe("after load()", () => {
	it("load a flat doc (no fieldParent in persisted shape) — rebuilds correctly", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "a", uuid: FLD_A.toString() }),
								f({ kind: "text", id: "b", uuid: FLD_B.toString() }),
							],
						},
					],
				},
			],
		});

		// Simulate a Firestore-persisted doc: strip fieldParent before loading.
		// The `load()` action must rebuild it from fieldOrder.
		const { fieldParent: _stripped, ...persistable } = doc;
		const store = createBlueprintDocStore();
		store.getState().load(persistable);

		const state = store.getState() as unknown as BlueprintDoc;
		assertFieldParentInvariants(state);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		expect(state.fieldParent[FLD_A]).toBe(formUuid);
		expect(state.fieldParent[FLD_B]).toBe(formUuid);
	});

	it("load a doc with nested groups (3+ levels deep) — invariants hold", () => {
		const doc = buildDoc({
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
									id: "lvl1",
									uuid: GRP.toString(),
									children: [
										f({
											kind: "group",
											id: "lvl2",
											uuid: GRP2.toString(),
											children: [
												f({
													kind: "repeat",
													id: "lvl3",
													uuid: RPT.toString(),
													children: [
														f({
															kind: "text",
															id: "deep_leaf",
															uuid: NESTED.toString(),
														}),
													],
												}),
											],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const { fieldParent: _stripped, ...persistable } = doc;
		const store = createBlueprintDocStore();
		store.getState().load(persistable);

		const state = store.getState() as unknown as BlueprintDoc;
		assertFieldParentInvariants(state);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		expect(state.fieldParent[GRP]).toBe(formUuid);
		expect(state.fieldParent[GRP2]).toBe(GRP);
		expect(state.fieldParent[RPT]).toBe(GRP2);
		expect(state.fieldParent[NESTED]).toBe(RPT);
	});
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
	it("empty doc (no modules, forms, or fields) — fieldParent is {}", () => {
		const doc = buildDoc();
		assertFieldParentInvariants(doc);
		expect(doc.fieldParent).toEqual({});
	});

	it("doc with forms but no fields — fieldParent is {}", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{ name: "F1", type: "survey" },
						{ name: "F2", type: "registration" },
					],
				},
			],
		});
		assertFieldParentInvariants(doc);
		expect(doc.fieldParent).toEqual({});
	});

	it("nested groups with deepest being empty — invariants hold for non-leaf containers", () => {
		const doc = buildDoc({
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
									id: "outer",
									uuid: GRP.toString(),
									children: [
										f({ kind: "text", id: "leaf", uuid: FLD_A.toString() }),
										// Inner empty group.
										f({
											kind: "group",
											id: "inner_empty",
											uuid: GRP2.toString(),
											children: [],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		assertFieldParentInvariants(doc);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		expect(doc.fieldParent[GRP]).toBe(formUuid);
		expect(doc.fieldParent[FLD_A]).toBe(GRP);
		expect(doc.fieldParent[GRP2]).toBe(GRP);
		// The inner empty group contributes no children, but its own parent entry is correct.
		expect(Object.keys(doc.fieldOrder[GRP2] ?? [])).toHaveLength(0);
	});

	it("multiple modules with multiple forms — each field has correct parent", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M1",
					forms: [
						{
							name: "F1",
							type: "survey",
							fields: [
								f({ kind: "text", id: "m1f1q1", uuid: FLD_A.toString() }),
							],
						},
					],
				},
				{
					name: "M2",
					forms: [
						{
							name: "F2",
							type: "registration",
							fields: [
								f({ kind: "text", id: "m2f2q1", uuid: FLD_B.toString() }),
							],
						},
					],
				},
			],
		});
		assertFieldParentInvariants(doc);

		// Each field must point to its own form, not the other form.
		const formUuids = Object.keys(doc.forms) as Uuid[];
		expect(formUuids).toHaveLength(2);
		expect(formUuids.some((fu) => doc.fieldOrder[fu]?.includes(FLD_A))).toBe(
			true,
		);
		expect(formUuids.some((fu) => doc.fieldOrder[fu]?.includes(FLD_B))).toBe(
			true,
		);
		// Cross-contamination check: FLD_A and FLD_B must have different parents.
		expect(doc.fieldParent[FLD_A]).not.toBe(doc.fieldParent[FLD_B]);
	});
});
