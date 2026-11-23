import "server-only";

/**
 * The two functions of a bring-in's lookup tables that reach a store: the
 * read of CommCare HQ's tables the app may read, and the birth's write of the
 * tables it reads into the Project. Every decision is `lookupTables.ts`'s.
 */

import type { Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	HQ_LOOKUP_INLINE_READ_MAX_ROWS,
	HQ_LOOKUP_ROWS_REQUEST_MAX_BYTES,
	HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
} from "@/lib/commcare/hq/bounds";
import type {
	CommCareApiError,
	CommCareCredentials,
} from "@/lib/commcare/hq/http";
import { readSelectedHqLookupRows } from "@/lib/commcare/hq/lookupSource";
import {
	type HqLookupTable,
	listHqLookupTables,
} from "@/lib/commcare/hq/lookupTables";
import type { AppDatabase } from "@/lib/db/pg";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { recordFromEntries } from "@/lib/domain/records";
import { readLookupFixtureDataInTransaction } from "@/lib/lookup/fixtureSnapshot";
import {
	createManagedLookupTablesInTransaction,
	type ManagedOriginWrite,
	type ManagedTableReviewed,
	readKeptLookupColumnIds,
	refreshManagedLookupTableInTransaction,
} from "@/lib/lookup/managed";
import type { ManagedLookupContent } from "@/lib/lookup/managedRules";
import { parseLookupRevision } from "@/lib/lookup/schema";
import {
	authorizeLookupWriteInTransaction,
	lockLookupProjectState,
} from "@/lib/lookup/writerTransaction";
import { canonicalLookupTable } from "../../hqResourceBaseline";
import { readSiblingLookupMappings } from "../../store";
import { isDeploymentServer } from "../../types";
import {
	type BroughtInTableWrite,
	type HqLookupTableRead,
	lookupTableStanding,
	managedLookupContentOf,
	sameManagedColumnCapFinding,
} from "./lookupTables";

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** Whether a failed row read is sent once more: an answered status of 500 or more that the
 *  edge did not give, or no answer at all. A read no answer began for has gone out twice
 *  by then, since `readHqJson` sends it once more itself; a read whose body the network
 *  cut off has gone out once, since `readHqJson` sends that one no more. */
function worthResending(error: CommCareApiError): boolean {
	return (
		error.cause === "network" ||
		(error.cause === undefined &&
			error.edgeRefusal !== true &&
			error.status >= 500)
	);
}

/** An answered status of 500 or more, from CommCare HQ itself, that is no gateway's. */
function failsEveryTime(error: CommCareApiError): boolean {
	return (
		error.cause === undefined &&
		error.edgeRefusal !== true &&
		error.status >= 500 &&
		error.status !== 502 &&
		error.status !== 503 &&
		error.status !== 504
	);
}

/**
 * The project space's lookup tables the source may read, with their rows.
 * One list read; then, for each table the reading references, its rows, one table at a time, stopping once the
 * first page names more rows than Nova holds (`over-row-limit`) or the rows
 * pass `HQ_LOOKUP_TABLE_ROWS_MAX_BYTES` (`over-byte-limit`), each a finding of
 * that table. The rows the request keeps are bounded together too: each table
 * is read at most as far as what remains of
 * `HQ_LOOKUP_ROWS_REQUEST_MAX_BYTES`, and a table that passes what remains,
 * including a table after the total inline budget is spent, retains its
 * confirmed source definition for a later independent paged refresh.
 *
 * A row read that fails with an answered status of 500 or more, or with no
 * answer, is sent once more. `readHqJson` already sends a read no answer began
 * for a second time, so a row read that never gets an answer goes out four
 * times in all, and one whose answer the network cuts off while its body
 * streams twice. Where both answers are a status of 500 or more
 * from CommCare HQ itself other than 502, 503 and 504, the table's rows are
 * unreadable: CommCare HQ fails that read every time for a row holding a field
 * with no value (`fixtures/models.py::LookupTableRow.fields_without_attributes`
 * raises `IndexError`, and `fixtures/resources/v0_1.py::FixtureResource.dehydrate_fields`
 * catches `FixtureVersionError` alone). Any other failing pair, and a failed
 * list, is returned as the failure, for the caller to classify, with the read
 * it answered: `lookup-tables` for the list, `lookup-rows` for a table's
 * rows, which CommCare HQ guards with different permissions.
 *
 * `listed` is every tag of the list, so a caller tells a table that is not
 * there from one whose rows were never asked for.
 */
