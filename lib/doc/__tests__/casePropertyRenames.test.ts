import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	CasePropertyRenamePlanError,
	type RenameCasePropertiesMutation,
} from "@/lib/doc/casePropertyRenames";
import {
	CasePropertySemanticProvenanceRequiredError,
	diffDocsToMutations,
} from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import {
	buildReferenceIndex,
	referencingSlotsOf,
} from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	casePropertyTargetKey,
	collectTranslationUnits,
	emptyCaseListConfig,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const FORM = testUuid("20000000-0000-4000-8000-000000000000");
const FIELD_A = testUuid("30000000-0000-4000-8000-000000000001");
const FIELD_B = testUuid("30000000-0000-4000-8000-000000000002");
const FIELD_NEW = testUuid("30000000-0000-4000-8000-000000000003");
const OPERATION = testUuid("40000000-0000-4000-8000-000000000000");

function fixture(): BlueprintDoc {
	return {
		appId: "app",
		appName: "App",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: ["a", "b", "c"].map((name) => ({
					name,
					label: proseText(name.toUpperCase()),
					data_type: "text" as const,
				})),
			},
		],
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "edit_patient",
				name: "Edit patient",
				type: "followup",
				caseOperations: [
					{
						uuid: OPERATION,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [{ property: "a", value: term(literal("value")) }],
					},
				],
			},
		},
		fields: {
			[FIELD_A]: {
				uuid: FIELD_A,
				id: "question_a",
				kind: "text",
				label: proseText("A"),
				caseWrite: { caseType: "patient", property: "a" },
			},
			[FIELD_B]: {
				uuid: FIELD_B,
				id: "question_b",
				kind: "text",
				label: proseText("B"),
				caseWrite: { caseType: "patient", property: "b" },
			},
		},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD_A, FIELD_B] },
		fieldParent: { [FIELD_A]: FORM, [FIELD_B]: FORM },
	};
}

