/**
 * The reference index's load-bearing proof: after EVERY applied
 * mutation batch, the incrementally maintained index deep-equals a
 * from-scratch rebuild of the same doc. `buildReferenceIndex` is the
 * oracle (it derives everything from the doc alone); the incremental
 * path is `applyMutations`' per-mutation maintenance. A divergence is
 * a correctness bug by definition — the maintenance missed a carrier
 * some mutation could change.
 *
 * The generator drives one op per applyMutations batch over a
 * reference-rich seed doc, with picks resolved against the RUNNING doc
 * the way the construction fuzz resolves its ops. The alphabet deliberately includes
 * candidate shapes the commit gate rejects (sibling-ID collisions,
 * dangling refs, and case-type flips on referenced types): index
 * maintenance runs while constructing the candidate the gate evaluates,
 * so it must stay rebuild-equal even when that candidate is rejected.
 *
 * Floors per the fuzz doctrine: the seed is pinned, and the run
 * asserts every op kind INDIVIDUALLY changed the doc at least once
 * (one op per batch, so a kind whose lowering always no-ops can't ride
 * a changing batch) — plus occurrence floors for the three
 * at-a-distance arms that motivated the maintenance buckets, each
 * tied to the shape it names: a root add carrying the predeclared pending
 * UUID that provably materialized the standing dangling carrier's edge, and
 * a cross-module form move.
 */

import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import {
	parseXPathForField,
	parseXPathForForm,
	resolveCloseFieldRef,
} from "@/lib/doc/expressionText";
import { applyMutations } from "@/lib/doc/mutations";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, entityTargetKey, type Uuid } from "@/lib/domain";
import { eq, literal, prop, subcasePath, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const PENDING_X_UUID = testUuid("reference-index-pending-x");

/** Reference-rich seed: two modules, every reference surface kind, and
 *  a standing dangling field UUID the add pool can satisfy. */
function seedDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Fuzz Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "age", label: proseText("Age") },
					{ name: "village", label: proseText("Village") },
				],
			},
			{
				name: "household",
				properties: [{ name: "region", label: proseText("Region") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						{
							uuid: testUuid("col00000-0000-4000-8000-000000000001"),
							kind: "plain",
							field: "case_name",
							header: "Name",
						},
						{
							uuid: testUuid("col00000-0000-4000-8000-000000000002"),
							kind: "calculated",
							header: "Age calc",
							expression: term(prop("patient", "age")),
						},
					],
					searchInputs: [
						{
							uuid: testUuid("sin00000-0000-4000-8000-000000000001"),
							kind: "simple",
							name: "by_village",
							label: "Village",
							type: "text",
							property: "village",
						},
						{
							uuid: testUuid("sin00000-0000-4000-8000-000000000002"),
							kind: "advanced",
							name: "age_filter",
							label: "Age",
							type: "text",
							predicate: eq(prop("patient", "age"), literal("18")),
							default: term(prop("patient", "village")),
						},
					],
					filter: eq(prop("patient", "age"), literal("1")),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						closeCondition: { field: "outcome", answer: "done" },
						formLinks: [
							{
								condition: "#form/age > 17 and #patient/age > 17",
								target: {
									type: "module",
									moduleUuid: testUuid("mod00000-0000-4000-8000-00000000000a"),
								},
								datums: [{ name: "case_id", xpath: "/data/age" }],
							},
						],
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
							f({
								kind: "group",
								id: "grp",
								children: [
									f({ kind: "text", id: "inner", label: proseText("Inner") }),
								],
							}),
							f({
								kind: "text",
								id: "watcher",
								label: proseText("See #patient/age and #form/grp/inner"),
								relevant: "#form/grp/inner != '' and /data/age > 0",
								required: "/data/case_name != ''",
							}),
							f({
								kind: "text",
								id: "pending",
								label: proseText("Pending"),
								// The canonical AST carries the predeclared identity
								// even while its field is absent. A later add with
								// that exact UUID materializes the index edge without
								// mutable path matching.
								relevant: {
									parts: [
										{ kind: "field-ref", uuid: PENDING_X_UUID },
										{ kind: "text", text: " = '1'" },
									],
								},
							}),
							f({
								kind: "text",
								id: "ctx_ref",
								label: proseText("Ctx #patient/age"),
								relevant: "#patient/age > 1",
							}),
							f({ kind: "text", id: "outcome", label: proseText("Outcome") }),
						],
					},
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
							}),
							f({
								kind: "hidden",
								id: "age_copy",
								calculate: "#patient/age + 0",
							}),
						],
					},
				],
			},
			{
				uuid: testUuid("households-module"),
				name: "Households",
				caseType: "household",
				caseListConfig: {
					columns: [],
					searchInputs: [],
					filter: eq(
						prop("household", "age", subcasePath("parent", "patient")),
						literal("1"),
					),
				},
				forms: [
					{
						name: "Visit household",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "region",
								label: proseText("Region"),
								caseWrite: { caseType: "household", property: "region" },
							}),
							f({
								kind: "text",
								id: "hh_ctx",
								label: proseText("HH"),
								relevant: "#patient/region != ''",
							}),
						],
					},
				],
			},
		],
	});
}

