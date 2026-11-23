import "server-only";

import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import type { ProjectDataGrant } from "@/lib/auth/dataGrant";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { CommCareCredentials } from "@/lib/commcare/client";
import {
	HQ_LOCATION_INVENTORY_MAX_ROWS,
	HQ_LOOKUP_INLINE_READ_MAX_ROWS,
	HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
} from "@/lib/commcare/hq/bounds";
import {
	classifyHqFailure,
	type HqFailure,
	type HqFailureKind,
} from "@/lib/commcare/hq/failure";
import { readHqPlaceInventory } from "@/lib/commcare/hq/locationInventory";
import type { HqLocation } from "@/lib/commcare/hq/locations";
import { readVerifiedGlobalLookupRows } from "@/lib/commcare/hq/lookupCoverage";
import {
	type LookupWorkerProjection,
	readLookupWorkerRestore,
} from "@/lib/commcare/hq/lookupRestore";
import {
	readSelectedHqLookupRows,
	verifyHqLookupDefinition,
} from "@/lib/commcare/hq/lookupSource";
import {
	type HqFixtureRow,
	type HqLookupTable,
	LOOKUP_ROWS_READ_CONCURRENCY,
	listHqLookupTables,
} from "@/lib/commcare/hq/lookupTables";
import { findHqMobileWorkers } from "@/lib/commcare/hq/workers";
import { COMMCARE_SERVERS, isCommCareServer } from "@/lib/commcare/servers";
import { xmlTextIssue } from "@/lib/commcare/xmlText";
import { loadAppInTransaction } from "@/lib/db/apps";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { getCommCareSettings, getHqCredentials } from "@/lib/db/settings";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceOccurrences,
	extractLookupReferenceTargets,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	orderedLocationProperties,
	orderedOrganizationLevels,
} from "@/lib/domain";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { LOOKUP_MAX_COLUMNS } from "@/lib/lookup/constants";
import { LookupError, LookupPastInlineCopyError } from "@/lib/lookup/errors";
import {
	type InventoryAccess,
	lockInventoryScope,
} from "@/lib/lookup/generations/scope";
import {
	LookupReviewMovedError,
	type ManagedRefreshReceipt,
	type ManagedTableReview,
	type ManagedTableReviewed,
	measureLookupRows,
	readKeptLookupColumnIds,
	readLookupTableReviewSnapshot,
	readManagedTableReview,
	refreshManagedLookupTableInTransaction,
	takeOverManagedLookupTableInTransaction,
} from "@/lib/lookup/managed";
import {
	lookupInlineCopyExcess,
	managedCanonicalSchema,
} from "@/lib/lookup/managedRules";
import { lookupWireNameSchema } from "@/lib/lookup/schema";
import { getLookupDefinitions, getLookupManifest } from "@/lib/lookup/service";
import { lookupSourceFactsSchema } from "@/lib/lookup/source";
import type {
	LookupHqOrigin,
	LookupReferencingAppSummary,
	LookupScope,
	LookupTableDefinition,
	LookupTableManifestEntry,
} from "@/lib/lookup/types";
import {
	authorizeLookupWriteInTransaction,
	LookupAuthorityError,
	lockLookupProjectState,
	lockLookupTableForUpdate,
} from "@/lib/lookup/writerTransaction";
import { OrganizationError } from "@/lib/organization/errors";
import {
	type ManagedPlacePlan,
	type ManagedPlacesRefresh,
	refreshManagedPlacesInTransaction,
} from "@/lib/organization/managed";
import { readPlaceState } from "@/lib/organization/pages";
import type { OrganizationScope } from "@/lib/organization/types";
import {
	appsThatReadIt,
	CONNECT_TO_REFRESH_PLACES,
	CONNECT_TO_REFRESH_TABLE,
	cannotReadManagedPlaces,
	cannotReadManagedTables,
	HOLDS_MORE_THAN_ONE_VALUE,
	HQ_UNAVAILABLE,
	holdsColumnNamed,
	MANAGED_TABLE_NO_COLUMNS,
	MANAGEMENT_NEEDS_ADMIN,
	MANAGEMENT_REVIEW_MOVED,
	managedColumnGoneItem,
	managedHandBackPastInlineRead,
	managedPlaceNotHoldable,
	managedPlacesPastInventory,
	managedTableGone,
	managedTableGoneItem,
	managedTableManyValuesItem,
	managedTableNameItem,
	managedTableNoColumnsItem,
	managedTablePastInlineItem,
	managedTablePastInlineRead,
	managedTableUnrepresentable,
	managedTableUnrepresentableItem,
	managedTableUnsupported,
	managedTableUnsupportedItem,
	managedTakeOverPastInlineRead,
	REFRESH_NEEDS_EDITOR,
	TABLE_HAS_HQ_ORIGIN,
	TABLE_TAKEN_OVER_MEANWHILE,
	takeHqTableBody,
	takeHqTableChanges,
	takeHqTableSourceMoved,
	takeHqTableTitle,
	USE_HQ_TABLE_NO_SOURCE,
	useHqTablePastInlineRead,
} from "@/lib/publish/managedData";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { transferAssignedSource } from "./assignedSourceTransfer";
import { deploymentNotFound } from "./errors";
import { canonicalLookupTable } from "./hqResourceBaseline";
import { observeLargeLookup } from "./largeLookupReceipt";
import {
	describeUnsupportedLookupContent,
	type UnsupportedLookupContent,
} from "./lookupResourcePlan";
import { refreshSourceInventory } from "./managedInventory";
import { transferManagedGeneration } from "./managedTransfer";
import {
	boundSourceFixture,
	managedLookupContentOf,
	provisionalLookupBinding,
} from "./reading/projectData/lookupTables";
import { planManagedPlaces } from "./reading/projectData/places";
import type { DeploymentScope, DeploymentTargetKey } from "./store";
import type { CanonicalLookupTable, ResourceBaseline } from "./types";

/**
 * Data CommCare HQ manages for an app: the lookup tables and the places Nova
 * keeps a copy of, read again from the project space that manages them.
 *
 * Four kinds of work live here. A publish re-reads the tables the app reads
 * that CommCare HQ manages and refreshes Nova's copy before the export
 * boundary validates it (`reReadManagedTablesForPublish`). A person refreshes
 * a table or the places, hands a table to Nova with Manage in Nova, or hands
 * it back. The table page and the Organization banner read what they show.
 * And the publish's push plan reads the table's own record of CommCare HQ's
 * table for a table a person took over (`baselineFromTableOrigin`).
 *
 * No lock is held across a read of CommCare HQ: every read finishes before
 * the short transaction that writes the copy opens, and that transaction
 * takes the lookup writer's own order (Project state, then the table), or
 * the organization writer's (the app row, then its state).
 */

// ---------------------------------------------------------------------------
// What changed in CommCare HQ
// ---------------------------------------------------------------------------

/** A change to a managed table in CommCare HQ that stops a publish or a refresh. */
export type ManagedTableChange =
	| { readonly kind: "table-gone" }
	| {
			readonly kind: "column-gone";
			readonly column: string;
			readonly uses: number;
	  }
	| {
			readonly kind: "unsupported";
			readonly holds: readonly UnsupportedLookupContent[];
	  }
	| { readonly kind: "no-columns" }
	| { readonly kind: "more-than-one-value" }
	/**
	 * CommCare HQ's table holds more than one inline read copies (more rows than
	 * `HQ_LOOKUP_INLINE_READ_MAX_ROWS`, more bytes than
	 * `HQ_LOOKUP_TABLE_ROWS_MAX_BYTES`, or content past what one inline copy
	 * writes, `managedRules.ts::lookupInlineCopyExcess`), and has changed since
	 * Nova's copy or could not be compared with it. A Project data refresh reads
	 * such a table in pages; no size of a table is past what Nova holds.
	 */
	| { readonly kind: "past-inline-read" }
	| { readonly kind: "name"; readonly name: string }
	| { readonly kind: "unrepresentable-text"; readonly column: string };

/** A column the app reads, by its wire name, and how many places of the app read it. */
interface ReadColumn {
	readonly wireName: string;
	readonly uses: number;
}

/** A managed table as Nova stores it: its columns and what its origin columns hold. */
interface StoredManagedTable {
	readonly sourceInventory: boolean;
	readonly projectId: string;
	readonly id: LookupTableId;
	readonly name: string;
	readonly tag: string;
	readonly server: string;
	readonly domain: string;
	readonly remoteId: string;
	/** `hq_canonical`'s digest: CommCare HQ's table at the last refresh. */
	readonly digest: string;
	readonly refreshedAt: string;
	readonly managedBy: "commcare-hq" | "nova";
	readonly columns: readonly {
		readonly id: LookupColumnId;
		readonly wireName: string;
		/** An app's column edge or an accepted design names it, so a refresh keeps it when CommCare HQ drops it. */
		readonly kept: boolean;
	}[];
}

/** One table's read of CommCare HQ: gone, its rows, or a read that failed. */
type TableRead =
	| { readonly kind: "gone" }
	| {
			readonly kind: "read";
			readonly table: HqLookupTable;
			readonly rows: readonly HqFixtureRow[];
	  }
	/**
	 * CommCare HQ's table holds more than one inline read takes: more rows than
	 * `HQ_LOOKUP_INLINE_READ_MAX_ROWS` by its first page's total, or more bytes
	 * than `HQ_LOOKUP_TABLE_ROWS_MAX_BYTES`. Nothing past that was read; a
	 * Project data refresh reads it in pages.
	 */
	| {
			readonly kind: "past-limit";
			readonly table: HqLookupTable;
	  }
	| { readonly kind: "failed"; readonly failure: HqFailure };

/**
 * What stops a copy of `stored` from taking CommCare HQ's table, in the
 * order a person reads them: the table gone; a column the app reads gone;
 * no column at all, where no column the app reads is gone already (Nova
 * holds a table only with one); content Nova can't hold (field properties,
 * row attributes, rows limited to certain users); a field with more than one
 * value; a cap; a field name outside the grammar; a cell holding a character
 * XML 1.0 cannot carry.
 * Empty where the copy can take it. The caps are judged over Postgres's own
 * measure of the rows, keyed as they would be stored, and the column cap
 * counts the columns a refresh keeps because an app still reads them.
 */
