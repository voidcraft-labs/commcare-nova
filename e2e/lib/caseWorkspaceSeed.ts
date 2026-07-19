/**
 * Stable patient-workspace fixture for hands-on Search / Results / Details QA.
 *
 * The app id and case-row ids are minted by the real stores on each seed run,
 * but every authored entity id and every displayed value below is fixed. That
 * gives screenshots and selectors a readable, repeatable surface without
 * risking primary-key collisions against an older fixture left in the local
 * persistent Postgres volume.
 */

import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { CaseInsert } from "@/lib/case-store";
import {
	asUuid,
	type BlueprintDoc,
	dateColumn,
	fuzzyMode,
	idMappingColumn,
	idMappingEntry,
	phoneColumn,
	plainColumn,
	simpleSearchInputDef,
	startsWithMode,
} from "@/lib/domain";
import { buildUrl } from "@/lib/routing/location";

export const CASE_WORKSPACE_SEED = {
	appName: "Visual QA — Patient workspace",
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
	caseCount: 8,
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
					{ name: "village", label: "Village", data_type: "text" },
					{
						name: "last_visit",
						label: "Last visit",
						data_type: "date",
					},
					{
						name: "care_priority",
						label: "Care priority",
						data_type: "text",
						options: [
							{ value: "routine", label: "Routine" },
							{ value: "priority", label: "Priority" },
							{ value: "urgent", label: "Urgent" },
						],
					},
					{
						name: "phone_number",
						label: "Phone number",
						data_type: "text",
					},
					{
						name: "date_of_birth",
						label: "Date of birth",
						data_type: "date",
					},
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
		],
	});
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
		},
	}));
}

export interface CaseWorkspaceRoutes {
	readonly search: string;
	readonly results: string;
	readonly details: string;
	readonly firstCase: string;
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
		firstCase: buildUrl(basePath, {
			kind: "cases",
			moduleUuid,
			caseId: firstCaseId,
		}),
	};
}
