/**
 * Independent admitted endpoints are the oracle: the generator constructs two
 * stored documents directly, then the real diff, JSON parser and commit gate
 * must reproduce the target exactly. It does not derive the target through the
 * same reducer used for replay. Fixed identities make fast-check replayable.
 */
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { mutationSequenceAdmissionIssue } from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

function emptyDoc(): BlueprintDoc {
	return buildDoc({ appName: "Empty" });
}
function singleModuleDoc(): BlueprintDoc {
	const doc = buildDoc({
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
	assertAdmittedDoc(doc);
	return doc;
}
function richDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Rich Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "village", label: proseText("Village"), data_type: "text" },
				],
			},
			{
				name: "household",
				properties: [
					{ name: "region", label: proseText("Region"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("rich-patient-column"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "int",
								id: "age",
								caseWrite: { caseType: "patient", property: "age" },
								label_media: { image: testMediaAssetId("rich-image") },
							}),
							f({
								kind: "group",
								id: "grp",
								children: [
									f({ kind: "text", id: "inner" }),
									f({ kind: "text", id: "inner2" }),
								],
							}),
							f({
								kind: "repeat",
								id: "rep",
								children: [f({ kind: "text", id: "rep_q" })],
							}),
							f({ kind: "text", id: "outcome" }),
						],
					},
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "village",
								caseWrite: { caseType: "patient", property: "village" },
							}),
						],
					},
				],
			},
			{
				name: "Households",
				caseType: "household",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("rich-household-column"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "region",
								caseWrite: { caseType: "household", property: "region" },
							}),
						],
					},
				],
			},
			{
				name: "Survey",
				forms: [
					{
						name: "Notes",
						type: "survey",
						fields: [f({ kind: "text", id: "notes" })],
					},
				],
			},
		],
	});
	doc.logo = testMediaAssetId("rich-logo");
	assertAdmittedDoc(doc);
	return doc;
}

function assertRoundTrip(prevRaw: BlueprintDoc, nextRaw: BlueprintDoc): void {
	// Only rebuild derived state. The strict stored schemas and domain gate
	// below refuse malformed or inadmissible authoring contents without repair.
	const prev = hydratePersistedBlueprint(
		blueprintDocSchema.parse(toPersistableDoc(prevRaw)),
	);
	const next = hydratePersistedBlueprint(
		blueprintDocSchema.parse(toPersistableDoc(nextRaw)),
	);
	if (prev.moduleOrder.length > 0) assertAdmittedDoc(prev);
	assertAdmittedDoc(next);
	const diff = diffDocsToMutations(prev, next);
	const wire: unknown = JSON.parse(JSON.stringify(diff));
	if (!Array.isArray(wire)) throw new Error("diff must be an array");
	const reparsed = wire.map((mutation) => mutationSchema.parse(mutation));
	const verdict = mutationCommitVerdict(
		prev,
		reparsed,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok, JSON.stringify(verdict.ok ? [] : verdict.findings)).toBe(
		true,
	);
	expect(toPersistableDoc(verdict.nextDoc)).toEqual(toPersistableDoc(next));
}
function reverseDisplayOrder(doc: BlueprintDoc, formUuid: Uuid): void {
	doc.fieldOrder[formUuid] = [...orderedFieldUuids(doc, formUuid)].reverse();
}
function completeModule(
	uuid: Uuid,
	id: string,
	name: string,
	parentModuleUuid?: Uuid,
): Mutation[] {
	const formUuid = testUuid(`${uuid}-form`);
	return [
		{
			kind: "addModule",
			module: {
				uuid,
				id,
				name,
				...(parentModuleUuid === undefined ? {} : { parentModuleUuid }),
			},
			after: null,
		},
		{
			kind: "addForm",
			moduleUuid: uuid,
			form: {
				uuid: formUuid,
				id: `${id}_form`,
				name: `${name} form`,
				type: "survey",
			},
		},
		{
			kind: "addField",
			parentUuid: formUuid,
			field: {
				uuid: testUuid(`${uuid}-field`),
				id: "question",
				kind: "text",
				label: proseText("Question"),
			},
		},
	];
}