function catalogOnlyFixture(): BlueprintDoc {
	const doc = fixture();
	return {
		...doc,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

function rename(
	...renames: RenameCasePropertiesMutation["renames"]
): RenameCasePropertiesMutation {
	return { kind: "renameCaseProperties", renames };
}

function admittedRename(
	...renames: RenameCasePropertiesMutation["renames"]
): AdmittedMutationBatch {
	return admitMutationBatch([rename(...renames)]);
}

function apply(
	doc: BlueprintDoc,
	mutations: readonly Mutation[] | AdmittedMutationBatch,
): BlueprintDoc {
	const admitted = admitMutationBatch(mutations);
	return produce(doc, (draft) => {
		applyMutations(draft, admitted);
	});
}

function caseWriteProperty(
	doc: BlueprintDoc,
	fieldUuid: typeof FIELD_A | typeof FIELD_B,
): string | undefined {
	const field = doc.fields[fieldUuid];
	return field !== undefined && "caseWrite" in field
		? field.caseWrite?.property
		: undefined;
}

function expectRoundTrip(prev: BlueprintDoc, next: BlueprintDoc): Mutation[] {
	const mutations = diffDocsToMutations(prev, next);
	expect(toPersistableDoc(apply(prev, mutations))).toEqual(
		toPersistableDoc(next),
	);
	return mutations;
}

describe("explicit app-wide case-property rename", () => {
	it("rewrites target prose tokens and keeps a current translation current", () => {
		const start = fixture();
		const field = start.fields[FIELD_A];
		expect(field.kind).toBe("text");
		if (field.kind !== "text") return;
		field.label = {
			parts: [
				{ kind: "text", text: "Current " },
				{ kind: "case-ref", caseType: "patient", property: "a" },
			],
		};
		const beforeUnit = collectTranslationUnits(start).find(
			(unit) => unit.owner.kind === "field" && unit.owner.fieldUuid === FIELD_A,
		);
		expect(beforeUnit).toBeDefined();
		if (beforeUnit === undefined) return;
		start.localization = {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "Español", direction: "ltr" },
			},
			translations: {
				es: {
					[beforeUnit.id]: {
						value: {
							parts: [
								{ kind: "case-ref", caseType: "patient", property: "a" },
								{ kind: "text", text: " actual" },
							],
						},
						sourceFingerprint: beforeUnit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		};

		const renamed = apply(
			start,
			admittedRename({ caseType: "patient", from: "a", to: "fresh" }),
		);
		const afterUnit = collectTranslationUnits(renamed).find(
			(unit) => unit.id === beforeUnit.id,
		);
		expect(afterUnit).toBeDefined();
		const entry = renamed.localization?.translations.es?.[beforeUnit.id];
		expect(entry?.sourceFingerprint).toBe(afterUnit?.sourceFingerprint);
		expect(entry?.value).toMatchObject({
			parts: [
				{ kind: "case-ref", caseType: "patient", property: "fresh" },
				{ kind: "text", text: " actual" },
			],
		});
	});

	it("preserves every translated option through a simultaneous property swap", () => {
		const start = fixture();
		const patient = start.caseTypes?.[0];
		if (patient === undefined) throw new Error("missing patient type");
		for (const property of patient.properties) {
			if (property.name !== "a" && property.name !== "b") continue;
			property.data_type = "single_select";
			property.options = [
				{
					value: "yes",
					label: proseText(`Yes for ${property.name}`),
				},
			];
		}
		const columnA = plainColumn(testUuid("translated-swap-column-a"), "a", "A");
		const columnB = plainColumn(testUuid("translated-swap-column-b"), "b", "B");
		start.modules[MODULE].caseListConfig = {
			...emptyCaseListConfig(),
			columns: [columnA, columnB],
			listColumnOrder: [columnA.uuid, columnB.uuid],
			detailColumnOrder: [columnA.uuid, columnB.uuid],
		};
		const beforeUnits = collectTranslationUnits(start);
		const optionUnit = (property: string) =>
			beforeUnits.find(
				(unit) =>
					unit.owner.kind === "case-property-option" &&
					unit.owner.caseType === "patient" &&
					unit.owner.property === property &&
					unit.owner.value === "yes",
			);
		const beforeA = optionUnit("a");
		const beforeB = optionUnit("b");
		if (beforeA === undefined || beforeB === undefined) {
			throw new Error("missing option translation units");
		}
		start.localization = {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "Español", direction: "ltr" },
			},
			translations: {
				es: {
					[beforeA.id]: {
						value: proseText("Sí para A"),
						sourceFingerprint: beforeA.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
					[beforeB.id]: {
						value: proseText("Sí para B"),
						sourceFingerprint: beforeB.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		};

		const swapped = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "a" },
			),
		);
		const afterUnits = collectTranslationUnits(swapped);
		const afterOptionUnit = (property: string) =>
			afterUnits.find(
				(unit) =>
					unit.owner.kind === "case-property-option" &&
					unit.owner.caseType === "patient" &&
					unit.owner.property === property &&
					unit.owner.value === "yes",
			);
		const afterA = afterOptionUnit("a");
		const afterB = afterOptionUnit("b");
		if (afterA === undefined || afterB === undefined) {
			throw new Error("missing renamed option translation units");
		}
		const translations = swapped.localization?.translations.es;
		expect(Object.keys(translations ?? {})).toHaveLength(2);
		expect(translations?.[afterB.id]).toMatchObject({
			value: proseText("Sí para A"),
			sourceFingerprint: afterB.sourceFingerprint,
		});
		expect(translations?.[afterA.id]).toMatchObject({
			value: proseText("Sí para B"),
			sourceFingerprint: afterA.sourceFingerprint,
		});
	});

	it("applies chains, swaps, and cycles simultaneously while field ids stay local", () => {
		const start = fixture();
		const chain = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "fresh" },
			),
		);
		expect(chain.fields[FIELD_A].id).toBe("question_a");
		expect(chain.fields[FIELD_B].id).toBe("question_b");
		expect(caseWriteProperty(chain, FIELD_A)).toBe("b");
		expect(caseWriteProperty(chain, FIELD_B)).toBe("fresh");
		expect(chain.forms[FORM].caseOperations?.[0]?.writes?.[0]?.property).toBe(
			"b",
		);
		expect(
			chain.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["b", "fresh", "c"]);

		const swap = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "a" },
			),
		);
		expect(caseWriteProperty(swap, FIELD_A)).toBe("b");
		expect(caseWriteProperty(swap, FIELD_B)).toBe("a");
		expect(
			swap.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["b", "a", "c"]);

		const cycle = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "c" },
				{ caseType: "patient", from: "c", to: "a" },
			),
		);
		expect(
			cycle.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["b", "c", "a"]);
	});

	it("rewrites every structured automation carrier and exact message token", () => {
		const start = fixture();
		const parentType = {
			name: "household",
			properties: [
				{
					name: "parent_a",
					label: proseText("Parent A"),
					data_type: "text" as const,
				},
			],
		};
		const patient = start.caseTypes?.[0];
		if (patient === undefined) throw new Error("missing patient type");
		patient.parent_type = "household";
		patient.relationship = "child";
		start.caseTypes = [...(start.caseTypes ?? []), parentType];
		const updateUuid = testUuid("rename-automation-update");
		const updateItemUuid = testUuid("rename-automation-update-item");
		const alertUuid = testUuid("rename-automation-alert");
		start.automations = {
			[updateUuid]: {
				uuid: updateUuid,
				kind: "case-update",
				name: "Copy parent",
				caseType: "patient",
				criteriaOperator: "all",
				criteria: [
					{
						uuid: testUuid("rename-automation-criterion"),
						kind: "match-property",
						scope: "parent",
						property: "parent_a",
						matchType: "has-value",
					},
				],
				setupOnlyCriteria: [],
				updates: [
					{
						uuid: updateItemUuid,
						target: { scope: "parent", property: "parent_a" },
						value: {
							kind: "case-property",
							source: { scope: "case", property: "a" },
						},
					},
				],
				closeCase: false,
			},
			[alertUuid]: {
				uuid: alertUuid,
				kind: "conditional-alert",
				name: "Patient alert",
				caseType: "patient",
				criteriaOperator: "all",
				criteria: [],
				setupOnlyCriteria: [],
				recipients: [
					{
						uuid: testUuid("rename-automation-recipient"),
						kind: "case-property-email",
						property: "a",
					},
				],
				schedule: {
					kind: "timed",
					repeatEvery: 7,
					totalIterations: 2,
					startOffsetDays: 0,
					startDayOfWeek: -1,
					start: { kind: "case-property", property: "a" },
					events: [
						{
							uuid: testUuid("rename-automation-event"),
							day: 0,
							timing: { kind: "case-property-time", property: "a" },
							content: {
								kind: "email",
								subject: {
									parts: [
										{ kind: "text", text: "For " },
										{
											kind: "case-property",
											scope: "case",
											caseType: "patient",
											property: "a",
										},
										{ kind: "text", text: " literal {case.a}" },
									],
								},
								body: {
									kind: "rich-text",
									html: {
										parts: [
											{ kind: "text", text: "<p>" },
											{
												kind: "case-property",
												scope: "case",
												caseType: "patient",
												property: "a",
											},
											{ kind: "text", text: " / " },
											{
												kind: "case-property",
												scope: "parent",
												caseType: "household",
												property: "parent_a",
											},
											{
												kind: "text",
												text: " / {case.owner.name}</p>",
											},
										],
									},
								},
							},
						},
					],
				},
				includeDescendantLocations: false,
				locationLevelUuids: [],
				userDataFilters: [
					{
						uuid: testUuid("rename-automation-user-filter"),
						userPropertyUuid: testUuid("rename-worker-property"),
						values: [
							{ kind: "literal", value: "literal {a}" },
							{
								kind: "case-property",
								caseType: "patient",
								property: "a",
							},
						],
					},
				],
				useUserCaseForFilter: false,
				resetCaseProperty: "a",
				stopDateCaseProperty: "a",
			},
		};
		start.automationOrder = [updateUuid, alertUuid];
		start.refIndex = buildReferenceIndex(start);

		const next = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "fresh" },
				{ caseType: "household", from: "parent_a", to: "parent_fresh" },
			),
		);
		const update = next.automations?.[updateUuid];
		const alert = next.automations?.[alertUuid];
		if (update?.kind !== "case-update" || alert?.kind !== "conditional-alert") {
			throw new Error("missing renamed automations");
		}
		expect(update.criteria[0]).toMatchObject({
			scope: "parent",
			property: "parent_fresh",
		});
		expect(update.updates[0]).toMatchObject({
			target: { scope: "parent", property: "parent_fresh" },
			value: { source: { scope: "case", property: "fresh" } },
		});
		expect(alert.recipients[0]).toMatchObject({ property: "fresh" });
		expect(alert.resetCaseProperty).toBe("fresh");
		expect(alert.stopDateCaseProperty).toBe("fresh");
		expect(alert.userDataFilters[0]?.values).toEqual([
			{ kind: "literal", value: "literal {a}" },
			{
				kind: "case-property",
				caseType: "patient",
				property: "fresh",
			},
		]);
		if (alert.schedule.kind !== "timed") throw new Error("wrong schedule");
		expect(alert.schedule.start).toEqual({
			kind: "case-property",
			property: "fresh",
		});
		expect(alert.schedule.events[0]?.timing).toEqual({
			kind: "case-property-time",
			property: "fresh",
		});
		const content = alert.schedule.events[0]?.content;
		if (content?.kind !== "email") throw new Error("wrong content");
		expect(content).toMatchObject({
			subject: {
				parts: [
					{ kind: "text", text: "For " },
					{
						kind: "case-property",
						scope: "case",
						caseType: "patient",
						property: "fresh",
					},
					{ kind: "text", text: " literal {case.a}" },
				],
			},
			body: {
				kind: "rich-text",
				html: {
					parts: [
						{ kind: "text", text: "<p>" },
						{
							kind: "case-property",
							scope: "case",
							caseType: "patient",
							property: "fresh",
						},
						{ kind: "text", text: " / " },
						{
							kind: "case-property",
							scope: "parent",
							caseType: "household",
							property: "parent_fresh",
						},
						{ kind: "text", text: " / {case.owner.name}</p>" },
					],
				},
			},
		});
		expect(
			referencingSlotsOf(next, casePropertyTargetKey("patient", "fresh")).get(
				alertUuid,
			),
		).toContain("automation_template_property");
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
	});

	it("indexes and renames automatic-update parent properties through an extension edge", () => {
		const start = fixture();
		const patient = start.caseTypes?.[0];
		if (patient === undefined) throw new Error("missing patient type");
		patient.parent_type = "household";
		patient.relationship = "extension";
		start.caseTypes = [
			patient,
			{
				name: "household",
				properties: [
					{
						name: "state",
						label: proseText("State"),
						data_type: "text",
					},
				],
			},
		];
		const automationUuid = testUuid("rename-extension-parent-automation");
		start.automations = {
			[automationUuid]: {
				uuid: automationUuid,
				kind: "case-update",
				name: "Update extension parent",
				caseType: "patient",
				criteriaOperator: "all",
				criteria: [
					{
						uuid: testUuid("rename-extension-parent-criterion"),
						kind: "match-property",
						scope: "parent",
						property: "state",
						matchType: "has-value",
					},
				],
				setupOnlyCriteria: [],
				updates: [
					{
						uuid: testUuid("rename-extension-parent-update"),
						target: { scope: "parent", property: "state" },
						value: {
							kind: "case-property",
							source: { scope: "parent", property: "state" },
						},
					},
				],
				closeCase: false,
			},
		};
		start.automationOrder = [automationUuid];
		start.refIndex = buildReferenceIndex(start);
		expect(
			referencingSlotsOf(
				start,
				casePropertyTargetKey("household", "state"),
			).get(automationUuid),
		).toEqual(
			expect.arrayContaining([
				"automation_criterion_property",
				"automation_update_property",
			]),
		);

		const next = apply(
			start,
			admittedRename({
				caseType: "household",
				from: "state",
				to: "parent_state",
			}),
		);
		const automation = next.automations?.[automationUuid];
		if (automation?.kind !== "case-update") {
			throw new Error("missing automatic update");
		}
		expect(automation.criteria[0]).toMatchObject({
			scope: "parent",
			property: "parent_state",
		});
		expect(automation.updates[0]).toMatchObject({
			target: { scope: "parent", property: "parent_state" },
			value: {
				source: { scope: "parent", property: "parent_state" },
			},
		});
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
	});

	it.each([
		["self-rename", [{ caseType: "patient", from: "a", to: "a" }]],
		[
			"duplicate-source",
			[
				{ caseType: "patient", from: "a", to: "fresh" },
				{ caseType: "patient", from: "a", to: "other" },
			],
		],
		[
			"duplicate-destination",
			[
				{ caseType: "patient", from: "a", to: "fresh" },
				{ caseType: "patient", from: "b", to: "fresh" },
			],
		],
		["source-missing", [{ caseType: "patient", from: "missing", to: "fresh" }]],
		["occupied-destination", [{ caseType: "patient", from: "a", to: "b" }]],
		[
			"standard-scalar-property",
			[{ caseType: "patient", from: "a", to: "case_name" }],
		],
	] as const)(
		"rejects a non-bijective or inadmissible relation: %s",
		(reason, entries) => {
			expect(() => apply(fixture(), admittedRename(...entries))).toThrowError(
				expect.objectContaining({
					name: CasePropertyRenamePlanError.name,
					issue: expect.objectContaining({ reason }),
				}),
			);
		},
	);

	it("rejects a mixed batch at canonical admission", () => {
		expect(() =>
			admitMutationBatch([
				rename({ caseType: "patient", from: "a", to: "fresh" }),
				{ kind: "setAppName", name: "Mixed" },
			]),
		).toThrow();
	});
});

