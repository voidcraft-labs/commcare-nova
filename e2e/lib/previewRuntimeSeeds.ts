/**
 * Five running-app fixtures that only a real browser over real case rows can
 * exercise, one per smoke:
 *
 * - **form-refused**: a follow-up form whose date question preloads a case
 *   property. One record holds text that no date cast accepts, the shape an
 *   import leaves behind, so CommCare refuses to open the form for it; the
 *   other holds a real date and opens normally. Results show only the name,
 *   so neither the list nor its sort reads the refused value.
 * - **here-column**: a case list whose calculated column is a raw `here()`,
 *   which fills from the browser's position and re-reads on Android's rule.
 * - **search-claim**: a search-first module whose one matching record is
 *   owned by a persona other than the one searching, so opening its form
 *   depends on the search's claim bringing the case onto the device.
 * - **search-results**: a search-first module whose form reads what the
 *   search found, so it opens only after a completed search; reached from a
 *   reloaded record link, which keeps no search, it offers the way back to
 *   Search instead.
 * - **search-choice**: a search-first module whose Radius field narrows sites
 *   to those near a point. The journey authors "Depends on a condition" and a
 *   distance read from the Radius answer in that field's condition, then
 *   watches Preview's results change with the Area and Radius answers. Three
 *   sites sit about 1, 6 and 56 kilometers from the point.
 *
 * Each journey reads its own rows, so every Playwright attempt gets its own
 * app through its native profile.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	calculatedColumn,
	fuzzyMode,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	count,
	input,
	literal,
	matchAll,
	prop,
	term,
	whenInput,
	within,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const FORM_REFUSED_SEED = {
	appName: "Smoke — Refused preload",
	moduleUuid: testUuid("form-refused-module"),
	formUuid: testUuid("form-refused-form"),
	moduleName: "Patients",
	formName: "Check due date",
	caseType: "patient",
	property: "due_date",
	propertyLabel: "Due date",
	columnUuid: testUuid("form-refused-name-column"),
	/** The imported record: its due date is text no date cast accepts. */
	refused: { caseName: "Ada Okafor", value: "next week" },
	/** The record that opens the form. */
	opens: { caseName: "Bea Lund", value: "2026-11-02" },
} as const;

export function buildFormRefusedBlueprint(appId: string): BlueprintDoc {
	const seed = FORM_REFUSED_SEED;
	return buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{
						name: seed.property,
						label: proseText(seed.propertyLabel),
						data_type: "date",
					},
				],
			},
		],
		modules: [
			{
				uuid: seed.moduleUuid,
				name: seed.moduleName,
				caseType: seed.caseType,
				// Results show and sort on the name only: the refused value is
				// read by the form's preload and nothing else.
				caseListConfig: {
					columns: [plainColumn(seed.columnUuid, "case_name", "Patient")],
					searchInputs: [],
				},
				forms: [
					{
						uuid: seed.formUuid,
						name: seed.formName,
						type: "followup",
						fields: [
							f({
								kind: "date",
								id: seed.property,
								label: proseText(seed.propertyLabel),
								caseWrite: {
									caseType: seed.caseType,
									property: seed.property,
								},
							}),
						],
					},
				],
			},
		],
	});
}

export const HERE_COLUMN_SEED = {
	appName: "Smoke — Location column",
	moduleUuid: testUuid("here-column-module"),
	moduleName: "Patients",
	caseType: "patient",
	caseName: "Ada Okafor",
	columns: {
		name: testUuid("here-column-name"),
		position: testUuid("here-column-position"),
	},
} as const;

export function buildHereColumnBlueprint(appId: string): BlueprintDoc {
	const seed = HERE_COLUMN_SEED;
	return buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{ name: "note", label: proseText("Note"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: seed.moduleUuid,
				name: seed.moduleName,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [
						plainColumn(seed.columns.name, "case_name", "Patient"),
						calculatedColumn(seed.columns.position, "Your position", {
							kind: "here",
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}

export function hereColumnRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "module",
		moduleUuid: HERE_COLUMN_SEED.moduleUuid,
	});
}

export function formRefusedRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "module",
		moduleUuid: FORM_REFUSED_SEED.moduleUuid,
	});
}

export const SEARCH_CLAIM_SEED = {
	appName: "Smoke — Search claim",
	moduleUuid: testUuid("search-claim-module"),
	moduleName: "Patients",
	formName: "Visit",
	caseType: "patient",
	columnUuid: testUuid("search-claim-name-column"),
	searchInputUuid: testUuid("search-claim-name-input"),
	prompt: { name: "patient_name", label: "Patient name" },
	noteLabel: "Last note",
	/** The persona who searches. */
	searcher: { uuid: testUuid("search-claim-asha"), name: "Asha" },
	/** The persona who owns the matching record. */
	owner: { uuid: testUuid("search-claim-ben"), name: "Ben" },
	match: { caseName: "Kofi Mensah", lastNote: "Seen at the clinic" },
} as const;