const endpointArb = fc.record({
	modules: fc.integer({ min: 1, max: 7 }),
	forms: fc.integer({ min: 0, max: 7 }),
	owners: fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.nat({ max: 2 })),
	reverse: fc.boolean(),
	nested: fc.boolean(),
	group: fc.boolean(),
	grouped: fc.boolean(),
	optional: fc.boolean(),
	secret: fc.boolean(),
	decimal: fc.boolean(),
	media: fc.boolean(),
	extraOption: fc.boolean(),
	text: fc.nat({ max: 2 }),
	// Each form's query repeat: absent, present and unheld, or holding one of
	// the two placements a query over no answer can express.
	queryRepeat: fc.constantFrom("absent", "unheld", "model-iteration", "count"),
});

/** Open patients: a query that reads no answer of the form, so either
 *  placement expresses the repeat. */
const OPEN_PATIENTS = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("patient", "case_name"), literal("open"))],
	},
	value: prop("patient", "case_id"),
} as const;
type Endpoint = typeof endpointArb extends fc.Arbitrary<infer T> ? T : never;
function endpoint(spec: Endpoint): BlueprintDoc {
	const indices = [0, 1, 2].filter(
		(index) => (spec.modules & (1 << index)) !== 0,
	);
	if (spec.reverse) indices.reverse();
	const formIndices = [0, 1, 2].filter(
		(index) => (spec.forms & (1 << index)) !== 0,
	);
	if (spec.reverse) formIndices.reverse();
	const doc = buildDoc({
		appId: "independent-diff",
		appName: `App ${spec.text}`,
		caseTypes: [{ name: "patient", properties: [] }],
		modules: indices.map((index, position) => {
			const forms = formIndices
				.filter(
					(formIndex) =>
						indices[spec.owners[formIndex] % indices.length] === index,
				)
				.map((formIndex) => {
					const key = `independent-form-${formIndex}`;
					const optional = f({
						uuid: testUuid(`${key}-optional`),
						kind: spec.secret ? "secret" : "text",
						id: "optional",
						label: proseText(`Optional ${spec.text}`),
					});
					const group = f({
						uuid: testUuid(`${key}-group`),
						kind: "group",
						id: "group",
						children: spec.optional && spec.grouped ? [optional] : [],
					});
					const fields = [
						f({
							uuid: testUuid(`${key}-base`),
							kind: "text",
							id: "base",
							label: proseText(`Base ${spec.text}`),
							...(spec.media
								? {
										label_media: {
											image: testMediaAssetId("independent-label"),
										},
									}
								: {}),
						}),
						f({
							uuid: testUuid(`${key}-number`),
							kind: spec.decimal ? "decimal" : "int",
							id: "number",
							label: proseText("Number"),
						}),
						f({
							uuid: testUuid(`${key}-select`),
							kind: "single_select",
							id: "select",
							optionsSource: {
								kind: "inline",
								options: [0, 1, ...(spec.extraOption ? [2] : [])].map(
									(option) => ({
										uuid: testUuid(`${key}-option-${option}`),
										value: `value_${option}`,
										label: proseText(`Option ${option} ${spec.text}`),
									}),
								),
							},
						}),
						...(spec.group ? [group] : []),
						...(spec.optional && (!spec.group || !spec.grouped)
							? [optional]
							: []),
						...(spec.queryRepeat === "absent"
							? []
							: [
									f({
										uuid: testUuid(`${key}-visits`),
										kind: "repeat",
										id: "visits",
										label: proseText("Visits"),
										repeat_mode: "query_bound",
										data_source: { ids_query: OPEN_PATIENTS },
										...(spec.queryRepeat === "unheld"
											? {}
											: { placement: spec.queryRepeat }),
										children: [
											f({
												uuid: testUuid(`${key}-visit-note`),
												kind: "text",
												id: "visit_note",
												label: proseText("Visit note"),
											}),
										],
									}),
								]),
					];
					if (spec.reverse) fields.reverse();
					return {
						uuid: testUuid(key),
						id: `form_${formIndex}`,
						name: `Form ${formIndex} ${spec.text}`,
						type: "followup" as const,
						...(spec.optional ? { purpose: "Notes" } : {}),
						fields,
					};
				});
			return {
				uuid: testUuid(`independent-module-${index}`),
				id: `module_${index}`,
				name: `Module ${index} ${spec.text}`,
				caseType: "patient",
				...(forms.length === 0 ? { caseListMenuItem: {} } : {}),
				...(spec.nested && position === indices.length - 1 && position > 0
					? { parentModuleUuid: testUuid(`independent-module-${indices[0]}`) }
					: {}),
				caseListConfig: {
					columns: [
						plainColumn(
							testUuid(`independent-column-${index}`),
							"case_name",
							"Name",
						),
					],
					searchInputs: [],
				},
				forms,
			};
		}),
	});
	if (spec.media) doc.logo = testMediaAssetId("independent-logo");
	return doc;
}

