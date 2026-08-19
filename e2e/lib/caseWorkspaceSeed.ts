/**
 * Stable patient-workspace fixture for hands-on Search / Results / Details QA.
 *
 * The app id and case-row ids are minted by the real stores on each seed run,
 * but every authored entity id and every displayed value below is fixed. That
 * gives screenshots and selectors a readable, repeatable surface without
 * risking primary-key collisions against an older fixture left in the local
 * persistent Postgres volume.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { CaseInsert } from "@/lib/case-store";
import {
	asUuid,
	type BlueprintDoc,
	calculatedColumn,
	dateColumn,
	fuzzyMode,
	idMappingColumn,
	idMappingEntry,
	phoneColumn,
	plainColumn,
	simpleSearchInputDef,
	startsWithMode,
	tileCell,
} from "@/lib/domain";
import {
	ancestorPath,
	prop,
	relationStep,
	term,
} from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const CASE_WORKSPACE_SEED = {
	appName: "Visual QA — Patient workspace",
	/** The Project data table the smoke path binds a select to. Its name and
	 *  column labels are asserted verbatim, so they are fixed here. */
	lookupTableName: "Referral destinations",
	lookupTableTag: "referral_destinations",
	lookupValueColumnLabel: "Code",
	lookupLabelColumnLabel: "Destination",
	lookupTimeColumnLabel: "Opening time",
	lookupDatetimeColumnLabel: "Last verified",
	/** A deliberately empty table proves columns and their settings do not
	 * disappear merely because there are no row cells to render. */
	emptyLookupTableName: "Referral tiers",
	emptyLookupTableTag: "referral_tiers",
	emptyLookupColumnLabel: "Tier",
	moduleName: "Patients",
	moduleUuid: asUuid("7b4e2c91-5a68-4d3f-8c72-1e9a6b5d4f30"),
	caseType: "patient",
	columns: {
		patientName: asUuid("62f4a8d1-3c75-4e09-9b21-7d6a5c4f3e10"),
		patientId: asUuid("1c8d5e72-4b39-46a1-8f07-2e6c9a5d3b40"),
		village: asUuid("93a6d2f4-7e18-4c50-a3b9-5d1f8e6c2a70"),
		lastVisit: asUuid("4e7b1c95-2d68-4a30-9f42-8c5e1a6d7b20"),
		carePriority: asUuid("8a2f6d31-5c94-47e0-b168-3d7a9c4e2f50"),
		phoneNumber: asUuid("5d9c3a76-1e42-4b80-a5f7-6c2d8e4a9b10"),
		dateOfBirth: asUuid("2f6a8c43-9d15-4e70-8b32-1c5f7a9d6e40"),
	},
	searchInputs: {
		patientName: asUuid("a3d7f1c5-6e29-4b80-9a42-5c8d2e7f1b60"),
		patientId: asUuid("c8e2a5d9-1f64-4730-b7a6-4d9c2e5f8a10"),
		village: asUuid("6f1b4d82-9a35-4c70-8e26-3d7f5a1c9b40"),
		lastVisit: asUuid("d5a9c2e7-4b18-46f0-a3d5-8c1e7b9f2a60"),
	},
	/**
	 * The second module: the same patients drawn as a case tile, with a
	 * follow-up form so the persistent tile has somewhere to pin. It shares
	 * the case type (and therefore the rows) with the module above, so one
	 * seeded population feeds both the row layout and the tile layout.
	 */
	tile: {
		moduleUuid: asUuid("0d5c9e18-6b47-4a32-9e75-2c8b1f4d6a90"),
		formUuid: asUuid("b7e1a4c6-3f52-4d18-8a94-6e2c5d9f1b30"),
		columns: {
			patientName: asUuid("e4c17a95-8d23-4b60-9f18-5a7c3e2d8f40"),
			carePriority: asUuid("7a3e9d51-2c68-4f04-b592-8d1a6c4e7b20"),
			village: asUuid("5c2a8f31-9e46-4d70-b183-4a6f2c8e1d50"),
			lastVisit: asUuid("9b6d2f47-5a13-4e80-8c26-7f4a1d9e5c30"),
			phoneNumber: asUuid("3e8b5d29-7c14-4a60-9f37-1b5e8a2c6d40"),
		},
		selectFieldUuid: asUuid("2f9c4b78-1d63-4e25-a840-7c3b6e1f5d90"),
		/* Every field the `record_visit` form authors, in render order. A test
		 * asserting how many rows the canvas draws reads this rather than a
		 * literal, so adding a field here can never leave a stale count behind
		 * in a spec that never mentions the field. */
		formFieldIds: ["visit_note", "referred_to", "visit_started", "next_dose"],
	},
	caseCount: 8,
	/**
	 * The third module: a GROUPED tile, on its own household/visit pair so it
	 * adds nothing to the patient fixture every other spec reads.
	 *
	 * Visit names interleave the two households on purpose — Ada, Ben, Cal,
	 * Dot alphabetically — so a list that shows whole groups is really showing
	 * the clustering rather than the sort. Eve has no household at all, which
	 * is the empty group key the device produces for a case carrying no such
	 * connection.
	 */
	grouped: {
		moduleUuid: asUuid("1a7f3c58-2e94-4b60-9d13-6c8a5f2e7b40"),
		householdCaseType: "household",
		visitCaseType: "visit",
		columns: {
			householdVillage: asUuid("6d2b9e41-7a35-4c80-b529-1f8c4a6d3e70"),
			visitName: asUuid("4f8c1a63-9d27-4e50-8b41-3a6e2c9f5d80"),
			visitOutcome: asUuid("8e3a5c72-1b46-4d90-a728-5c1f9d3b6a20"),
		},
		/** Household names, in the order the grouped list shows them. */
		households: ["Kijiji ward", "Riverside ward"],
		/** Visit names, in the order the grouped list shows them. */
		visitOrder: ["Ada", "Cal", "Ben", "Dot", "Eve"],
		headerRows: 1,
	},
} as const;