export async function readHqLookupTablesForReading(input: {
	readonly creds: CommCareCredentials;
	readonly domain: string;
	readonly referencedTags: (
		listed: readonly HqLookupTable[],
	) => Promise<ReadonlySet<string>>;
	readonly cancel?: AbortSignal;
}): Promise<
	| {
			readonly tables: readonly HqLookupTableRead[];
			readonly listed: readonly string[];
	  }
	| HqLookupReadFailure
> {
	const { creds, domain, cancel } = input;
	const list = await listHqLookupTables(creds, domain, { cancel });
	if ("success" in list) return { ...list, request: "lookup-tables" };
	const candidates =
		list.length === 0
			? new Set<string>()
			: new Set(await input.referencedTags(list));
	const distinct = new Set<string>();
	for (const table of list) {
		if (!candidates.has(table.tag)) continue;
		if (distinct.has(table.tag))
			return {
				success: false,
				status: 503,
				cause: "moved",
				request: "lookup-tables",
			};
		distinct.add(table.tag);
	}
	const tables: HqLookupTableRead[] = [];
	/* What remains of the request's bound on the rows it keeps. */
	let remaining = HQ_LOOKUP_ROWS_REQUEST_MAX_BYTES;
	for (const table of list) {
		if (!candidates.has(table.tag)) continue;
		candidates.delete(table.tag);
		const bound = Math.min(HQ_LOOKUP_TABLE_ROWS_MAX_BYTES, remaining);
		const readRows = () =>
			readSelectedHqLookupRows(creds, domain, table, {
				cancel,
				maxRows: HQ_LOOKUP_INLINE_READ_MAX_ROWS,
				maxBytes: bound,
			});
		let answer = await readRows();
		if (
			"success" in answer &&
			worthResending(answer) &&
			cancel?.aborted !== true
		) {
			const first = answer;
			answer = await readRows();
			if ("success" in answer) {
				if (failsEveryTime(first) && failsEveryTime(answer)) {
					tables.push({ kind: "rows-unreadable", table });
					continue;
				}
				return { ...answer, request: "lookup-rows" };
			}
		}
		if ("success" in answer) return { ...answer, request: "lookup-rows" };
		if ("kind" in answer) {
			if (answer.by === "rows") {
				tables.push({
					kind: "over-row-limit",
					table,
					totalCount: answer.totalCount,
				});
				continue;
			}
			tables.push({ kind: "over-byte-limit", table });
			continue;
		}
		remaining -= answer.bytes;
		tables.push({
			kind: "read",
			table,
			rows: answer.rows,
			canonical: canonicalLookupTable(table, answer.rows),
		});
	}
	return { tables, listed: list.map((table) => table.tag) };
}

/** A failed read of a bring-in's lookup tables, with the read that failed. */
export type HqLookupReadFailure = CommCareApiError & {
	readonly request: "lookup-tables" | "lookup-rows";
};

// ---------------------------------------------------------------------------
// The birth's write
// ---------------------------------------------------------------------------

/** A table the birth was about to write is no longer the table the review showed. */
export class BroughtInTableChangedError extends Error {
	readonly name = "BroughtInTableChangedError";
	readonly tag: string;
	constructor(tag: string) {
		super(
			`The lookup table ${tag} changed in the Project between the review and the birth.`,
		);
		this.tag = tag;
	}
}

/**
 * Write the tables a bring-in's app reads, inside the transaction that makes
 * the app or commits its change: the birth's, after its app row is inserted,
 * and a bring-in of changes made in CommCare HQ's commit, after its app row,
 * head and membership checks; in both before the gate reads the Project's
 * lookup definitions. A bring-in that is turned back therefore creates and
 * changes no lookup table.
 *
 * It reads the member's role on that transaction
 * (`authorizeLookupWriteInTransaction`), then, under the Project's lookup
 * lock, the Project's tables of the written tags with their rows and the
 * columns CommCare HQ's content would keep, and derives each standing again,
 * with the sibling mappings read on the same transaction. Every writer of a
 * table's content takes that lock first, so these reads stand until commit.
 * Where a standing's kind is no longer the one its binding was made for, an
 * answered offer is no longer offered, a `same-managed` table would now hold
 * more columns than Nova takes, or a Project table's revisions moved since the
 * read, it throws `BroughtInTableChangedError` and the transaction rolls back
 * whole. Otherwise one create for the `new` tables, then a refresh for each
 * `same-managed` and an adopt for each `use-commcare-hq`, in table id order,
 * the order every writer that locks several of the Project's tables takes
 * them in; nothing for a table used as it stands. A `choice` with no answer
 * never reaches here.
 *
 * Each refresh and adoption is held, under the table's own lock, to what the
 * reading saw (`ManagedTableReviewed`): its revisions, and for an adoption
 * the apps the review listed as reading the table. An app that began reading
 * it since moves no revision, and app commits take no Project state, so only
 * that lock makes the list hold. A mismatch is `LookupReviewMovedError`.
 *
 * `readAt` is when the reading's read of CommCare HQ's tables began. A table
 * the bring-in would refresh or adopt whose stored `hq_refreshed_at` is later
 * was refreshed from a newer read of CommCare HQ since, which need move no
 * revision, so the writer refuses it (`LookupReviewMovedError`) rather than
 * write the older read over it. Every table the bring-in writes is stamped
 * `readAt`, so a refresh whose read began before the bring-in's never
 * replaces it.
 *
 * The standing is derived again with no apps and no fields read: its kind
 * depends on neither, and the one offer that reads the fields, `use-project`'s
 * missing column, reads the table's definition, whose revision is held.
 */
export async function writeBroughtInLookupTablesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: {
		readonly projectId: string;
		readonly actorUserId: string;
		/** The app the birth inserted: its own mappings are no sibling's. */
		readonly appId: string;
	},
	write: {
		readonly origin: { readonly server: string; readonly domain: string };
		readonly tables: readonly BroughtInTableWrite[];
		readonly readAt: Date;
	},
): Promise<void> {
	if (write.tables.length === 0) return;
	const { origin } = write;
	if (!isDeploymentServer(origin.server)) {
		throw new Error(
			`A bring-in names the CommCare HQ server "${origin.server}", which Nova does not know.`,
		);
	}
	const authority = await authorizeLookupWriteInTransaction(
		tx,
		{ projectId: scope.projectId, actorId: scope.actorUserId },
		"edit",
	);
	const { role } = authority;
	const mayAdminister = roleAllowsApp(role, "delete");

	await lockLookupProjectState(tx, authority);
	const tags = write.tables.map((table) => table.read.table.tag);
	const stored = await tx
		.selectFrom("lookup_tables")
		.select([
			"id",
			"tag",
			(eb) =>
				eb
					.cast<string>("definition_revision", "text")
					.as("definition_revision"),
			(eb) => eb.cast<string>("rows_revision", "text").as("rows_revision"),
			"hq_refreshed_at",
		])
		.where("project_id", "=", scope.projectId)
		.where("tag", "in", tags)
		.execute();
	const storedByTag = new Map(stored.map((row) => [row.tag, row]));
	const tableIds = stored.map((row) => lookupTableIdSchema.parse(row.id));
	const snapshot = await readLookupFixtureDataInTransaction(
		tx,
		scope.projectId,
		tableIds,
		"project-editor",
	);
	const siblings = await readSiblingLookupMappings(
		{
			appId: scope.appId,
			projectId: scope.projectId,
			role,
			actorUserId: scope.actorUserId,
		},
		{ server: origin.server, domain: origin.domain },
		tableIds,
		tx,
	);
	const keptColumns = await readKeptLookupColumnIds(
		tx,
		scope.projectId,
		tableIds,
	);

	const created: Parameters<
		typeof createManagedLookupTablesInTransaction
	>[2][number][] = [];
	const refreshes: {
		readonly tableId: string;
		readonly mode: "refresh" | "adopt";
		/** What the reading saw of the Project table, which the write holds it to under its lock. */
		readonly reviewed: ManagedTableReviewed;
		readonly content: ManagedLookupContent;
		readonly origin: ManagedOriginWrite;
		readonly newMemberIds?: BroughtInTableWrite["binding"]["memberIds"];
		readonly newColumnIds: BroughtInTableWrite["binding"]["columns"];
	}[] = [];
	for (const table of write.tables) {
		const tag = table.read.table.tag;
		const row = storedByTag.get(tag);
		if (table.projectTable === null) {
			if (row !== undefined) throw new BroughtInTableChangedError(tag);
		} else if (
			row === undefined ||
			row.id !== table.projectTable.tableId ||
			row.definition_revision !== table.projectTable.definitionRevision ||
			row.rows_revision !== table.projectTable.rowsRevision
		) {
			throw new BroughtInTableChangedError(tag);
		}
		const definition =
			row === undefined
				? undefined
				: snapshot.definitions.find((candidate) => candidate.id === row.id);
		if (row !== undefined && definition === undefined) {
			throw new BroughtInTableChangedError(tag);
		}
		const keptColumnIds =
			definition === undefined || !Object.hasOwn(keptColumns, definition.id)
				? []
				: keptColumns[definition.id];
		const standing = lookupTableStanding({
			read: table.read,
			origin,
			existing:
				definition === undefined
					? null
					: {
							table: definition,
							rows: snapshot.rowsByTable.get(definition.id) ?? [],
						},
			apps: [],
			siblings: siblings.filter(
				(sibling) => sibling.tableId === definition?.id,
			),
			appReads: [],
			mayAdminister,
			keptColumnIds,
		});
		if (
			standing.kind !== table.standing.kind ||
			sameManagedColumnCapFinding(table.read, standing, keptColumnIds) !== null
		) {
			throw new BroughtInTableChangedError(tag);
		}
		const content = managedLookupContentOf(table.read.table, table.read.rows);
		const managedOrigin: ManagedOriginWrite = {
			server: origin.server,
			domain: origin.domain,
			remoteId: table.read.table.id,
			canonical: { ...table.read.canonical },
		};
		let mode: "refresh" | "adopt" | null = null;
		switch (standing.kind) {
			case "new":
				created.push({
					binding: table.binding,
					name: tag,
					content,
					origin: managedOrigin,
				});
				break;
			case "same-managed":
				mode = "refresh";
				break;
			case "same-equal":
				break;
			case "choice": {
				if (table.choice === null) {
					/* Named by its place in the write, never its tag: this reaches the route's
					 * failed line and Sentry (layer 7's small edit, kept for the
					 * rebase). */
					throw new Error(
						`A lookup table reached the birth with no answer to its choice (table ${write.tables.indexOf(table) + 1} of the ${write.tables.length} the birth writes).`,
					);
				}
				if (!standing.options[table.choice].offered) {
					throw new BroughtInTableChangedError(tag);
				}
				if (table.choice === "use-commcare-hq") mode = "adopt";
				break;
			}
		}
		if (mode === null || definition === undefined) continue;
		if (table.projectTable === null) {
			throw new Error(
				`A lookup table the bring-in refreshes or adopts reached the write with no Project table (table ${write.tables.indexOf(table) + 1} of the ${write.tables.length} it writes).`,
			);
		}
		// The fields the Project table has no column for take the ids the
		// binding gave them, so the document's reads name the columns made.
		const wireNames = new Set(
			definition.columns.map((column) => column.wireName),
		);
		refreshes.push({
			tableId: definition.id,
			mode,
			reviewed: {
				definitionRevision: parseLookupRevision(
					table.projectTable.definitionRevision,
				),
				rowsRevision: parseLookupRevision(table.projectTable.rowsRevision),
				/* The apps the person was shown reading the table, which an
				 * adoption is held to; a refresh of a table managed from this
				 * project space names none and is held to its revisions. */
				readerAppIds:
					table.standing.kind === "choice"
						? table.standing.apps.map((app) => app.appId).sort()
						: [],
			},
			content,
			origin: managedOrigin,
			newMemberIds: table.binding.memberIds,
			newColumnIds: recordFromEntries(
				Object.entries(table.binding.columns).filter(
					([field]) => !wireNames.has(field),
				),
			),
		});
	}

	if (created.length > 0) {
		await createManagedLookupTablesInTransaction(
			tx,
			authority,
			created,
			write.readAt,
		);
	}
	refreshes.sort((left, right) =>
		left.tableId < right.tableId ? -1 : left.tableId > right.tableId ? 1 : 0,
	);
	for (const refresh of refreshes) {
		const base = {
			tableId: lookupTableIdSchema.parse(refresh.tableId),
			content: refresh.content,
			origin: refresh.origin,
			at: write.readAt,
			newMemberIds: refresh.newMemberIds,
			newColumnIds: refresh.newColumnIds,
			/* The app's columns bind the ids the reading gave them, so the
			 * bring-in writes what the reading read, or refuses where a newer
			 * read of CommCare HQ's table landed since. */
			olderReadYields: false,
		};
		await refreshManagedLookupTableInTransaction(
			tx,
			authority,
			refresh.mode === "adopt"
				? { ...base, mode: "adopt", reviewed: refresh.reviewed }
				: {
						...base,
						mode: "refresh",
						reviewed: {
							definitionRevision: refresh.reviewed.definitionRevision,
							rowsRevision: refresh.reviewed.rowsRevision,
						},
					},
		);
	}
}
