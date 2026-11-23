import "server-only";

import type { Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	appendSyntheticBatchInTransaction,
	loadAppInTransaction,
} from "@/lib/db/apps";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { PersistedBlueprint } from "@/lib/domain";
import {
	type LookupTableId,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { LookupError } from "@/lib/lookup/errors";
import { readLookupTableReviewSnapshot } from "@/lib/lookup/managed";
import { readTableMembers } from "@/lib/lookup/members";
import { getLookupManifest, getLookupTable } from "@/lib/lookup/service";
import type {
	LookupAuthoringCreateTable,
	LookupReferencingAppSummary,
	LookupScope,
	LookupTableManifestEntry,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import {
	authorizeLookupWriteInTransaction,
	LookupAuthorityError,
	lockLookupProjectState,
} from "@/lib/lookup/writerTransaction";
import {
	appsThatReadIt,
	MANAGEMENT_REVIEW_MOVED,
	REFRESH_NEEDS_EDITOR,
	SEPARATE_TABLE_ASSIGNED,
	SEPARATE_TABLE_INDEXES,
	SEPARATE_TABLE_NO_APPS,
	SEPARATE_TABLE_NO_READERS,
	SEPARATE_TABLE_OWNED,
	SEPARATE_TABLE_TOO_LARGE,
	separateTableAppChanged,
	separateTableBody,
	separateTableTitle,
} from "@/lib/publish/managedData";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { LOOKUP_TABLE_NOT_FOUND } from "./managedData";

/**
 * Create a separate table: a new Project table made from what a table holds
 * now, under its own name and export name, and the chosen apps that read the
 * old table rebound to the new one by identity, in one transaction.
 *
 * It is the answer for a table a destination cannot take as it stands
 * (Nova's copy of a table another project space manages, whose indexes
 * CommCare HQ never showed Nova, or a shared table a change cannot reach
 * safely while other apps read it): the new table is Nova's, authored in
 * full, so the next publish of the chosen apps sends it under its new
 * export name, and the old table, its rows, its origin and every other app
 * stay as they were. Two apps that shared the old table never gain
 * independent authority over it: the old one keeps its one origin and its
 * mappings, and the new one is a new resource with none.
 *
 * The confirmation binds the table's two revisions and the apps that read
 * it (`reviewDigest`). Under the Project state and the old table's row
 * `FOR SHARE`, the write compares both again, creates the new table through
 * the shared authoring batch (`applyLookupAuthoringBatchInTransaction`) and
 * rewrites each chosen app's references through the guarded synthetic
 * writer (`appendSyntheticBatchInTransaction`), which locks the app at the
 * sequence it read, rechecks the member's edit, gates the rebound document
 * against the new table in this transaction and replaces its reference
 * edges. Any refusal leaves the Project's data and every app as they were.
 */

export interface SeparateTableReview {
	readonly title: string;
	readonly lines: readonly string[];
	/** The apps that read the table now, each of which the person may choose. */
	readonly apps: readonly LookupReferencingAppSummary[];
	/** A name and an export name the Project holds no table under. */
	readonly suggested: { readonly name: string; readonly tag: string };
	readonly reviewDigest: string;
}

export type SeparateTableOutcome =
	| {
			readonly ok: true;
			readonly table: LookupTableManifestEntry;
			/** The apps rebound to the new table. */
			readonly appIds: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly reason:
				| "not-found"
				| "not-permitted"
				| "unsupported"
				| "invalid-input"
				| "review-moved"
				| "app-changed";
			readonly message: string;
	  };

type Refused = Extract<SeparateTableOutcome, { readonly ok: false }>;

function refused(reason: Refused["reason"], message: string): Refused {
	return { ok: false, reason, message };
}

/** The digest of what the confirmation showed: the table's revisions and its readers. */
function separateReviewDigest(snapshot: {
	readonly tableId: LookupTableId;
	readonly definitionRevision: string;
	readonly rowsRevision: string;
	readonly readerAppIds: readonly string[];
}): string {
	return canonicalJsonDigest({
		v: 1,
		action: "separate-table",
		tableId: snapshot.tableId,
		definitionRevision: snapshot.definitionRevision,
		rowsRevision: snapshot.rowsRevision,
		readerAppIds: [...snapshot.readerAppIds].sort(),
	});
}

/** The first name of the form `<base>_<n>` (or the base itself) `taken` holds none of, ignoring case. */
function vacant(base: string, taken: ReadonlySet<string>, join: string) {
	for (let n = 2; ; n++) {
		const candidate = `${base}${join}${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

/**
 * What Create a separate table would do, writing nothing. Null where the
 * Project holds no such table. Refuses, as the change itself does, a table
 * whose rows go to certain workers and one larger than one change copies.
 */
export async function reviewSeparateTable(
	scope: LookupScope,
	tableIdInput: LookupTableId,
): Promise<
	{ readonly ok: true; readonly review: SeparateTableReview } | Refused
> {
	const parsed = lookupTableIdSchema.safeParse(tableIdInput);
	if (!parsed.success) return refused("not-found", LOOKUP_TABLE_NOT_FOUND);
	const snapshot = await readLookupTableReviewSnapshot(
		scope.projectId,
		parsed.data,
	);
	if (snapshot === null) return refused("not-found", LOOKUP_TABLE_NOT_FOUND);
	if (!roleAllowsApp(scope.role, "edit"))
		return refused("not-permitted", REFRESH_NEEDS_EDITOR);
	if (snapshot.readers.length === 0)
		return refused("unsupported", SEPARATE_TABLE_NO_READERS);
	const copyable = await copyableTable(scope, snapshot.tableId);
	if (!copyable.ok) return copyable;
	const { table } = copyable;
	const manifest = await getLookupManifest(scope);
	const tags = new Set(manifest.tables.map((one) => one.tag.toLowerCase()));
	const names = new Set(manifest.tables.map((one) => one.name.toLowerCase()));
	const lines = [separateTableBody(table.name)];
	if (table.columns.some((column) => column.index === "unobserved"))
		lines.push(SEPARATE_TABLE_INDEXES);
	lines.push(SEPARATE_TABLE_OWNED);
	const readers = appsThatReadIt(snapshot.readers);
	if (readers !== null) lines.push(readers);
	return {
		ok: true,
		review: {
			title: separateTableTitle(table.name),
			lines,
			apps: snapshot.readers,
			suggested: {
				name: vacant(table.name, names, " "),
				tag: vacant(table.tag, tags, "_"),
			},
			reviewDigest: separateReviewDigest(snapshot),
		},
	};
}

/** The table's rows and definition, where a separate table can carry them. */
async function copyableTable(
	scope: LookupScope,
	tableId: LookupTableId,
): Promise<
	{ readonly ok: true; readonly table: LookupTableSnapshot } | Refused
> {
	let table: LookupTableSnapshot;
	try {
		table = await getLookupTable(scope, tableId);
	} catch (error) {
		if (!(error instanceof LookupError)) throw error;
		if (error.code === "not_found")
			return refused("not-found", LOOKUP_TABLE_NOT_FOUND);
		if (error.code === "storage_limit")
			return refused("unsupported", SEPARATE_TABLE_TOO_LARGE);
		/* A source whose rows Nova holds only per worker, or whose inventory
		 * is not current, has no rows one copy could take. */
		if (error.code === "managed_in_hq")
			return refused("unsupported", SEPARATE_TABLE_ASSIGNED);
		throw error;
	}
	if (
		table.workerAccess === "assigned" ||
		table.hq?.source?.distribution === "assigned"
	)
		return refused("unsupported", SEPARATE_TABLE_ASSIGNED);
	return { ok: true, table };
}

/** The new table's draft: every column, detail and row of `table`, keyed by the old ids. */
function separateDraft(
	table: LookupTableSnapshot,
	name: string,
	tag: string,
): LookupAuthoringCreateTable {
	const attributeNames = new Map(
		(table.attributes ?? []).map((member) => [member.id, member.wireName]),
	);
	const columnsById = new Map(
		table.columns.map((column) => [column.id, column]),
	);
	return {
		key: table.id,
		name,
		tag,
		...(table.attributes?.length
			? {
					attributes: table.attributes.map(({ wireName, label }) => ({
						wireName,
						label,
					})),
				}
			: {}),
		columns: table.columns.map((column) => ({
			key: column.id,
			wireName: column.wireName,
			label: column.label,
			dataType: column.dataType,
			...(column.repeated ? { repeated: true as const } : {}),
			...(column.properties?.length
				? {
						properties: column.properties.map(({ wireName, label }) => ({
							wireName,
							label,
						})),
					}
				: {}),
			/* An index CommCare HQ never showed Nova is not authored as one: the
			 * confirmation said the new table indexes none. */
			...(column.index === "indexed" ? { indexed: true } : {}),
		})),
		rows: table.rows.map((row) => ({
			key: row.id,
			cells: Object.entries(row.values).map(([columnId, value]) => ({
				columnKey: columnId,
				value,
			})),
			content: {
				...(row.attributes
					? {
							attributes: Object.fromEntries(
								Object.entries(row.attributes).flatMap(([id, text]) => {
									const wire = attributeNames.get(id as never);
									return wire === undefined || text === undefined
										? []
										: [[wire, text]];
								}),
							),
						}
					: {}),
				...(row.occurrences
					? {
							occurrences: Object.fromEntries(
								Object.entries(row.occurrences).flatMap(([columnId, list]) => {
									const column = columnsById.get(columnId as never);
									if (column === undefined || list === undefined) return [];
									const propertyNames = new Map(
										(column.properties ?? []).map((member) => [
											member.id,
											member.wireName,
										]),
									);
									return [
										[
											column.wireName,
											list.map((occurrence) => ({
												text: occurrence.text,
												properties: Object.fromEntries(
													Object.entries(occurrence.properties).flatMap(
														([id, text]) => {
															const wire = propertyNames.get(id as never);
															return wire === undefined || text === undefined
																? []
																: [[wire, text]];
														},
													),
												),
											})),
										],
									];
								}),
							),
						}
					: {}),
			},
		})),
	};
}

/**
 * Replace every value and key of `value` equal to an id in `ids` with its
 * new id. Ids are UUIDs, so equality on a whole value names exactly the
 * references to the old table, its columns and its details, wherever the
 * document's typed slots hold them; text is never searched inside.
 */
function rebound(value: unknown, ids: ReadonlyMap<string, string>): unknown {
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => rebound(item, ids));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				ids.get(key) ?? key,
				rebound(item, ids),
			]),
		);
	return value;
}

/** The old ids of the table, its columns and its details to the new ones. */
async function idMap(
	tx: Transaction<AppDatabase>,
	projectId: string,
	table: LookupTableSnapshot,
	newTableId: LookupTableId,
	columnIds: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
	const ids = new Map<string, string>([[table.id, newTableId], ...columnIds]);
	const members = await readTableMembers(tx, projectId, newTableId);
	const newAttributes = new Map(
		(members.get(null) ?? []).map((member) => [member.wireName, member.id]),
	);
	for (const member of table.attributes ?? []) {
		const id = newAttributes.get(member.wireName);
		if (id === undefined)
			throw new Error(
				`The separate table lost the row detail ${member.wireName} it was made with.`,
			);
		ids.set(member.id, id);
	}
	for (const column of table.columns) {
		const newColumnId = columnIds.get(column.id);
		const properties = new Map(
			(members.get(newColumnId as never) ?? []).map((member) => [
				member.wireName,
				member.id,
			]),
		);
		for (const member of column.properties ?? []) {
			const id = properties.get(member.wireName);
			if (id === undefined)
				throw new Error(
					`The separate table lost the value detail ${member.wireName} of a column it was made with.`,
				);
			ids.set(member.id, id);
		}
	}
	return ids;
}

class AppMovedError extends Error {
	constructor(readonly appName: string) {
		super(`The app ${appName} moved while a separate table was being made.`);
	}
}

export async function separateLookupTable(
	scope: LookupScope,
	tableIdInput: LookupTableId,
	input: {
		readonly name: string;
		readonly tag: string;
		readonly appIds: readonly string[];
		readonly reviewDigest: string;
	},
): Promise<SeparateTableOutcome> {
	const parsed = lookupTableIdSchema.safeParse(tableIdInput);
	if (!parsed.success) return refused("not-found", LOOKUP_TABLE_NOT_FOUND);
	const tableId = parsed.data;
	if (!roleAllowsApp(scope.role, "edit"))
		return refused("not-permitted", REFRESH_NEEDS_EDITOR);
	const appIds = [...new Set(input.appIds)].sort();
	if (appIds.length === 0)
		return refused("invalid-input", SEPARATE_TABLE_NO_APPS);
	const snapshot = await readLookupTableReviewSnapshot(
		scope.projectId,
		tableId,
	);
	if (snapshot === null) return refused("not-found", LOOKUP_TABLE_NOT_FOUND);
	if (
		separateReviewDigest(snapshot) !== input.reviewDigest ||
		appIds.some((appId) => !snapshot.readerAppIds.includes(appId))
	)
		return refused("review-moved", MANAGEMENT_REVIEW_MOVED);
	const copyable = await copyableTable(scope, tableId);
	if (!copyable.ok) return copyable;
	const { table } = copyable;
	if (
		table.definitionRevision !== snapshot.definitionRevision ||
		table.rowsRevision !== snapshot.rowsRevision
	)
		return refused("review-moved", MANAGEMENT_REVIEW_MOVED);
	const names = new Map(
		snapshot.readers.map((app) => [app.appId, app.appName]),
	);
	try {
		const newTableId = await withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			await lockLookupProjectState(tx, authority);
			const held = await tx
				.selectFrom("lookup_tables")
				.select(["definition_revision", "rows_revision"])
				.where("project_id", "=", scope.projectId)
				.where("id", "=", tableId)
				.forShare()
				.executeTakeFirst();
			const readers = (
				await readLookupReferencingApps(tx, {
					projectId: scope.projectId,
					tableId,
				})
			)
				.map((app) => app.appId)
				.sort();
			if (
				held === undefined ||
				String(held.definition_revision) !== snapshot.definitionRevision ||
				String(held.rows_revision) !== snapshot.rowsRevision ||
				readers.join() !== snapshot.readerAppIds.join()
			)
				throw new LookupError("conflict", MANAGEMENT_REVIEW_MOVED);
			const receipt = await applyLookupAuthoringBatchInTransaction(
				tx,
				authority,
				{ createTables: [separateDraft(table, input.name, input.tag)] },
			);
			const created = receipt.tables.find((one) => one.key === table.id);
			if (created === undefined)
				throw new Error("The separate table's batch made no table.");
			const ids = await idMap(
				tx,
				scope.projectId,
				table,
				created.tableId,
				new Map(created.columnIds.map(({ key, id }) => [key, id])),
			);
			for (const appId of appIds) {
				const app = await loadAppInTransaction(tx, appId);
				if (app === null || app.project_id !== scope.projectId)
					throw new AppMovedError(names.get(appId) ?? appId);
				const target = rebound(app.blueprint, ids) as PersistedBlueprint;
				const left = extractLookupReferenceTargets(
					hydratePersistedBlueprint(target),
				);
				if (left.tableIds.includes(tableId))
					throw new Error(
						`The app ${appId} still names the old table after its references were rebound.`,
					);
				try {
					await appendSyntheticBatchInTransaction(tx, {
						appId,
						expectedBaseSeq: app.mutation_seq,
						targetDoc: target,
						authority: { kind: "user", actorUserId: scope.actorId },
					});
				} catch (error) {
					if (error instanceof BlueprintCommitRejectedError)
						throw new AppMovedError(names.get(appId) ?? appId);
					throw error;
				}
			}
			return created.tableId;
		});
		const manifest = await getLookupManifest(scope);
		const entry = manifest.tables.find((one) => one.id === newTableId);
		if (entry === undefined)
			return refused("not-found", LOOKUP_TABLE_NOT_FOUND);
		return { ok: true, table: entry, appIds };
	} catch (error) {
		if (error instanceof AppMovedError)
			return refused("app-changed", separateTableAppChanged(error.appName));
		if (error instanceof LookupAuthorityError)
			return error.standing === "not-a-member"
				? refused("not-found", LOOKUP_TABLE_NOT_FOUND)
				: refused("not-permitted", REFRESH_NEEDS_EDITOR);
		if (error instanceof LookupError) {
			if (error.code === "conflict")
				return refused("review-moved", MANAGEMENT_REVIEW_MOVED);
			if (error.code === "invalid_input" || error.code === "tag_taken")
				return refused("invalid-input", error.message);
			if (error.code === "storage_limit")
				return refused("unsupported", SEPARATE_TABLE_TOO_LARGE);
		}
		throw error;
	}
}