/**
 * Build the exact blueprint installed into the seed app.
 *
 * Only Nova's canonical standard property names are authored (`case_name`,
 * `external_id`): the historical CCHQ aliases (`name`, `external-id`) never
 * enter this fixture. Phone and date of birth are deliberately Details-only,
 * which exercises that valid but secondary configuration without filling the
 * Results editor with hidden rows.
 */
export function buildCaseWorkspaceBlueprint(appId: string): BlueprintDoc {
	const ids = CASE_WORKSPACE_SEED;
	return buildDoc({
		appId,
		appName: ids.appName,
		caseTypes: [
			{
				name: ids.caseType,
				properties: [
					{ name: "village", label: proseText("Village"), data_type: "text" },
					{
						name: "last_visit",
						label: proseText("Last visit"),
						data_type: "date",
					},
					{
						name: "care_priority",
						label: proseText("Care priority"),
						data_type: "text",
						options: [
							{ value: "routine", label: proseText("Routine") },
							{ value: "priority", label: proseText("Priority") },
							{ value: "urgent", label: proseText("Urgent") },
						],
					},
					{
						name: "phone_number",
						label: proseText("Phone number"),
						data_type: "text",
					},
					{
						name: "date_of_birth",
						label: proseText("Date of birth"),
						data_type: "date",
					},
				],
			},
			// The grouped module's own pair, kept separate from `patient` so a
			// grouped fixture adds nothing to the population every other spec
			// reads.
			{
				name: ids.grouped.householdCaseType,
				properties: [
					{ name: "village", label: proseText("Village"), data_type: "text" },
				],
			},
			{
				name: ids.grouped.visitCaseType,
				parent_type: ids.grouped.householdCaseType,
				properties: [
					{ name: "outcome", label: proseText("Outcome"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: ids.moduleUuid,
				id: "patients",
				name: ids.moduleName,
				caseType: ids.caseType,
				caseListOnly: true,
				caseListConfig: {
					columns: [
						plainColumn(ids.columns.patientName, "case_name", "Patient", {
							visibleInList: true,
							visibleInDetail: true,
							sort: { direction: "asc", priority: 1 },
						}),
						plainColumn(ids.columns.patientId, "external_id", "Patient ID", {
							visibleInList: true,
							visibleInDetail: true,
						}),
						plainColumn(ids.columns.village, "village", "Village", {
							visibleInList: true,
							visibleInDetail: true,
						}),
						dateColumn(
							ids.columns.lastVisit,
							"last_visit",
							"Last visit",
							"%d %b %Y",
							{
								visibleInList: true,
								visibleInDetail: true,
								sort: { direction: "desc", priority: 0 },
							},
						),
						idMappingColumn(
							ids.columns.carePriority,
							"care_priority",
							"Care priority",
							[
								idMappingEntry("routine", "Routine"),
								idMappingEntry("priority", "Priority"),
								idMappingEntry("urgent", "Urgent"),
							],
							{ visibleInList: true, visibleInDetail: true },
						),
						phoneColumn(
							ids.columns.phoneNumber,
							"phone_number",
							"Phone number",
							{ visibleInList: false, visibleInDetail: true },
						),
						dateColumn(
							ids.columns.dateOfBirth,
							"date_of_birth",
							"Date of birth",
							"%d %b %Y",
							{ visibleInList: false, visibleInDetail: true },
						),
					],
					listColumnOrder: [
						ids.columns.patientName,
						ids.columns.patientId,
						ids.columns.village,
						ids.columns.lastVisit,
						ids.columns.carePriority,
						ids.columns.phoneNumber,
						ids.columns.dateOfBirth,
					],
					detailColumnOrder: [
						ids.columns.patientName,
						ids.columns.patientId,
						ids.columns.village,
						ids.columns.lastVisit,
						ids.columns.carePriority,
						ids.columns.phoneNumber,
						ids.columns.dateOfBirth,
					],
					searchInputs: [
						simpleSearchInputDef(
							ids.searchInputs.patientName,
							"patient_name",
							"Patient name",
							"text",
							"case_name",
							{ mode: fuzzyMode() },
						),
						simpleSearchInputDef(
							ids.searchInputs.patientId,
							"patient_id",
							"Patient ID",
							"text",
							"external_id",
						),
						simpleSearchInputDef(
							ids.searchInputs.village,
							"village",
							"Village",
							"text",
							"village",
							{ mode: startsWithMode() },
						),
						simpleSearchInputDef(
							ids.searchInputs.lastVisit,
							"last_visit",
							"Last visit",
							"date-range",
							"last_visit",
						),
					],
				},
				// No subtitle on purpose: the search editor must center a lone title
				// and only make room when the author actually adds supporting copy.
				caseSearchConfig: {
					searchScreenTitle: "Find a patient",
					searchButtonLabel: "Show patients",
				},
			},
			{
				uuid: ids.tile.moduleUuid,
				id: "patient_tile",
				name: "Patient tile",
				caseType: ids.caseType,
				// Nothing is shown on Details on purpose: with no confirm screen the
				// running tile continues straight into the follow-up form, which is
				// the shortest honest path to the persistent tile.
				caseListConfig: {
					// Presence is the switch; `persistOnForms` additionally keeps the
					// same tile above every form in this module.
					tile: { persistOnForms: true },
					columns: [
						plainColumn(ids.tile.columns.patientName, "case_name", "Patient", {
							visibleInList: true,
							visibleInDetail: false,
							sort: { direction: "asc", priority: 0 },
							tile: tileCell(0, 0, 4, 1, { fontSize: "large" }),
						}),
						// The one cell that asks for a box — which puts the WHOLE tile in
						// boxed layout, so its plain siblings become inset.
						idMappingColumn(
							ids.tile.columns.carePriority,
							"care_priority",
							"Care priority",
							[
								idMappingEntry("routine", "Routine"),
								idMappingEntry("priority", "Priority"),
								idMappingEntry("urgent", "Urgent"),
							],
							{
								visibleInList: true,
								visibleInDetail: false,
								tile: tileCell(4, 0, 2, 1, {
									horizontalAlign: "right",
									showBorder: true,
									showShading: true,
								}),
							},
						),
						plainColumn(ids.tile.columns.village, "village", "Village", {
							visibleInList: true,
							visibleInDetail: false,
							tile: tileCell(0, 1, 3, 1, { fontSize: "small" }),
						}),
						dateColumn(
							ids.tile.columns.lastVisit,
							"last_visit",
							"Last visit",
							"%d %b %Y",
							{
								visibleInList: true,
								visibleInDetail: false,
								tile: tileCell(3, 1, 3, 1, {
									horizontalAlign: "right",
									fontSize: "small",
								}),
							},
						),
						// An authored cell ACTION on a tile: the phone link has to stay a
						// sibling of the row's own action, never a child of it.
						phoneColumn(
							ids.tile.columns.phoneNumber,
							"phone_number",
							"Phone number",
							{
								visibleInList: true,
								visibleInDetail: false,
								tile: tileCell(0, 2, 6, 1, { fontSize: "small" }),
							},
						),
					],
					listColumnOrder: [
						ids.tile.columns.patientName,
						ids.tile.columns.carePriority,
						ids.tile.columns.village,
						ids.tile.columns.lastVisit,
						ids.tile.columns.phoneNumber,
					],
					detailColumnOrder: [
						ids.tile.columns.patientName,
						ids.tile.columns.carePriority,
						ids.tile.columns.village,
						ids.tile.columns.lastVisit,
						ids.tile.columns.phoneNumber,
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: ids.tile.formUuid,
						id: "record_visit",
						name: "Record a visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "visit_note",
								label: proseText("Visit note"),
								caseWrite: { caseType: ids.caseType, property: "visit_note" },
							}),
							/* The binding target for the Project data smoke path. It ships
							 * with typed-in options precisely because those are what the
							 * asymmetric switch keeps as the fallback — the smoke proves a
							 * table can be bound over them and that they come back. */
							f({
								uuid: ids.tile.selectFieldUuid,
								kind: "single_select",
								id: "referred_to",
								label: "Referred to",
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: asUuid("c3becee8-294f-4477-a8aa-868f0634bb6f"),
											value: "clinic",
											label: "Clinic",
										},
										{
											uuid: asUuid("91de4f27-6304-4442-a5af-b171071d9051"),
											value: "hospital",
											label: "Hospital",
										},
									],
								},
							}),
							// The two answers whose stored shape a native browser
							// input cannot render: a datetime carries a zone
							// designator and a time carries the `Z` storage tag.
							// Both are case properties so opening this form on a
							// seeded row exercises preload, not just entry.
							f({
								kind: "datetime",
								id: "visit_started",
								label: proseText("Visit started"),
								caseWrite: {
									caseType: ids.caseType,
									property: "visit_started",
								},
							}),
							f({
								kind: "time",
								id: "next_dose",
								label: proseText("Next dose"),
								caseWrite: { caseType: ids.caseType, property: "next_dose" },
							}),
						],
					},
				],
			},
			{
				uuid: ids.grouped.moduleUuid,
				id: "visit_group",
				name: "Visits by household",
				caseType: ids.grouped.visitCaseType,
				caseListOnly: true,
				caseListConfig: {
					// The heading is one row deep, drawn from the group's first
					// visit. Its cell reads the HOUSEHOLD's village through the
					// visit's `parent` index — the pattern grouping is for, and the
					// one that proves a calculated projection survives the grouped
					// read.
					tile: {
						grouping: {
							identifier: "parent",
							headerRows: ids.grouped.headerRows,
						},
					},
					columns: [
						calculatedColumn(
							ids.grouped.columns.householdVillage,
							"Household village",
							term(
								prop(
									ids.grouped.visitCaseType,
									"village",
									ancestorPath(
										relationStep("parent", ids.grouped.householdCaseType),
									),
								),
							),
							{
								visibleInList: true,
								visibleInDetail: false,
								tile: tileCell(0, 0, 6, 1, { fontSize: "large" }),
							},
						),
						plainColumn(ids.grouped.columns.visitName, "case_name", "Visit", {
							visibleInList: true,
							visibleInDetail: true,
							sort: { direction: "asc", priority: 0 },
							tile: tileCell(0, 1, 3, 1),
						}),
						plainColumn(
							ids.grouped.columns.visitOutcome,
							"outcome",
							"Outcome",
							{
								visibleInList: true,
								visibleInDetail: true,
								tile: tileCell(3, 1, 3, 1, {
									horizontalAlign: "right",
									fontSize: "small",
								}),
							},
						),
					],
					listColumnOrder: [
						ids.grouped.columns.householdVillage,
						ids.grouped.columns.visitName,
						ids.grouped.columns.visitOutcome,
					],
					detailColumnOrder: [
						ids.grouped.columns.householdVillage,
						ids.grouped.columns.visitName,
						ids.grouped.columns.visitOutcome,
					],
					searchInputs: [],
				},
			},
		],
	});
}