async function managedTableChanges(
	stored: StoredManagedTable,
	read: Exclude<TableRead, { readonly kind: "failed" }>,
	readColumns: readonly ReadColumn[],
): Promise<readonly ManagedTableChange[]> {
	if (read.kind === "gone") return [{ kind: "table-gone" }];
	const { table } = read;
	const changes: ManagedTableChange[] = [];
	const fields = new Set(table.fields);
	for (const column of readColumns) {
		if (!fields.has(column.wireName)) {
			changes.push({
				kind: "column-gone",
				column: column.wireName,
				uses: column.uses,
			});
		}
	}
	/* CommCare HQ's table editor can remove every field, and the copy's own
	 * rule holds a table only with a column. */
	if (table.fields.length === 0 && changes.length === 0) {
		changes.push({ kind: "no-columns" });
	}
	if (read.kind === "past-limit") {
		changes.push({ kind: "past-inline-read" });
		return changes;
	}
	const { rows } = read;

	const badNames = table.fields.filter(
		(field) => !lookupWireNameSchema.safeParse(field).success,
	);
	const unrepresentable = table.fields.find((field) =>
		rows.some((row) => {
			if (!Object.hasOwn(row.fields, field)) return false;
			const value = row.fields[field];
			return typeof value === "string"
				? xmlTextIssue(value) !== undefined
				: value.some((item) => xmlTextIssue(item.value) !== undefined);
		}),
	);

	/* What one inline copy writes is judged only over content a copy could
	 * hold: a row with a field of several values, a name the grammar refuses or
	 * a character no stored row can carry is already a stop. */
	if (badNames.length === 0 && unrepresentable === undefined) {
		const content = managedLookupContentOf(table, rows);
		const projected = boundSourceFixture(
			table,
			rows,
			provisionalLookupBinding(table, {
				appId: stored.id,
				readingId: stored.id,
			}),
		).rows;
		const measured = await measureLookupRows(
			projected.map((row) => row.values),
			projected.map(({ attributes, occurrences }) => ({
				attributes,
				occurrences,
			})),
		);
		const keptGone = stored.columns.filter(
			(column) => column.kept && !fields.has(column.wireName),
		).length;
		const columnCount = table.fields.length + keptGone;
		if (
			lookupInlineCopyExcess(content, measured).length > 0 ||
			(keptGone > 0 && columnCount > LOOKUP_MAX_COLUMNS)
		)
			changes.push({ kind: "past-inline-read" });
	}
	for (const name of badNames) changes.push({ kind: "name", name });
	if (unrepresentable !== undefined) {
		changes.push({ kind: "unrepresentable-text", column: unrepresentable });
	}
	return changes;
}

/** One item of `hq_managed_data_changed` per change, in the item sentences of `lib/publish/managedData.ts`. */
export function managedTableChangeItem(
	tag: string,
	change: ManagedTableChange,
): string {
	switch (change.kind) {
		case "table-gone":
			return managedTableGoneItem(tag);
		case "column-gone":
			return managedColumnGoneItem(change.column, tag, change.uses);
		case "no-columns":
			return managedTableNoColumnsItem(tag);
		case "unsupported":
			return managedTableUnsupportedItem(
				tag,
				describeUnsupportedLookupContent(change.holds),
			);
		case "more-than-one-value":
			return managedTableManyValuesItem(tag);
		case "past-inline-read":
			return managedTablePastInlineItem(tag);
		case "name":
			return managedTableNameItem(tag, change.name);
		case "unrepresentable-text":
			return managedTableUnrepresentableItem(change.column, tag);
	}
}

// ---------------------------------------------------------------------------
// The stored tables
// ---------------------------------------------------------------------------

/**
 * The tables among `tableIds` that came from CommCare HQ, with their
 * columns, in table id order. Project-scoped: a foreign or missing id is
 * not there.
 */
async function readStoredManagedTables(
	projectId: string,
	tableIds: readonly string[],
): Promise<readonly StoredManagedTable[]> {
	if (tableIds.length === 0) return [];
	const db = await getAppDb();
	const tables = await db
		.selectFrom("lookup_tables")
		.select([
			"id",
			"name",
			"tag",
			"hq_server",
			"hq_domain",
			"hq_remote_id",
			"hq_canonical",
			"hq_refreshed_at",
			"hq_taken_over_at",
		])
		.where("project_id", "=", projectId)
		.where("id", "in", lookupTableIds(tableIds))
		.where("hq_server", "is not", null)
		.orderBy("id")
		.execute();
	if (tables.length === 0) return [];
	const ids = tables.map((table) => table.id);
	const columns = await db
		.selectFrom("lookup_columns")
		.select(["id", "table_id", "wire_name"])
		.where("project_id", "=", projectId)
		.where("table_id", "in", ids)
		.orderBy("table_id")
		.orderBy("order_key")
		.orderBy("id")
		.execute();
	const referenced = new Set(
		(
			await db
				.selectFrom("lookup_column_references")
				.select("column_id")
				.where("project_id", "=", projectId)
				.where("table_id", "in", ids)
				.execute()
		).map((row) => row.column_id),
	);
	const protections = await db
		.selectFrom("design_lookup_protections")
		.select(["table_id", "column_id"])
		.where("project_id", "=", projectId)
		.where("table_id", "in", ids)
		.execute();
	const wholeTableProtected = new Set(
		protections
			.filter((protection) => protection.column_id === null)
			.map((protection) => protection.table_id),
	);
	const protectedColumns = new Set(
		protections.flatMap((protection) =>
			protection.column_id === null ? [] : [protection.column_id],
		),
	);
	return tables.map((table) => {
		if (
			table.hq_server === null ||
			table.hq_domain === null ||
			table.hq_remote_id === null ||
			table.hq_refreshed_at === null
		) {
			throw new Error(
				"A lookup table's CommCare HQ origin was stored only in part.",
			);
		}
		const canonical = managedCanonicalSchema.parse(table.hq_canonical);
		return {
			id: lookupTableIdSchema.parse(table.id),
			sourceInventory:
				canonical.source?.inventory === "unavailable" ||
				canonical.source?.distribution === "assigned" ||
				canonical.source?.storage === "generation",
			projectId,
			name: table.name,
			tag: table.tag,
			server: table.hq_server,
			domain: table.hq_domain,
			remoteId: table.hq_remote_id,
			digest: canonical.digest,
			refreshedAt: table.hq_refreshed_at.toISOString(),
			managedBy: table.hq_taken_over_at === null ? "commcare-hq" : "nova",
			columns: columns
				.filter((column) => column.table_id === table.id)
				.map((column) => ({
					id: lookupColumnIdSchema.parse(column.id),
					wireName: column.wire_name,
					kept:
						referenced.has(column.id) ||
						protectedColumns.has(column.id) ||
						wholeTableProtected.has(table.id),
				})),
		};
	});
}

/** Table ids as the store keys them; a caller's ids are Nova's own, so one that is not is an invariant failure. */
function lookupTableIds(tableIds: readonly string[]): LookupTableId[] {
	return tableIds.map((tableId) => lookupTableIdSchema.parse(tableId));
}

/** Whether a stored origin names this project space. */
function originIs(
	origin: { readonly server: string; readonly domain: string },
	target: DeploymentTargetKey,
): boolean {
	return origin.server === target.server && origin.domain === target.domain;
}

// ---------------------------------------------------------------------------
// Reading CommCare HQ
// ---------------------------------------------------------------------------

/** The kinds of a refused read that are the key's or the account's to fix: every 401 and 403 CommCare HQ itself gave. */
const ACCOUNT_REFUSAL_KINDS: ReadonlySet<HqFailureKind> = new Set([
	"permission",
	"plan-lacks-api-access",
	"key-not-accepted",
	"api-cut-off",
	"not-a-member",
]);

/** Whether a failed read is the key's or the account's to fix, rather than a question Nova couldn't ask. */
export function isAccountRefusal(failure: HqFailure): boolean {
	return ACCOUNT_REFUSAL_KINDS.has(failure.kind);
}

/** One table's read: gone from the list, or its rows. The list answered, so the key reaches the project space. */
async function readTable(
	creds: CommCareCredentials,
	domain: string,
	list: readonly HqLookupTable[],
	stored: Pick<StoredManagedTable, "id" | "projectId" | "tag" | "remoteId">,
): Promise<TableRead> {
	const peers = list.filter((candidate) => candidate.tag === stored.tag);
	const [table] = peers;
	if (peers.length !== 1 || table === undefined || table.id !== stored.remoteId)
		return { kind: "gone" };
	/* A table past one inline read is read in pages by a Project data refresh,
	 * so this read stops after the first page that says so. */
	let rows = await readSelectedHqLookupRows(creds, domain, table, {
		maxRows: HQ_LOOKUP_INLINE_READ_MAX_ROWS,
		maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
	});
	// A zero-occurrence field fails inside HQ's own filtered list serializer.
	// Auth refusals, temp network failures and malformed answers grant no fallback.
	if (
		"success" in rows &&
		rows.status === 500 &&
		!rows.edgeRefusal &&
		rows.cause === undefined &&
		table.isGlobal
	) {
		const db = await getAppDb();
		const candidates = await db
			.selectFrom("lookup_rows")
			.select("hq_row_id")
			.innerJoin("lookup_tables", (join) =>
				join
					.onRef("lookup_tables.id", "=", "lookup_rows.table_id")
					.onRef("lookup_tables.project_id", "=", "lookup_rows.project_id"),
			)
			.where("lookup_rows.project_id", "=", stored.projectId)
			.where("lookup_rows.table_id", "=", stored.id)
			.where("lookup_tables.hq_remote_id", "=", table.id)
			.where("lookup_tables.hq_domain", "=", domain)
			.where("lookup_tables.hq_server", "=", creds.server)
			.limit(HQ_LOOKUP_INLINE_READ_MAX_ROWS + 1)
			.execute();
		if (
			candidates.length <= HQ_LOOKUP_INLINE_READ_MAX_ROWS &&
			candidates.every((row) => row.hq_row_id !== null)
		) {
			rows = await readVerifiedGlobalLookupRows(creds, domain, table, {
				binding: canonicalJsonDigest([
					stored.projectId,
					stored.id,
					creds.username,
				]),
				candidates: candidates.flatMap((row) =>
					row.hq_row_id === null ? [] : [row.hq_row_id],
				),
				maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
			});
		}
	}

	if ("success" in rows) {
		return {
			kind: "failed",
			failure: classifyHqFailure(rows, "lookup-rows", { member: true }),
		};
	}
	if ("kind" in rows) return { kind: "past-limit", table };
	return { kind: "read", table, rows: rows.rows };
}

