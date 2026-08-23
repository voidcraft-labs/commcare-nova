/**
 * Round-trip oracle for `diffDocsToMutations`.
 *
 * THE invariant: replaying the diff of `(prev → next)` on `prev`
 * reproduces `next`, compared on the persistable projection (derived
 * `fieldParent` + `refIndex` stripped via `toPersistableDoc`).
 *
 *   stripDerived(produce(prev, d => applyMutations(d, diff(prev, next))))
 *     ≡ stripDerived(next)
 *
 * The replay goes through the REAL persistence wire, not an in-memory
 * shortcut: every emitted mutation is serialized via
 * `JSON.parse(JSON.stringify({ mutations }))` (the `PUT /api/apps/[id]`
 * body — which DROPS `undefined`-valued keys, the exact shape a clear must
 * survive), re-parsed through `mutationSchema`, and the RE-PARSED mutations
 * are what get applied. So the oracle proves not just "the diff replays"
 * but "the diff replays after a JSON + schema round-trip" — the blind spot
 * that let the null-vs-undefined clear bug slip past an in-memory replay.
 *
 * `prev` is one random valid mutation batch off a seed doc; `next` is
 * ANOTHER random batch off `prev`. The two batches independently exercise
 * every diffable shape — add/remove/identity-change/convert/update/move at
 * module, form, and field level, plus app-name / connect / logo / case-types /
 * media — and deliberately SET-then-CLEAR optional slots
 * (`relevant`, a form's `purpose`, a module's `caseType`, every media
 * slot, the logo) so the clear path is exercised, not just the set path.
 * Both batches go through the SAME reducer the oracle replays the diff
 * with, so any state the reducer can produce is fair game (including
 * shapes the commit gate would reject — the diff backs persistence, not
 * the gate).
 *
 * The generators mirror `referenceIndex.fuzz.test.ts`'s pick-against-the-
 * running-doc style: each op resolves its targets against the doc of the
 * moment, so a batch is a sequence of dependent edits, not a static plan.
 */

import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	parseXPathForField,
	parseXPathForForm,
} from "@/lib/doc/expressionText";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	orderedFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "@/lib/doc/fieldWalk";
import { mutationSequenceAdmissionIssue } from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

// ── Seeds ─────────────────────────────────────────────────────────────

/** Empty doc — no modules, no case types, no logo. */
function emptyDoc(): BlueprintDoc {
	return buildDoc({ appName: "Empty" });
}

/** Single survey module, single form, two leaf fields. */
function singleModuleDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Single",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({ kind: "text", id: "q1", label: proseText("Q1") }),
							f({ kind: "int", id: "q2", label: proseText("Q2") }),
						],
					},
				],
			},
		],
	});
}

/** Reference-rich seed: two modules, nested group + repeat, case types,
 *  a logo, and a field carrying message media — exercises every branch. */
function richDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Rich Clinic",
		connectType: "learn",
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
					columns: [],
					searchInputs: [],
					filter: eq(prop("patient", "age"), literal("1")),
				},
				forms: [
					{
						name: "Register",
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
							f({
								kind: "group",
								id: "grp",
								label: proseText("Group"),
								children: [
									f({ kind: "text", id: "inner", label: proseText("Inner") }),
									f({
										kind: "text",
										id: "inner2",
										label: proseText("Inner 2"),
									}),
								],
							}),
							f({
								kind: "repeat",
								id: "rep",
								label: proseText("Repeat"),
								children: [
									f({ kind: "text", id: "rep_q", label: proseText("Rep Q") }),
								],
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
						],
					},
				],
			},
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "region",
								label: proseText("Region"),
								caseWrite: { caseType: "household", property: "region" },
							}),
						],
					},
				],
			},
		],
	});
	doc.logo = testMediaAssetId("asset-logo-1");
	// Attach message media to one field so the field-media diff branch fires.
	const ageField = Object.values(doc.fields).find((fld) => fld.id === "age");
	if (ageField) {
		(ageField as Record<string, unknown>).label_media = {
			image: testMediaAssetId("asset-img-1"),
		};
	}
	return doc;
}

const SEEDS: Array<() => BlueprintDoc> = [emptyDoc, singleModuleDoc, richDoc];

// ── Pools ─────────────────────────────────────────────────────────────

const ID_POOL = [
	"age",
	"village",
	"note",
	"status",
	"inner",
	"outcome",
	"extra",
];
const XPATH_POOL = [
	"#form/age > 17",
	"/data/village != ''",
	"#patient/age > 0",
	"#patient/age = '1'",
	"",
];
const LABEL_POOL = ["Plain", "See #patient/age", "Check stuff"];
const CASE_TYPE_POOL: Array<string | undefined> = [
	"patient",
	"household",
	"visit",
	undefined,
];