/**
 * The grouped module's households, in display order. Inserted first so their
 * minted ids can index the visits below.
 */
export function caseWorkspaceHouseholdRows(): readonly CaseInsert[] {
	return [
		{ name: "Kijiji ward", village: "Kijiji" },
		{ name: "Riverside ward", village: "Riverside" },
	].map((household) => ({
		case_type: CASE_WORKSPACE_SEED.grouped.householdCaseType,
		case_name: household.name,
		status: "open" as const,
		properties: { village: household.village },
	}));
}

/**
 * The grouped module's visits. Names interleave the two households
 * alphabetically, so a list that shows whole groups is showing the clustering
 * rather than the sort — and Eve carries no household at all, which is the
 * empty group key.
 *
 * `householdIds` is the minted-id list from `caseWorkspaceHouseholdRows`, in
 * the same order.
 */
export function caseWorkspaceVisitRows(
	householdIds: readonly string[],
): readonly CaseInsert[] {
	const [kijiji, riverside] = householdIds;
	if (kijiji === undefined || riverside === undefined) {
		throw new Error(
			"e2e/lib/caseWorkspaceSeed.ts: caseWorkspaceVisitRows needs both household ids, in seeded order.",
		);
	}
	return [
		{ name: "Ada", household: kijiji, outcome: "Seen" },
		{ name: "Ben", household: riverside, outcome: "Referred" },
		{ name: "Cal", household: kijiji, outcome: "Referred" },
		{ name: "Dot", household: riverside, outcome: "Seen" },
		{ name: "Eve", household: undefined, outcome: "Seen" },
	].map((visit) => ({
		case_type: CASE_WORKSPACE_SEED.grouped.visitCaseType,
		case_name: visit.name,
		status: "open" as const,
		...(visit.household === undefined
			? {}
			: { parent_case_id: visit.household }),
		properties: { outcome: visit.outcome },
	}));
}

