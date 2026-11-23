/**
 * A document that holds an entity of every authored identity kind, each at
 * its own place, for the tests of the read-back comparison. The comparison is
 * a walk of two documents' stored shapes, so the entities a fixture builder
 * does not make are written as the stored shape holds them.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import {
	type Automation,
	type BlueprintDoc,
	columnSort,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	translationSourceFingerprint,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { authoredBlueprintIdentities } from "@/lib/domain/authoredIdentities";
import { searchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";

const U = (name: string) => testUuid(`read-back-${name}`) as Uuid;

/** Every kind of entity Nova's document holds, one or more of each. */
export function everyKindDocument(): BlueprintDoc {
	const built = buildDoc({
		appId: "read-back-app",
		modules: [
			{
				uuid: "read-back-patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "read-back-register",
						name: "Register",
						type: "registration",
						fields: [
							f({ kind: "text", id: "case_name", label: "Name" }),
							f({
								kind: "single_select",
								id: "colour",
								label: "Colour",
								options: [
									{ value: "red", label: "Red" },
									{ value: "blue", label: "Blue" },
								],
							}),
						],
					},
				],
			},
		],
	});
	const doc = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
	const modules = doc.modules as Record<string, Record<string, unknown>>;
	const forms = doc.forms as Record<string, Record<string, unknown>>;
	const [moduleUuid] = Object.keys(modules);
	const [formUuid] = Object.keys(forms);
	if (moduleUuid === undefined || formUuid === undefined)
		throw new Error("The fixture holds a menu and a form.");
	const module = modules[moduleUuid] as Record<string, unknown>;
	const config = module.caseListConfig as Record<string, unknown>;
	config.searchInputs = [{ uuid: U("search"), name: "name" }];
	config.calculatedSorts = [{ uuid: U("sort") }];
	(config.columns as unknown[]).push({
		uuid: U("mapping"),
		kind: "id-mapping",
		field: "colour",
		header: "Colour",
		mapping: [{ uuid: U("mapping-row"), value: "red", label: "Red" }],
	});
	(config.listColumnOrder as unknown[]).push(U("mapping"));
	(config.detailColumnOrder as unknown[]).push(U("mapping"));
	config.detailTabs = [
		{
			uuid: U("tab"),
			title: "Patient",
			startColumnUuid: (config.detailColumnOrder as unknown[])[0],
		},
	];
	module.entryPoint = { uuid: U("menu-entry") };
	const form = forms[formUuid] as Record<string, unknown>;
	form.caseOperations = [{ uuid: U("operation"), id: "patient" }];
	form.formLinks = [{ uuid: U("link") }];
	doc.userProperties = { [U("property")]: { uuid: U("property"), slug: "d" } };
	doc.userPropertyOrder = [U("property")];
	doc.userTypes = { [U("type")]: { uuid: U("type"), name: "Nurse" } };
	doc.userTypeOrder = [U("type")];
	doc.personas = { [U("persona")]: { uuid: U("persona"), name: "Ana" } };
	doc.personaOrder = [U("persona")];
	doc.organizationLevels = { [U("level")]: { uuid: U("level"), code: "d" } };
	doc.organizationLevelOrder = [U("level")];
	doc.locationProperties = {
		[U("location-property")]: { uuid: U("location-property"), slug: "p" },
	};
	doc.locationPropertyOrder = [U("location-property")];
	doc.automations = {
		[U("update")]: {
			uuid: U("update"),
			kind: "case-update",
			criteria: [{ uuid: U("criterion") }],
			setupOnlyCriteria: [{ uuid: U("setup-criterion") }],
			updates: [{ uuid: U("update-row") }],
		},
		[U("alert")]: {
			uuid: U("alert"),
			kind: "conditional-alert",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: U("recipient") }],
			schedule: { events: [{ uuid: U("event") }] },
			userDataFilters: [{ uuid: U("filter") }],
		},
	};
	doc.automationOrder = [U("update"), U("alert")];
	return doc as unknown as BlueprintDoc;
}

/**
 * A well-formed case app that also holds every kind CommCare HQ's app holds
 * nothing of: a worker property, a worker type and a persona that use it, an
 * automation that updates cases with its criteria, and an alert with its
 * recipients, events and a filter by worker data.
 */
export function worldDocument(): BlueprintDoc {
	const built = buildDoc({
		appId: "read-back-world",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "status", label: "Status" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						purpose: "Registers a patient",
						fields: [f({ kind: "text", id: "case_name", label: "Name" })],
					},
				],
			},
		],
	});
	const property = U("world-property");
	const alert = U("world-alert");
	const update = U("world-update");
	const automations: Record<string, Automation> = {
		[update]: {
			uuid: update,
			kind: "case-update",
			name: "Close resolved patients",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [
				{
					uuid: U("world-criterion"),
					kind: "match-property",
					scope: "case",
					property: "status",
					matchType: "equal",
					value: "resolved",
				},
			],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: U("world-update-row"),
					target: { scope: "case", property: "status" },
					value: { kind: "literal", value: "closed" },
				},
			],
			closeCase: true,
		},
		[alert]: {
			uuid: alert,
			kind: "conditional-alert",
			name: "Remind the owner",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: U("world-recipient"), kind: "owner" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: U("world-event"),
						minutesToWait: 0,
						content: {
							kind: "sms",
							message: { parts: [{ kind: "text", text: "Visit due" }] },
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [
				{
					uuid: U("world-filter"),
					userPropertyUuid: property,
					values: [{ kind: "literal", value: "north" }],
				},
			],
		},
	} as Record<string, Automation>;
	return {
		...built,
		userProperties: {
			[property]: { uuid: property, slug: "district", label: "District" },
		},
		userPropertyOrder: [property],
		userTypes: {
			[U("world-type")]: {
				uuid: U("world-type"),
				name: "Nurse",
				values: { [property]: "north" },
			},
		},
		userTypeOrder: [U("world-type")],
		personas: {
			[U("world-persona")]: {
				uuid: U("world-persona"),
				name: "Ana",
				userTypeUuid: U("world-type"),
			},
		},
		personaOrder: [U("world-persona")],
		automations,
		automationOrder: [update, alert],
	} as BlueprintDoc;
}