// ── Pools ───────────────────────────────────────────────────────────

const ID_POOL = [
	"pending_x", // carries the seed's predeclared dangling UUID
	"age",
	"village",
	"note",
	"status",
	"grp",
	"inner",
	"outcome",
];
const XPATH_POOL = [
	"#form/age > 17",
	"#form/grp/inner = '1'",
	"/data/village != ''",
	"#patient/age > 0",
	"#patient/age = '1'",
	"#user/username != ''",
	"string-length(#form/pending_x) > 0",
	"if(", // unparseable — extraction and rewriters see the same tree
	"",
];
const LABEL_POOL = [
	"Plain label",
	"See #patient/age",
	"Check #form/grp/inner then #patient/village",
	"Trailing #household/region.",
];
const CASE_TYPE_POOL = ["patient", "household", "visit", undefined];

type FuzzOp =
	| {
			kind: "addField";
			parentPick: number;
			idPick: number;
			relevantPick: number;
			labelPick: number;
			casePropPick: number;
			asGroup: boolean;
	  }
	| { kind: "removeField"; fieldPick: number }
	| { kind: "updateFieldId"; fieldPick: number; idPick: number }
	| { kind: "moveField"; fieldPick: number; parentPick: number; index: number }
	| { kind: "duplicateField"; fieldPick: number }
	| { kind: "convertField"; fieldPick: number }
	| {
			kind: "updateField";
			fieldPick: number;
			relevantPick: number;
			labelPick: number;
	  }
	| { kind: "addForm"; modulePick: number; withClose: boolean }
	| { kind: "removeForm"; formPick: number }
	| { kind: "moveForm"; formPick: number; modulePick: number; index: number }
	| { kind: "renameForm"; formPick: number }
	| { kind: "updateForm"; formPick: number; closeIdPick: number }
	| { kind: "addModule"; caseTypePick: number }
	| { kind: "removeModule"; modulePick: number }
	| { kind: "moveModule"; modulePick: number; index: number }
	| { kind: "renameModule"; modulePick: number }
	| { kind: "updateModule"; modulePick: number; caseTypePick: number }
	| { kind: "editCaseTypes"; drop: boolean }
	| { kind: "setAppName" };