/** Stable displayed rows; the case store supplies fresh collision-safe ids. */
export function caseWorkspaceCaseRows(): readonly CaseInsert[] {
	const rows = [
		{
			caseName: "Amina Yusuf",
			externalId: "PAT-1042",
			openedOn: "2024-02-12T08:30:00.000Z",
			modifiedOn: "2026-07-14T09:20:00.000Z",
			village: "Kijiji",
			phoneNumber: "+254 712 555 014",
			dateOfBirth: "1988-03-14",
			lastVisit: "2026-07-14",
			carePriority: "urgent",
		},
		{
			caseName: "Daniel Mwangi",
			externalId: "PAT-1017",
			openedOn: "2023-11-03T10:00:00.000Z",
			modifiedOn: "2026-07-12T15:45:00.000Z",
			village: "Riverside",
			phoneNumber: "+254 733 555 018",
			dateOfBirth: "1976-11-02",
			lastVisit: "2026-07-12",
			carePriority: "routine",
		},
		{
			caseName: "Grace Ndlovu",
			externalId: "PAT-1093",
			openedOn: "2025-01-18T07:15:00.000Z",
			modifiedOn: "2026-07-10T11:05:00.000Z",
			village: "Mtoni",
			phoneNumber: "+27 82 555 0103",
			dateOfBirth: "1994-06-21",
			lastVisit: "2026-07-10",
			carePriority: "priority",
		},
		{
			caseName: "Josephine Banda",
			externalId: "PAT-1028",
			openedOn: "2022-08-29T13:10:00.000Z",
			modifiedOn: "2026-07-08T08:50:00.000Z",
			village: "Green Market",
			phoneNumber: "+265 991 555 022",
			dateOfBirth: "1968-09-30",
			lastVisit: "2026-07-08",
			carePriority: "urgent",
		},
		{
			caseName: "Samuel Okoro",
			externalId: "PAT-1064",
			openedOn: "2024-05-07T09:40:00.000Z",
			modifiedOn: "2026-07-05T16:30:00.000Z",
			village: "Hillside",
			phoneNumber: "+234 803 555 0164",
			dateOfBirth: "2001-01-19",
			lastVisit: "2026-07-05",
			carePriority: "routine",
		},
		{
			caseName: "Fatima Diallo",
			externalId: "PAT-1081",
			openedOn: "2023-04-16T12:25:00.000Z",
			modifiedOn: "2026-07-03T10:10:00.000Z",
			village: "Old Town",
			phoneNumber: "+221 77 555 0181",
			dateOfBirth: "1983-12-07",
			lastVisit: "2026-07-03",
			carePriority: "priority",
		},
		{
			caseName: "Elias Kamau",
			externalId: "PAT-1055",
			openedOn: "2025-09-22T08:05:00.000Z",
			modifiedOn: "2026-06-28T14:15:00.000Z",
			village: "Kijiji",
			phoneNumber: "+254 701 555 055",
			dateOfBirth: "2015-04-26",
			lastVisit: "2026-06-28",
			carePriority: "routine",
		},
		{
			caseName: "Mercy Chirwa",
			externalId: "PAT-1039",
			openedOn: "2021-06-11T11:35:00.000Z",
			modifiedOn: "2026-06-21T09:00:00.000Z",
			village: "Riverside",
			phoneNumber: "",
			dateOfBirth: "1959-08-11",
			lastVisit: "2026-06-21",
			carePriority: "priority",
		},
	] as const;

	return rows.map((row) => ({
		case_type: CASE_WORKSPACE_SEED.caseType,
		case_name: row.caseName,
		external_id: row.externalId,
		status: "open",
		opened_on: row.openedOn,
		modified_on: row.modifiedOn,
		properties: {
			village: row.village,
			phone_number: row.phoneNumber,
			date_of_birth: row.dateOfBirth,
			last_visit: row.lastVisit,
			care_priority: row.carePriority,
			visit_started: `${row.lastVisit}T${SEEDED_VISIT_START}`,
			next_dose: SEEDED_NEXT_DOSE,
		},
	}));
}