describe("diff of independent admitted stored endpoints", () => {
	it("orders new forms after a retained form evacuated into a newly born module", () => {
		const common: Endpoint = {
			modules: 4,
			forms: 1,
			owners: [0, 0, 0],
			reverse: false,
			nested: false,
			group: false,
			grouped: false,
			optional: false,
			secret: false,
			decimal: false,
			media: false,
			extraOption: false,
			text: 0,
			queryRepeat: "absent",
		};
		assertRoundTrip(
			endpoint(common),
			endpoint({ ...common, modules: 1, forms: 3 }),
		);
	});

	it("diffs documents that differ only in a hold to one holdPlacements and replays to the target", () => {
		const common: Endpoint = {
			modules: 1,
			forms: 3,
			owners: [0, 0, 0],
			reverse: false,
			nested: false,
			group: false,
			grouped: false,
			optional: false,
			secret: false,
			decimal: false,
			media: false,
			extraOption: false,
			text: 0,
			queryRepeat: "model-iteration",
		};
		for (const [from, to] of [
			["model-iteration", "count"],
			["count", "unheld"],
			["unheld", "model-iteration"],
		] as const) {
			const prev = endpoint({ ...common, queryRepeat: from });
			const next = endpoint({ ...common, queryRepeat: to });
			const diff = diffDocsToMutations(prev, next);
			expect(diff).toEqual([
				{
					kind: "holdPlacements",
					holds: [0, 1].map((form) => ({
						target: "query-repeat",
						fieldUuid: testUuid(`independent-form-${form}-visits`),
						placement: to === "unheld" ? null : to,
					})),
				},
			]);
			assertRoundTrip(prev, next);
		}
	});

	it("replays arbitrary structural, ordering, scalar, option and media changes through JSON and the real gate", async () => {
		await fc.assert(
			fc.property(endpointArb, endpointArb, (a, b) => {
				assertRoundTrip(endpoint(a), endpoint(b));
			}),
			{ numRuns: 200, seed: 20260628 },
		);
	}, 60_000);
	it("returns no edits for independently cloned equal documents", () => {
		const doc = richDoc();
		const clone = structuredClone(doc);
		expect(clone).not.toBe(doc);
		expect(diffDocsToMutations(doc, clone)).toEqual([]);
	});
});

// ── Explicit unit cases ───────────────────────────────────────────────

