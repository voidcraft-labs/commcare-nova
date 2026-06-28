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
 * `prev` is one random valid mutation batch off a seed doc; `next` is
 * ANOTHER random batch off `prev`. The two batches independently exercise
 * every diffable shape — add/remove/rename/convert/update/move at module,
 * form, and field level, plus app-name / connect / logo / case-types /
 * media. Both batches go through the SAME reducer the oracle replays the
 * diff with, so any state the reducer can produce is fair game (including
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
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	parseXPathForField,
	parseXPathForForm,
} from "@/lib/doc/expressionText";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";

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
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "int", id: "q2", label: "Q2" }),
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
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age" },
					{ name: "village", label: "Village" },
				],
			},
			{ name: "household", properties: [{ name: "region", label: "Region" }] },
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
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "int",
								id: "age",
								label: "Age",
								case_property_on: "patient",
							}),
							f({
								kind: "group",
								id: "grp",
								label: "Group",
								children: [
									f({ kind: "text", id: "inner", label: "Inner" }),
									f({ kind: "text", id: "inner2", label: "Inner 2" }),
								],
							}),
							f({
								kind: "repeat",
								id: "rep",
								label: "Repeat",
								children: [f({ kind: "text", id: "rep_q", label: "Rep Q" })],
							}),
							f({ kind: "text", id: "outcome", label: "Outcome" }),
						],
					},
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
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
								label: "Region",
								case_property_on: "household",
							}),
						],
					},
				],
			},
		],
	});
	doc.logo = "asset-logo-1";
	// Attach message media to one field so the field-media diff branch fires.
	const ageField = Object.values(doc.fields).find((fld) => fld.id === "age");
	if (ageField) {
		(ageField as Record<string, unknown>).label_media = {
			image: "asset-img-1",
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
	"#case/age = '1'",
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
	| { kind: "renameField"; fieldPick: number; idPick: number }
	| { kind: "moveField"; fieldPick: number; parentPick: number; index: number }
	| { kind: "convertField"; fieldPick: number }
	| {
			kind: "updateField";
			fieldPick: number;
			relevantPick: number;
			labelPick: number;
	  }
	| { kind: "setFieldMedia"; fieldPick: number; clear: boolean }
	| { kind: "addForm"; modulePick: number; ftype: number }
	| { kind: "removeForm"; formPick: number }
	| { kind: "moveForm"; formPick: number; modulePick: number; index: number }
	| { kind: "renameForm"; formPick: number; namePick: number }
	| { kind: "updateForm"; formPick: number; purposePick: number }
	| { kind: "setFormMedia"; formPick: number; clear: boolean }
	| { kind: "addModule"; caseTypePick: number; namePick: number }
	| { kind: "removeModule"; modulePick: number }
	| { kind: "moveModule"; modulePick: number; index: number }
	| { kind: "renameModule"; modulePick: number; namePick: number }
	| { kind: "updateModule"; modulePick: number; caseTypePick: number }
	| { kind: "setModuleMedia"; modulePick: number; clear: boolean }
	| { kind: "setCaseTypes"; drop: boolean }
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
			.map((r) => ({ kind: "renameField" as const, ...r })),
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
			.record({ formPick: fc.nat({ max: 8 }), purposePick: fc.nat({ max: 3 }) })
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
			.map((r) => ({ kind: "setCaseTypes" as const, ...r })),
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
			const field = op.asGroup
				? ({
						uuid: mintUuid(),
						kind: "group",
						id: ID_POOL[op.idPick],
						label: "Group",
					} as never)
				: ({
						uuid: mintUuid(),
						kind: "text",
						id: ID_POOL[op.idPick],
						label: LABEL_POOL[op.labelPick],
						relevant: parseXPathForForm(
							doc,
							formUuid,
							XPATH_POOL[op.relevantPick],
						),
						...(caseProp && { case_property_on: caseProp }),
					} as never);
			return [{ kind: "addField", parentUuid, field }];
		}
		case "removeField": {
			const uuid = pickField(doc, op.fieldPick);
			return uuid ? [{ kind: "removeField", uuid }] : [];
		}
		case "renameField": {
			const uuid = pickField(doc, op.fieldPick);
			return uuid
				? [{ kind: "renameField", uuid, newId: ID_POOL[op.idPick] }]
				: [];
		}
		case "moveField": {
			const uuid = pickField(doc, op.fieldPick);
			const toParentUuid = pickParent(doc, op.parentPick);
			if (!uuid || !toParentUuid) return [];
			return [{ kind: "moveField", uuid, toParentUuid, toIndex: op.index }];
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
						label: LABEL_POOL[op.labelPick],
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
					media: op.clear ? null : { image: `asset-${mintUuid()}` },
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
			return [{ kind: "moveForm", uuid, toModuleUuid, toIndex: op.index }];
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
			const purpose = PURPOSE_POOL[op.purposePick];
			return [
				{
					kind: "updateForm",
					uuid,
					patch: purpose === "" ? {} : { purpose },
				},
			];
		}
		case "setFormMedia": {
			const uuid = pickForm(doc, op.formPick);
			if (!uuid) return [];
			return [
				{
					kind: "setFormMedia",
					uuid,
					icon: op.clear ? null : (`asset-${mintUuid()}` as never),
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
			return uuid ? [{ kind: "moveModule", uuid, toIndex: op.index }] : [];
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
					icon: op.clear ? null : (`asset-${mintUuid()}` as never),
					audioLabel: null,
				},
			];
		}
		case "setCaseTypes":
			return [
				{
					kind: "setCaseTypes",
					caseTypes: op.drop
						? null
						: [
								{
									name: "patient",
									properties: [{ name: "case_name", label: "N" }],
								},
							],
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
					logo: op.clear ? null : (`asset-${mintUuid()}` as never),
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

/** The diff replayed on `prev` must equal `next` on the persistable shape. */
function assertRoundTrip(prev: BlueprintDoc, next: BlueprintDoc): void {
	const diff = diffDocsToMutations(prev, next);
	const replayed = produce(prev, (draft) => {
		applyMutations(draft, diff);
	});
	expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
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
	});

	it("returns [] when prev deep-equals next", () => {
		const doc = richDoc();
		const clone = produce(doc, () => {});
		expect(diffDocsToMutations(doc, clone)).toEqual([]);
	});
});