/**
 * The stored spellings a temporal case property actually carries
 * (`lib/domain/temporalValues.ts`): a datetime with the offset of the zone
 * it was entered in, a time with the `Z` storage tag on a naive wall clock.
 *
 * Two details are load-bearing rather than arbitrary.
 *
 * The datetime's offset is deliberately not the runner's. A form shows the
 * wall clock the answer was entered at rather than converting it, so an
 * assertion on `9:15 AM` holds in every CI timezone — and would fail the
 * moment the field started converting.
 *
 * The time deliberately carries NO milliseconds. That is the shape the
 * writer produced before the padding rule landed, so real rows hold it: it
 * is valid RFC 3339, the schema takes it, and a surface that confused "not
 * canonical" with "not valid" would refuse a submission over an answer
 * nobody typed. Keeping it here means that confusion cannot come back
 * unnoticed.
 */
const SEEDED_VISIT_START = "09:15:00.000-04:00";
const SEEDED_NEXT_DOSE = "08:45:00Z";

/** What those two stored values read as once a person can see them. */
export const SEEDED_TEMPORAL_DISPLAY = {
	visitStartedTime: "9:15 AM",
	nextDose: "8:45 AM",
} as const;

export interface CaseWorkspaceRoutes {
	readonly search: string;
	readonly results: string;
	readonly details: string;
	readonly condition: string;
	readonly firstCase: string;
	/** The tile-laid-out module's Results list. */
	readonly tileResults: string;
	/** The grouped tile module's Results list. */
	readonly groupedResults: string;
	/** The follow-up form that carries the module's persistent tile. */
	readonly tileForm: string;
	/** The Project data workspace's table list. */
	readonly projectData: string;
	/** That form with its select field selected, so the options-source editor
	 *  is what the inspector rail is showing. */
	readonly selectField: string;
}