/**
 * The credentials that read a project space a table or the places came
 * from: the actor's connection, where it is on the origin's server and
 * approved for the origin's project space.
 */
async function originCredentials(
	actorUserId: string,
	origin: { readonly server: string; readonly domain: string },
): Promise<
	| { readonly ok: true; readonly creds: CommCareCredentials }
	| { readonly ok: false; readonly reason: "not-connected" | "cannot-read" }
> {
	const result = await getHqCredentials(actorUserId, origin.domain);
	if (!result.ok) {
		return {
			ok: false,
			reason:
				result.error === "not_configured" ? "not-connected" : "cannot-read",
		};
	}
	if (result.creds.server !== origin.server) {
		return { ok: false, reason: "cannot-read" };
	}
	return { ok: true, creds: result.creds };
}

/**
 * CommCare HQ's table as the copy takes it, in the copy's own refresh. `at`
 * is when the read began, taken before CommCare HQ was asked, so the copy
 * records the moment its content was CommCare HQ's at the latest.
 */
async function refreshTable(
	scope: LookupScope,
	stored: StoredManagedTable,
	table: HqLookupTable,
	rows: readonly HqFixtureRow[],
	write:
		| { readonly mode: "refresh" }
		| { readonly mode: "adopt"; readonly reviewed: ManagedTableReviewed },
	at: Date,
): Promise<ManagedRefreshReceipt> {
	const canonical = canonicalLookupTable(table, rows);
	const base = {
		tableId: stored.id,
		content: managedLookupContentOf(table, rows),
		origin: {
			server: stored.server,
			domain: stored.domain,
			remoteId: table.id,
			canonical: { ...canonical },
		},
		at,
		olderReadYields: true,
	};
	/* The member's role is read again on the write's own transaction: a
	 * demotion or a removal during the read of CommCare HQ stops the write. */
	return withAppTx(async (tx) =>
		refreshManagedLookupTableInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(
				tx,
				scope,
				write.mode === "refresh" ? "edit" : "delete",
			),
			write.mode === "refresh"
				? { ...base, mode: "refresh" }
				: { ...base, mode: "adopt", reviewed: write.reviewed },
		),
	);
}

// ---------------------------------------------------------------------------
// Before a publish
// ---------------------------------------------------------------------------

export interface ManagedTablesReRead {
	/** Tables whose origin is the target and that changed in what the app reads. Stops. */
	readonly blocking: readonly {
		readonly tag: string;
		readonly name: string;
		readonly changes: readonly ManagedTableChange[];
	}[];
	/** Tables refreshed, with what changed. */
	readonly refreshed: readonly {
		readonly tag: string;
		readonly receipt: ManagedRefreshReceipt;
	}[];
	/** Tables of another project space the publisher could not read: pushed from the copy as it is. */
	readonly stale: readonly {
		readonly tag: string;
		readonly domain: string;
		readonly refreshedAt: string;
	}[];
	/** The target's table list, for the `project-data` edge to reuse. */
	readonly hqTables: readonly HqLookupTable[] | null;
}

/**
 * Read again the tables `doc` reads that CommCare HQ manages, and refresh
 * Nova's copy of each one that changed in a way the app can take.
 *
 * Tables managed in the target are read with the publisher's key: the list
 * once, then each table's rows a few at a time. A failed read is the answer
 * `unreadable`, with the table's name where its rows failed. Where any of
 * them changed in something the app reads, nothing is refreshed, and every
 * change of every such table is answered at once, so the person reads them
 * all. Otherwise each table whose content moved is refreshed in its own
 * short transaction, with the publisher as who refreshed it.
 *
 * A table managed in another project space is read where the publisher's
 * connection is on that server and approved for that project space, and
 * refreshed where those reads find nothing that stops it. In every other
 * case it is `stale`, and the publish goes on from Nova's copy: nothing of
 * that project space is written.
 *
 * Every read finishes before the first transaction opens. A table someone
 * took over with Manage in Nova between the read and its refresh is left
 * as it is, since it is then Nova's to publish.
 */
export async function reReadManagedTablesForPublish(input: {
	readonly requireHqImport: (() => void) | null;
	readonly access: {
		readonly appId: string;
		readonly projectId: string;
		readonly role: string;
		readonly actorUserId: string;
	};
	readonly doc: BlueprintDoc;
	readonly target: DeploymentTargetKey;
	readonly creds: CommCareCredentials;
	/**
	 * Checks, before each page, that the publisher may still publish: a table
	 * larger than one inline read is compared with Nova's copy by reading it
	 * in pages, and a page is read only while this resolves. Absent, such a
	 * table cannot be compared, and stops the publish with the refresh it needs.
	 */
	readonly checkAccess?: () => Promise<void>;
}): Promise<
	| ManagedTablesReRead
	/** `rows` is the name of the table whose rows could not be read, or null for the list. */
	| { readonly unreadable: HqFailure; readonly rows: string | null }
> {
	const { access, doc, target, creds } = input;
	/* Every refresh this publish writes is of reads that begin after now. */
	const at = new Date();
	const scope: LookupScope = {
		projectId: access.projectId,
		actorId: access.actorUserId,
		role: access.role,
	};
	const { tableIds, columnTargets } = extractLookupReferenceTargets(doc);
	const managed = (
		await readStoredManagedTables(access.projectId, tableIds)
	).filter((table) => table.managedBy === "commcare-hq");
	if (managed.length > 0) input.requireHqImport?.();
	const here = managed.filter((table) => originIs(table, target));
	const elsewhere = managed.filter((table) => !originIs(table, target));
	const occurrences = extractLookupReferenceOccurrences(
		doc,
		PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
	);
	const readColumnsOf = (stored: StoredManagedTable): ReadColumn[] =>
		stored.columns.flatMap((column) =>
			columnTargets.some(
				(target) =>
					target.tableId === stored.id && target.columnId === column.id,
			)
				? [
						{
							wireName: column.wireName,
							uses: occurrences.filter(
								(occurrence) =>
									occurrence.tableId === stored.id &&
									occurrence.columnId === column.id,
							).length,
						},
					]
				: [],
		);

	type Pending = {
		readonly stored: StoredManagedTable;
		readonly table: HqLookupTable;
		readonly rows: readonly HqFixtureRow[];
	};
	const blocking: {
		tag: string;
		name: string;
		changes: readonly ManagedTableChange[];
	}[] = [];
	const pending: Pending[] = [];
	let hqTables: readonly HqLookupTable[] | null = null;

	if (here.length > 0) {
		const list = await listHqLookupTables(creds, target.domain);
		if ("success" in list) {
			return {
				unreadable: classifyHqFailure(list, "lookup-tables"),
				rows: null,
			};
		}
		hqTables = list;
		const reads = await mapWithConcurrency(
			here,
			LOOKUP_ROWS_READ_CONCURRENCY,
			(stored) => readTable(creds, target.domain, list, stored),
		);
		for (const [index, stored] of here.entries()) {
			const read = reads[index];
			if (read.kind === "failed") {
				return { unreadable: read.failure, rows: stored.name };
			}
		}
		for (const [index, stored] of here.entries()) {
			const read = reads[index];
			if (read.kind === "failed") continue;
			const changes = await managedTableChanges(
				stored,
				read,
				readColumnsOf(stored),
			);
			/* A table past one inline read is no stop where it is still the
			 * table Nova's copy holds: the publish leaves it in CommCare HQ, and
			 * only a change since the copy's refresh needs that refresh. */
			if (
				changes.length === 1 &&
				changes[0]?.kind === "past-inline-read" &&
				read.kind !== "gone" &&
				(await copyStillCurrent(
					creds,
					target.domain,
					stored,
					read,
					input.checkAccess,
				))
			)
				continue;
			if (changes.length > 0) {
				blocking.push({ tag: stored.tag, name: stored.name, changes });
			} else if (read.kind === "read") {
				pending.push({ stored, table: read.table, rows: read.rows });
			}
		}
		if (blocking.length > 0) {
			return { blocking, refreshed: [], stale: [], hqTables };
		}
	}

	const stale: { tag: string; domain: string; refreshedAt: string }[] = [];
	const staleOf = (stored: StoredManagedTable) => ({
		tag: stored.tag,
		domain: stored.domain,
		refreshedAt: stored.refreshedAt,
	});
	for (const group of groupByOrigin(elsewhere)) {
		const origin = group[0];
		const credentials = await originCredentials(access.actorUserId, origin);
		if (!credentials.ok) {
			stale.push(...group.map(staleOf));
			continue;
		}
		const list = await listHqLookupTables(credentials.creds, origin.domain);
		if ("success" in list) {
			stale.push(...group.map(staleOf));
			continue;
		}
		const reads = await mapWithConcurrency(
			group,
			LOOKUP_ROWS_READ_CONCURRENCY,
			(stored) => readTable(credentials.creds, origin.domain, list, stored),
		);
		for (const [index, stored] of group.entries()) {
			const read = reads[index];
			if (read.kind !== "read") {
				stale.push(staleOf(stored));
				continue;
			}
			const changes = await managedTableChanges(
				stored,
				read,
				readColumnsOf(stored),
			);
			if (changes.length > 0) stale.push(staleOf(stored));
			else pending.push({ stored, table: read.table, rows: read.rows });
		}
	}

	const refreshed: { tag: string; receipt: ManagedRefreshReceipt }[] = [];
	for (const { stored, table, rows } of pending) {
		/* The copy compares source identities too. Replacing a row with the same
		 * values still changes its provenance. */
		try {
			const receipt = await refreshTable(
				scope,
				stored,
				table,
				rows,
				{ mode: "refresh" },
				at,
			);
			/* A newer refresh landed while this publish read CommCare HQ: the
			 * copy holds that read, and this one changed nothing. */
			if (receipt.changed !== "superseded" && receipt.changed !== "nothing") {
				refreshed.push({ tag: stored.tag, receipt });
			}
		} catch (error) {
			/* The publisher was removed from the Project, or can no longer edit
			 * it, while CommCare HQ was read: the answer every deployment write
			 * gives a member who lost access. */
			if (error instanceof LookupAuthorityError) throw deploymentNotFound();
			/* Someone chose Manage in Nova for the table since it was read: it is
			 * Nova's to publish now, and the copy stays as they left it. */
			if (error instanceof LookupError && error.code === "conflict") continue;
			throw error;
		}
	}
	return { blocking: [], refreshed, stale, hqTables };
}

