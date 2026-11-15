/**
 * An app brought in from CommCare HQ with Project data CommCare HQ manages,
 * for the journey that shows what Nova offers on such data: a lookup table
 * that is a copy of the project space's, and places that are a copy of its
 * organization.
 *
 * The copies are written through the two writers a bring-in uses
 * (`createManagedLookupTablesInTransaction` and
 * `writeManagedPlacesInTransaction`), from CommCare HQ's answers in the
 * shapes `lib/commcare/hq` reads, so every origin column is what a real
 * bring-in stores. One form chooses from the table, so the table's
 * confirmations have an app to name. The app holds no persona.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { HqLocation } from "@/lib/commcare/hq/locations";
import type {
	HqFixtureRow,
	HqLookupTable,
} from "@/lib/commcare/hq/lookupTables";
import {
	type BlueprintDoc,
	type OrganizationLevel,
	organizationLevelSchema,
} from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const MANAGED_DATA_SEED = {
	appName: "Smoke — Managed data",
	/** The CommCare HQ server and project space the copies came from. */
	server: "india",
	domain: "district-health",
	/** The account the owner's stored connection names. */
	username: "smoke-owner@district-health.example",
	table: {
		name: "Facilities",
		tag: "facilities",
		remoteId: "9f2c1d0e4b5a46c7b8d9e0f1a2b3c4d5",
		fields: ["code", "name"],
		rows: [
			{ code: "north_clinic", name: "North clinic" },
			{ code: "south_clinic", name: "South clinic" },
		],
	},
	moduleName: "Visits",
	formName: "Facility visit",
	questionLabel: "Facility",
	levels: {
		district: {
			uuid: testUuid("managed-data-level-district"),
			code: "district",
			name: "District",
		},
		clinic: {
			uuid: testUuid("managed-data-level-clinic"),
			code: "clinic",
			name: "Clinic",
		},
	},
	places: {
		district: { name: "North district", siteCode: "north_district" },
		clinic: { name: "North clinic", siteCode: "north_clinic" },
	},
	/** When the bring-in read CommCare HQ. */
	broughtInAt: "2026-11-10T09:00:00.000Z",
} as const;

/** CommCare HQ's table as `listHqLookupTables` reads it. */
export function managedHqTable(): HqLookupTable {
	const { table } = MANAGED_DATA_SEED;
	return {
		id: table.remoteId,
		tag: table.tag,
		isGlobal: true,
		fields: table.fields,
		fieldProperties: Object.fromEntries(
			table.fields.map((field) => [field, []]),
		),
		itemAttributes: [],
	};
}

/** The table's rows as `readHqLookupTableRows` reads them. */
export function managedHqRows(): HqFixtureRow[] {
	const { table } = MANAGED_DATA_SEED;
	return table.rows.map((row, index) => ({
		id: `${table.remoteId}-row-${index}`,
		fields: { ...row },
	}));
}

/** The project space's places as `listHqLocations` reads them, parent first. */
export function managedHqPlaces(): HqLocation[] {
	const { levels, places } = MANAGED_DATA_SEED;
	return [
		{
			locationId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
			name: places.district.name,
			siteCode: places.district.siteCode,
			locationTypeCode: levels.district.code,
			parentLocationId: null,
			latitude: null,
			longitude: null,
			values: {},
		},
		{
			locationId: "0f9e8d7c6b5a49382716a5b4c3d2e1f0",
			name: places.clinic.name,
			siteCode: places.clinic.siteCode,
			locationTypeCode: levels.clinic.code,
			parentLocationId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
			latitude: null,
			longitude: null,
			values: {},
		},
	];
}

/** The app's two levels, as a bring-in assumes them: every level holds workers, each carrying their own branch. */
export function managedDataLevels(): OrganizationLevel[] {
	const { district, clinic } = MANAGED_DATA_SEED.levels;
	const caseFlow = {
		workers: "assigned",
		ownsCases: true,
		descendantCases: { kind: "none" },
	} as const;
	return [
		organizationLevelSchema.parse({
			uuid: district.uuid,
			code: district.code,
			name: district.name,
			caseFlow,
			addressBook: { reach: "own-branch" },
		}),
		organizationLevelSchema.parse({
			uuid: clinic.uuid,
			code: clinic.code,
			name: clinic.name,
			parentLevelUuid: district.uuid,
			caseFlow,
			addressBook: { reach: "own-branch" },
		}),
	];
}

/** The app: one survey whose question chooses a facility from the managed table. */
export function buildManagedDataBlueprint(
	appId: string,
	table: {
		readonly tableId: LookupTableId;
		readonly columns: Readonly<Record<string, LookupColumnId>>;
	},
): BlueprintDoc {
	const seed = MANAGED_DATA_SEED;
	const code = table.columns.code;
	const name = table.columns.name;
	if (code === undefined || name === undefined) {
		throw new Error("The managed table needs its code and name columns.");
	}
	const doc = buildDoc({
		appName: seed.appName,
		modules: [
			{
				name: seed.moduleName,
				forms: [
					{
						name: seed.formName,
						type: "survey",
						fields: [
							{
								id: "facility",
								kind: "single_select" as const,
								label: proseText(seed.questionLabel),
								optionsSource: {
									kind: "lookup" as const,
									tableId: table.tableId,
									valueColumnId: code,
									labelColumnId: name,
								},
							},
						],
					},
				],
			},
		],
	});
	doc.appId = appId;
	const levels = managedDataLevels();
	doc.organizationLevels = Object.fromEntries(
		levels.map((level) => [level.uuid, level]),
	);
	doc.organizationLevelOrder = levels.map((level) => level.uuid);
	return doc;
}

/** Where the journey opens each screen. */
export function managedDataRoutes(appId: string, tableId: LookupTableId) {
	const base = `/build/${appId}`;
	return {
		tables: buildUrl(base, { kind: "project-data" }),
		table: buildUrl(base, { kind: "project-data", tableId }),
		organization: buildUrl(base, {
			kind: "app-setup",
			section: "organization",
		}),
		users: buildUrl(base, { kind: "app-setup", section: "users" }),
	};
}