describe("diffDocsToMutations — explicit cases", () => {
	it("adds a field beside a field moved into the same container", () => {
		const prev = richDoc();
		const group = Object.values(prev.fields).find(
			(field) => field.id === "grp",
		);
		const outcome = Object.values(prev.fields).find(
			(field) => field.id === "outcome",
		);
		if (group === undefined || outcome === undefined)
			throw new Error("fixture targets missing");
		const next = produce(prev, (draft) => {
			applyMutations(draft, [
				{
					kind: "moveField",
					uuid: outcome.uuid,
					toParentUuid: group.uuid,
					after: null,
				},
				{
					kind: "addField",
					parentUuid: group.uuid,
					after: outcome.uuid,
					field: {
						uuid: testUuid("beside-moved"),
						id: "beside",
						kind: "text",
						label: proseText("Beside"),
					},
				},
			]);
		});
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
					caseListConfig: {
						columns: [
							plainColumn(testUuid("non-catalog-column"), "case_name", "Name"),
						],
						searchInputs: [],
					},
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

	it.each(["datetime", "text"] as const)(
		"replays a %s question with media becoming a hidden value, and back",
		(kind) => {
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
										kind,
										uuid: testUuid("media-drop-subject"),
										id: "subject",
										label: proseText("Subject"),
										label_media: { image: testMediaAssetId("drop-image") },
										help: proseText("Help"),
										help_media: { audio: testMediaAssetId("drop-audio") },
									}),
								],
							},
						],
					},
				],
			});
			const next = produce(prev, (draft) => {
				draft.fields[testUuid("media-drop-subject")] = {
					uuid: testUuid("media-drop-subject"),
					id: "subject",
					kind: "hidden",
					calculate: { kind: "today" },
				};
			});
			// The convert drops the slots a hidden value lacks, so the diff sends no
			// media clear the gate would refuse on them.
			expect(
				diffDocsToMutations(prev, next).filter(
					(mutation) => mutation.kind === "setFieldMedia",
				),
			).toEqual([]);
			assertRoundTrip(prev, next);
			// Undo's direction: the hidden value back to the question, with its
			// label seeded on the convert and its media set after it.
			assertRoundTrip(next, prev);
		},
	);

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
					forms: [
						{
							name: "Reg",
							type: "survey",
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
				...completeModule(newborn, "newborn", "Newborn", promotedParent),
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
				...completeModule(newRoot, "new_root", "New root"),
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

	it("diffs app name, logo clear and an unrelated catalog declaration", () => {
		const prev = richDoc();
		const next = produce(prev, (draft) => {
			draft.appName = "Renamed";
			delete draft.logo;
			draft.caseTypes?.push({ name: "independent", properties: [] });
		});
		expect(diffDocsToMutations(prev, next)).toEqual(
			expect.arrayContaining([
				{ kind: "setAppName", name: "Renamed" },
				{ kind: "setAppLogo", logo: null },
				{ kind: "declareCaseType", caseType: "independent" },
			]),
		);
		assertRoundTrip(prev, next);
	});

	it("diffs two documents that differ only in app settings to one setAppSettings", () => {
		const prev = richDoc();
		const next = produce(prev, (draft) => {
			draft.appSettings.showIncompleteForms = true;
		});
		expect(diffDocsToMutations(prev, next)).toEqual([
			{ kind: "setAppSettings", settings: { showIncompleteForms: true } },
		]);
		assertRoundTrip(prev, next);
	});

	it("diffs a declaration change to one setAppSettings naming only runsOnlyOn, a clear as null", () => {
		const both = produce(richDoc(), (draft) => {
			delete draft.appSettings.runsOnlyOn;
		});
		const android = produce(both, (draft) => {
			draft.appSettings.runsOnlyOn = "android";
		});
		expect(diffDocsToMutations(both, android)).toEqual([
			{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } },
		]);
		assertRoundTrip(both, android);
		expect(diffDocsToMutations(android, both)).toEqual([
			{ kind: "setAppSettings", settings: { runsOnlyOn: null } },
		]);
		assertRoundTrip(android, both);
	});
});

/* Two admitted endpoints that differ in the form's own case, a keyed write
 * through `via`, or the open and close conditions diff to the payloads
 * autosave carries (part 01 §16.1), and the replay through JSON and the gate
 * lands the target. Catches autosave dropping a keyed write or a condition. */
