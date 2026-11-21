import "server-only";

/**
 * The one read of a bring-in's project data: CommCare HQ's lookup tables the
 * source may read, with their rows; the Project's tables of those tags; and,
 * where the source may read places, CommCare HQ's levels and places. Every
 * decision is `index.ts`'s; this file only reads.
 */

import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { classifyHqFailure, type HqFailure } from "@/lib/commcare/hq/failure";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import {
	type HqLocation,
	type HqLocationType,
	listHqLocations,
	listHqLocationTypes,
} from "@/lib/commcare/hq/locations";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import { getAppDb } from "@/lib/db/pg";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { recordFromEntries } from "@/lib/domain/records";
import { readLookupFixtureDataInTransaction } from "@/lib/lookup/fixtureSnapshot";
import {
	measureLookupRows,
	readKeptLookupColumnIds,
} from "@/lib/lookup/managed";
import type { LookupRowsMeasure } from "@/lib/lookup/managedRules";
import { readAllLookupDefinitionsInTransaction } from "@/lib/lookup/service";
import type {
	LookupFixtureRow,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupRowValues,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { MAX_LOCATIONS_PER_APP } from "@/lib/organization/schema";
import {
	readSiblingLookupMappings,
	type SiblingLookupMapping,
} from "../../store";
import { isDeploymentServer } from "../../types";
import {
	assembleReadingProjectData,
	type ReadingPlacesRead,
	type ReadingProjectData,
	rowsToMeasure,
} from "./index";
import { readHqLookupTablesForReading } from "./lookupTableStore";
import { sourceMayReadPlaces } from "./places";

/** The Project's side of the read, and Postgres's measure of candidate rows. */
export interface ReadingProjectSide {
	/**
	 * The Project's tables whose tag is one of `tags`, each with its rows and
	 * the columns CommCare HQ's content would keep (`ReadingProjectAnswers.keptColumns`),
	 * in one snapshot.
	 */
	readonly tables: (tags: readonly string[]) => Promise<{
		readonly projectId: string;
		readonly projectRevision: LookupRevision;
		readonly definitions: readonly LookupTableDefinition[];
		readonly rowsByTable: Readonly<Record<string, readonly LookupFixtureRow[]>>;
		readonly keptColumns: Readonly<Record<string, readonly string[]>>;
	}>;
	/** The apps that reference each table, by table id. */
	readonly referencingApps: (
		tableIds: readonly string[],
	) => Promise<
		Readonly<Record<string, readonly LookupReferencingAppSummary[]>>
	>;
	/** Live mappings of the Project's other apps for these tables on the origin. */
	readonly siblings: (
		tableIds: readonly string[],
	) => Promise<readonly SiblingLookupMapping[]>;
	/** Whether the actor holds the Project's `delete` capability. */
	readonly mayAdminister: () => Promise<boolean>;
	/** What Postgres measures of candidate rows. */
	readonly measureRows: (
		rows: readonly LookupRowValues[],
	) => Promise<LookupRowsMeasure>;
}

/**
 * Production's binding of the Project's side: one read-only snapshot of the
 * Project's tables of the tags with their rows, the apps whose reference
 * edges name each table, the sibling mappings of the Project's other apps on
 * the origin (`appId` names the app, which no deployment names yet), the
 * actor's role, and `measureLookupRows`. Every read asks the actor's role
 * first, and a person who may not view the Project reads nothing.
 */
export function postgresProjectSide(input: {
	readonly projectId: string;
	readonly actorUserId: string;
	readonly appId: string;
	readonly origin: { readonly server: string; readonly domain: string };
}): ReadingProjectSide {
	const { projectId, actorUserId, appId, origin } = input;
	const { server } = origin;
	if (!isDeploymentServer(server)) {
		throw new Error(
			`A bring-in names the CommCare HQ server "${server}", which Nova does not know.`,
		);
	}
	let role: Promise<string> | undefined;
	const viewerRole = (): Promise<string> => {
		role ??= projectRoleFor(actorUserId, projectId).then((found) => {
			if (found === null || !roleAllowsApp(found, "view")) {
				throw new Error(
					"The Project's side of a bring-in is read for a member who may view the Project.",
				);
			}
			return found;
		});
		return role;
	};
	return {
		async tables(tags) {
			await viewerRole();
			const wanted = new Set(tags);
			const db = await getAppDb();
			return db
				.transaction()
				.setIsolationLevel("repeatable read")
				.setAccessMode("read only")
				.execute(async (tx) => {
					const all = await readAllLookupDefinitionsInTransaction(
						tx,
						projectId,
					);
					const definitions = all.definitions.filter((definition) =>
						wanted.has(definition.tag),
					);
					const tableIds = definitions.map((definition) => definition.id);
					const fixture = await readLookupFixtureDataInTransaction(
						tx,
						projectId,
						tableIds,
					);
					return {
						projectId,
						projectRevision: all.projectRevision,
						definitions,
						rowsByTable: recordFromEntries(fixture.rowsByTable),
						keptColumns: await readKeptLookupColumnIds(tx, projectId, tableIds),
					};
				});
		},
		async referencingApps(tableIds) {
			await viewerRole();
			const db = await getAppDb();
			const answers = recordFromEntries<readonly LookupReferencingAppSummary[]>(
				[],
			);
			for (const tableId of tableIds) {
				answers[tableId] = await readLookupReferencingApps(db, {
					projectId,
					tableId: lookupTableIdSchema.parse(tableId),
				});
			}
			return answers;
		},
		async siblings(tableIds) {
			return readSiblingLookupMappings(
				{ appId, projectId, role: await viewerRole(), actorUserId },
				{ server, domain: origin.domain },
				tableIds,
			);
		},
		async mayAdminister() {
			return roleAllowsApp(await viewerRole(), "delete");
		},
		measureRows: measureLookupRows,
	};
}

/**
 * The text a source's test reads: the body as HQ served it and every form's
 * attachment. A test of the text, never a reading of an expression.
 */
function readingSourceText(source: HqAppSource): string {
	const parts = [JSON.stringify(source.raw)];
	for (const menu of source.modules)
		for (const form of menu.forms)
			if (form.attachment !== null) parts.push(form.attachment);
	return parts.join("\n");
}

type PlacesAnswer =
	| { readonly kind: "read"; readonly places: ReadingPlacesRead }
	| { readonly kind: "failed"; readonly failure: HqFailure };

/** CommCare HQ's levels, then its places, stopping once past Nova's limit. */
async function readPlacesOnce(
	creds: CommCareCredentials,
	domain: string,
	cancel: AbortSignal | undefined,
): Promise<PlacesAnswer> {
	const levels = await listHqLocationTypes(creds, domain, { cancel });
	if ("success" in levels) {
		return {
			kind: "failed",
			failure: classifyHqFailure(levels, "location-types"),
		};
	}
	const places = await listHqLocations(creds, domain, {
		cancel,
		stopPast: MAX_LOCATIONS_PER_APP,
	});
	if ("success" in places) {
		return { kind: "failed", failure: classifyHqFailure(places, "locations") };
	}
	if ("kind" in places) {
		return {
			kind: "read",
			places: {
				hqLevels: levels,
				hqPlaces: [],
				placesPastLimit: {
					totalCount: places.by === "rows" ? places.totalCount : null,
				},
			},
		};
	}
	return {
		kind: "read",
		places: { hqLevels: levels, hqPlaces: places, placesPastLimit: null },
	};
}

/** Whether every place stands at a level the level list holds. */
function placesAgreeWithLevels(
	levels: readonly HqLocationType[],
	places: readonly HqLocation[],
): boolean {
	const codes = new Set(levels.map((level) => level.code));
	return places.every((place) => codes.has(place.locationTypeCode));
}

/**
 * The levels and places. Where a place names a level the level list lacks,
 * the two reads straddled a change in CommCare HQ, and both are read once
 * more; a second pair that disagrees too is CommCare HQ not answering one
 * state.
 */
async function readPlaces(
	creds: CommCareCredentials,
	domain: string,
	cancel: AbortSignal | undefined,
): Promise<PlacesAnswer> {
	const first = await readPlacesOnce(creds, domain, cancel);
	if (
		first.kind === "failed" ||
		placesAgreeWithLevels(first.places.hqLevels, first.places.hqPlaces)
	) {
		return first;
	}
	const second = await readPlacesOnce(creds, domain, cancel);
	if (
		second.kind === "failed" ||
		placesAgreeWithLevels(second.places.hqLevels, second.places.hqPlaces)
	) {
		return second;
	}
	return {
		kind: "failed",
		failure: { kind: "hq-unavailable", request: "locations", status: 200 },
	};
}

/**
 * Read a bring-in's project data, in order: CommCare HQ's lookup tables the
 * source's text may name, with their rows; the Project's tables of those tags
 * through `project`, with the apps that read them, the columns CommCare HQ's
 * content would keep, the sibling mappings and whether the actor may
 * administer the Project; Postgres's measure of each candidate's rows that
 * have a stored form; and, where `places` is `always` or the source's text may
 * read places, CommCare HQ's levels and places. Every id derives from `appId`
 * and `readingId`, so nothing is minted and nothing is written. A failed read
 * of CommCare HQ is `failed`, classified by the read that failed; a table's
 * own unreadable rows or length is no failure, and neither is a failed read of
 * the levels and places that only the source's text asked for, which is held
 * as `placesUnread`, since the text's test can say yes for an app that reads
 * no place. The caller ends the reading with it as `unreadPlacesFailure`
 * says.
 */
export async function readReadingProjectData(input: {
	readonly creds: CommCareCredentials;
	readonly server: string;
	readonly domain: string;
	/** The app's id and the reading's id: every lookup id derives from them. */
	readonly appId: string;
	readonly readingId: string;
	readonly source: HqAppSource;
	/**
	 * Another source whose text names tables and places for this read too:
	 * a review of changes made in CommCare HQ reads one set of Project data
	 * for the baseline's source and the app now, which both readings share.
	 */
	readonly alsoSource?: HqAppSource;
	readonly project: ReadingProjectSide;
	/** `always` reads places whatever the source's text says. */
	readonly places: "when-source-reads" | "always";
	/** The caller's way to stop early, joined to each read's own deadline. */
	readonly cancel?: AbortSignal;
}): Promise<
	| { readonly kind: "read"; readonly data: ReadingProjectData }
	| { readonly kind: "failed"; readonly failure: HqFailure }
> {
	const { creds, domain, cancel, project } = input;
	const ids = { appId: input.appId, readingId: input.readingId };
	const sourceText =
		input.alsoSource === undefined
			? readingSourceText(input.source)
			: `${readingSourceText(input.source)}\n${readingSourceText(input.alsoSource)}`;

	/* Dated before CommCare HQ is asked, as every refresh dates its read. */
	const tablesReadAt = new Date();
	const lookups = await readHqLookupTablesForReading({
		creds,
		domain,
		sourceText,
		cancel,
	});
	if ("success" in lookups) {
		return {
			kind: "failed",
			failure: classifyHqFailure(lookups, lookups.request),
		};
	}

	const tags = lookups.tables.map((read) => read.table.tag);
	const projectTables = await project.tables(tags);
	const tableIds = projectTables.definitions.map((definition) => definition.id);
	const apps = await project.referencingApps(tableIds);
	const siblings = await project.siblings(tableIds);
	const mayAdminister = await project.mayAdminister();

	const measured = new Map<string, LookupRowsMeasure | null>();
	for (const read of lookups.tables) {
		const rows = rowsToMeasure(read, ids);
		measured.set(
			read.table.tag,
			rows === null ? null : await project.measureRows(rows),
		);
	}

	let places: ReadingPlacesRead | null = null;
	let placesUnread: HqFailure | null = null;
	if (input.places === "always" || sourceMayReadPlaces(sourceText)) {
		const answer = await readPlaces(creds, domain, cancel);
		if (answer.kind === "read") places = answer.places;
		else if (input.places === "always" || cancel?.aborted === true) {
			return answer;
		} else placesUnread = answer.failure;
	}

	return {
		kind: "read",
		data: assembleReadingProjectData({
			origin: { server: input.server, domain },
			appId: input.appId,
			readingId: input.readingId,
			tablesReadAt,
			tables: lookups.tables,
			hqTags: lookups.listed,
			project: {
				projectId: projectTables.projectId,
				projectRevision: projectTables.projectRevision,
				definitions: projectTables.definitions,
				rowsByTable: projectTables.rowsByTable,
				apps,
				keptColumns: projectTables.keptColumns,
				siblings,
				mayAdminister,
			},
			measured,
			places,
			placesUnread,
		}),
	};
}
