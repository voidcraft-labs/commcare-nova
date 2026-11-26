import "server-only";

/**
 * The one read of a bring-in's project data: CommCare HQ's lookup tables the
 * source may read, with their rows; the Project's tables of those tags; and,
 * where the source may read places, CommCare HQ's levels and places. Every
 * decision is `index.ts`'s; this file only reads.
 */

import { isDeepStrictEqual } from "node:util";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { readHqSourceFlag } from "@/lib/commcare/client";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { classifyHqFailure, type HqFailure } from "@/lib/commcare/hq/failure";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import { readHqPlaceInventory } from "@/lib/commcare/hq/locationInventory";
import {
	readWorkingLocationFixture,
	readWorkingSuiteDetails,
	type WorkingLocationWitness,
	type WorkingSource,
} from "@/lib/commcare/hq/workingLocationFixture";
import { isJsonObject } from "@/lib/commcare/reader/jsonCursor";
import { WorkLimitReached } from "@/lib/commcare/workMeter";
import type { ConditionalFactory } from "@/lib/commcare/xpath/instanceSources";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import { getAppDb } from "@/lib/db/pg";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { normalizedHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { recordFromEntries } from "@/lib/domain/records";
import { readLookupFixtureDataInTransaction } from "@/lib/lookup/fixtureSnapshot";
import { measureLookupRows } from "@/lib/lookup/managed";
import type { LookupRowsMeasure } from "@/lib/lookup/managedRules";
import { readAllLookupDefinitionsInTransaction } from "@/lib/lookup/service";
import type {
	LookupFixtureRow,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupRowContent,
	LookupRowValues,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	readSiblingLookupMappings,
	type SiblingLookupMapping,
} from "../../store";
import { isDeploymentServer } from "../../types";
import { Pieces } from "../pieces";
import {
	assembleReadingProjectData,
	type ReadingPlacesRead,
	type ReadingProjectData,
	rowsToMeasure,
} from "./index";
import { referencedLookupTags } from "./lookupDependencies";
import { readHqLookupTablesForReading } from "./lookupTableStore";
import { sourceMayReadPlaces } from "./places";

/** The Project's side of the read, and Postgres's measure of candidate rows. */
export interface ReadingProjectSide {
	/**
	 * The Project's tables whose tag is one of `tags`, each with its rows, in
	 * one snapshot.
	 */
	readonly tables: (tags: readonly string[]) => Promise<{
		readonly projectId: string;
		readonly projectRevision: LookupRevision;
		readonly definitions: readonly LookupTableDefinition[];
		readonly rowsByTable: Readonly<Record<string, readonly LookupFixtureRow[]>>;
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
		contents?: readonly LookupRowContent[],
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
			const role = await viewerRole();
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
						roleAllowsApp(role, "edit") ? "project-editor" : "device",
					);
					return {
						projectId,
						projectRevision: all.projectRevision,
						definitions,
						rowsByTable: recordFromEntries(fixture.rowsByTable),
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

export function mayUseProjectFactory(source: string | HqAppSource): boolean {
	const text = typeof source === "string" ? source : readingSourceText(source);
	return (
		(typeof source !== "string" &&
			Array.isArray(source.raw.modules) &&
			source.raw.modules.some((menu: unknown) => {
				if (!isJsonObject(menu) || !isJsonObject(menu.case_details))
					return false;
				return [menu.case_details.short, menu.case_details.long].some(
					(detail) =>
						isJsonObject(detail) &&
						Array.isArray(detail.columns) &&
						detail.columns.some(
							(column: unknown) =>
								isJsonObject(column) &&
								column.useXpathExpression === true &&
								typeof column.field === "string" &&
								(column.field.includes("instance") ||
									column.field.includes("&")),
						),
				);
			})) ||
		text.includes("locations") ||
		text.includes("commcare:reports") ||
		text.includes("commcare-reports") ||
		text.includes("&#")
	);
}

type PlacesAnswer =
	| { readonly kind: "read"; readonly places: ReadingPlacesRead }
	| { readonly kind: "failed"; readonly failure: HqFailure };

async function readPlaces(
	creds: CommCareCredentials,
	domain: string,
	cancel?: AbortSignal,
): Promise<PlacesAnswer> {
	const read = await readHqPlaceInventory(creds, domain, cancel);
	if (read.kind === "failed")
		return {
			kind: "failed",
			failure: classifyHqFailure(read.error, read.request),
		};
	return {
		kind: "read",
		places:
			read.kind === "inconsistent"
				? { hqLevels: [], hqPlaces: [], inconsistent: true }
				: { hqLevels: read.levels, hqPlaces: read.places },
	};
}

/** Project settings for factories an expression in this source actually consumes.
 * A baseline can ask for the project setting, but only the current working
 * app can supply its rendered form or suite. */
export function sourceFactoryReads(input: {
	creds: CommCareCredentials;
	domain: string;
	working?: WorkingSource;
	source: HqAppSource;
	cancel?: AbortSignal;
}) {
	const { creds, domain, cancel } = input;
	const sameSuiteSource = (after: HqAppSource) => {
		const before = normalizedHqAppSource(input.source.raw);
		const current = normalizedHqAppSource(after.raw);
		return (
			"normalized" in before &&
			"normalized" in current &&
			isDeepStrictEqual(before.normalized, current.normalized)
		);
	};
	const detailReads = new Map<string, Set<string>>();
	let suiteDetails: Awaited<ReturnType<typeof readWorkingSuiteDetails>>;
	const needed = new Set<ConditionalFactory>();
	let formWitness: WorkingLocationWitness | undefined;
	let currentSuite = false;
	return {
		observeDetail(source: HqAppSource, details: readonly string[], id: string) {
			if (source !== input.source) return;
			for (const detail of details) {
				const ids = detailReads.get(detail) ?? new Set<string>();
				ids.add(id);
				detailReads.set(detail, ids);
			}
		},
		async readDetails() {
			if (
				!suiteDetails &&
				detailReads.size &&
				input.working?.source === input.source
			)
				suiteDetails = await readWorkingSuiteDetails(
					{ ...input, working: input.working, sameSuiteSource },
					detailReads,
				);
			return suiteDetails;
		},
		observe(
			source: HqAppSource,
			kind: ConditionalFactory,
			id: string,
			form?: WorkingLocationWitness,
		) {
			needed.add(kind);
			if (
				kind === "locations" &&
				id === "locations" &&
				source === input.source
			) {
				if (form) formWitness ??= form;
				else currentSuite = true;
			}
		},
		async read(): Promise<
			| {
					kind: "read";
					facts: NonNullable<ReadingProjectData["sourceProjectFactories"]>;
			  }
			| { kind: "failed"; failure: HqFailure }
		> {
			const sourceProjectFactories: {
				locations?: "flat" | "hierarchical";
				mobileReports?: boolean;
			} = {};
			for (const kind of needed) {
				const flag = await readHqSourceFlag(
					creds,
					domain,
					kind === "locations" ? "HIERARCHICAL_LOCATION_FIXTURE" : "MOBILE_UCR",
					{ cancel },
				);
				if (flag.kind === "failed") return flag;
				if (flag.kind === "not-a-member")
					return {
						kind: "failed",
						failure: {
							kind: "not-a-member",
							request: "project-spaces",
							status: 403,
						},
					};
				if (kind === "mobileReports")
					sourceProjectFactories.mobileReports = flag.kind === "applied";
				else if (flag.kind === "not-applied")
					sourceProjectFactories.locations = "flat";
				else if (
					input.working?.source === input.source &&
					(formWitness || currentSuite)
				) {
					const observed = await readWorkingLocationFixture({
						creds,
						domain,
						working: input.working,
						witness: formWitness,
						sameSuiteSource,
						cancel,
					});
					if (observed !== undefined)
						sourceProjectFactories.locations = observed;
				}
			}

			return { kind: "read", facts: sourceProjectFactories };
		},
	};
}

/**
 * Read a bring-in's project data, in order: CommCare HQ's lookup tables the
 * source reads, with their rows; the Project's tables of those tags
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
	readonly working?: WorkingSource;
	/**
	 * Another source whose text names tables and places for this read too:
	 * a review of changes made in CommCare HQ reads one set of Project data
	 * for the baseline's source and the app now, which both readings share.
	 */
	readonly alsoSource?: HqAppSource;
	/** The current app's actual alignment. A stored baseline reads by its own form identities. */
	readonly modules?: readonly HqAlignedModule[];
	readonly pieces?: Pieces;
	readonly project: ReadingProjectSide;
	/** `always` reads places whatever the source's text says. */
	readonly places: "when-source-reads" | "always";
	/** The caller's way to stop early, joined to each read's own deadline. */
	readonly cancel?: AbortSignal;
}): Promise<
	| { readonly kind: "read"; readonly data: ReadingProjectData }
	| { readonly kind: "too-intricate" }
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
	let lookups: Awaited<ReturnType<typeof readHqLookupTablesForReading>>;
	const factoryReads = sourceFactoryReads(input);
	const pieces = input.pieces ?? new Pieces(cancel);
	let suiteDetails: Awaited<ReturnType<typeof readWorkingSuiteDetails>>;
	const dependencies = async (
		listed: Parameters<typeof referencedLookupTags>[0]["listed"],
	) => {
		const options = {
			...input,
			listed,
			pieces,
			observeFactory: factoryReads.observe,
		};
		const first = await referencedLookupTags({
			...options,
			observeSuiteDetail: factoryReads.observeDetail,
		});
		suiteDetails = await factoryReads.readDetails();
		return suiteDetails
			? referencedLookupTags({ ...options, suiteDetails })
			: first;
	};
	try {
		let gathered = false;
		lookups = await readHqLookupTablesForReading({
			creds,
			domain,
			cancel,
			referencedTags: (listed) => {
				gathered = true;
				return dependencies(listed);
			},
		});
		// Even a source using no Project tables can consume a project-scoped
		// factory. Entity-encoded words go through the actual renderer.
		if (
			!("success" in lookups) &&
			!gathered &&
			(mayUseProjectFactory(input.source) ||
				(input.alsoSource && mayUseProjectFactory(input.alsoSource)))
		)
			await dependencies([]);
	} catch (error) {
		if (error instanceof WorkLimitReached) return { kind: "too-intricate" };
		throw error;
	}
	if ("success" in lookups) {
		return {
			kind: "failed",
			failure: classifyHqFailure(lookups, lookups.request),
		};
	}

	const factories = await factoryReads.read();
	if (factories.kind === "failed") return factories;
	const sourceProjectFactories = factories.facts;

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
			rows === null
				? null
				: await project.measureRows(
						rows.map((row) => row.values),
						rows.map(({ attributes, occurrences }) => ({
							attributes,
							occurrences,
						})),
					),
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
		data: {
			sourceProjectFactories,
			suiteDetails,
			...assembleReadingProjectData({
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
					siblings,
					mayAdminister,
				},
				measured,
				places,
				placesUnread,
			}),
		},
	};
}