export function buildSearchClaimBlueprint(appId: string): BlueprintDoc {
	const seed = SEARCH_CLAIM_SEED;
	const doc = buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{
						name: "last_note",
						label: proseText(seed.noteLabel),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: seed.moduleUuid,
				name: seed.moduleName,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [plainColumn(seed.columnUuid, "case_name", "Patient")],
					searchInputs: [
						simpleSearchInputDef(
							seed.searchInputUuid,
							seed.prompt.name,
							seed.prompt.label,
							"text",
							"case_name",
							{ mode: fuzzyMode() },
						),
					],
				},
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						name: seed.formName,
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "last_note",
								label: proseText(seed.noteLabel),
								caseWrite: { caseType: seed.caseType, property: "last_note" },
							}),
						],
					},
				],
			},
		],
	});
	doc.personas = {
		[seed.searcher.uuid]: {
			uuid: seed.searcher.uuid,
			name: seed.searcher.name,
		},
		[seed.owner.uuid]: { uuid: seed.owner.uuid, name: seed.owner.name },
	};
	doc.personaOrder = [seed.searcher.uuid, seed.owner.uuid];
	return doc;
}

export const SEARCH_RESULTS_SEED = {
	appName: "Smoke — Search results",
	moduleUuid: testUuid("search-results-module"),
	moduleName: "Patients",
	formName: "Check in",
	caseType: "patient",
	columnUuid: testUuid("search-results-name-column"),
	searchInputUuid: testUuid("search-results-name-input"),
	prompt: { name: "patient_name", label: "Patient name" },
	noteLabel: "Note",
	match: { caseName: "Kofi Mensah" },
} as const;

export function buildSearchResultsBlueprint(appId: string): BlueprintDoc {
	const seed = SEARCH_RESULTS_SEED;
	return buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{ name: "note", label: proseText(seed.noteLabel), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: seed.moduleUuid,
				name: seed.moduleName,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [plainColumn(seed.columnUuid, "case_name", "Patient")],
					searchInputs: [
						simpleSearchInputDef(
							seed.searchInputUuid,
							seed.prompt.name,
							seed.prompt.label,
							"text",
							"case_name",
							{ mode: fuzzyMode() },
						),
					],
				},
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						name: seed.formName,
						type: "followup",
						fields: [
							// How many patients the search found.
							f({
								kind: "hidden",
								id: "found",
								calculate: count({
									kind: "cases",
									source: "search-results",
									where: [],
								}),
							}),
							f({
								kind: "text",
								id: "note",
								label: proseText(seed.noteLabel),
								caseWrite: { caseType: seed.caseType, property: "note" },
							}),
						],
					},
				],
			},
		],
	});
}

export const SEARCH_CHOICE_SEED = {
	appName: "Smoke — Search choice",
	moduleUuid: testUuid("search-choice-module"),
	moduleName: "Sites",
	caseType: "site",
	columnUuid: testUuid("search-choice-name-column"),
	radius: {
		uuid: testUuid("search-choice-radius-input"),
		name: "radius",
		label: "Radius in km",
	},
	area: {
		uuid: testUuid("search-choice-area-input"),
		name: "area",
		label: "Area",
	},
	/** The fixed radius both branches start with, in kilometers. */
	startRadiusKm: 2,
	/** About 1.1, 5.6 and 55.6 km east of 0 0 along the equator. */
	sites: [
		{ caseName: "Clinic yard", home: "0 0.01" },
		{ caseName: "Market", home: "0 0.05" },
		{ caseName: "Hill farm", home: "0 0.5" },
	],
} as const;

/** The Radius field applies, once answered, "home is within 2 km of 0 0";
 * the Area field narrows nothing on its own. The journey makes the Radius
 * condition depend on whether Area is answered. */
export function buildSearchChoiceBlueprint(appId: string): BlueprintDoc {
	const seed = SEARCH_CHOICE_SEED;
	return buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{ name: "home", label: proseText("Home"), data_type: "geopoint" },
					{ name: "note", label: proseText("Note"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: seed.moduleUuid,
				name: seed.moduleName,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [plainColumn(seed.columnUuid, "case_name", "Site")],
					searchInputs: [
						advancedSearchInputDef(
							seed.radius.uuid,
							seed.radius.name,
							seed.radius.label,
							"text",
							whenInput(
								input(seed.radius.uuid),
								within(
									prop(seed.caseType, "home"),
									term(literal("0 0")),
									seed.startRadiusKm,
									"kilometers",
								),
							),
						),
						advancedSearchInputDef(
							seed.area.uuid,
							seed.area.name,
							seed.area.label,
							"text",
							matchAll(),
						),
					],
				},
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						name: "Visit site",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: seed.caseType, property: "note" },
							}),
						],
					},
				],
			},
		],
	});
}

export function searchChoiceRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "search-config",
		moduleUuid: SEARCH_CHOICE_SEED.moduleUuid,
	});
}