/** Build canonical relative paths through the production route serializer. */
export function caseWorkspaceRoutes(
	appId: string,
	firstCaseId: string,
): CaseWorkspaceRoutes {
	const basePath = `/build/${appId}`;
	const moduleUuid = CASE_WORKSPACE_SEED.moduleUuid;
	return {
		search: buildUrl(basePath, { kind: "search-config", moduleUuid }),
		results: buildUrl(basePath, { kind: "cases", moduleUuid }),
		details: buildUrl(basePath, { kind: "detail-config", moduleUuid }),
		condition: buildUrl(basePath, { kind: "module-condition", moduleUuid }),
		firstCase: buildUrl(basePath, {
			kind: "cases",
			moduleUuid,
			caseId: firstCaseId,
		}),
		tileResults: buildUrl(basePath, {
			kind: "cases",
			moduleUuid: CASE_WORKSPACE_SEED.tile.moduleUuid,
		}),
		groupedResults: buildUrl(basePath, {
			kind: "cases",
			moduleUuid: CASE_WORKSPACE_SEED.grouped.moduleUuid,
		}),
		tileForm: buildUrl(basePath, {
			kind: "form",
			moduleUuid: CASE_WORKSPACE_SEED.tile.moduleUuid,
			formUuid: CASE_WORKSPACE_SEED.tile.formUuid,
		}),
		projectData: buildUrl(basePath, { kind: "project-data" }),
		selectField: buildUrl(basePath, {
			kind: "form",
			moduleUuid: CASE_WORKSPACE_SEED.tile.moduleUuid,
			formUuid: CASE_WORKSPACE_SEED.tile.formUuid,
			selectedUuid: CASE_WORKSPACE_SEED.tile.selectFieldUuid,
		}),
	};
}