/**
 * A French and English survey whose menu name holds a translation a model
 * wrote that wants review, and whose one question holds a validation message
 * with no condition: two contents no export holds.
 */
export function unexportedTextDocument(): BlueprintDoc {
	const doc = buildDoc({
		appId: "read-back-text",
		modules: [
			{
				name: "Clients",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: "Note",
								validate_msg: proseText("Never shown"),
							}),
						],
					},
				],
			},
		],
	});
	const menu = doc.moduleOrder[0] as Uuid;
	return {
		...doc,
		localization: {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fr" },
			translations: {
				fra: {
					[makeTranslationUnitId("module", menu, "name")]: {
						value: "Les clients",
						sourceFingerprint: translationSourceFingerprint("text", "Clients"),
						origin: "ai",
						review: "needs-review",
						translatedFrom: "eng",
					},
				},
			},
		},
	} as BlueprintDoc;
}

/**
 * A case list whose column hidden from Results and from Details sorts the list and is named in
 * Sort by under another text than its header: a header no export holds, since each prints the
 * name in the header's place.
 */
export function sortNamedHiddenColumnDocument(): BlueprintDoc {
	const doc = buildDoc({
		appId: "read-back-sort-name",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [f({ kind: "text", id: "case_name", label: "Name" })],
					},
				],
			},
		],
	});
	const menu = doc.moduleOrder[0] as Uuid;
	const module = doc.modules[menu];
	const config = module?.caseListConfig;
	if (module === undefined || config === undefined)
		throw new Error("The fixture holds a menu with a case list.");
	const hidden = {
		...plainColumn(U("sort-named-column"), "weight", "Weight column"),
		visibleInList: false,
		visibleInDetail: false,
		sort: columnSort("desc", 0, undefined, "Heaviest first"),
	};
	return {
		...doc,
		modules: {
			...doc.modules,
			[menu]: {
				...module,
				caseListConfig: {
					...config,
					columns: [...config.columns, hidden],
					listColumnOrder: [...config.listColumnOrder, hidden.uuid],
					detailColumnOrder: [...config.detailColumnOrder, hidden.uuid],
				},
			},
		},
	};
}

/**
 * A menu of a case type whose forms are all surveys, so it lists no cases, holding a list of its
 * own: a column no export holds, since such a menu is written the one name column every new menu
 * in CommCare HQ holds.
 */
export function surveyListDocument(): BlueprintDoc {
	return buildDoc({
		appId: "read-back-survey-list",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: "Village" }],
			},
		],
		modules: [
			{
				name: "Household surveys",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "village", header: "Village" },
				]),
				forms: [
					{
						name: "Census",
						type: "survey",
						fields: [f({ kind: "text", id: "head", label: "Head" })],
					},
				],
			},
		],
	});
}

/**
 * A searched menu in English and Spanish whose Spanish holds a translation of the search guard
 * sentence for a location and a number, which no Search field of the app carries: a translation no
 * export holds, since an export prints only the guards its fields' values need.
 */
export function unprintedGuardDocument(): BlueprintDoc {
	const doc = localizationWireFixture("prompts");
	const spanish = doc.localization?.translations.spa;
	const quote = makeTranslationUnitId(
		"system",
		"search-validation",
		searchRuntimeValidationMessage(new Set(["quote"]))?.key ?? "",
	);
	const unit = makeTranslationUnitId(
		"system",
		"search-validation",
		searchRuntimeValidationMessage(new Set(["geopoint", "decimal-number"]))
			?.key ?? "",
	);
	const entry = spanish?.[quote];
	const fingerprint = translationUnitsById(doc).get(unit)?.sourceFingerprint;
	if (spanish === undefined || entry === undefined || fingerprint === undefined)
		throw new Error("The fixture holds no Spanish guard to copy.");
	spanish[unit] = {
		...entry,
		value: "Indique una ubicación y un número.",
		sourceFingerprint: fingerprint,
	};
	return doc;
}

/** Every object of `value` whose `uuid` is `uuid`. */
function holders(value: unknown, uuid: string): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap((one) => holders(one, uuid));
	if (value === null || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	return [
		...(record.uuid === uuid ? [record] : []),
		...Object.values(record).flatMap((one) => holders(one, uuid)),
	];
}

/** `doc` with one change planted inside the entity `uuid`, on a copy. */
export function plantedInside(doc: BlueprintDoc, uuid: string): BlueprintDoc {
	const copy = JSON.parse(JSON.stringify(doc)) as BlueprintDoc;
	const [holder] = holders(copy, uuid);
	if (holder === undefined)
		throw new Error(`The document holds no entity ${uuid}.`);
	holder.planted = true;
	return copy;
}

/** Every entity of `doc` with its kind. */
export function entitiesOf(doc: BlueprintDoc) {
	return authoredBlueprintIdentities(doc);
}
