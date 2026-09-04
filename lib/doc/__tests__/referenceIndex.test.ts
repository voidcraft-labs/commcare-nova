/**
 * Reference index — build, queries, and the per-mutation maintenance
 * behaviors with non-obvious correctness rules:
 *
 *   - identity keying (form-local refs land on the target's uuid with
 *     prefix coverage; `#case/…` keys under the module's CURRENT type;
 *     AST refs key on the relation walk's destination);
 *   - the declarations index (case-property peers + form-scoped id
 *     holders) and the close-condition unique-holder rule;
 *   - resolution-context maintenance: an add that makes a previously
 *     dangling `#form/…` ref resolve, and a module case-type change
 *     re-keying contextual refs — both at-a-distance shifts where the
 *     carrier itself was never touched.
 *
 * The standing incremental ≡ rebuild proof lives in
 * `referenceIndex.fuzz.test.ts`; these are the targeted, readable pins.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { planModuleChildDependentsOnRemove } from "@/lib/doc/moduleDependents";
import { applyMutations } from "@/lib/doc/mutations";
import {
	buildReferenceIndex,
	declarersOf,
	referencingCarrierUuids,
} from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	automationSchema,
	type BlueprintDoc,
	canonicalProseTemplate,
	casePropertyTargetKey,
	caseTypeTargetKey,
	entityTargetKey,
	expressionSource,
	hiddenSearchInputDef,
	locationTargetKey,
	printProseTemplate,
	simpleSearchInputDef,
	type Uuid,
	userPropertyTargetKey,
} from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	and,
	eq,
	fixedLocation,
	input,
	isBlank,
	literal,
	ownerLocationAtLevel,
	prop,
	sessionUserProperty,
	subcasePath,
	tableColumn,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

function uuidByFieldId(doc: BlueprintDoc, id: string): Uuid {
	const found = Object.values(doc.fields).find((field) => field.id === id);
	if (!found) throw new Error(`no field with id ${id} in fixture`);
	return found.uuid;
}

/** Carrier → slot-id edges to `targetKey`, read straight off the
 *  index's `in` bucket — the structure the slot assertions pin. */
function slotsFor(
	doc: BlueprintDoc,
	targetKey: string,
): Record<string, Record<string, true>> {
	return (doc.refIndex ?? buildReferenceIndex(doc)).in[targetKey] ?? {};
}

/** Printed text of an AST-stored relevant slot. */
function printedRelevant(doc: BlueprintDoc, uuid: Uuid): string | undefined {
	const field = doc.fields[uuid];
	return field ? expressionSource(field, "relevant", doc) : undefined;
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

/** A doc rich in every reference surface kind. */
function richDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Clinic",
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
				caseListConfig: {
					columns: [],
					searchInputs: [],
					filter: eq(prop("patient", "age"), literal("1")),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						closeCondition: { field: "outcome", answer: "done" },
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
								kind: "group",
								id: "grp",
								children: [
									f({ kind: "text", id: "inner", label: proseText("Inner") }),
								],
							}),
							f({
								kind: "text",
								id: "watcher",
								label: proseText("Watcher"),
								relevant: "#form/grp/inner != '' and /data/case_name != ''",
							}),
							f({
								kind: "text",
								id: "slash_watcher",
								label: proseText("Slash"),
								relevant: "/data/grp/inner != ''",
							}),
							f({
								kind: "text",
								id: "ctx_ref",
								label: proseText("Ctx"),
								relevant: "#patient/age > 1",
							}),
							f({ kind: "text", id: "outcome", label: proseText("Outcome") }),
						],
					},
				],
			},
		],
	});
	const watcher = uuidByFieldId(doc, "watcher");
	const inner = uuidByFieldId(doc, "inner");
	const watcherField = doc.fields[watcher];
	if (!watcherField || !("label" in watcherField)) {
		throw new Error("expected watcher to carry a label");
	}
	watcherField.label = canonicalProseTemplate([
		{ kind: "text", text: "See " },
		{ kind: "case-ref", caseType: "patient", property: "age" },
		{ kind: "text", text: " and " },
		{ kind: "field-ref", uuid: inner },
	]);
	return doc;
}