describe("endpoint diff keeps local carrier edits local", () => {
	it("round-trips writer add and removal without manufacturing rename intent", () => {
		const start = fixture();
		const withWriter = apply(start, [
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: FIELD_NEW,
					id: "question_fresh",
					kind: "text",
					label: proseText("Fresh"),
					caseWrite: { caseType: "patient", property: "fresh" },
				},
			},
		]);
		expectRoundTrip(start, withWriter);
		const removed = apply(withWriter, [
			{ kind: "removeField", uuid: FIELD_NEW },
		]);
		expectRoundTrip(withWriter, removed);
	});

	it("round-trips a local field caseWrite retarget without moving peer carriers", () => {
		const start = fixture();
		const retargeted = apply(start, [
			{
				kind: "updateField",
				uuid: FIELD_A,
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "fresh" },
				},
			},
		]);
		const mutations = expectRoundTrip(start, retargeted);
		expect(mutations).toContainEqual({
			kind: "updateField",
			uuid: FIELD_A,
			targetKind: "text",
			patch: {
				caseWrite: { caseType: "patient", property: "fresh" },
			},
		});
		expect(caseWriteProperty(retargeted, FIELD_B)).toBe("b");
		expect(
			retargeted.forms[FORM].caseOperations?.[0]?.writes?.[0]?.property,
		).toBe("a");
	});

	it("round-trips a case-operation write destination edit", () => {
		const start = fixture();
		const changed = produce(start, (draft) => {
			const operation = draft.forms[FORM].caseOperations?.[0];
			if (operation?.writes?.[0] !== undefined) {
				operation.writes[0].property = "b";
			}
		});
		const mutations = expectRoundTrip(start, changed);
		expect(mutations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "updateForm",
					uuid: FORM,
					caseOperationPatch: {
						operation: "remove-write",
						uuid: OPERATION,
						property: "a",
					},
				}),
				expect.objectContaining({
					kind: "updateForm",
					uuid: FORM,
					caseOperationPatch: expect.objectContaining({
						operation: "add-write",
						uuid: OPERATION,
						value: expect.objectContaining({ property: "b" }),
					}),
				}),
			]),
		);
	});

	it("round-trips independent catalog add and removal", () => {
		const start = fixture();
		const added = apply(start, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "fresh", label: proseText("Fresh") },
			},
		]);
		expectRoundTrip(start, added);
		const removed = apply(added, [
			{
				kind: "removeCaseProperty",
				caseType: "patient",
				property: "fresh",
			},
		]);
		expectRoundTrip(added, removed);
	});
});