describe("diffDocsToMutations — the own case, keyed writes and conditions", () => {
	const MODULE = testUuid("diff-own-module");
	const REG = testUuid("diff-own-registration");
	const FUP = testUuid("diff-own-followup");
	const CLS = testUuid("diff-own-close");
	const SURVEY = testUuid("diff-own-survey");
	const REG_NAME = testUuid("diff-own-reg-name");
	const REG_FLAG = testUuid("diff-own-reg-flag");
	const FUP_NOTE = testUuid("diff-own-fup-note");
	const CLS_NOTE = testUuid("diff-own-cls-note");
	const SURVEY_Q = testUuid("diff-own-survey-q");
	const OWN_REG = testUuid("diff-own-arm-registration");
	const OWN_FUP = testUuid("diff-own-arm-followup");
	const OWN_CLS = testUuid("diff-own-arm-close");
	const OWN_SURVEY = testUuid("diff-own-arm-survey");
	const answerOf = (uuid: Uuid) => ({
		kind: "term" as const,
		term: { kind: "field" as const, uuid },
	});
	const answered = (uuid: Uuid, value: string) => ({
		kind: "eq" as const,
		left: answerOf(uuid),
		right: { kind: "term" as const, term: { kind: "literal" as const, value } },
	});
	const viaParent: [{ identifier: string }] = [{ identifier: "parent" }];

	function ownDoc(): BlueprintDoc {
		const doc = buildDoc(
			{
				appName: "Own cases",
				caseTypes: [
					{
						name: "household",
						properties: [
							{ name: "note", label: proseText("Note"), data_type: "text" },
						],
					},
					{
						name: "patient",
						parent_type: "household",
						relationship: "child",
						properties: [
							{ name: "note", label: proseText("Note"), data_type: "text" },
						],
					},
				],
				modules: [
					{
						uuid: MODULE,
						name: "Patients",
						caseType: "patient",
						caseListConfig: {
							columns: [
								plainColumn(testUuid("diff-own-column"), "case_name", "Name"),
							],
							searchInputs: [],
						},
						forms: [
							{
								uuid: REG,
								name: "Register",
								type: "registration",
								fields: [
									f({ uuid: REG_NAME, kind: "text", id: "case_name" }),
									f({ uuid: REG_FLAG, kind: "text", id: "flag" }),
								],
							},
							{
								uuid: FUP,
								name: "Visit",
								type: "followup",
								fields: [f({ uuid: FUP_NOTE, kind: "text", id: "note" })],
							},
							{
								uuid: CLS,
								name: "Discharge",
								type: "close",
								fields: [f({ uuid: CLS_NOTE, kind: "text", id: "note" })],
							},
							{
								uuid: SURVEY,
								name: "Survey",
								type: "survey",
								fields: [f({ uuid: SURVEY_Q, kind: "text", id: "q" })],
							},
						],
					},
				],
			},
			(draft) => {
				draft.forms[REG].caseOperations = [
					{
						uuid: OWN_REG,
						id: "patient",
						action: "own",
						name: answerOf(REG_NAME),
					},
				];
				draft.forms[FUP].caseOperations = [
					{
						uuid: OWN_FUP,
						id: "patient",
						action: "own",
						writes: [{ property: "note", value: answerOf(FUP_NOTE) }],
					},
				];
				draft.forms[CLS].caseOperations = [
					{ uuid: OWN_CLS, id: "patient", action: "own" },
				];
			},
		);
		assertAdmittedDoc(doc);
		return doc;
	}

	it("diffs an own case born with the form's type into the type patch and an own add", () => {
		const prev = ownDoc();
		const next = produce(prev, (draft) => {
			draft.forms[SURVEY].type = "followup";
			draft.forms[SURVEY].caseOperations = [
				{ uuid: OWN_SURVEY, id: "patient", action: "own" },
			];
		});
		expect(diffDocsToMutations(prev, next)).toEqual(
			expect.arrayContaining([
				{ kind: "updateForm", uuid: SURVEY, patch: { type: "followup" } },
				{
					kind: "updateForm",
					uuid: SURVEY,
					patch: {},
					caseOperationChange: {
						operation: "add",
						value: { uuid: OWN_SURVEY, id: "patient", action: "own" },
					},
				},
			]),
		);
		assertRoundTrip(prev, next);
		assertRoundTrip(next, prev);
	});

	it("diffs the own case's name and owner into one own patch", () => {
		const prev = ownDoc();
		const next = produce(prev, (draft) => {
			const own = draft.forms[REG].caseOperations?.[0];
			if (own?.action !== "own") throw new Error("fixture own case missing");
			own.name = answerOf(REG_FLAG);
			own.owner = { kind: "term", term: { kind: "literal", value: "team" } };
		});
		expect(diffDocsToMutations(prev, next)).toEqual([
			{
				kind: "updateForm",
				uuid: REG,
				patch: {},
				caseOperationPatch: {
					operation: "update",
					uuid: OWN_REG,
					targetAction: "own",
					patch: {
						name: answerOf(REG_FLAG),
						owner: { kind: "term", term: { kind: "literal", value: "team" } },
					},
				},
			},
		]);
		assertRoundTrip(prev, next);
		assertRoundTrip(next, prev);
	});

	it("diffs a write through via as its own key, beside the write of the same property", () => {
		const prev = ownDoc();
		const next = produce(prev, (draft) => {
			const own = draft.forms[FUP].caseOperations?.[0];
			if (own === undefined) throw new Error("fixture own case missing");
			own.writes = [
				{ property: "note", value: answerOf(FUP_NOTE), via: viaParent },
				{ property: "note", value: answerOf(FUP_NOTE), onlyIfChanged: true },
			];
		});
		const diff = diffDocsToMutations(prev, next);
		expect(diff).toEqual(
			expect.arrayContaining([
				{
					kind: "updateForm",
					uuid: FUP,
					patch: {},
					caseOperationPatch: {
						operation: "add-write",
						uuid: OWN_FUP,
						value: {
							property: "note",
							value: answerOf(FUP_NOTE),
							via: viaParent,
						},
						after: null,
					},
				},
				{
					kind: "updateForm",
					uuid: FUP,
					patch: {},
					caseOperationPatch: {
						operation: "update-write",
						uuid: OWN_FUP,
						key: { property: "note" },
						patch: { onlyIfChanged: true },
					},
				},
			]),
		);
		assertRoundTrip(prev, next);
		assertRoundTrip(next, prev);
	});

	it("diffs the open and close conditions into the form patch, a clear as null", () => {
		const prev = ownDoc();
		const next = produce(prev, (draft) => {
			draft.forms[REG].openCondition = answered(REG_FLAG, "yes");
			draft.forms[REG].closeCondition = answered(REG_FLAG, "gone");
			draft.forms[CLS].closeCondition = answered(CLS_NOTE, "done");
		});
		expect(diffDocsToMutations(prev, next)).toEqual(
			expect.arrayContaining([
				{
					kind: "updateForm",
					uuid: REG,
					patch: {
						openCondition: answered(REG_FLAG, "yes"),
						closeCondition: answered(REG_FLAG, "gone"),
					},
				},
				{
					kind: "updateForm",
					uuid: CLS,
					patch: { closeCondition: answered(CLS_NOTE, "done") },
				},
			]),
		);
		assertRoundTrip(prev, next);
		expect(diffDocsToMutations(next, prev)).toEqual(
			expect.arrayContaining([
				{
					kind: "updateForm",
					uuid: REG,
					patch: { openCondition: null, closeCondition: null },
				},
				{ kind: "updateForm", uuid: CLS, patch: { closeCondition: null } },
			]),
		);
		assertRoundTrip(next, prev);
	});

	it("carries a held placement only in the trailing holdPlacements", () => {
		const prev = ownDoc();
		const next = produce(prev, (draft) => {
			draft.forms[SURVEY].type = "close";
			draft.forms[SURVEY].caseOperations = [
				{
					uuid: OWN_SURVEY,
					id: "patient",
					action: "own",
					placement: { kind: "basic", slot: "own" },
				},
			];
			draft.forms[CLS].ownClosePlacement = {
				kind: "save-to-case",
				path: ["nova_operations", "patient"],
			};
		});
		const diff = diffDocsToMutations(prev, next);
		const structural = JSON.stringify(
			diff.filter((mutation) => mutation.kind !== "holdPlacements"),
		);
		expect(structural).not.toContain("placement");
		expect(structural).not.toContain("ownClosePlacement");
		// The holds travel in the one trailing `holdPlacements`.
		expect(diff.filter((m) => m.kind === "holdPlacements")).toEqual([
			diff.at(-1),
		]);
		expect(diff.at(-1)).toEqual({
			kind: "holdPlacements",
			// Document order: the Discharge form precedes the Survey form.
			holds: [
				{
					target: "own-close",
					formUuid: CLS,
					placement: {
						kind: "save-to-case",
						path: ["nova_operations", "patient"],
					},
				},
				{
					target: "case-operation",
					formUuid: SURVEY,
					operationUuid: OWN_SURVEY,
					placement: { kind: "basic", slot: "own" },
				},
			],
		});
	});
});