const opArb: fc.Arbitrary<FuzzOp> = fc.oneof(
	{
		weight: 5,
		arbitrary: fc
			.record({
				parentPick: fc.nat({ max: 9 }),
				idPick: fc.nat({ max: ID_POOL.length - 1 }),
				relevantPick: fc.nat({ max: XPATH_POOL.length - 1 }),
				labelPick: fc.nat({ max: LABEL_POOL.length - 1 }),
				casePropPick: fc.nat({ max: CASE_TYPE_POOL.length - 1 }),
				asGroup: fc.boolean(),
			})
			.map((r) => ({ kind: "addField" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ fieldPick: fc.nat({ max: 30 }) })
			.map((r) => ({ kind: "removeField" as const, ...r })),
	},
	{
		weight: 4,
		arbitrary: fc
			.record({
				fieldPick: fc.nat({ max: 30 }),
				idPick: fc.nat({ max: ID_POOL.length - 1 }),
			})
			.map((r) => ({ kind: "updateFieldId" as const, ...r })),
	},
	{
		weight: 3,
		arbitrary: fc
			.record({
				fieldPick: fc.nat({ max: 30 }),
				parentPick: fc.nat({ max: 9 }),
				index: fc.nat({ max: 6 }),
			})
			.map((r) => ({ kind: "moveField" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ fieldPick: fc.nat({ max: 30 }) })
			.map((r) => ({ kind: "duplicateField" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ fieldPick: fc.nat({ max: 30 }) })
			.map((r) => ({ kind: "convertField" as const, ...r })),
	},
	{
		weight: 3,
		arbitrary: fc
			.record({
				fieldPick: fc.nat({ max: 30 }),
				relevantPick: fc.nat({ max: XPATH_POOL.length - 1 }),
				labelPick: fc.nat({ max: LABEL_POOL.length - 1 }),
			})
			.map((r) => ({ kind: "updateField" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 3 }), withClose: fc.boolean() })
			.map((r) => ({ kind: "addForm" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ formPick: fc.nat({ max: 6 }) })
			.map((r) => ({ kind: "removeForm" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({
				formPick: fc.nat({ max: 6 }),
				modulePick: fc.nat({ max: 3 }),
				index: fc.nat({ max: 3 }),
			})
			.map((r) => ({ kind: "moveForm" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ formPick: fc.nat({ max: 6 }) })
			.map((r) => ({ kind: "renameForm" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({
				formPick: fc.nat({ max: 6 }),
				closeIdPick: fc.nat({ max: ID_POOL.length - 1 }),
			})
			.map((r) => ({ kind: "updateForm" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ caseTypePick: fc.nat({ max: CASE_TYPE_POOL.length - 1 }) })
			.map((r) => ({ kind: "addModule" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 3 }) })
			.map((r) => ({ kind: "removeModule" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 3 }), index: fc.nat({ max: 3 }) })
			.map((r) => ({ kind: "moveModule" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 3 }) })
			.map((r) => ({ kind: "renameModule" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({
				modulePick: fc.nat({ max: 3 }),
				caseTypePick: fc.nat({ max: CASE_TYPE_POOL.length - 1 }),
			})
			.map((r) => ({ kind: "updateModule" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ drop: fc.boolean() })
			.map((r) => ({ kind: "editCaseTypes" as const, ...r })),
	},
	{ weight: 1, arbitrary: fc.constant({ kind: "setAppName" as const }) },
);

// ── Pick resolution against the running doc ─────────────────────────

function pickField(doc: BlueprintDoc, pick: number): Uuid | undefined {
	const uuids = Object.keys(doc.fields) as Uuid[];
	return uuids.length > 0 ? uuids[pick % uuids.length] : undefined;
}

function pickForm(doc: BlueprintDoc, pick: number): Uuid | undefined {
	const uuids = Object.keys(doc.forms) as Uuid[];
	return uuids.length > 0 ? uuids[pick % uuids.length] : undefined;
}

function pickModule(doc: BlueprintDoc, pick: number): Uuid | undefined {
	return doc.moduleOrder.length > 0
		? doc.moduleOrder[pick % doc.moduleOrder.length]
		: undefined;
}

/**
 * The sibling a move should land after, drawn from the destination sequence.
 *
 * A move names an anchor rather than an index, so the fuzz op's numeric pick
 * has to resolve against the destination: `0` means first (`null`), and any
 * other value picks an existing member. Anchors the fuzzer can't satisfy —
 * an empty destination — also come out `null`, which places the item first
 * in a sequence where first and last are the same position anyway.
 */
function pickAnchor(sequence: readonly Uuid[], pick: number): Uuid | null {
	if (sequence.length === 0 || pick % (sequence.length + 1) === 0) return null;
	return sequence[(pick % (sequence.length + 1)) - 1];
}

/** Field parents: every form plus every group/repeat container. */
function pickParent(doc: BlueprintDoc, pick: number): Uuid | undefined {
	const parents = [
		...(Object.keys(doc.forms) as Uuid[]),
		...(Object.keys(doc.fields) as Uuid[]).filter((uuid) => {
			const kind = doc.fields[uuid]?.kind;
			return kind === "group" || kind === "repeat";
		}),
	];
	return parents.length > 0 ? parents[pick % parents.length] : undefined;
}

/** Parse a pool expression against the running doc, scoped to the
 *  form containing `parentUuid` — the same resolution the live commit
 *  surfaces perform before a mutation carries an expression. */
function parseRelevant(doc: BlueprintDoc, parentUuid: Uuid, pick: number) {
	const formUuid = doc.forms[parentUuid]
		? parentUuid
		: findContainingForm(doc, parentUuid);
	return parseXPathForForm(doc, formUuid, XPATH_POOL[pick]);
}

let minted = 0;
function mintUuid(): Uuid {
	minted++;
	return testUuid(`reference-index-fuzz-${minted}`);
}

/** Lower one abstract op to concrete mutations against `doc` — or none
 *  when the pick can't resolve (an empty batch is itself an arm). */
function lower(doc: BlueprintDoc, op: FuzzOp): Mutation[] {
	switch (op.kind) {
		case "addField": {
			const parentUuid = pickParent(doc, op.parentPick);
			if (!parentUuid) return [];
			const caseProp = CASE_TYPE_POOL[op.casePropPick];
			const id = ID_POOL[op.idPick];
			const uuid =
				id === "pending_x" && doc.fields[PENDING_X_UUID] === undefined
					? PENDING_X_UUID
					: mintUuid();
			const field = op.asGroup
				? ({
						uuid,
						kind: "group",
						id,
						label: proseText("Group"),
					} as never)
				: ({
						uuid,
						kind: "text",
						id,
						label: proseText(LABEL_POOL[op.labelPick]),
						relevant: parseRelevant(doc, parentUuid, op.relevantPick),
						...(caseProp && {
							caseWrite: { caseType: caseProp, property: id },
						}),
					} as never);
			return [{ kind: "addField", parentUuid, field }];
		}
		case "removeField": {
			const uuid = pickField(doc, op.fieldPick);
			return uuid ? [{ kind: "removeField", uuid }] : [];
		}
		case "updateFieldId": {
			const uuid = pickField(doc, op.fieldPick);
			const field = uuid ? doc.fields[uuid] : undefined;
			return field
				? [
						{
							kind: "updateField",
							uuid: field.uuid,
							targetKind: field.kind,
							patch: { id: ID_POOL[op.idPick] },
						} as Mutation,
					]
				: [];
		}
		case "moveField": {
			const uuid = pickField(doc, op.fieldPick);
			const toParentUuid = pickParent(doc, op.parentPick);
			if (!uuid || !toParentUuid) return [];
			const after = pickAnchor(doc.fieldOrder[toParentUuid] ?? [], op.index);
			return [{ kind: "moveField", uuid, toParentUuid, after }];
		}
		case "duplicateField": {
			const uuid = pickField(doc, op.fieldPick);
			return uuid ? (duplicateFieldMutations(doc, uuid)?.mutations ?? []) : [];
		}
		case "convertField": {
			const uuid = pickField(doc, op.fieldPick);
			if (!uuid) return [];
			const kind = doc.fields[uuid]?.kind;
			// text → secret and int → decimal are the registry's live
			// targets; anything else exercises the warn-and-skip arm.
			const toKind =
				kind === "text" ? "secret" : kind === "int" ? "decimal" : "secret";
			return [{ kind: "convertField", uuid, toKind }];
		}
		case "updateField": {
			const uuid = pickField(doc, op.fieldPick);
			if (!uuid) return [];
			const kind = doc.fields[uuid]?.kind;
			if (kind !== "text") return [];
			return [
				{
					kind: "updateField",
					uuid,
					targetKind: "text",
					patch: {
						relevant: parseXPathForField(
							doc,
							uuid,
							XPATH_POOL[op.relevantPick],
						),
						label: proseText(LABEL_POOL[op.labelPick]),
					},
				} as Mutation,
			];
		}
		case "addForm": {
			const moduleUuid = pickModule(doc, op.modulePick);
			if (!moduleUuid) return [];
			return [
				{
					kind: "addForm",
					moduleUuid,
					form: {
						uuid: mintUuid(),
						name: "Fuzz form",
						type: op.withClose ? "close" : "followup",
						...(op.withClose && {
							closeCondition: { field: "outcome", answer: "done" },
						}),
					} as never,
				},
			];
		}
		case "removeForm": {
			const uuid = pickForm(doc, op.formPick);
			return uuid ? [{ kind: "removeForm", uuid }] : [];
		}
		case "moveForm": {
			const uuid = pickForm(doc, op.formPick);
			const toModuleUuid = pickModule(doc, op.modulePick);
			if (!uuid || !toModuleUuid) return [];
			const after = pickAnchor(doc.formOrder[toModuleUuid] ?? [], op.index);
			return [{ kind: "moveForm", uuid, toModuleUuid, after }];
		}
		case "renameForm": {
			const uuid = pickForm(doc, op.formPick);
			return uuid ? [{ kind: "renameForm", uuid, newId: "Renamed form" }] : [];
		}
		case "updateForm": {
			const uuid = pickForm(doc, op.formPick);
			if (!uuid) return [];
			// The boundary resolves the authored id to the field's uuid; an
			// id nothing answers to rides verbatim (the dangling shape the
			// extraction must keep edge-less).
			return [
				{
					kind: "updateForm",
					uuid,
					patch: {
						closeCondition: {
							field: testUuid(
								resolveCloseFieldRef(doc, uuid, ID_POOL[op.closeIdPick]),
							),
							answer: "done",
						},
					},
				},
			];
		}
		case "addModule": {
			const caseType = CASE_TYPE_POOL[op.caseTypePick];
			return [
				{
					kind: "addModule",
					module: {
						uuid: mintUuid(),
						id: "fuzz_module",
						name: "Fuzz module",
						...(caseType && { caseType }),
					} as never,
				},
			];
		}
		case "removeModule": {
			const uuid = pickModule(doc, op.modulePick);
			return uuid ? [{ kind: "removeModule", uuid }] : [];
		}
		case "moveModule": {
			const uuid = pickModule(doc, op.modulePick);
			return uuid
				? [
						{
							kind: "moveModule",
							uuid,
							after: pickAnchor(doc.moduleOrder, op.index),
						},
					]
				: [];
		}
		case "renameModule": {
			const uuid = pickModule(doc, op.modulePick);
			return uuid
				? [{ kind: "renameModule", uuid, newId: "Renamed module" }]
				: [];
		}
		case "updateModule": {
			const uuid = pickModule(doc, op.modulePick);
			if (!uuid) return [];
			const caseType = CASE_TYPE_POOL[op.caseTypePick];
			return [{ kind: "updateModule", uuid, patch: { caseType } }];
		}
		case "editCaseTypes":
			if (op.drop) {
				return (doc.caseTypes ?? []).map((caseType) => ({
					kind: "retireCaseType" as const,
					caseType: caseType.name,
				}));
			}
			return doc.caseTypes?.some((caseType) => caseType.name === "patient")
				? []
				: [{ kind: "declareCaseType", caseType: "patient" }];
		case "setAppName":
			return [{ kind: "setAppName", name: "Renamed app" }];
	}
}

// ── The property ────────────────────────────────────────────────────

const OP_KINDS = [
	"addField",
	"removeField",
	"updateFieldId",
	"moveField",
	"duplicateField",
	"convertField",
	"updateField",
	"addForm",
	"removeForm",
	"moveForm",
	"renameForm",
	"updateForm",
	"addModule",
	"removeModule",
	"moveModule",
	"renameModule",
	"updateModule",
	"editCaseTypes",
	"setAppName",
] as const satisfies readonly FuzzOp["kind"][];

describe("reference index fuzz — incremental ≡ rebuild after every batch", () => {
	it("holds over random mutation sequences from a reference-rich seed", async () => {
		const changedTally = new Map<FuzzOp["kind"], number>(
			OP_KINDS.map((k) => [k, 0]),
		);
		let danglingSatisfiedAdds = 0;
		let crossModuleFormMoves = 0;

		await fc.assert(
			fc.property(
				// One op per applyMutations batch, so the per-kind floor
				// credits exactly the op that changed the doc — a kind whose
				// lowering always no-ops can't ride a changing batch.
				fc.array(opArb, { minLength: 1, maxLength: 24 }),
				(ops) => {
					let doc = seedDoc();
					/* Seed landmarks for the dangling-ref tally: the standing
					 * identity ref lives on the `pending` field. Only an add
					 * carrying `PENDING_X_UUID` can satisfy it. UUIDs are stable,
					 * so the landmarks survive renames/moves; if the sequence
					 * deletes them the edge check below simply never credits. */
					const pendingUuid = Object.values(doc.fields).find(
						(field) => field.id === "pending",
					)?.uuid;
					for (const op of ops) {
						const lowered = lower(doc, op);
						// Pre-state facts for the occurrence tallies.
						let satisfyingAddUuid: string | undefined;
						for (const mut of lowered) {
							if (
								mut.kind === "addField" &&
								(mut.field as { uuid?: string }).uuid === PENDING_X_UUID
							) {
								satisfyingAddUuid = (mut.field as { uuid: string }).uuid;
							}
							if (mut.kind === "moveForm") {
								const owner = Object.entries(doc.formOrder).find(([, list]) =>
									list.includes(mut.uuid),
								)?.[0];
								if (owner !== undefined && owner !== mut.toModuleUuid) {
									crossModuleFormMoves++;
								}
							}
						}
						const prev = doc;
						doc = produce(doc, (draft) => {
							applyMutations(draft, lowered);
						});
						if (doc !== prev) {
							changedTally.set(op.kind, (changedTally.get(op.kind) ?? 0) + 1);
						}
						/* Credit the dangling arm only when the add actually
						 * satisfied the ref: the standing carrier now holds an
						 * edge to the minted field. */
						if (
							satisfyingAddUuid !== undefined &&
							pendingUuid !== undefined &&
							doc.refIndex?.in[entityTargetKey(satisfyingAddUuid)]?.[
								pendingUuid
							] !== undefined
						) {
							danglingSatisfiedAdds++;
						}
						// THE invariant: the maintained index equals a rebuild.
						expect(doc.refIndex).toEqual(buildReferenceIndex(doc));
					}
				},
			),
			{ numRuns: 120, seed: 20260611 },
		);

		for (const kind of OP_KINDS) {
			expect(
				changedTally.get(kind) ?? 0,
				`op kind "${kind}" never landed a doc change — the fuzz no longer exercises its maintenance arm`,
			).toBeGreaterThan(0);
		}
		expect(
			danglingSatisfiedAdds,
			"no add ever satisfied the standing dangling field identity",
		).toBeGreaterThan(0);
		expect(
			crossModuleFormMoves,
			"no form ever moved across modules — the ctx re-key arm went unexercised",
		).toBeGreaterThan(0);
	});
});