describe("case-property placement anchors", () => {
	it.each([
		["missing", "missing"],
		["wrong case type", "household_only"],
		["self", "fresh"],
	] as const)("rejects a %s anchor", (_label, after) => {
		const start = fixture();
		start.caseTypes?.push({
			name: "household",
			properties: [
				{ name: "household_only", label: proseText("Household only") },
			],
		});
		expect(
			mutationTargetsInvalid(start, [
				{
					kind: "addCaseProperty",
					caseType: "patient",
					property: { name: "fresh", label: proseText("Fresh") },
					after,
				},
			]),
		).toBe(true);
	});

	it("rejects an anchor removed earlier in the same batch", () => {
		expect(
			mutationTargetsInvalid(fixture(), [
				{
					kind: "removeCaseProperty",
					caseType: "patient",
					property: "b",
				},
				{
					kind: "addCaseProperty",
					caseType: "patient",
					property: { name: "fresh", label: proseText("Fresh") },
					after: "b",
				},
			]),
		).toBe(true);
	});

	it("uses null for first, a same-type name for middle, and omission only for append", () => {
		const start = catalogOnlyFixture();
		const first = apply(start, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "first", label: proseText("First") },
				after: null,
			},
		]);
		const middle = apply(first, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "middle", label: proseText("Middle") },
				after: "a",
			},
		]);
		const end = apply(middle, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "end", label: proseText("End") },
			},
		]);
		expect(
			end.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["first", "a", "middle", "b", "c", "end"]);
	});
});