// ── Op alphabet ───────────────────────────────────────────────────────

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
	| { kind: "convertField"; fieldPick: number }
	| {
			kind: "updateField";
			fieldPick: number;
			relevantPick: number;
			labelPick: number;
			clearRelevant: boolean;
	  }
	| { kind: "setFieldMedia"; fieldPick: number; clear: boolean }
	| { kind: "addForm"; modulePick: number; ftype: number }
	| { kind: "removeForm"; formPick: number }
	| { kind: "moveForm"; formPick: number; modulePick: number; index: number }
	| { kind: "renameForm"; formPick: number; namePick: number }
	| {
			kind: "updateForm";
			formPick: number;
			purposePick: number;
			clearPurpose: boolean;
			closeConditionMode: number;
	  }
	| { kind: "setFormMedia"; formPick: number; clear: boolean }
	| { kind: "addModule"; caseTypePick: number; namePick: number }
	| { kind: "removeModule"; modulePick: number }
	| { kind: "moveModule"; modulePick: number; index: number }
	| { kind: "renameModule"; modulePick: number; namePick: number }
	| { kind: "updateModule"; modulePick: number; caseTypePick: number }
	| { kind: "setModuleMedia"; modulePick: number; clear: boolean }
	| { kind: "editCaseTypes"; drop: boolean }
	| { kind: "setAppName"; namePick: number }
	| { kind: "setConnectType"; pick: number }
	| { kind: "setAppLogo"; clear: boolean };