describe("buildReferenceIndex — identity-keyed edges", () => {
	it("indexes menu parent identity and reports child removal dependents", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Parent",
					forms: [{ name: "Parent form", type: "survey" }],
				},
				{
					name: "Child",
					forms: [{ name: "Child form", type: "survey" }],
				},
			],
		});
		const [parentUuid, childUuid] = doc.moduleOrder;
		const nested = apply(doc, [
			{
				kind: "moveModule",
				uuid: childUuid,
				parentModuleUuid: parentUuid,
				after: null,
			},
		]);

		expect(slotsFor(nested, entityTargetKey(parentUuid))).toMatchObject({
			[childUuid]: { module_parent: true },
		});
		expect(planModuleChildDependentsOnRemove(nested, parentUuid)).toMatchObject(
			{
				kind: "blocked",
				childUuids: [childUuid],
			},
		);

		const promoted = apply(nested, [
			{
				kind: "moveModule",
				uuid: childUuid,
				parentModuleUuid: null,
				after: parentUuid,
			},
		]);
		expect(slotsFor(promoted, entityTargetKey(parentUuid))).toEqual({});
		expect(planModuleChildDependentsOnRemove(promoted, parentUuid)).toEqual({
			kind: "clear",
		});
	});

	it("indexes every Blueprint carrier that names an organization identity", () => {
		const region = testUuid("11111111-1111-4111-8111-111111111111");
		const facility = testUuid("22222222-2222-4222-8222-222222222222");
		const property = testUuid("33333333-3333-4333-8333-333333333333");
		const persona = testUuid("44444444-4444-4444-8444-444444444444");
		const place = testUuid("55555555-5555-4555-8555-555555555555");
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Visit", type: "followup" }],
				},
			],
		});
		doc.organizationLevels = {
			[region]: {
				uuid: region,
				code: "region",
				name: "Region",
				caseFlow: { workers: "none", ownsCases: true },
				addressBook: { reach: "own-branch" },
			},
			[facility]: {
				uuid: facility,
				code: "facility",
				name: "Facility",
				parentLevelUuid: region,
				caseFlow: {
					workers: "assigned",
					ownsCases: false,
					descendantCases: { kind: "none" },
				},
				addressBook: { reach: "shared-branch", fromLevelUuid: region },
			},
		};
		doc.organizationLevelOrder = [region, facility];
		doc.locationProperties = {
			[property]: {
				uuid: property,
				slug: "phone",
				label: "Phone",
				levelUuids: [region],
			},
		};
		doc.locationPropertyOrder = [property];
		doc.personas = {
			[persona]: {
				uuid: persona,
				name: "Asha",
				locations: { primaryUuid: place },
			},
		};
		doc.personaOrder = [persona];
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const automationUuid = testUuid("reference-index-location-automation");
		doc.forms[formUuid].caseOperations = [
			{
				uuid: testUuid("66666666-6666-4666-8666-666666666666"),
				id: "fixed_owner",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: term(fixedLocation(place)),
			},
			{
				uuid: testUuid("77777777-7777-4777-8777-777777777777"),
				id: "reverse_owner",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: term(ownerLocationAtLevel(facility, "patient")),
			},
		];
		doc.automations = {
			[automationUuid]: {
				uuid: automationUuid,
				kind: "case-update",
				name: "Escalate place-owned cases",
				caseType: "patient",
				criteriaOperator: "all",
				criteria: [
					{
						uuid: testUuid("reference-index-location-criterion"),
						kind: "location",
						locationUuid: place,
						includeDescendants: true,
					},
				],
				setupOnlyCriteria: [],
				updates: [],
				closeCase: true,
			},
		};
		doc.automationOrder = [automationUuid];

		const levelSlots = slotsFor(doc, entityTargetKey(region));
		expect(levelSlots[facility]).toEqual({ organization_level_setting: true });
		expect(levelSlots[property]).toEqual({ location_property_level: true });
		expect(slotsFor(doc, entityTargetKey(facility))[formUuid]).toEqual({
			case_operation_owner: true,
		});
		expect(slotsFor(doc, caseTypeTargetKey("patient"))[formUuid]).toEqual(
			expect.objectContaining({ case_operation_owner: true }),
		);
		const placeSlots = slotsFor(doc, locationTargetKey(place));
		expect(placeSlots[persona]).toEqual({ persona_location: true });
		expect(placeSlots[formUuid]).toEqual({ case_operation_owner: true });
		expect(placeSlots[automationUuid]).toEqual({
			automation_criterion_location: true,
		});
	});

	it("indexes custom worker references by user-property identity across both AST families", () => {
		const propertyUuid = testUuid("worker-property-region");
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					displayCondition: eq(
						sessionUserProperty(propertyUuid),
						literal("north"),
					),
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({ kind: "text", id: "name", label: proseText("Name") }),
							],
						},
					],
				},
			],
		});
		doc.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "region",
				label: "Region",
			},
		};
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		(doc.fields[fieldUuid] as { relevant?: unknown }).relevant =
			parseXPathForForm(doc, formUuid, "#user/region = 'north'");

		const slots = slotsFor(doc, userPropertyTargetKey(propertyUuid));
		expect(slots[moduleUuid]).toEqual({ module_display_condition: true });
		expect(slots[fieldUuid]).toEqual({ relevant: true });
	});

	it("indexes the Search prompt slots: options filter, required condition, check, and hidden value", () => {
		// The four slots this PR added each carry an AST. The prompt slots
		// never name a case row (no case is selected on the Search screen),
		// so the identities they can reach are custom worker properties and
		// other inputs; only the former is an index target (search inputs are
		// not retirement or rename targets, so `input(...)` leaves index
		// nothing). The options filter is a table-row scope whose
		// `table-column` leaves belong to the lookup registry, not this index.
		const propertyUuid = testUuid("worker-property-region");
		const hiddenPropertyUuid = testUuid("worker-property-site");
		const regionUuid = testUuid("search-input-region");
		const nameUuid = testUuid("search-input-name");
		const siteUuid = testUuid("search-input-site");
		const tableId = "018f3e8a-7b2c-7def-8abc-0000000000a1" as LookupTableId;
		const valueColumn =
			"018f3e8a-7b2c-7def-8abc-0000000000b1" as LookupColumnId;
		const labelColumn =
			"018f3e8a-7b2c-7def-8abc-0000000000b2" as LookupColumnId;
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "region", label: proseText("Region") },
						{ name: "full_name", label: proseText("Name") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: resolveCaseListConfig({
						columns: [],
						searchInputs: [
							simpleSearchInputDef(
								regionUuid,
								"region",
								"Region",
								"select",
								"region",
								{
									options: {
										kind: "lookup",
										tableId,
										valueColumnId: valueColumn,
										labelColumnId: labelColumn,
										filter: eq(
											tableColumn(tableId, valueColumn),
											sessionUserProperty(propertyUuid),
										),
									},
								},
							),
							simpleSearchInputDef(
								nameUuid,
								"full_name",
								"Name",
								"text",
								"full_name",
								{
									required: {
										when: and(
											isBlank(input(regionUuid)),
											eq(sessionUserProperty(propertyUuid), literal("north")),
										),
									},
									validation: {
										rule: eq(
											input(nameUuid),
											sessionUserProperty(propertyUuid),
										),
										message: "Search your own region.",
									},
								},
							),
							hiddenSearchInputDef(
								siteUuid,
								"site",
								"Site",
								term(sessionUserProperty(hiddenPropertyUuid)),
							),
						],
					}),
				},
			],
		});
		doc.userProperties = {
			[propertyUuid]: { uuid: propertyUuid, slug: "region", label: "Region" },
			[hiddenPropertyUuid]: {
				uuid: hiddenPropertyUuid,
				slug: "site",
				label: "Site",
			},
		};
		const moduleUuid = doc.moduleOrder[0];

		expect(slotsFor(doc, userPropertyTargetKey(propertyUuid))).toEqual({
			[moduleUuid]: {
				search_input_options: true,
				search_input_required_when: true,
				search_input_validation_rule: true,
			},
		});
		expect(slotsFor(doc, userPropertyTargetKey(hiddenPropertyUuid))).toEqual({
			[moduleUuid]: { search_input_hidden_value: true },
		});
		// A sibling read is a removal dependency (`searchInputMutations.ts`),
		// not an index edge.
		expect(slotsFor(doc, entityTargetKey(regionUuid))).toEqual({});
		// The incremental index and the rebuild agree on the new slots.
		expect(buildReferenceIndex(doc).in).toEqual(
			(doc.refIndex ?? buildReferenceIndex(doc)).in,
		);
	});

	it("indexes module and form display-condition Predicate leaves", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: eq(prop("patient", "age"), literal(18)),
					forms: [
						{
							name: "Visit",
							type: "followup",
							displayCondition: eq(prop("patient", "age"), literal(18)),
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const slots = slotsFor(doc, casePropertyTargetKey("patient", "age"));
		expect(slots[moduleUuid]).toEqual({ module_display_condition: true });
		expect(slots[formUuid]).toEqual({ form_display_condition: true });
		expect(referencingCarrierUuids(doc, caseTypeTargetKey("patient"))).toEqual(
			expect.arrayContaining([moduleUuid, formUuid]),
		);
	});

	it("keys form-local refs on the target uuid, with prefix coverage for container paths", () => {
		const doc = richDoc();
		const grp = uuidByFieldId(doc, "grp");
		const inner = uuidByFieldId(doc, "inner");
		const watcher = uuidByFieldId(doc, "watcher");

		// An AST-stored ref is ONE identity leaf to the field it lands on —
		// `#form/grp/inner` / `/data/grp/inner` edge to `inner` alone, with
		// no container prefix edge: both XPath and prose store the target
		// field's identity, and printing re-derives its current full path.
		const slashWatcher = uuidByFieldId(doc, "slash_watcher");
		expect(referencingCarrierUuids(doc, entityTargetKey(grp))).toEqual([]);
		expect(slotsFor(doc, entityTargetKey(inner))[watcher]).toEqual({
			relevant: true,
			label: true,
		});
		expect(slotsFor(doc, entityTargetKey(inner))[slashWatcher]).toEqual({
			relevant: true,
		});

		// `/data/case_name` resolves the same way.
		const caseName = uuidByFieldId(doc, "case_name");
		expect(slotsFor(doc, entityTargetKey(caseName))[watcher]).toEqual({
			relevant: true,
		});
	});

	it("keys explicit per-type hashtags as case-type AND case-property edges", () => {
		const doc = richDoc();
		const watcher = uuidByFieldId(doc, "watcher");
		expect(
			referencingCarrierUuids(doc, casePropertyTargetKey("patient", "age")),
		).toContain(watcher);
		expect(
			referencingCarrierUuids(doc, caseTypeTargetKey("patient")),
		).toContain(watcher);
	});

	it("keys explicit XPath case refs under their authored type", () => {
		const doc = richDoc();
		const ctxRef = uuidByFieldId(doc, "ctx_ref");
		expect(
			referencingCarrierUuids(doc, casePropertyTargetKey("patient", "age")),
		).toContain(ctxRef);
		expect(
			referencingCarrierUuids(doc, caseTypeTargetKey("patient")),
		).toContain(ctxRef);
	});

	it("keys AST PropertyRefs on the relation walk's destination type", () => {
		const doc = buildDoc({
			modules: [
				{
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
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		// Destination (ofCaseType) is patient — the property edge lands there…
		expect(
			referencingCarrierUuids(doc, casePropertyTargetKey("patient", "age")),
		).toEqual([moduleUuid]);
		// …while origin + hint both register as type references.
		expect(
			referencingCarrierUuids(doc, caseTypeTargetKey("household")),
		).toContain(moduleUuid);
		expect(
			referencingCarrierUuids(doc, caseTypeTargetKey("patient")),
		).toContain(moduleUuid);
	});

	it("keys the close condition on the checked field's uuid — cousins can't shake it", () => {
		const doc = richDoc();
		const formUuid = doc.moduleOrder.flatMap((m) => doc.formOrder[m] ?? [])[0];
		const outcome = uuidByFieldId(doc, "outcome");
		expect(referencingCarrierUuids(doc, entityTargetKey(outcome))).toEqual([
			formUuid,
		]);

		// The ref names ONE field by uuid — a cousin minting the same id
		// changes nothing about the edge (the id-stored era dropped it on
		// ambiguity; identity has no ambiguity to drop).
		const grp = uuidByFieldId(doc, "grp");
		const next = apply(doc, [
			{
				kind: "addField",
				parentUuid: grp,
				field: {
					uuid: "11111111-1111-4111-8111-111111111111",
					kind: "text",
					id: "outcome",
					label: proseText("Cousin outcome"),
				} as never,
			},
		]);
		expect(referencingCarrierUuids(next, entityTargetKey(outcome))).toEqual([
			formUuid,
		]);
	});
});

describe("index-driven rewrites — slash-path descendants and mid-batch currency", () => {
	it("re-anchors a /data/… descendant ref when its container renames, and again when it moves", () => {
		const doc = richDoc();
		const grp = uuidByFieldId(doc, "grp");
		const slashWatcher = uuidByFieldId(doc, "slash_watcher");

		const renamed = apply(doc, [
			{
				kind: "updateField",
				uuid: grp,
				targetKind: "group",
				patch: { id: "grp2" },
			},
		]);
		expect(printedRelevant(renamed, slashWatcher)).toBe(
			"/data/grp2/inner != ''",
		);
		expect(renamed.refIndex).toEqual(buildReferenceIndex(renamed));

		const formUuid = renamed.moduleOrder.flatMap(
			(m) => renamed.formOrder[m] ?? [],
		)[0];
		const outerUuid = "33333333-3333-4333-8333-333333333333";
		const moved = apply(renamed, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: outerUuid,
					kind: "group",
					id: "outer",
					label: proseText("Outer"),
				} as never,
			},
			{
				kind: "moveField",
				uuid: grp,
				toParentUuid: outerUuid as never,
				after: null,
			},
		]);
		expect(printedRelevant(moved, slashWatcher)).toBe(
			"/data/outer/grp2/inner != ''",
		);
		expect(moved.refIndex).toEqual(buildReferenceIndex(moved));
	});

	it("a field-ID update later in the SAME batch reprojects a ref the batch itself just added", () => {
		// Mid-batch currency is what lets reducers be lookup-driven at all:
		// the add's maintenance must land its edges BEFORE the ID update's
		// reducer looks carriers up, inside one applyMutations call. The
		// fresh prose and XPath refs both store identity and follow the ID change
		// at projection time without rewriting stored bytes.
		const doc = richDoc();
		const caseName = uuidByFieldId(doc, "case_name");
		const formUuid = doc.moduleOrder.flatMap((m) => doc.formOrder[m] ?? [])[0];
		const mintedUuid = "44444444-4444-4444-8444-444444444444";
		const next = apply(doc, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: mintedUuid,
					kind: "text",
					id: "fresh_ref",
					label: canonicalProseTemplate([
						{ kind: "text", text: "Fresh " },
						{ kind: "field-ref", uuid: caseName },
					]),
					relevant: parseXPathForForm(doc, formUuid, "#form/case_name != ''"),
				} as never,
			},
			{
				kind: "updateField",
				uuid: caseName,
				targetKind: "text",
				patch: { id: "full_name" },
			},
		]);
		const fresh = next.fields[mintedUuid as never];
		expect(
			"label" in fresh && fresh.label !== undefined
				? printProseTemplate(fresh.label, next)
				: undefined,
		).toBe("Fresh #form/full_name");
		expect(printedRelevant(next, mintedUuid as never)).toBe(
			"#form/full_name != ''",
		);
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
	});
});