/**
 * Whether CommCare HQ's table is the one Nova's copy last took: its canonical
 * digest, over the definition, the row count and every row in order, equals
 * the stored one. Rows already read inline are digested as they are; a table
 * past one inline read is read in pages, each page only while `checkAccess`
 * resolves, and nothing is kept. Without `checkAccess`, or where the paged
 * read does not finish, it is not established, so false.
 */
async function copyStillCurrent(
	creds: CommCareCredentials,
	domain: string,
	stored: StoredManagedTable,
	read: Exclude<TableRead, { readonly kind: "gone" | "failed" }>,
	checkAccess: (() => Promise<void>) | undefined,
): Promise<boolean> {
	if (read.kind === "read")
		return canonicalLookupTable(read.table, read.rows).digest === stored.digest;
	if (checkAccess === undefined) return false;
	const seen = await observeLargeLookup(creds, domain, read.table, checkAccess);
	return "canonical" in seen && seen.canonical.digest === stored.digest;
}

/** Tables grouped by the project space they came from, in their order. */
function groupByOrigin(
	tables: readonly StoredManagedTable[],
): readonly (readonly StoredManagedTable[])[] {
	const groups = new Map<string, StoredManagedTable[]>();
	for (const table of tables) {
		const key = `${table.server}\u0000${table.domain}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [table]);
		else group.push(table);
	}
	return [...groups.values()];
}

/** The origin a `project-data` edge reads of each table it plans. */
export interface LookupTableOriginRead {
	readonly tableId: string;
	readonly server: string;
	readonly domain: string;
	readonly managedBy: "commcare-hq" | "nova";
	/** Set where a person took the table over with Manage in Nova. */
	readonly takenOver: { readonly at: string; readonly by: string } | null;
	readonly remoteId: string;
	/** `hq_canonical`, as stored. */
	readonly canonical: unknown;
	readonly refreshedAt: string;
}

/**
 * The CommCare HQ origins of the tables among `tableIds` that came from
 * there, in one statement, for the push plan and its drift check.
 */
export async function readLookupTableOrigins(
	scope: DeploymentScope,
	tableIds: readonly string[],
): Promise<readonly LookupTableOriginRead[]> {
	if (!roleAllowsApp(scope.role, "view") || tableIds.length === 0) return [];
	const db = await getAppDb();
	const rows = await db
		.selectFrom("lookup_tables")
		.select([
			"id",
			"hq_server",
			"hq_domain",
			"hq_remote_id",
			"hq_canonical",
			"hq_refreshed_at",
			"hq_taken_over_at",
			"hq_taken_over_by",
		])
		.where("project_id", "=", scope.projectId)
		.where("id", "in", lookupTableIds(tableIds))
		.where("hq_server", "is not", null)
		.orderBy("id")
		.execute();
	return rows.map((row) => {
		if (
			row.hq_server === null ||
			row.hq_domain === null ||
			row.hq_remote_id === null ||
			row.hq_refreshed_at === null
		) {
			throw new Error(
				"A lookup table's CommCare HQ origin was stored only in part.",
			);
		}
		const takenOver =
			row.hq_taken_over_at === null
				? null
				: {
						at: row.hq_taken_over_at.toISOString(),
						by: row.hq_taken_over_by ?? "",
					};
		if (takenOver !== null && takenOver.by === "") {
			throw new Error("A lookup table's takeover names nobody.");
		}
		return {
			tableId: row.id,
			server: row.hq_server,
			domain: row.hq_domain,
			managedBy: takenOver === null ? "commcare-hq" : "nova",
			takenOver,
			remoteId: row.hq_remote_id,
			canonical: row.hq_canonical,
			refreshedAt: row.hq_refreshed_at.toISOString(),
		};
	});
}

/** `CanonicalLookupTable`, as `hqResourceBaseline.ts::canonicalLookupTable` writes it. */
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalLookupTableSchema = z.object({
	source: lookupSourceFactsSchema.optional(),
	remoteId: z.string().min(1),
	tag: z.string(),
	isGlobal: z.boolean(),
	fields: z.array(
		z.object({ name: z.string(), properties: z.array(z.string()) }),
	),
	itemAttributes: z.array(z.string()),
	rowCount: z.number().int().nonnegative().nullable(),
	rowsDigest: DIGEST,
	definitionDigest: DIGEST,
	digest: DIGEST,
});

/**
 * The baseline a taken-over table is compared with: its stored `hq_canonical`,
 * parsed as `CanonicalLookupTable`, under the id CommCare HQ holds the tag at
 * now. A stored value that is no such table throws: the table's CHECK and its
 * one writer rule it out.
 */
export function baselineFromTableOrigin(input: {
	/** `lookup_tables.hq_canonical` */
	readonly canonical: unknown;
	/** `remote.id` */
	readonly remoteId: string;
	/** `hq_refreshed_at` */
	readonly refreshedAt: string;
}): Exclude<ResourceBaseline, { readonly origin: "unread" }> {
	const parsed: CanonicalLookupTable = canonicalLookupTableSchema.parse(
		input.canonical,
	);
	return {
		origin: "push",
		kind: "lookup-table",
		remoteId: input.remoteId,
		canonical: { ...parsed, remoteId: input.remoteId },
		digest: parsed.digest,
		observedAt: input.refreshedAt,
	};
}

// ---------------------------------------------------------------------------
// Refresh, Manage in Nova, and the hand-back
// ---------------------------------------------------------------------------

export type ManagedTableOutcome =
	| {
			readonly ok: true;
			readonly receipt: ManagedRefreshReceipt | null;
			readonly table: LookupTableManifestEntry;
	  }
	| {
			readonly ok: false;
			readonly reason:
				| "not-found"
				| "not-permitted"
				| "not-connected"
				| "cannot-read"
				| "unavailable"
				| "table-gone"
				| "unsupported"
				/** The table is larger than one inline read, and its paged refresh needs a sign-in grant. */
				| "needs-paged-refresh"
				| "name"
				| "unrepresentable-text"
				| "state-changed"
				/** Manage in Nova or the hand-back over a table, or apps that read
				 *  it, other than the confirmation showed: nothing changed. */
				| "review-moved";
			readonly message: string;
	  };

/** `lib/lookup`'s own sentence for a table that is not there. */
export const LOOKUP_TABLE_NOT_FOUND = "Lookup resource was not found.";

type Refused = Extract<ManagedTableOutcome, { readonly ok: false }>;

function refusedTable(reason: Refused["reason"], message: string): Refused {
	return { ok: false, reason, message };
}

/** The table's definition, with its origin, or null where the Project has no such table. */
async function managedDefinition(
	scope: LookupScope,
	tableId: LookupTableId,
): Promise<LookupTableDefinition | null> {
	const parsed = lookupTableIdSchema.safeParse(tableId);
	if (!parsed.success) return null;
	const snapshot = await getLookupDefinitions(scope, [parsed.data]);
	return snapshot.definitions[0] ?? null;
}

/** The table's entry in the Project's manifest as it stands now. */
async function manifestEntry(
	scope: LookupScope,
	tableId: LookupTableId,
): Promise<LookupTableManifestEntry | null> {
	const manifest = await getLookupManifest(scope);
	return manifest.tables.find((table) => table.id === tableId) ?? null;
}

/**
 * What a read of CommCare HQ's table is for: each says the table past one
 * inline read with the next step that reaches it from there. Only a refresh
 * has a paged path; a takeover reaches one through a refresh, and a hand-back
 * or Use the table from CommCare HQ has none.
 */
type CopyPurpose = "refresh" | "take-over" | "hand-back" | "use-hq-table";

/** The refusal of `purpose` for a table past one inline read. */
function pastInlineReadRefusal(purpose: CopyPurpose): Refused {
	switch (purpose) {
		case "refresh":
			return refusedTable("needs-paged-refresh", managedTablePastInlineRead);
		case "take-over":
			return refusedTable("needs-paged-refresh", managedTakeOverPastInlineRead);
		case "hand-back":
			return refusedTable("unsupported", managedHandBackPastInlineRead);
		case "use-hq-table":
			return refusedTable("unsupported", useHqTablePastInlineRead);
	}
}

/**
 * Read CommCare HQ's table for `purpose`, with the actor's connection on the
 * origin's server, and judge what stops the copy taking it, the first in the
 * order a publish lists them.
 */
async function readForCopy(
	scope: LookupScope,
	stored: StoredManagedTable,
	purpose: CopyPurpose,
): Promise<
	| {
			readonly ok: true;
			readonly table: HqLookupTable;
			readonly rows: readonly HqFixtureRow[];
	  }
	| Refused
> {
	const credentials = await originCredentials(scope.actorId, stored);
	if (!credentials.ok) {
		return credentials.reason === "not-connected"
			? refusedTable("not-connected", CONNECT_TO_REFRESH_TABLE)
			: refusedTable("cannot-read", cannotReadManagedTables(stored.domain));
	}
	const list = await listHqLookupTables(credentials.creds, stored.domain);
	const failed = (failure: HqFailure): Refused =>
		isAccountRefusal(failure)
			? refusedTable("cannot-read", cannotReadManagedTables(stored.domain))
			: refusedTable("unavailable", HQ_UNAVAILABLE);
	if ("success" in list) {
		return failed(classifyHqFailure(list, "lookup-tables"));
	}
	const read = await readTable(credentials.creds, stored.domain, list, stored);
	if (read.kind === "failed") return failed(read.failure);
	const [change] = await managedTableChanges(stored, read, []);
	if (change !== undefined) return changeRefusal(stored, change, purpose);
	if (read.kind !== "read") {
		throw new Error("A table read as gone came back with no change.");
	}
	return { ok: true, table: read.table, rows: read.rows };
}

/** The refusal of `purpose` for the first change that stops it. */
function changeRefusal(
	stored: StoredManagedTable,
	change: ManagedTableChange,
	purpose: CopyPurpose,
): Refused {
	switch (change.kind) {
		case "table-gone":
			return refusedTable(
				"table-gone",
				managedTableGone(stored.tag, stored.domain),
			);
		case "unsupported":
			return refusedTable(
				"unsupported",
				managedTableUnsupported(describeUnsupportedLookupContent(change.holds)),
			);
		case "no-columns":
			return refusedTable("unsupported", MANAGED_TABLE_NO_COLUMNS);
		case "more-than-one-value":
			return refusedTable(
				"unsupported",
				managedTableUnsupported(HOLDS_MORE_THAN_ONE_VALUE),
			);
		case "past-inline-read":
			return pastInlineReadRefusal(purpose);
		case "name":
			return refusedTable(
				"name",
				managedTableUnsupported(holdsColumnNamed(change.name)),
			);
		case "unrepresentable-text":
			return refusedTable(
				"unrepresentable-text",
				managedTableUnrepresentable(change.column),
			);
		case "column-gone":
			throw new Error(
				"A refresh from the table's page judges no column an app reads: it keeps the column.",
			);
	}
}

/** The stored managed table `tableId`, or null where the Project has none that came from CommCare HQ. */
async function storedManagedTable(
	scope: LookupScope,
	tableId: LookupTableId,
): Promise<StoredManagedTable | null> {
	const definition = await managedDefinition(scope, tableId);
	if (definition === null || definition.hq === undefined) return null;
	const [stored] = await readStoredManagedTables(scope.projectId, [
		definition.id,
	]);
	return stored ?? null;
}

/** A single projection a Project editor explicitly chose to inspect. Project,
 * table, remote origin and the caller's existing key are resolved server-side.
 * A new full restore is fetched on each use and no unrelated restore data is returned. */
export async function inspectManagedLookupWorker(
	access: InventoryAccess,
	workerName: string,
): Promise<
	| { ok: true; tableName: string; worker: LookupWorkerProjection }
	| { ok: false; message: string }
> {
	const unavailable = {
		ok: false as const,
		message:
			"Nova couldn't verify the current data for this worker. You can check the worker's account and your connection to the table's project space, then refresh.",
	};
	const { scope, tableId } = access;
	const initial = await withAppTx((tx) => lockInventoryScope(tx, access));
	const standing = await readManagedTableReview(scope.projectId, tableId);
	const origin = standing?.definition.hq;
	if (
		!standing ||
		!origin ||
		origin.managedBy !== "commcare-hq" ||
		!roleAllowsApp(scope.role, "edit")
	)
		return unavailable;
	const grant = await originCredentials(scope.actorId, origin);
	if (!grant.ok) return unavailable;
	const listed = await listHqLookupTables(grant.creds, origin.domain);
	if ("success" in listed) return unavailable;
	const peers = listed.filter((table) => table.tag === standing.definition.tag);
	const [table] = peers;
	if (peers.length !== 1 || !table || table.id !== origin.remoteId)
		return unavailable;
	const localPart = workerName.trim().toLowerCase();
	if (localPart && !/^[\w.+-]{1,128}$/.test(localPart)) return unavailable;
	let worker: { username: string; userId?: string } = {
		username: grant.creds.username,
	};
	if (localPart) {
		const username = localPart + "@" + origin.domain + ".commcarehq.org";
		const result = await findHqMobileWorkers(grant.creds, origin.domain, [
			username,
		]);
		if (
			"success" in result ||
			result.length !== 1 ||
			result[0].username !== username
		)
			return unavailable;
		worker = result[0];
	}
	const observation = await readLookupWorkerRestore(
		grant.creds,
		origin.domain,
		table,
		worker,
		{
			binding: canonicalJsonDigest([
				scope.projectId,
				tableId,
				scope.actorId,
				standing.reviewDigest,
			]),
		},
	);
	if (
		"success" in observation ||
		observation.read !== "full" ||
		(localPart !== "" && observation.principal !== "commcare")
	)
		return unavailable;
	if (await verifyHqLookupDefinition(grant.creds, origin.domain, table))
		return unavailable;
	const [current, role, reconnected] = await Promise.all([
		readManagedTableReview(scope.projectId, tableId),
		projectRoleFor(scope.actorId, scope.projectId),
		originCredentials(scope.actorId, origin),
	]);
	if (
		!current ||
		current.reviewDigest !== standing.reviewDigest ||
		!role ||
		!roleAllowsApp(role, "edit") ||
		!reconnected.ok ||
		reconnected.creds.username !== grant.creds.username ||
		reconnected.creds.apiKey !== grant.creds.apiKey
	)
		return unavailable;
	const final = await withAppTx((tx) => lockInventoryScope(tx, access));
	if (
		final.scopeDigest !== initial.scopeDigest ||
		final.revision !== initial.revision
	)
		return unavailable;
	return { ok: true, tableName: standing.definition.name, worker: observation };
}

/** The outcome of a write that landed: the receipt and the table's manifest entry now. */
async function landed(
	scope: LookupScope,
	tableId: LookupTableId,
	receipt: ManagedRefreshReceipt | null,
): Promise<ManagedTableOutcome> {
	const table = await manifestEntry(scope, tableId);
	if (table === null) return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
	return { ok: true, receipt, table };
}

/**
 * Refresh Nova's copy of a table CommCare HQ manages: the list, then the
 * table's rows, with the actor's key, and the copy's refresh arm. Needs the
 * Project's `edit`. Every refusal leaves the copy as it was; a column an app
 * reads that CommCare HQ dropped is kept, and the receipt names it.
 */
export async function refreshManagedLookupTable(
	scope: LookupScope,
	tableId: LookupTableId,
	grant?: ProjectDataGrant,
): Promise<ManagedTableOutcome> {
	const stored = await storedManagedTable(scope, tableId);
	if (stored === null) return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
	if (!roleAllowsApp(scope.role, "edit")) {
		return refusedTable("not-permitted", REFRESH_NEEDS_EDITOR);
	}
	if (stored.managedBy !== "commcare-hq") {
		return refusedTable("state-changed", TABLE_TAKEN_OVER_MEANWHILE);
	}
	const at = new Date();
	try {
		const stream = async () => {
			if (!grant)
				return refusedTable(
					"not-permitted",
					"This refresh needs your current sign-in. You can reconnect and try again.",
				);
			const result = await refreshSourceInventory(
				{ scope, tableId, grant },
				stored,
			);
			if (!result.ok) return refusedTable(result.reason, result.message);
			return landed(scope, stored.id, result.receipt);
		};
		if (stored.sourceInventory) return await stream();
		const read = await readForCopy(scope, stored, "refresh");
		if (!read.ok)
			return read.reason === "needs-paged-refresh" && grant
				? await stream()
				: read;
		let receipt: ManagedRefreshReceipt;
		try {
			receipt = await refreshTable(
				scope,
				stored,
				read.table,
				read.rows,
				{ mode: "refresh" },
				at,
			);
		} catch (error) {
			/* Postgres measured more than one inline copy writes: the same table
			 * is read again in pages, where no size is past what Nova holds. */
			if (error instanceof LookupPastInlineCopyError && grant)
				return await stream();
			throw error;
		}
		return landed(scope, stored.id, receipt);
	} catch (error) {
		const refused = refusedWrite(error, TABLE_TAKEN_OVER_MEANWHILE);
		if (refused !== null) return refused;
		throw error;
	}
}

/**
 * The outcome for a write of the copy that the copy's own transaction
 * refused, or null for a fault: the table taken over or handed back
 * meanwhile (`conflict`, worded by `conflictMessage`), removed meanwhile, a
 * cap Postgres measured (one inline copy's, said for `purpose`, or the
 * Project's storage), or content the copy's own rules refuse. Each leaves
 * the table as it was.
 */
function refusedWrite(
	error: unknown,
	conflictMessage: string,
	purpose: CopyPurpose = "refresh",
): Refused | null {
	if (!(error instanceof LookupError)) return null;
	/* The member's role, read on the write's transaction: removed from the
	 * Project finds nothing, and a role that fell names who can. */
	if (error instanceof LookupAuthorityError) {
		if (error.standing === "not-a-member")
			return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
		return refusedTable(
			"not-permitted",
			error.capability === "delete"
				? MANAGEMENT_NEEDS_ADMIN
				: REFRESH_NEEDS_EDITOR,
		);
	}
	if (error instanceof LookupReviewMovedError)
		return refusedTable("review-moved", MANAGEMENT_REVIEW_MOVED);
	switch (error.code) {
		case "conflict":
			return refusedTable("state-changed", conflictMessage);
		case "not_found":
			return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
		case "storage_limit":
			if (!(error instanceof LookupPastInlineCopyError))
				return refusedTable("unsupported", error.message);
			return purpose === "refresh"
				? refusedTable("needs-paged-refresh", error.message)
				: pastInlineReadRefusal(purpose);
		case "managed_in_hq":
		case "referenced":
		case "accepted_design":
		case "invalid_input":
			return refusedTable("unsupported", error.message);
		default:
			return null;
	}
}

/**
 * The table's review as it stands, where it is the one the confirmation
 * showed (`reviewDigest`, from the table's view); otherwise the refusal that
 * says it moved, and the surface reads the view again. A change of who
 * manages a table is consent to what it does to the apps that read it, so it
 * acts only on what the person saw.
 */
async function reviewStanding(
	scope: LookupScope,
	tableId: LookupTableId,
	reviewDigest: string,
): Promise<
	{ readonly ok: true; readonly review: ManagedTableReview } | Refused
> {
	const review = await readManagedTableReview(scope.projectId, tableId);
	if (review === null) return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
	if (!roleAllowsApp(scope.role, "delete")) {
		return refusedTable("not-permitted", MANAGEMENT_NEEDS_ADMIN);
	}
	if (review.reviewDigest !== reviewDigest) {
		return refusedTable("review-moved", MANAGEMENT_REVIEW_MOVED);
	}
	return { ok: true, review };
}

/**
 * Hand a table CommCare HQ manages to Nova: from now on it is edited in
 * Nova and each publish to its project space replaces CommCare HQ's table
 * with Nova's. A fresh global fixture and ordered inventory establish the
 * source data and index flags. Needs the Project's `delete`,
 * read again on the write's transaction. Acts only where `reviewDigest` is
 * the table's review as it stands, and holds the write to that review under
 * the table's lock (`takeOverManagedLookupTableInTransaction`). A table Nova
 * manages already is answered as it stands.
 */
export async function manageLookupTableInNova(
	scope: LookupScope,
	tableId: LookupTableId,
	reviewDigest: string,
	dataGrant?: ProjectDataGrant,
	renewedWorkbook?: Buffer,
): Promise<ManagedTableOutcome> {
	const standing = await reviewStanding(scope, tableId, reviewDigest);
	if (!standing.ok) return standing;
	const { review } = standing;
	if (review.managedBy === "nova") return landed(scope, review.tableId, null);
	const stored = await storedManagedTable(scope, tableId);
	if (!stored) return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
	if (review.definition.hq?.source?.distribution === "assigned") {
		if (!dataGrant || !renewedWorkbook)
			return refusedTable(
				"unsupported",
				"You can download just this table from its project space and attach that new workbook to confirm its worker assignments.",
			);
		if (review.definition.hq.source.inventory !== "complete")
			return refusedTable(
				"unsupported",
				"You can refresh the source inventory before transferring this table.",
			);
		try {
			await transferAssignedSource(
				{ scope, tableId, grant: dataGrant },
				review,
				renewedWorkbook,
			);
		} catch (error) {
			const refused = refusedWrite(error, TABLE_TAKEN_OVER_MEANWHILE);
			if (refused) return refused;
			throw error;
		}
		return landed(scope, review.tableId, null);
	}
	if (review.definition.hq?.source?.storage === "generation") {
		if (!dataGrant)
			return refusedTable(
				"not-permitted",
				"This transfer needs your current sign-in. You can reconnect and try again.",
			);
		if (review.definition.hq.source.distribution !== "global")
			return refusedTable(
				"unsupported",
				"Nova needs the table’s current worker access settings before it can take over this source.",
			);
		try {
			await transferManagedGeneration(
				{ scope, tableId, grant: dataGrant },
				review,
			);
		} catch (error) {
			const refusal = refusedWrite(error, TABLE_TAKEN_OVER_MEANWHILE);
			if (refusal) return refusal;
			throw error;
		}
		return landed(scope, tableId, null);
	}
	const access = dataGrant ? { scope, tableId, grant: dataGrant } : undefined;
	const initial = access
		? await withAppTx((tx) => lockInventoryScope(tx, access, "transfer"))
		: undefined;
	const source = await readForCopy(scope, stored, "take-over");
	if (!source.ok) return source;
	const cannotTransfer = () =>
		refusedTable(
			"unsupported",
			"Nova needs the complete table and current index and worker access settings to manage it. You can keep using the table in its project space.",
		);
	if (!source.table.isGlobal) return cannotTransfer();
	const grant = await originCredentials(scope.actorId, stored);
	if (!grant.ok) return refusedTable("not-connected", CONNECT_TO_REFRESH_TABLE);
	const verified = await readVerifiedGlobalLookupRows(
		grant.creds,
		stored.domain,
		source.table,
		{
			binding: canonicalJsonDigest([
				scope.projectId,
				scope.actorId,
				tableId,
				reviewDigest,
			]),
			candidates: source.rows.map((row) => row.id),
			maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
		},
	);
	if ("success" in verified) return cannotTransfer();
	const fresh = canonicalLookupTable(source.table, verified.rows);
	if (fresh.digest !== stored.digest)
		return refusedTable(
			"review-moved",
			"The source table changed since this copy was reviewed. You can refresh it and review the changes.",
		);
	const renewed = await originCredentials(scope.actorId, stored);
	if (
		!renewed.ok ||
		renewed.creds.username !== grant.creds.username ||
		renewed.creds.apiKey !== grant.creds.apiKey
	)
		return refusedTable("not-connected", CONNECT_TO_REFRESH_TABLE);
	try {
		await withAppTx(async (tx) => {
			if (
				access &&
				initial &&
				(await lockInventoryScope(tx, access, "transfer")).scopeDigest !==
					initial.scopeDigest
			)
				throw new LookupReviewMovedError();
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"delete",
			);
			await lockLookupProjectState(tx, authority);
			await lockLookupTableForUpdate(
				tx,
				authority,
				review.tableId,
				null,
				"hq-management",
			);
			const retained = await tx
				.selectFrom("lookup_rows")
				.select(["hq_row_id", "hq_sort_key"])
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", review.tableId)
				.orderBy("order_key")
				.orderBy("id")
				.limit(verified.rows.length + 1)
				.execute();
			if (
				retained.length !== verified.rows.length ||
				retained.some(
					(row, i) =>
						row.hq_row_id !== verified.rows[i].id ||
						(row.hq_sort_key !== null &&
							row.hq_sort_key !== verified.rows[i].sortKey),
				)
			)
				throw new LookupError(
					"managed_in_hq",
					"The source row identities have changed. You can refresh the table in Project data before reviewing it again.",
				);
			return takeOverManagedLookupTableInTransaction(
				tx,
				authority,
				review.tableId,
				review,
				new Date(),
				{ sourceDigest: fresh.digest, indexedFields: verified.indexedFields },
			);
		});
	} catch (error) {
		/* Removed since it was read: the page answers as for any table that
		 * is not there. A member removed or demoted, or a review that moved,
		 * is said as `refusedWrite` says it. */
		const refused = refusedWrite(
			error,
			TABLE_TAKEN_OVER_MEANWHILE,
			"take-over",
		);
		if (refused !== null) return refused;
		throw error;
	}
	return landed(scope, review.tableId, null);
}

/**
 * Let CommCare HQ manage a table Nova took over again: Nova takes CommCare
 * HQ's columns and rows as they are now, every column becomes text, and the
 * takeover is cleared. Needs the Project's `delete`, read again on the
 * write's transaction, and the actor's connection on the origin's server.
 * Acts only where `reviewDigest` is the table's review as it stands, and the
 * adoption is held to that review (its revisions and the apps that read it)
 * under the table's lock, so an edit or a new reader that lands during the
 * read of CommCare HQ stops it. Refuses as a refresh does, leaving the table
 * as it was. A table CommCare HQ manages already is answered as it stands.
 */
export async function letHqManageLookupTable(
	scope: LookupScope,
	tableId: LookupTableId,
	reviewDigest: string,
): Promise<ManagedTableOutcome> {
	const standing = await reviewStanding(scope, tableId, reviewDigest);
	if (!standing.ok) return standing;
	const { review } = standing;
	const stored = await storedManagedTable(scope, review.tableId);
	if (stored === null) return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
	if (stored.managedBy === "commcare-hq") return landed(scope, stored.id, null);
	const at = new Date();
	const read = await readForCopy(scope, stored, "hand-back");
	if (!read.ok) return read;
	try {
		const receipt = await refreshTable(
			scope,
			stored,
			read.table,
			read.rows,
			{ mode: "adopt", reviewed: review },
			at,
		);
		return landed(scope, stored.id, receipt);
	} catch (error) {
		const refused = refusedWrite(
			error,
			error instanceof Error ? error.message : "",
			"hand-back",
		);
		if (refused !== null) return refused;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Use the table from CommCare HQ
// ---------------------------------------------------------------------------

/**
 * A project space where a publish of one of the Project's apps holds a live
 * mapping of a Nova table, under the tag the table has now: the HQ table
 * there that the Project accounts for (`store.ts::readSiblingLookupMappings`
 * reads the same rows for a push). `pushTokens` are the mappings' own tokens,
 * which every change of a mapping moves, so a confirmation is held to the
 * mappings it showed.
 */
export interface HqTableSource {
	readonly server: string;
	readonly serverLabel: string;
	readonly domain: string;
	readonly remoteId: string;
	readonly appIds: readonly string[];
	readonly pushTokens: readonly string[];
}

/** The live mappings of a table under `tag`, each HQ table once, in a stable order. */
async function readHqTableSources(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	tag: string,
	lock = false,
): Promise<readonly HqTableSource[]> {
	/* Under a write, the mappings are held `FOR SHARE` first, so a publish
	 * cannot supersede or repoint one before the write commits. */
	if (lock)
		await db
			.selectFrom("app_deployment_resources as r")
			.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
			.select("r.id")
			.where("d.project_id", "=", projectId)
			.where("r.kind", "=", "lookup-table")
			.where("r.nova_resource_id", "=", tableId)
			.where("r.superseded_at", "is", null)
			.orderBy("r.id")
			.forShare("r")
			.execute();
	const rows = await db
		.selectFrom("app_deployment_resources as r")
		.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
		.select(["d.server", "d.domain", "d.app_id", "r.remote_id", "r.push_token"])
		.where("d.project_id", "=", projectId)
		.where("r.kind", "=", "lookup-table")
		.where("r.nova_resource_id", "=", tableId)
		.where("r.superseded_at", "is", null)
		.where("r.pushed_identity", "=", tag)
		.orderBy("d.server")
		.orderBy("d.domain")
		.orderBy("r.remote_id")
		.orderBy("d.app_id")
		.orderBy("r.push_token")
		.execute();
	const sources = new Map<string, HqTableSource>();
	for (const row of rows) {
		if (!isCommCareServer(row.server)) continue;
		const key = JSON.stringify([row.server, row.domain, row.remote_id]);
		const known = sources.get(key);
		sources.set(key, {
			server: row.server,
			serverLabel: COMMCARE_SERVERS[row.server].label,
			domain: row.domain,
			remoteId: row.remote_id,
			appIds: [...(known?.appIds ?? []), row.app_id],
			pushTokens: [...(known?.pushTokens ?? []), row.push_token],
		});
	}
	return [...sources.values()];
}

/** The project space a person chose to take a table from. */
export interface HqTableSourceChoice {
	readonly server: string;
	readonly domain: string;
}

/**
 * What the table page offers a Nova table that a publish put in one or more
 * project spaces: those project spaces, and the apps that read the table.
 * Null where the Project holds no such table, or the table came from
 * CommCare HQ (its own banner offers the change of who manages it).
 */
export interface HqTableSourcesView {
	readonly name: string;
	readonly sources: readonly (HqTableSource & {
		/** Whether the viewer's CommCare HQ connection is on that server. */
		readonly connected: boolean;
	})[];
	readonly apps: readonly LookupReferencingAppSummary[];
}

export async function readHqTableSourcesView(
	scope: LookupScope,
	tableIdInput: LookupTableId,
): Promise<HqTableSourcesView | null> {
	const parsed = lookupTableIdSchema.safeParse(tableIdInput);
	if (!parsed.success) return null;
	const snapshot = await readLookupTableReviewSnapshot(
		scope.projectId,
		parsed.data,
	);
	if (snapshot === null || snapshot.managedBy !== null) return null;
	const sources = await readHqTableSources(
		await getAppDb(),
		scope.projectId,
		snapshot.tableId,
		snapshot.definition.tag,
	);
	const settings = await getCommCareSettings(scope.actorId);
	return {
		name: snapshot.definition.name,
		sources: sources.map((source) => ({
			...source,
			connected: settings.configured && settings.server === source.server,
		})),
		apps: snapshot.readers,
	};
}

/**
 * The confirmation of Use the table from CommCare HQ for one chosen project
 * space, read just now: what the table there does to Nova's, the apps that
 * read it, and the digest the confirmation carries back. It binds the
 * table's two revisions, the apps that read it, every live mapping of the
 * table and the read of CommCare HQ's table, so a change to any of them
 * after the person read this stops the change.
 */
export interface UseHqTableReview {
	readonly title: string;
	readonly lines: readonly string[];
	readonly apps: readonly LookupReferencingAppSummary[];
	readonly reviewDigest: string;
}

type UseHqTableRead =
	| {
			readonly ok: true;
			readonly review: UseHqTableReview;
			readonly reviewed: ManagedTableReviewed;
			readonly source: HqTableSource;
			readonly stored: StoredManagedTable;
			readonly table: HqLookupTable;
			readonly rows: readonly HqFixtureRow[];
	  }
	| Refused;

async function readUseHqTable(
	scope: LookupScope,
	tableIdInput: LookupTableId,
	choice: HqTableSourceChoice,
): Promise<UseHqTableRead> {
	const parsed = lookupTableIdSchema.safeParse(tableIdInput);
	if (!parsed.success) return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
	if (!roleAllowsApp(scope.role, "delete"))
		return refusedTable("not-permitted", MANAGEMENT_NEEDS_ADMIN);
	const snapshot = await readLookupTableReviewSnapshot(
		scope.projectId,
		parsed.data,
	);
	if (snapshot === null)
		return refusedTable("not-found", LOOKUP_TABLE_NOT_FOUND);
	const { definition } = snapshot;
	if (snapshot.managedBy !== null)
		return refusedTable("state-changed", TABLE_HAS_HQ_ORIGIN);
	const sources = await readHqTableSources(
		await getAppDb(),
		scope.projectId,
		snapshot.tableId,
		definition.tag,
	);
	if (sources.length === 0)
		return refusedTable("not-found", USE_HQ_TABLE_NO_SOURCE);
	const matching = sources.filter(
		(source) =>
			source.server === choice.server && source.domain === choice.domain,
	);
	const [source] = matching;
	if (source === undefined || matching.length !== 1)
		return refusedTable("review-moved", takeHqTableSourceMoved(choice.domain));
	const stored: StoredManagedTable = {
		sourceInventory: false,
		projectId: scope.projectId,
		id: snapshot.tableId,
		name: definition.name,
		tag: definition.tag,
		server: source.server,
		domain: source.domain,
		remoteId: source.remoteId,
		digest: "",
		refreshedAt: new Date(0).toISOString(),
		managedBy: "commcare-hq",
		columns: [],
	};
	const read = await readForCopy(scope, stored, "use-hq-table");
	if (!read.ok) return read;
	const fields = new Set(read.table.fields);
	const kept = new Set(
		(
			await readKeptLookupColumnIds(await getAppDb(), scope.projectId, [
				snapshot.tableId,
			])
		)[snapshot.tableId] ?? [],
	);
	const columnsByWire = new Set(
		definition.columns.map((column) => column.wireName),
	);
	const otherDomains = [
		...new Set(
			sources.filter((other) => other !== source).map((other) => other.domain),
		),
	];
	const reviewed: ManagedTableReviewed = {
		definitionRevision: snapshot.definitionRevision,
		rowsRevision: snapshot.rowsRevision,
		readerAppIds: snapshot.readerAppIds,
	};
	const lines = [
		takeHqTableBody(source.domain),
		...takeHqTableChanges({
			domain: source.domain,
			rowsBefore: snapshot.rowCount,
			rowsAfter: read.rows.length,
			addedColumns: read.table.fields.filter(
				(field) => !columnsByWire.has(field),
			),
			removedColumns: definition.columns
				.filter(
					(column) => !fields.has(column.wireName) && !kept.has(column.id),
				)
				.map((column) => column.label),
			keptColumns: definition.columns
				.filter((column) => !fields.has(column.wireName) && kept.has(column.id))
				.map((column) => column.label),
			typedColumns: definition.columns
				.filter(
					(column) => column.dataType !== "text" && fields.has(column.wireName),
				)
				.map((column) => column.label),
			assignmentsRemoved: definition.workerAccess === "assigned",
			assignedInHq: !read.table.isGlobal,
			otherDomains,
		}),
	];
	const readers = appsThatReadIt(snapshot.readers);
	if (readers !== null) lines.push(readers);
	const reviewDigest = canonicalJsonDigest({
		v: 1,
		action: "use-hq-table",
		tableId: snapshot.tableId,
		definitionRevision: snapshot.definitionRevision,
		rowsRevision: snapshot.rowsRevision,
		readerAppIds: snapshot.readerAppIds,
		mappings: sources.map((one) => [
			one.server,
			one.domain,
			one.remoteId,
			one.pushTokens,
		]),
		source: [source.server, source.domain, source.remoteId],
		hq: canonicalLookupTable(read.table, read.rows).digest,
	});
	return {
		ok: true,
		review: {
			title: takeHqTableTitle(definition.name, source.domain),
			lines,
			apps: snapshot.readers,
			reviewDigest,
		},
		reviewed,
		source,
		stored,
		table: read.table,
		rows: read.rows,
	};
}

/**
 * Read what Use the table from CommCare HQ would do with the table in
 * `choice`, writing nothing: the confirmation's title and lines and the
 * digest it carries back. Refuses as the change itself does.
 */
export async function reviewUseHqTable(
	scope: LookupScope,
	tableId: LookupTableId,
	choice: HqTableSourceChoice,
): Promise<{ readonly ok: true; readonly review: UseHqTableReview } | Refused> {
	const read = await readUseHqTable(scope, tableId, choice);
	return read.ok ? { ok: true, review: read.review } : read;
}

/**
 * Use the table from CommCare HQ: a Nova table a publish put in `choice`
 * becomes Nova's copy of the table there, managed in CommCare HQ from then
 * on, as a table brought in from there is. Needs the Project's `delete`,
 * read again on the write's transaction, and the actor's connection on that
 * server. Acts only where `reviewDigest` is the review read again now: the
 * table's revisions, its readers, every live mapping of it and CommCare HQ's
 * table there. Under the Project state and the table's lock it reads the
 * mappings again `FOR SHARE`, so a publish cannot supersede or repoint the
 * chosen one before this commits, and takes CommCare HQ's columns and rows
 * through the copy's own `adopt` arm, which compares the table's revisions
 * and readers under that lock and waits for an open workbook carrying it.
 * The table keeps its id, so no app changes; the next publish to `choice`
 * leaves the table there as it is and supersedes the mapping.
 */
export async function takeHqTableForLookupTable(
	scope: LookupScope,
	tableId: LookupTableId,
	choice: HqTableSourceChoice,
	reviewDigest: string,
): Promise<ManagedTableOutcome> {
	const at = new Date();
	const read = await readUseHqTable(scope, tableId, choice);
	if (!read.ok) return read;
	if (read.review.reviewDigest !== reviewDigest)
		return refusedTable("review-moved", MANAGEMENT_REVIEW_MOVED);
	const canonical = canonicalLookupTable(read.table, read.rows);
	try {
		const receipt = await withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"delete",
			);
			await lockLookupProjectState(tx, authority);
			const locked = await lockLookupTableForUpdate(
				tx,
				authority,
				read.stored.id,
				null,
				"hq-management",
			);
			if (locked.hq_server !== null || locked.tag !== read.stored.tag)
				throw new LookupReviewMovedError();
			const now = await readHqTableSources(
				tx,
				scope.projectId,
				read.stored.id,
				read.stored.tag,
				true,
			);
			const same = now.find(
				(source) =>
					source.server === read.source.server &&
					source.domain === read.source.domain &&
					source.remoteId === read.source.remoteId,
			);
			if (
				same === undefined ||
				same.pushTokens.join() !== read.source.pushTokens.join()
			)
				throw new LookupReviewMovedError();
			return refreshManagedLookupTableInTransaction(tx, authority, {
				tableId: read.stored.id,
				content: managedLookupContentOf(read.table, read.rows),
				origin: {
					server: read.source.server,
					domain: read.source.domain,
					remoteId: read.table.id,
					canonical: { ...canonical },
				},
				at,
				olderReadYields: true,
				mode: "adopt",
				reviewed: read.reviewed,
			});
		});
		return landed(scope, read.stored.id, receipt);
	} catch (error) {
		const refused = refusedWrite(
			error,
			error instanceof Error ? error.message : "",
			"use-hq-table",
		);
		if (refused !== null) return refused;
		throw error;
	}
}

/** Whether the viewer's CommCare HQ connection is on `server`. */
async function connectedOn(userId: string, server: string): Promise<boolean> {
	const settings = await getCommCareSettings(userId);
	return settings.configured && settings.server === server;
}

/** The server's label and base address, for an origin Nova stored. */
function serverOf(server: string): { label: string; baseUrl: string } {
	if (!isCommCareServer(server)) {
		throw new Error(
			`A CommCare HQ origin names the server "${server}", which Nova does not know.`,
		);
	}
	return COMMCARE_SERVERS[server];
}

/** What the table page shows of a table that came from CommCare HQ. `view`. */
export async function readManagedLookupTableView(
	scope: LookupScope,
	tableId: LookupTableId,
): Promise<{
	readonly origin: LookupHqOrigin;
	readonly serverLabel: string;
	readonly hqUrl: string;
	/** Whether the viewer has a CommCare HQ connection on that server. */
	readonly connected: boolean;
	readonly apps: readonly LookupReferencingAppSummary[];
	readonly goneColumns: readonly {
		readonly wireName: string;
		readonly apps: readonly LookupReferencingAppSummary[];
	}[];
	/**
	 * What a change of who manages the table is decided over (who manages
	 * it, its revisions and `apps`), as one digest. Manage in Nova and the
	 * hand-back send it back, and act only while it is the table's.
	 */
	readonly reviewDigest: string;
	/** The table's name, as the confirmations title it. */
	readonly name: string;
	/** The labels of the columns that are not text, which a hand-back makes text. */
	readonly typedColumns: readonly string[];
} | null> {
	const parsed = lookupTableIdSchema.safeParse(tableId);
	if (!parsed.success) return null;
	const review = await readManagedTableReview(scope.projectId, parsed.data);
	if (review === null) return null;
	const { definition, readers: apps } = review;
	const origin = definition.hq;
	if (origin === undefined) return null;
	const server = serverOf(origin.server);
	const db = await getAppDb();
	const goneColumns = [];
	for (const columnId of origin.goneColumnIds) {
		const column = definition.columns.find(
			(candidate) => candidate.id === columnId,
		);
		if (column === undefined) continue;
		goneColumns.push({
			wireName: column.wireName,
			apps: await readLookupReferencingApps(db, {
				projectId: scope.projectId,
				tableId: definition.id,
				columnId,
			}),
		});
	}
	return {
		origin,
		serverLabel: server.label,
		hqUrl: `${server.baseUrl}/a/${origin.domain}/fixtures/`,
		connected: await connectedOn(scope.actorId, origin.server),
		apps,
		goneColumns,
		reviewDigest: review.reviewDigest,
		name: definition.name,
		typedColumns: definition.columns
			.filter((column) => column.dataType !== "text")
			.map((column) => column.label),
	};
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export type ManagedPlacesOutcome =
	| {
			readonly ok: true;
			readonly refresh: ManagedPlacesRefresh;
			/** `hq_refreshed_at` as this refresh wrote it. */
			readonly refreshedAt: string;
	  }
	| {
			readonly ok: false;
			readonly reason:
				| "not-found"
				| "not-permitted"
				| "not-connected"
				| "cannot-read"
				| "unavailable"
				| "over-limit"
				| "not-holdable";
			readonly message: string;
	  };

type PlacesRefused = Extract<ManagedPlacesOutcome, { readonly ok: false }>;

/** `lib/organization`'s own sentence for an app with no places from CommCare HQ. */
export const NO_MANAGED_PLACES =
	"This app has no places from CommCare HQ to refresh. Reload to get the latest organization.";

/**
 * Refresh Nova's copy of an app's places from the project space that
 * manages them, over `hqPlaces` that project space listed: the copy is
 * planned over the app's levels and location properties as the document
 * holds them in the same transaction, and written by the organization's
 * refresh writer. A plan with findings writes nothing. Never writes the
 * document. `at` is when the read began, taken before CommCare HQ was asked.
 */
export async function refreshManagedPlacesFromRead(
	scope: OrganizationScope,
	origin: { readonly server: string; readonly domain: string },
	hqPlaces: readonly HqLocation[],
	at: Date,
): Promise<ManagedPlacesOutcome> {
	try {
		return await withAppTx(async (tx: Transaction<AppDatabase>) => {
			const app = await loadAppInTransaction(tx, scope.appId);
			if (app === null) {
				return placesRefused("not-found", NO_MANAGED_PLACES);
			}
			const doc = hydratePersistedBlueprint(app.blueprint);
			if (hqPlaces.some((place) => place.observation === undefined))
				return placesRefused(
					"cannot-read",
					"Nova needs both place inventories from the source project space to refresh its copy. Check your connection to that space, then try again.",
				);
			const plan: ManagedPlacePlan = planManagedPlaces({
				hqPlaces,
				levels: orderedOrganizationLevels(doc),
				properties: orderedLocationProperties(doc),
				mode: "refresh",
			});
			const [finding] = plan.findings;
			if (finding !== undefined) {
				return placesRefused(
					"not-holdable",
					managedPlaceNotHoldable(
						finding.detail.name ?? origin.domain,
						origin.domain,
					),
				);
			}
			const refresh = await refreshManagedPlacesInTransaction(tx, scope, {
				plan,
				at,
				origin,
			});
			return { ok: true, refresh, refreshedAt: at.toISOString() } as const;
		});
	} catch (error) {
		if (error instanceof OrganizationError) {
			if (error.code === "limit") {
				return placesRefused("over-limit", error.message);
			}
			if (error.code === "rejected") {
				return placesRefused("not-holdable", error.message);
			}
			if (error.code === "not_found") {
				return placesRefused("not-found", error.message);
			}
			if (error.code === "forbidden") {
				return placesRefused("not-permitted", REFRESH_NEEDS_EDITOR);
			}
		}
		throw error;
	}
}

function placesRefused(
	reason: PlacesRefused["reason"],
	message: string,
): PlacesRefused {
	return { ok: false, reason, message };
}

/**
 * Refresh Nova's copy of an app's places from the project space that
 * manages them, with the actor's key on the origin's server. Needs `edit`.
 * Every refusal leaves the copy as it was.
 */
export async function refreshManagedPlaces(
	scope: OrganizationScope,
): Promise<ManagedPlacesOutcome> {
	const { hq } = await readPlaceState(scope);
	if (hq === undefined) return placesRefused("not-found", NO_MANAGED_PLACES);
	if (!roleAllowsApp(scope.role, "edit")) {
		return placesRefused("not-permitted", REFRESH_NEEDS_EDITOR);
	}
	const credentials = await originCredentials(scope.actorUserId, hq);
	if (!credentials.ok) {
		return credentials.reason === "not-connected"
			? placesRefused("not-connected", CONNECT_TO_REFRESH_PLACES)
			: placesRefused("cannot-read", cannotReadManagedPlaces(hq.domain));
	}
	const at = new Date();
	const inventory = await readHqPlaceInventory(credentials.creds, hq.domain);
	if (inventory.kind === "inconsistent")
		return placesRefused(
			"not-holdable",
			"The place lists in CommCare HQ disagree. You can check the levels and parents there, then refresh again.",
		);
	if (inventory.kind === "failed") {
		const failure = classifyHqFailure(inventory.error, inventory.request);
		if (isAccountRefusal(failure))
			return placesRefused("cannot-read", cannotReadManagedPlaces(hq.domain));
		// A list past what Nova reads stays past it: no retry would answer.
		if (inventory.error.cause === "too-large")
			return placesRefused(
				"over-limit",
				managedPlacesPastInventory(hq.domain, HQ_LOCATION_INVENTORY_MAX_ROWS),
			);
		return placesRefused("unavailable", HQ_UNAVAILABLE);
	}
	return refreshManagedPlacesFromRead(scope, hq, inventory.places, at);
}

/** What the Organization banner shows of places that came from CommCare HQ. `view`. */
export async function readManagedPlacesView(scope: OrganizationScope): Promise<{
	readonly serverLabel: string;
	readonly hqUrl: string;
	/** Whether the viewer has a CommCare HQ connection on that server. */
	readonly connected: boolean;
} | null> {
	const { hq } = await readPlaceState(scope);
	if (hq === undefined) return null;
	const server = serverOf(hq.server);
	return {
		serverLabel: server.label,
		hqUrl: `${server.baseUrl}/a/${hq.domain}/settings/locations/list/`,
		connected: await connectedOn(scope.actorUserId, hq.server),
	};
}

/** The app's managed places as provisioning reads them on one project space. */
export interface ManagedPlaceIds {
	/**
	 * Each live place of the copy, by Nova's id, to CommCare HQ's id for it
	 * and the level the copy stands it at.
	 */
	readonly ids: ReadonlyMap<
		string,
		{ readonly hqLocationId: string; readonly levelUuid: string }
	>;
	/**
	 * The live places of the copy a refresh found gone from CommCare HQ
	 * (`hq_gone_at`) and kept, because a persona, an owner rule or an
	 * automation still names them. CommCare HQ refuses an account standing in
	 * one, so provisioning refuses it first.
	 */
	readonly gone: ReadonlySet<string>;
}

/**
 * The app's managed places on `target`, where the target is the project
 * space that manages them: each live place's CommCare HQ id and level, and the live
 * places CommCare HQ no longer has. Empty everywhere else, where places reach
 * CommCare HQ through the publish's own `location` mappings. `view`.
 */
export async function readManagedPlaceIds(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<ManagedPlaceIds> {
	if (!roleAllowsApp(scope.role, "view")) {
		return { ids: new Map(), gone: new Set() };
	}
	const db = await getAppDb();
	const rows = await db
		.selectFrom("app_locations as l")
		.innerJoin("app_organization_state as s", "s.app_id", "l.app_id")
		.innerJoin("apps as a", "a.id", "l.app_id")
		.select(["l.id", "l.hq_location_id", "l.hq_gone_at", "l.level_uuid"])
		.where("l.app_id", "=", scope.appId)
		.where("a.project_id", "=", scope.projectId)
		.where("s.hq_server", "=", target.server)
		.where("s.hq_domain", "=", target.domain)
		.where("l.archived_at", "is", null)
		.execute();
	const ids = new Map<
		string,
		{ readonly hqLocationId: string; readonly levelUuid: string }
	>();
	const gone = new Set<string>();
	for (const row of rows) {
		if (row.hq_location_id === null || row.hq_gone_at !== null)
			gone.add(row.id);
		else
			ids.set(row.id, {
				hqLocationId: row.hq_location_id,
				levelUuid: row.level_uuid,
			});
	}
	return { ids, gone };
}