const opArb: fc.Arbitrary<FuzzOp> = fc.oneof(
	{
		weight: 5,
		arbitrary: fc
			.record({
				parentPick: fc.nat({ max: 12 }),
				idPick: fc.nat({ max: ID_POOL.length - 1 }),
				relevantPick: fc.nat({ max: XPATH_POOL.length - 1 }),
				labelPick: fc.nat({ max: LABEL_POOL.length - 1 }),
				casePropPick: fc.nat({ max: CASE_TYPE_POOL.length - 1 }),
				asGroup: fc.boolean(),
			})
			.map((r) => ({ kind: "addField" as const, ...r })),
	},
	{
		weight: 3,
		arbitrary: fc
			.record({ fieldPick: fc.nat({ max: 40 }) })
			.map((r) => ({ kind: "removeField" as const, ...r })),
	},
	{
		weight: 4,
		arbitrary: fc
			.record({
				fieldPick: fc.nat({ max: 40 }),
				idPick: fc.nat({ max: ID_POOL.length - 1 }),
			})
			.map((r) => ({ kind: "updateFieldId" as const, ...r })),
	},
	{
		weight: 4,
		arbitrary: fc
			.record({
				fieldPick: fc.nat({ max: 40 }),
				parentPick: fc.nat({ max: 12 }),
				index: fc.nat({ max: 6 }),
			})
			.map((r) => ({ kind: "moveField" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ fieldPick: fc.nat({ max: 40 }) })
			.map((r) => ({ kind: "convertField" as const, ...r })),
	},
	{
		weight: 3,
		arbitrary: fc
			.record({
				fieldPick: fc.nat({ max: 40 }),
				relevantPick: fc.nat({ max: XPATH_POOL.length - 1 }),
				labelPick: fc.nat({ max: LABEL_POOL.length - 1 }),
				clearRelevant: fc.boolean(),
			})
			.map((r) => ({ kind: "updateField" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ fieldPick: fc.nat({ max: 40 }), clear: fc.boolean() })
			.map((r) => ({ kind: "setFieldMedia" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 4 }), ftype: fc.nat({ max: 3 }) })
			.map((r) => ({ kind: "addForm" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ formPick: fc.nat({ max: 8 }) })
			.map((r) => ({ kind: "removeForm" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({
				formPick: fc.nat({ max: 8 }),
				modulePick: fc.nat({ max: 4 }),
				index: fc.nat({ max: 4 }),
			})
			.map((r) => ({ kind: "moveForm" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ formPick: fc.nat({ max: 8 }), namePick: fc.nat({ max: 3 }) })
			.map((r) => ({ kind: "renameForm" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({
				formPick: fc.nat({ max: 8 }),
				purposePick: fc.nat({ max: 3 }),
				clearPurpose: fc.boolean(),
				closeConditionMode: fc.nat({ max: 2 }),
			})
			.map((r) => ({ kind: "updateForm" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ formPick: fc.nat({ max: 8 }), clear: fc.boolean() })
			.map((r) => ({ kind: "setFormMedia" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({
				caseTypePick: fc.nat({ max: CASE_TYPE_POOL.length - 1 }),
				namePick: fc.nat({ max: 3 }),
			})
			.map((r) => ({ kind: "addModule" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 4 }) })
			.map((r) => ({ kind: "removeModule" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 4 }), index: fc.nat({ max: 4 }) })
			.map((r) => ({ kind: "moveModule" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 4 }), namePick: fc.nat({ max: 3 }) })
			.map((r) => ({ kind: "renameModule" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({
				modulePick: fc.nat({ max: 4 }),
				caseTypePick: fc.nat({ max: CASE_TYPE_POOL.length - 1 }),
			})
			.map((r) => ({ kind: "updateModule" as const, ...r })),
	},
	{
		weight: 2,
		arbitrary: fc
			.record({ modulePick: fc.nat({ max: 4 }), clear: fc.boolean() })
			.map((r) => ({ kind: "setModuleMedia" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ drop: fc.boolean() })
			.map((r) => ({ kind: "editCaseTypes" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ namePick: fc.nat({ max: 3 }) })
			.map((r) => ({ kind: "setAppName" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ pick: fc.nat({ max: 2 }) })
			.map((r) => ({ kind: "setConnectType" as const, ...r })),
	},
	{
		weight: 1,
		arbitrary: fc
			.record({ clear: fc.boolean() })
			.map((r) => ({ kind: "setAppLogo" as const, ...r })),
	},
);

// ── Pick resolution ───────────────────────────────────────────────────

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

let minted = 0;
function mintUuid(): string {
	minted++;
	return `df000000-0000-4000-8000-${minted.toString().padStart(12, "0")}`;
}

/**
 * The sibling a move should land after, drawn from the destination sequence.
 *
 * A move names an anchor rather than an index, so the op's numeric pick has to
 * resolve against the destination: `0` means first (`null`), any other value
 * picks an existing member, and the moved entity is excluded because it is
 * spliced out before it is spliced back in.
 */
function anchorAt(
	members: readonly Uuid[],
	pick: number,
	excludeUuid?: Uuid,
): Uuid | null {
	const sibs = members.filter((u) => u !== excludeUuid);
	if (sibs.length === 0) return null;
	const slot = pick % (sibs.length + 1);
	return slot === 0 ? null : sibs[slot - 1];
}

const FORM_TYPES = ["registration", "followup", "close", "survey"] as const;
const NAME_POOL = ["Alpha", "Beta", "Gamma", "Delta"];
const PURPOSE_POOL = ["Purpose A", "Purpose B", "", "Purpose C"];

/** Lower one abstract op to concrete mutations against the running doc. */
function lower(doc: BlueprintDoc, op: FuzzOp): Mutation[] {
	switch (op.kind) {
		case "addField": {
			const parentUuid = pickParent(doc, op.parentPick);
			if (!parentUuid) return [];
			const formUuid = doc.forms[parentUuid]
				? parentUuid
				: findContainingForm(doc, parentUuid);
			const caseProp = CASE_TYPE_POOL[op.casePropPick];
			const id = ID_POOL[op.idPick];
			const field = op.asGroup
				? ({
						uuid: mintUuid(),
						kind: "group",
						id,
						label: proseText("Group"),
					} as never)
				: ({
						uuid: mintUuid(),
						kind: "text",
						id,
						label: proseText(LABEL_POOL[op.labelPick]),
						relevant: parseXPathForForm(
							doc,
							formUuid,
							XPATH_POOL[op.relevantPick],
						),
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
			const after = anchorAt(
				orderedFieldUuids(doc, toParentUuid),
				op.index,
				uuid,
			);
			return [{ kind: "moveField", uuid, toParentUuid, after }];
		}
		case "convertField": {
			const uuid = pickField(doc, op.fieldPick);
			if (!uuid) return [];
			const kind = doc.fields[uuid]?.kind;
			const toKind =
				kind === "text"
					? "secret"
					: kind === "secret"
						? "text"
						: kind === "int"
							? "decimal"
							: kind === "group"
								? "repeat"
								: kind === "repeat"
									? "group"
									: "secret";
			return [{ kind: "convertField", uuid, toKind }];
		}
		case "updateField": {
			const uuid = pickField(doc, op.fieldPick);
			if (!uuid) return [];
			const kind = doc.fields[uuid]?.kind;
			if (kind !== "text") return [];
			// `clearRelevant` drops a previously-set `relevant` (the clearable
			// optional slot) via an explicit `null`, the wire shape of a clear —
			// so a later batch that re-sets it (or this batch clearing what an
			// earlier op set) exercises the diff's set→clear path, not just set.
			return [
				{
					kind: "updateField",
					uuid,
					targetKind: "text",
					patch: {
						relevant: op.clearRelevant
							? null
							: parseXPathForField(doc, uuid, XPATH_POOL[op.relevantPick]),
						label: proseText(LABEL_POOL[op.labelPick]),
					},
				} as Mutation,
			];
		}
		case "setFieldMedia": {
			const uuid = pickField(doc, op.fieldPick);
			if (!uuid) return [];
			return [
				{
					kind: "setFieldMedia",
					fieldUuid: uuid,
					slot: "label",
					media: op.clear ? null : { image: testMediaAssetId(mintUuid()) },
				},
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
						id: "fuzz_form",
						name: "Fuzz form",
						type: FORM_TYPES[op.ftype],
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
			const after = anchorAt(
				orderedFormUuids(doc, toModuleUuid),
				op.index,
				uuid,
			);
			return [{ kind: "moveForm", uuid, toModuleUuid, after }];
		}
		case "renameForm": {
			const uuid = pickForm(doc, op.formPick);
			return uuid
				? [{ kind: "renameForm", uuid, newId: NAME_POOL[op.namePick] }]
				: [];
		}
		case "updateForm": {
			const uuid = pickForm(doc, op.formPick);
			if (!uuid) return [];
			// Two clearable optional slots driven together so set→clear is
			// exercised across batches: `purpose` (set, or `null`-cleared) and
			// `closeCondition` (set to a condition over a field the form holds,
			// `null`-cleared, or left alone). The `null` is the wire shape of a
			// clear — `JSON.stringify` drops `undefined`, so only `null`
			// survives the persistence wire the oracle replays.
			const patch: Record<string, unknown> = {};
			const purpose = PURPOSE_POOL[op.purposePick];
			if (op.clearPurpose) patch.purpose = null;
			else if (purpose !== "") patch.purpose = purpose;
			if (op.closeConditionMode === 1) {
				patch.closeCondition = null;
			} else if (op.closeConditionMode === 2) {
				const fieldUuid = (doc.fieldOrder[uuid] ?? [])[0];
				if (fieldUuid !== undefined) {
					patch.closeCondition = { field: fieldUuid, answer: "yes" };
				}
			}
			return [{ kind: "updateForm", uuid, patch: patch as never }];
		}
		case "setFormMedia": {
			const uuid = pickForm(doc, op.formPick);
			if (!uuid) return [];
			return [
				{
					kind: "setFormMedia",
					uuid,
					icon: op.clear ? null : testMediaAssetId(mintUuid()),
					audioLabel: null,
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
						name: NAME_POOL[op.namePick],
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
			if (!uuid) return [];
			return [
				{
					kind: "moveModule",
					uuid,
					after: anchorAt(orderedModuleUuids(doc), op.index, uuid),
				},
			];
		}
		case "renameModule": {
			const uuid = pickModule(doc, op.modulePick);
			return uuid
				? [{ kind: "renameModule", uuid, newId: NAME_POOL[op.namePick] }]
				: [];
		}
		case "updateModule": {
			const uuid = pickModule(doc, op.modulePick);
			if (!uuid) return [];
			const caseType = CASE_TYPE_POOL[op.caseTypePick];
			return [{ kind: "updateModule", uuid, patch: { caseType } }];
		}
		case "setModuleMedia": {
			const uuid = pickModule(doc, op.modulePick);
			if (!uuid) return [];
			return [
				{
					kind: "setModuleMedia",
					uuid,
					icon: op.clear ? null : testMediaAssetId(mintUuid()),
					audioLabel: null,
				},
			];
		}
		case "editCaseTypes":
			if (op.drop) {
				return (doc.caseTypes ?? []).map((caseType) => ({
					kind: "retireCaseType" as const,
					caseType: caseType.name,
				}));
			}
			return doc.caseTypes?.some((caseType) => caseType.name === "patient")
				? [
						{
							kind: "setCaseProperty",
							caseType: "patient",
							property: { name: "case_name", label: proseText("N") },
						},
					]
				: [
						{ kind: "declareCaseType", caseType: "patient" },
						{
							kind: "addCaseProperty",
							caseType: "patient",
							property: { name: "case_name", label: proseText("N") },
						},
					];
		case "setAppName":
			return [{ kind: "setAppName", name: NAME_POOL[op.namePick] }];
		case "setConnectType": {
			const ct = ([null, "learn", "deliver"] as const)[op.pick];
			return [{ kind: "setConnectType", connectType: ct }];
		}
		case "setAppLogo":
			return [
				{
					kind: "setAppLogo",
					logo: op.clear ? null : testMediaAssetId(mintUuid()),
				},
			];
	}
}

/** Apply a batch of ops to a doc, returning the resulting doc. */
function applyOps(doc: BlueprintDoc, ops: FuzzOp[]): BlueprintDoc {
	let cur = doc;
	for (const op of ops) {
		const muts = lower(cur, op);
		cur = produce(cur, (draft) => {
			applyMutations(draft, muts);
		});
	}
	return cur;
}

/**
 * The diff replayed on `prev` must equal `next` on the persistable shape —
 * replayed through the REAL wire, not in memory. Each emitted mutation is
 * serialized via `JSON.parse(JSON.stringify({ mutations }))` (the `PUT`
 * body, which drops `undefined`-valued keys) and re-parsed through
 * `mutationSchema` (asserting every one parses); the RE-PARSED mutations
 * are what get applied. This catches a clear that lowers to
 * `{ key: undefined }` — gone after JSON, a no-op that silently keeps the
 * stale value — and any payload the schema rejects.
 */
function assertRoundTrip(prev: BlueprintDoc, next: BlueprintDoc): void {
	const diff = diffDocsToMutations(prev, next);
	const onWire = JSON.parse(JSON.stringify({ mutations: diff })) as {
		mutations: unknown[];
	};
	const reparsed = onWire.mutations.map((m) => {
		const result = mutationSchema.safeParse(m);
		if (!result.success) {
			throw new Error(
				`emitted mutation failed mutationSchema: ${result.error.message}\n${JSON.stringify(m)}`,
			);
		}
		return result.data;
	});
	const replayed = produce(prev, (draft) => {
		applyMutations(draft, reparsed as Mutation[]);
	});
	// Membership arrays compare RAW: array position IS the sequence, so
	// canonicalizing one would erase exactly what the round trip is checking.
	// The case-type CATALOG is the one exception — it is name-keyed, its array
	// position is not authoritative, and the catalog diff is therefore a no-op
	// on a reorder-only delta.
	expect(withSortedCatalog(toPersistableDoc(replayed))).toEqual(
		withSortedCatalog(toPersistableDoc(next)),
	);
}

/** Sort the name-keyed case-type catalog (types, then each type's properties)
 *  so a catalog reorder isn't read as a content difference. */
function withSortedCatalog<T extends ReturnType<typeof toPersistableDoc>>(
	doc: T,
): T {
	return produce(doc, (draft) => {
		const d = draft as unknown as BlueprintDoc;
		if (!d.caseTypes) return;
		d.caseTypes = [...d.caseTypes]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((caseType) => ({
				...caseType,
				properties: [...caseType.properties].sort((a, b) =>
					a.name.localeCompare(b.name),
				),
			}));
	});
}

/** Reverse a form's visual order. The membership array IS that order, so
 *  reversing it is the whole gesture. */
function reverseDisplayOrder(doc: BlueprintDoc, formUuid: Uuid): void {
	doc.fieldOrder[formUuid] = [...orderedFieldUuids(doc, formUuid)].reverse();
}

// ── The property ──────────────────────────────────────────────────────

describe("diffDocsToMutations — diff(prev, next) replayed on prev ≡ next", () => {
	it("holds over random (prev, next) pairs across every seed", () => {
		let iterations = 0;
		fc.assert(
			fc.property(
				fc.nat({ max: SEEDS.length - 1 }),
				fc.array(opArb, { minLength: 0, maxLength: 16 }),
				fc.array(opArb, { minLength: 0, maxLength: 16 }),
				(seedPick, batchA, batchB) => {
					iterations++;
					const seed = SEEDS[seedPick]();
					const prev = applyOps(seed, batchA);
					const next = applyOps(prev, batchB);
					assertRoundTrip(prev, next);
				},
			),
			{ numRuns: 1000, seed: 20260628 },
		);
		expect(iterations).toBeGreaterThanOrEqual(1000);
		/* A thousand diff-and-replay rounds over documents this size costs more
		 * than the 5s default on a CI runner. The seed is fixed, so the run is
		 * deterministic and the only variable is machine speed — the honest fix
		 * is a timeout that matches the work, not fewer rounds, which would
		 * quietly weaken the property this file exists to prove. */
	}, 60_000);

	it("returns [] when prev deep-equals next", () => {
		const doc = richDoc();
		const clone = produce(doc, () => {});
		expect(diffDocsToMutations(doc, clone)).toEqual([]);
	});
});

// ── Explicit unit cases ───────────────────────────────────────────────

describe("diffDocsToMutations — explicit cases", () => {
	it("adds a field beside a field moved into the same container", () => {
		const prev = richDoc();
		const next = applyOps(prev, [
			{
				kind: "moveField",
				fieldPick: 0,
				parentPick: 9,
				index: 3,
			},
			{
				kind: "addField",
				parentPick: 4,
				idPick: 0,
				relevantPick: 0,
				labelPick: 0,
				casePropPick: 0,
				asGroup: false,
			},
		]);
		assertRoundTrip(prev, next);
	});

	it("reconciles a pure field-ID change through updateField", () => {
		const prev = singleModuleDoc();
		const next = produce(prev, (draft) => {
			const target = Object.values(draft.fields).find((fld) => fld.id === "q1");
			if (target) target.id = "q1_renamed";
		});
		const diff = diffDocsToMutations(prev, next);
		// Field identity has one canonical mutation dialect: the ID rides the
		// same target-kind-aware updateField patch used by direct authoring.
		expect(
			diff.some(
				(m) =>
					m.kind === "updateField" &&
					(m.patch as { id?: string }).id === "q1_renamed",
			),
		).toBe(true);
		assertRoundTrip(prev, next);
	});

	it("pure field reorder within a form", () => {
		const prev = singleModuleDoc();
		const formUuid = prev.moduleOrder
			.flatMap((m) => prev.formOrder[m] ?? [])
			.at(0);
		const next = produce(prev, (draft) => {
			if (!formUuid) return;
			reverseDisplayOrder(draft as unknown as BlueprintDoc, formUuid);
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.some((m) => m.kind === "moveField")).toBe(true);
		assertRoundTrip(prev, next);
	});

	it("a non-catalog structural edit emits no catalog mutations", () => {
		// A doc WITH a catalog; reorder its fields (a purely structural edit
		// that doesn't touch the catalog). The diff must NOT re-pin the whole
		// catalog — replaying it must leave a co-member's concurrent catalog add
		// untouched.
		const prev = buildDoc({
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
					name: "M",
					caseType: "patient",
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								},
								{
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
								},
							],
						},
					],
				},
			],
		});
		expect(prev.caseTypes).not.toBeNull();
		const backfilled = prev;
		const formUuid = backfilled.moduleOrder
			.flatMap((m) => backfilled.formOrder[m] ?? [])
			.at(0);
		const next = produce(backfilled, (draft) => {
			if (!formUuid) return;
			reverseDisplayOrder(draft as unknown as BlueprintDoc, formUuid);
		});
		const diff = diffDocsToMutations(backfilled, next);
		expect(diff.some((m) => m.kind === "moveField")).toBe(true);
		// No catalog re-pin on a purely structural edit.
		expect(
			diff.some(
				(m) =>
					m.kind === "addCaseProperty" ||
					m.kind === "removeCaseProperty" ||
					m.kind === "setCaseProperty" ||
					m.kind === "declareCaseType" ||
					m.kind === "retireCaseType",
			),
		).toBe(false);
		assertRoundTrip(backfilled, next);
	});

	it("field kind convert (text → secret) reconciles remaining slots", () => {
		const prev = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "pw",
									label: proseText("Password"),
									hint: proseText("secret"),
								}),
							],
						},
					],
				},
			],
		});
		const next = produce(prev, (draft) => {
			const target = Object.values(draft.fields).find((fld) => fld.id === "pw");
			if (target) {
				(target as Record<string, unknown>).kind = "secret";
				(target as Record<string, unknown>).label = proseText("PIN");
			}
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.some((m) => m.kind === "convertField")).toBe(true);
		assertRoundTrip(prev, next);
	});

	it("field media set then a separate clear", () => {
		const prev = singleModuleDoc();
		const withMedia = produce(prev, (draft) => {
			const target = Object.values(draft.fields).find((fld) => fld.id === "q1");
			if (target)
				(target as Record<string, unknown>).label_media = {
					image: testMediaAssetId("a1"),
				};
		});
		// set
		const setDiff = diffDocsToMutations(prev, withMedia);
		expect(setDiff.some((m) => m.kind === "setFieldMedia")).toBe(true);
		assertRoundTrip(prev, withMedia);
		// clear
		const clearDiff = diffDocsToMutations(withMedia, prev);
		expect(
			clearDiff.some((m) => m.kind === "setFieldMedia" && m.media === null),
		).toBe(true);
		assertRoundTrip(withMedia, prev);
	});

	it("cross-parent field move into a group", () => {
		const prev = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "loose", label: proseText("Loose") }),
								f({
									kind: "group",
									id: "g",
									label: proseText("Group"),
									children: [
										f({ kind: "text", id: "child", label: proseText("Child") }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const groupUuid = Object.values(prev.fields).find(
			(fld) => fld.id === "g",
		)?.uuid;
		const looseUuid = Object.values(prev.fields).find(
			(fld) => fld.id === "loose",
		)?.uuid;
		const next = produce(prev, (draft) => {
			if (!groupUuid || !looseUuid) return;
			// remove from form order
			for (const order of Object.values(draft.fieldOrder)) {
				const at = order.indexOf(looseUuid);
				if (at !== -1) order.splice(at, 1);
			}
			const groupOrder = draft.fieldOrder[groupUuid] ?? [];
			groupOrder.push(looseUuid);
			draft.fieldOrder[groupUuid] = groupOrder;
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.some((m) => m.kind === "moveField")).toBe(true);
		assertRoundTrip(prev, next);
	});

	it("module add with forms and fields", () => {
		const prev = emptyDoc();
		const next = buildDoc({
			appName: "Empty",
			modules: [
				{
					name: "New",
					caseType: "thing",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({ kind: "text", id: "a", label: proseText("A") }),
								f({
									kind: "group",
									id: "grp",
									label: proseText("G"),
									children: [
										f({ kind: "text", id: "b", label: proseText("B") }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.some((m) => m.kind === "addModule")).toBe(true);
		expect(diff.some((m) => m.kind === "addForm")).toBe(true);
		expect(
			diff.filter((m) => m.kind === "addField").length,
		).toBeGreaterThanOrEqual(3);
		assertRoundTrip(prev, next);
	});

	it("module remove cascades children (single removeModule emitted)", () => {
		const prev = richDoc();
		const firstModule = prev.moduleOrder[0];
		const next = produce(prev, (draft) => {
			// remove module + its forms + their fields by hand
			for (const formUuid of draft.formOrder[firstModule] ?? []) {
				const stack = [...(draft.fieldOrder[formUuid] ?? [])];
				while (stack.length > 0) {
					const fu = stack.pop();
					if (fu === undefined) continue;
					for (const c of draft.fieldOrder[fu] ?? []) stack.push(c);
					delete draft.fieldOrder[fu];
					delete draft.fields[fu];
				}
				delete draft.fieldOrder[formUuid];
				delete draft.forms[formUuid];
			}
			delete draft.formOrder[firstModule];
			delete draft.modules[firstModule];
			draft.moduleOrder = draft.moduleOrder.filter((m) => m !== firstModule);
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.filter((m) => m.kind === "removeModule").length).toBe(1);
		expect(diff.some((m) => m.kind === "removeForm")).toBe(false);
		expect(diff.some((m) => m.kind === "removeField")).toBe(false);
		assertRoundTrip(prev, next);
	});

	it("evacuates a retained child before removing its parent", () => {
		const roots = richDoc();
		const [parentUuid, childUuid] = roots.moduleOrder;
		const prev = produce(roots, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: childUuid,
					parentModuleUuid: parentUuid,
					after: null,
				},
			]);
		});
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: childUuid,
					parentModuleUuid: null,
					after: parentUuid,
				},
				{ kind: "removeModule", uuid: parentUuid },
			]);
		});
		const diff = diffDocsToMutations(prev, next);
		const evacuation = diff.findIndex(
			(mutation) =>
				mutation.kind === "moveModule" && mutation.uuid === childUuid,
		);
		const removal = diff.findIndex(
			(mutation) =>
				mutation.kind === "removeModule" && mutation.uuid === parentUuid,
		);
		expect(evacuation).toBeGreaterThanOrEqual(0);
		expect(removal).toBeGreaterThan(evacuation);
		if (evacuation >= 0) {
			expect(diff[evacuation]).toMatchObject({ parentModuleUuid: null });
		}
		assertRoundTrip(prev, next);
	});

	it("promotes an existing parent before adding its new child", () => {
		const roots = richDoc();
		const [firstRoot, promotedParent] = roots.moduleOrder;
		const prev = produce(roots, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: promotedParent,
					parentModuleUuid: firstRoot,
					after: null,
				},
			]);
		});
		const newborn = testUuid("diff-new-child-of-promoted-parent");
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: promotedParent,
					parentModuleUuid: null,
					after: firstRoot,
				},
				{
					kind: "addModule",
					module: {
						uuid: newborn,
						id: "newborn",
						name: "Newborn",
						parentModuleUuid: promotedParent,
					},
					after: null,
				},
			]);
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.map((mutation) => mutation.kind)).toEqual(
			expect.arrayContaining(["moveModule", "addModule"]),
		);
		expect(
			diff.findIndex(
				(mutation) =>
					mutation.kind === "moveModule" && mutation.uuid === promotedParent,
			),
		).toBeLessThan(
			diff.findIndex(
				(mutation) =>
					mutation.kind === "addModule" && mutation.module.uuid === newborn,
			),
		);
		assertRoundTrip(prev, next);
	});

	it("adds a new root before reparenting an existing module under it", () => {
		const prev = richDoc();
		const existing = prev.moduleOrder[0];
		const newRoot = testUuid("diff-new-root-parent");
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{
					kind: "addModule",
					module: { uuid: newRoot, id: "new_root", name: "New root" },
					after: null,
				},
				{
					kind: "moveModule",
					uuid: existing,
					parentModuleUuid: newRoot,
					after: null,
				},
			]);
		});
		const diff = diffDocsToMutations(prev, next);
		expect(
			diff.findIndex(
				(mutation) =>
					mutation.kind === "addModule" && mutation.module.uuid === newRoot,
			),
		).toBeLessThan(
			diff.findIndex(
				(mutation) =>
					mutation.kind === "moveModule" && mutation.uuid === existing,
			),
		);
		assertRoundTrip(prev, next);
	});

	it("lands a relocating sibling before a move that names it as final anchor", () => {
		const base = buildDoc({
			appName: "Relocation dependencies",
			modules: ["A", "B", "C", "X"].map((name) => ({
				name,
				forms: [
					{
						name: `${name} form`,
						type: "survey" as const,
						fields: [
							f({
								kind: "text",
								id: `${name.toLowerCase()}_question`,
								label: proseText(`${name} question`),
							}),
						],
					},
				],
			})),
		});
		const [parentA, siblingB, parentC, movingX] = base.moduleOrder;
		const prev = produce(base, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: movingX,
					parentModuleUuid: parentC,
					after: null,
				},
			]);
		});
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: siblingB,
					parentModuleUuid: parentA,
					after: null,
				},
				{
					kind: "moveModule",
					uuid: movingX,
					parentModuleUuid: parentA,
					after: siblingB,
				},
			]);
		});

		const diff = diffDocsToMutations(prev, next);
		const relocations = diff.filter(
			(mutation): mutation is Extract<Mutation, { kind: "moveModule" }> =>
				mutation.kind === "moveModule" &&
				Object.hasOwn(mutation, "parentModuleUuid"),
		);
		expect(relocations.map((mutation) => mutation.uuid)).toEqual([
			siblingB,
			movingX,
		]);
		expect(relocations[1]).toMatchObject({ after: siblingB });
		expect(mutationSequenceAdmissionIssue(prev, diff)).toBeUndefined();
		expect(mutationTargetsInvalid(prev, diff)).toBe(false);
		assertRoundTrip(prev, next);
	});

	it("evacuates a child before demoting its root when their final anchors cycle", () => {
		const base = buildDoc({
			appName: "Root demotion dependencies",
			modules: ["A", "B", "C"].map((name) => ({
				name,
				forms: [
					{
						name: `${name} form`,
						type: "survey" as const,
						fields: [
							f({
								kind: "text",
								id: `${name.toLowerCase()}_question`,
								label: proseText(`${name} question`),
							}),
						],
					},
				],
			})),
		});
		const [demotedRoot, oldChild, newParent] = base.moduleOrder;
		const prev = produce(base, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: oldChild,
					parentModuleUuid: demotedRoot,
					after: null,
				},
			]);
		});
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: oldChild,
					parentModuleUuid: newParent,
					after: null,
				},
				{
					kind: "moveModule",
					uuid: demotedRoot,
					parentModuleUuid: newParent,
					after: null,
				},
			]);
		});

		const diff = diffDocsToMutations(prev, next);
		const relocations = diff.filter(
			(mutation): mutation is Extract<Mutation, { kind: "moveModule" }> =>
				mutation.kind === "moveModule" &&
				Object.hasOwn(mutation, "parentModuleUuid"),
		);
		expect(relocations).toMatchObject([
			{ uuid: oldChild, parentModuleUuid: newParent, after: null },
			{ uuid: demotedRoot, parentModuleUuid: newParent, after: null },
		]);
		expect(mutationSequenceAdmissionIssue(prev, diff)).toBeUndefined();
		expect(mutationTargetsInvalid(prev, diff)).toBe(false);
		assertRoundTrip(prev, next);
	});

	it("removes all old children before demoting their surviving root", () => {
		const base = buildDoc({
			appName: "Demotion after removals",
			modules: ["A", "B", "C", "D"].map((name) => ({
				name,
				forms: [
					{
						name: `${name} form`,
						type: "survey" as const,
						fields: [
							f({
								kind: "text",
								id: `${name.toLowerCase()}_question`,
								label: proseText(`${name} question`),
							}),
						],
					},
				],
			})),
		});
		const [demotedRoot, childB, childC, newParent] = base.moduleOrder;
		const prev = produce(base, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: childB,
					parentModuleUuid: demotedRoot,
					after: null,
				},
				{
					kind: "moveModule",
					uuid: childC,
					parentModuleUuid: demotedRoot,
					after: childB,
				},
			]);
		});
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{ kind: "removeModule", uuid: childB },
				{ kind: "removeModule", uuid: childC },
				{
					kind: "moveModule",
					uuid: demotedRoot,
					parentModuleUuid: newParent,
					after: null,
				},
			]);
		});

		const diff = diffDocsToMutations(prev, next);
		const demotionAt = diff.findIndex(
			(mutation) =>
				mutation.kind === "moveModule" && mutation.uuid === demotedRoot,
		);
		for (const childUuid of [childB, childC]) {
			expect(
				diff.findIndex(
					(mutation) =>
						mutation.kind === "removeModule" && mutation.uuid === childUuid,
				),
			).toBeLessThan(demotionAt);
		}
		expect(mutationSequenceAdmissionIssue(prev, diff)).toBeUndefined();
		expect(mutationTargetsInvalid(prev, diff)).toBe(false);
		assertRoundTrip(prev, next);
	});

	it("removes and relocates mixed old children before demoting their root", () => {
		const base = buildDoc({
			appName: "Mixed demotion dependencies",
			modules: ["A", "B", "C", "D"].map((name) => ({
				name,
				forms: [
					{
						name: `${name} form`,
						type: "survey" as const,
						fields: [
							f({
								kind: "text",
								id: `${name.toLowerCase()}_question`,
								label: proseText(`${name} question`),
							}),
						],
					},
				],
			})),
		});
		const [demotedRoot, removedChild, relocatedChild, newParent] =
			base.moduleOrder;
		const prev = produce(base, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: removedChild,
					parentModuleUuid: demotedRoot,
					after: null,
				},
				{
					kind: "moveModule",
					uuid: relocatedChild,
					parentModuleUuid: demotedRoot,
					after: removedChild,
				},
			]);
		});
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{ kind: "removeModule", uuid: removedChild },
				{
					kind: "moveModule",
					uuid: relocatedChild,
					parentModuleUuid: newParent,
					after: null,
				},
				{
					kind: "moveModule",
					uuid: demotedRoot,
					parentModuleUuid: newParent,
					after: relocatedChild,
				},
			]);
		});

		const diff = diffDocsToMutations(prev, next);
		const removeAt = diff.findIndex(
			(mutation) =>
				mutation.kind === "removeModule" && mutation.uuid === removedChild,
		);
		const relocateAt = diff.findIndex(
			(mutation) =>
				mutation.kind === "moveModule" && mutation.uuid === relocatedChild,
		);
		const demotionAt = diff.findIndex(
			(mutation) =>
				mutation.kind === "moveModule" && mutation.uuid === demotedRoot,
		);
		expect(removeAt).toBeLessThan(demotionAt);
		expect(relocateAt).toBeLessThan(demotionAt);
		expect(mutationSequenceAdmissionIssue(prev, diff)).toBeUndefined();
		expect(mutationTargetsInvalid(prev, diff)).toBe(false);
		assertRoundTrip(prev, next);
	});

	it("removes children before their parent", () => {
		const roots = richDoc();
		const [parentUuid, childUuid] = roots.moduleOrder;
		const prev = produce(roots, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveModule",
					uuid: childUuid,
					parentModuleUuid: parentUuid,
					after: null,
				},
			]);
		});
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{ kind: "removeModule", uuid: childUuid },
				{ kind: "removeModule", uuid: parentUuid },
			]);
		});
		const removals = diffDocsToMutations(prev, next).filter(
			(mutation): mutation is Extract<Mutation, { kind: "removeModule" }> =>
				mutation.kind === "removeModule",
		);
		expect(removals.map((mutation) => mutation.uuid)).toEqual([
			childUuid,
			parentUuid,
		]);
		assertRoundTrip(prev, next);
	});

	it("app-level: name, connect type, logo, case types", () => {
		const prev = richDoc();
		const next = produce(prev, (draft) => {
			draft.appName = "Renamed";
			draft.connectType = "deliver";
			draft.logo = undefined;
			draft.caseTypes = [{ name: "only", properties: [] }];
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.some((m) => m.kind === "setAppName")).toBe(true);
		expect(diff.some((m) => m.kind === "setConnectType")).toBe(true);
		expect(diff.some((m) => m.kind === "setAppLogo" && m.logo === null)).toBe(
			true,
		);
		// The catalog change rides granular kinds (declare the new type, retire
		// the old).
		expect(
			diff.some((m) => m.kind === "declareCaseType" && m.caseType === "only"),
		).toBe(true);
		expect(diff.some((m) => m.kind === "retireCaseType")).toBe(true);
		assertRoundTrip(prev, next);
	});
});