describe("declarations index", () => {
	it("lists case-property declarers independently of field-ID changes", () => {
		const doc = richDoc();
		const caseName = uuidByFieldId(doc, "case_name");
		expect(declarersOf(doc, "patient", "case_name")).toEqual([caseName]);

		const renamed = apply(doc, [
			{
				kind: "updateField",
				uuid: caseName,
				targetKind: "text",
				patch: { id: "full_name" },
			},
		]);
		expect(declarersOf(renamed, "patient", "case_name")).toEqual([caseName]);
		expect(declarersOf(renamed, "patient", "full_name")).toEqual([]);
	});
});

describe("incremental maintenance", () => {
	it("removals drop every trace of the removed subtree", () => {
		const doc = richDoc();
		const moduleUuid = doc.moduleOrder[0];
		const next = apply(doc, [{ kind: "removeModule", uuid: moduleUuid }]);
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
		expect(next.refIndex?.in).toEqual({});
		expect(next.refIndex?.out).toEqual({});
		expect(next.refIndex?.decl).toEqual({});
	});

	it("rekeys parent and host automation edges when source ancestry changes", () => {
		const automationUuid = testUuid("automation-meta-reference");
		const doc = buildDoc({
			caseTypes: [
				{
					name: "visit",
					parent_type: "household",
					relationship: "extension",
					properties: [],
				},
				{
					name: "household",
					properties: [
						{ name: "state", label: "State", data_type: "text" },
						{ name: "source", label: "Source", data_type: "text" },
						{ name: "target", label: "Target", data_type: "text" },
					],
				},
				{
					name: "patient",
					properties: [
						{ name: "state", label: "State", data_type: "text" },
						{ name: "source", label: "Source", data_type: "text" },
						{ name: "target", label: "Target", data_type: "text" },
					],
				},
			],
		}) as BlueprintDoc;
		const automation = automationSchema.parse({
			uuid: automationUuid,
			kind: "case-update",
			name: "Move household values",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [
				{
					uuid: testUuid("automation-meta-criterion"),
					kind: "match-property",
					scope: "parent",
					property: "state",
					matchType: "has-value",
				},
			],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: testUuid("automation-meta-update"),
					target: { scope: "parent", property: "target" },
					value: {
						kind: "case-property",
						source: { scope: "host", property: "source" },
					},
				},
			],
			closeCase: false,
		});
		doc.automations = { [automationUuid]: automation };
		doc.automationOrder = [automationUuid];
		doc.refIndex = buildReferenceIndex(doc);

		const next = apply(doc, [
			{ kind: "setCaseTypeMeta", caseType: "visit", parent_type: "patient" },
		]);

		expect(next.refIndex).toEqual(buildReferenceIndex(next));
		expect(slotsFor(next, casePropertyTargetKey("household", "state"))).toEqual(
			{},
		);
		expect(
			slotsFor(next, casePropertyTargetKey("household", "source")),
		).toEqual({});
		expect(
			slotsFor(next, casePropertyTargetKey("household", "target")),
		).toEqual({});
		for (const property of ["state", "source", "target"]) {
			expect(
				Object.keys(slotsFor(next, casePropertyTargetKey("patient", property))),
			).toContain(automationUuid);
		}
	});
});