// ── Explicit unit cases ───────────────────────────────────────────────

describe("diffDocsToMutations — explicit cases", () => {
	it("pure rename of a field (id rides updateField, no cascade)", () => {
		const prev = singleModuleDoc();
		const next = produce(prev, (draft) => {
			const target = Object.values(draft.fields).find((fld) => fld.id === "q1");
			if (target) target.id = "q1_renamed";
		});
		const diff = diffDocsToMutations(prev, next);
		// Field id is reconciled through the updateField patch (cascade-free),
		// not renameField — see diffDocsToMutations' field-update note.
		expect(
			diff.some(
				(m) =>
					m.kind === "updateField" &&
					(m.patch as { id?: string }).id === "q1_renamed",
			),
		).toBe(true);
		expect(diff.some((m) => m.kind === "renameField")).toBe(false);
		assertRoundTrip(prev, next);
	});

	it("pure field reorder within a form", () => {
		const prev = singleModuleDoc();
		const formUuid = prev.moduleOrder
			.flatMap((m) => prev.formOrder[m] ?? [])
			.at(0);
		const next = produce(prev, (draft) => {
			if (formUuid)
				draft.fieldOrder[formUuid] = [
					...(draft.fieldOrder[formUuid] ?? []),
				].reverse();
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff.some((m) => m.kind === "moveField")).toBe(true);
		assertRoundTrip(prev, next);
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
									label: "Password",
									hint: "secret",
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
				(target as Record<string, unknown>).label = "PIN";
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
				(target as Record<string, unknown>).label_media = { image: "a1" };
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
								f({ kind: "text", id: "loose", label: "Loose" }),
								f({
									kind: "group",
									id: "g",
									label: "Group",
									children: [f({ kind: "text", id: "child", label: "Child" })],
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
								f({ kind: "text", id: "a", label: "A" }),
								f({
									kind: "group",
									id: "grp",
									label: "G",
									children: [f({ kind: "text", id: "b", label: "B" })],
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
		expect(diff.some((m) => m.kind === "setCaseTypes")).toBe(true);
		assertRoundTrip(prev, next);
	});
});