describe("endpoint ambiguity and exact command provenance", () => {
	it("refuses an exact full-carrier rename without provenance", () => {
		const start = fixture();
		const command = admittedRename({
			caseType: "patient",
			from: "a",
			to: "fresh",
		});
		const renamed = apply(start, command);
		expect(() => diffDocsToMutations(start, renamed)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
		expect(
			diffDocsToMutations(start, renamed, {
				casePropertyRename: command,
			}),
		).toEqual(command);
	});

	it("still refuses a rename-shaped subdelta when the app name also changes", () => {
		const start = fixture();
		const renamed = apply(
			start,
			admittedRename({
				caseType: "patient",
				from: "a",
				to: "fresh",
			}),
		);
		const renamedAndRetitled = produce(renamed, (draft) => {
			draft.appName = "Retitled app";
		});

		expect(() => diffDocsToMutations(start, renamedAndRetitled)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
	});

	it("still refuses a rename-shaped subdelta when an unrelated field label also changes", () => {
		const start = fixture();
		const renamed = apply(
			start,
			admittedRename({
				caseType: "patient",
				from: "a",
				to: "fresh",
			}),
		);
		const renamedAndRelabeled = produce(renamed, (draft) => {
			const field = draft.fields[FIELD_B];
			if (field !== undefined && "label" in field) {
				field.label = proseText("New question label");
			}
		});

		expect(() => diffDocsToMutations(start, renamedAndRelabeled)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
	});

	it("rejects provenance that does not reproduce the complete endpoint", () => {
		const start = fixture();
		const renamed = apply(
			start,
			admittedRename({
				caseType: "patient",
				from: "a",
				to: "fresh",
			}),
		);
		expect(() =>
			diffDocsToMutations(start, renamed, {
				casePropertyRename: admittedRename({
					caseType: "patient",
					from: "b",
					to: "other",
				}),
			}),
		).toThrow(CasePropertySemanticProvenanceRequiredError);
	});

	it("returns the exact recorded command instead of synthesized carrier edits", () => {
		const start = fixture();
		const command = admittedRename(
			{ caseType: "patient", from: "a", to: "b" },
			{ caseType: "patient", from: "b", to: "a" },
		);
		// The provenance path is defined by replaying the exact recorded
		// semantic command, not by reconstructing local carrier edits.
		const replayed = apply(start, command);
		expect(
			diffDocsToMutations(start, replayed, {
				casePropertyRename: command,
			}),
		).toEqual(command);
	});

	it("uses an exact recorded non-rename catalog replacement only to construct its granular inverse", () => {
		const start = catalogOnlyFixture();
		const forward = admitMutationBatch([
			{
				kind: "removeCaseProperty",
				caseType: "patient",
				property: "a",
			},
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "fresh", label: proseText("Fresh") },
			},
		]);
		const replaced = apply(start, forward);

		expect(() => diffDocsToMutations(replaced, start)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
		const inverse = diffDocsToMutations(replaced, start, {
			recordedNonRenameForward: forward,
		});
		expect(inverse).not.toContainEqual(
			expect.objectContaining({ kind: "renameCaseProperties" }),
		);
		expect(toPersistableDoc(apply(replaced, inverse))).toEqual(
			toPersistableDoc(start),
		);
	});

	it("constructs a local writer-retarget inverse from its exact ordinary command without widening rename authority", () => {
		const start = fixture();
		const forward = admitMutationBatch([
			{
				kind: "updateField",
				uuid: FIELD_A,
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "fresh" },
				},
			},
		]);
		const retargeted = apply(start, forward);
		const inverse = diffDocsToMutations(retargeted, start, {
			recordedNonRenameForward: forward,
		});

		expect(inverse).toContainEqual({
			kind: "updateField",
			uuid: FIELD_A,
			targetKind: "text",
			patch: {
				caseWrite: { caseType: "patient", property: "a" },
			},
		});
		expect(inverse).not.toContainEqual(
			expect.objectContaining({ kind: "renameCaseProperties" }),
		);
		expect(toPersistableDoc(apply(retargeted, inverse))).toEqual(
			toPersistableDoc(start),
		);
	});

	it("rejects an explicit rename or mismatched replay presented as ordinary provenance", () => {
		const start = fixture();
		const command = admittedRename({
			caseType: "patient",
			from: "a",
			to: "fresh",
		});
		const renamed = apply(start, command);
		expect(() =>
			diffDocsToMutations(renamed, start, {
				recordedNonRenameForward: command,
			}),
		).toThrow(CasePropertySemanticProvenanceRequiredError);
		expect(() =>
			diffDocsToMutations(renamed, start, {
				recordedNonRenameForward: admitMutationBatch([
					{ kind: "setAppName", name: "Wrong" },
				]),
			}),
		).toThrow(CasePropertySemanticProvenanceRequiredError);
	});
});
