import "server-only";

/**
 * The destination ledger of lookup tables Nova publishes through CommCare
 * HQ's JSON resources, and the journal of each request it sends there.
 *
 * A destination is one Nova table on one project space (`server`, `domain`),
 * keyed by the Project, not the app: every app of the Project that publishes
 * the table there shares the one mapping of Nova row UUIDs to the row ids
 * CommCare HQ minted, so a second app's publish of unchanged rows writes
 * nothing. Identity is that mapping; a rank or a value never identifies a
 * row.
 *
 * Every request is journaled before it is sent, in the transaction that
 * rechecks Nova's authority over the table (`store.ts::admitLookupJsonWrite`),
 * and settled when its outcome is known. At most one operation per
 * destination is open, by a unique index over the open states, and every
 * admission locks the destination row and compares its revision with the one
 * the caller planned over, so two publishers of one table, from any of the
 * Project's apps, take turns and never send over each other's plan. An
 * operation stays open while its outcome is unknown (`uncertain`) or a
 * person must look at what CommCare HQ holds (`review`), which keeps every
 * later write to that table waiting until a read settles it.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupJsonLedger, LookupJsonOperation } from "./lookupJsonPlan";

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;

/** One Nova table on one project space. */
export interface LookupJsonDestinationKey {
	readonly projectId: string;
	readonly server: string;
	readonly domain: string;
	readonly tableId: LookupTableId;
}

/** What one journaled request intends, and what it found, by kind. */
export type LookupJsonJournalEntry =
	| {
			readonly kind: "create-table";
			readonly tag: string;
			readonly definitionDigest: string;
	  }
	| {
			readonly kind: "create-row";
			readonly rowId: string;
			/** The rank the plan wanted; CommCare HQ gives its own. */
			readonly sortKey: number;
			readonly digest: string;
	  }
	| {
			readonly kind: "update-row";
			readonly rowId: string;
			readonly remoteId: string;
			readonly sortKey: number;
			readonly digest: string;
			readonly before: { readonly sortKey: number; readonly digest: string };
	  }
	| {
			readonly kind: "delete-row";
			readonly rowId: string;
			readonly remoteId: string;
			readonly before: { readonly sortKey: number; readonly digest: string };
	  };

/** An operation whose outcome the journal does not know yet, or that waits for a person. */
export type LookupJsonOpenOperation = LookupJsonJournalEntry & {
	readonly id: string;
	readonly state: "admitted" | "uncertain" | "review";
	readonly admittedAt: Date;
};

/** The destination as the ledger holds it. */
export interface LookupJsonDestination {
	/** Null where no destination row exists. */
	readonly revision: string | null;
	/** Null until a create is acknowledged and the table found under its tag. */
	readonly ledger: LookupJsonLedger | null;
	/** The tag a create was journaled under, while the table is not yet found. */
	readonly pendingTag: string | null;
	readonly open: LookupJsonOpenOperation | null;
}

/** How a sent request ended, as the journal settles it. */
export type LookupJsonSettlement =
	| {
			readonly kind: "applied";
			readonly remoteId?: string;
			readonly sortKey?: number;
	  }
	| { readonly kind: "not-applied" }
	| { readonly kind: "uncertain" }
	| { readonly kind: "review" };

const OPEN_STATES = ["admitted", "uncertain", "review"] as const;

function toEntry(row: {
	kind: string;
	row_id: string | null;
	remote_id: string | null;
	intended: Record<string, unknown>;
	before: Record<string, unknown> | null;
}): LookupJsonJournalEntry {
	const intended = row.intended;
	const before = row.before as {
		sortKey: number;
		digest: string;
	} | null;
	switch (row.kind) {
		case "create-table":
			return {
				kind: "create-table",
				tag: intended.tag as string,
				definitionDigest: intended.definitionDigest as string,
			};
		case "create-row":
			return {
				kind: "create-row",
				rowId: row.row_id as string,
				sortKey: intended.sortKey as number,
				digest: intended.digest as string,
			};
		case "update-row":
			if (before === null || row.remote_id === null) break;
			return {
				kind: "update-row",
				rowId: row.row_id as string,
				remoteId: row.remote_id,
				sortKey: intended.sortKey as number,
				digest: intended.digest as string,
				before,
			};
		case "delete-row":
			if (before === null || row.remote_id === null) break;
			return {
				kind: "delete-row",
				rowId: row.row_id as string,
				remoteId: row.remote_id,
				before,
			};
	}
	throw new Error(
		`A lookup table's JSON journal holds an operation Nova cannot read (${row.kind}).`,
	);
}

/** The destination, its ledger and its open operation, read together. */
export async function readLookupJsonDestination(
	db: Db,
	key: LookupJsonDestinationKey,
	options: { readonly lock?: boolean } = {},
): Promise<LookupJsonDestination> {
	const scoped = {
		project_id: key.projectId,
		server: key.server,
		domain: key.domain,
		table_id: key.tableId,
	};
	const destination = options.lock
		? await db
				.selectFrom("lookup_json_destinations")
				.selectAll()
				.where("project_id", "=", scoped.project_id)
				.where("server", "=", scoped.server)
				.where("domain", "=", scoped.domain)
				.where("table_id", "=", scoped.table_id)
				.forUpdate()
				.executeTakeFirst()
		: await db
				.selectFrom("lookup_json_destinations")
				.selectAll()
				.where("project_id", "=", scoped.project_id)
				.where("server", "=", scoped.server)
				.where("domain", "=", scoped.domain)
				.where("table_id", "=", scoped.table_id)
				.executeTakeFirst();
	if (destination === undefined)
		return { revision: null, ledger: null, pendingTag: null, open: null };
	const [rows, open] = await Promise.all([
		db
			.selectFrom("lookup_json_destination_rows")
			.select(["row_id", "remote_row_id", "sort_key", "digest"])
			.where("project_id", "=", scoped.project_id)
			.where("server", "=", scoped.server)
			.where("domain", "=", scoped.domain)
			.where("table_id", "=", scoped.table_id)
			.orderBy("sort_key")
			.orderBy("remote_row_id")
			.execute(),
		db
			.selectFrom("lookup_json_operations")
			.select([
				"id",
				"kind",
				"row_id",
				"remote_id",
				"intended",
				"before",
				"state",
				"admitted_at",
			])
			.where("project_id", "=", scoped.project_id)
			.where("server", "=", scoped.server)
			.where("domain", "=", scoped.domain)
			.where("table_id", "=", scoped.table_id)
			.where("state", "in", [...OPEN_STATES])
			.executeTakeFirst(),
	]);
	return {
		revision: String(destination.revision),
		ledger:
			destination.remote_table_id === null
				? null
				: {
						remoteTableId: destination.remote_table_id,
						tag: destination.tag,
						definitionDigest: destination.definition_digest,
						rows: rows.map((row) => ({
							novaRowId: row.row_id,
							remoteId: row.remote_row_id,
							sortKey: row.sort_key,
							digest: row.digest,
						})),
					},
		pendingTag: destination.remote_table_id === null ? destination.tag : null,
		open:
			open === undefined
				? null
				: {
						...toEntry(open),
						id: open.id,
						state: open.state as LookupJsonOpenOperation["state"],
						admittedAt: new Date(open.admitted_at),
					},
	};
}

/** Every Nova table that has a destination on this project space. */
export async function readLookupJsonDestinationTableIds(
	db: Db,
	target: {
		readonly projectId: string;
		readonly server: string;
		readonly domain: string;
	},
): Promise<ReadonlySet<string>> {
	const rows = await db
		.selectFrom("lookup_json_destinations")
		.select("table_id")
		.where("project_id", "=", target.projectId)
		.where("server", "=", target.server)
		.where("domain", "=", target.domain)
		.execute();
	return new Set(rows.map((row) => row.table_id as string));
}

/** The journal entry a planned operation is admitted as. */
export function lookupJsonJournalEntry(
	operation: LookupJsonOperation,
	digestOf: (operation: LookupJsonOperation) => string,
	definitionDigest: string,
): LookupJsonJournalEntry {
	switch (operation.kind) {
		case "create-table":
			return {
				kind: "create-table",
				tag: operation.definition.tag,
				definitionDigest,
			};
		case "create-row":
			return {
				kind: "create-row",
				rowId: operation.novaRowId,
				sortKey: operation.row.sortKey,
				digest: digestOf(operation),
			};
		case "update-row":
			return {
				kind: "update-row",
				rowId: operation.novaRowId,
				remoteId: operation.remoteId,
				sortKey: operation.row.sortKey,
				digest: digestOf(operation),
				before: operation.before,
			};
		case "delete-row":
			return {
				kind: "delete-row",
				rowId: operation.novaRowId,
				remoteId: operation.remoteId,
				before: operation.before,
			};
	}
}

/**
 * Journal one operation as admitted, inside the caller's admission
 * transaction, after it has rechecked Nova's authority over the table.
 *
 * `stale` where the destination's revision is not the one the plan was made
 * over (another publisher wrote meanwhile), `busy` where another operation is
 * open. A create journals the destination itself, with no remote id yet.
 */
export async function journalLookupJsonOperation(
	tx: Transaction<AppDatabase>,
	key: LookupJsonDestinationKey,
	input: {
		readonly expectedRevision: string | null;
		readonly appId: string;
		readonly actorUserId: string;
		readonly entry: LookupJsonJournalEntry;
	},
): Promise<
	| { readonly kind: "journaled"; readonly operationId: string }
	| { readonly kind: "stale" }
	| { readonly kind: "busy" }
> {
	const { entry } = input;
	if (entry.kind === "create-table") {
		await tx
			.insertInto("lookup_json_destinations")
			.values({
				project_id: key.projectId,
				server: key.server,
				domain: key.domain,
				table_id: key.tableId,
				tag: entry.tag,
				remote_table_id: null,
				definition_digest: entry.definitionDigest,
				created_by: input.actorUserId,
			})
			.onConflict((conflict) =>
				conflict
					.columns(["project_id", "server", "domain", "table_id"])
					.doNothing(),
			)
			.execute();
	}
	const held = await readLookupJsonDestination(tx, key, { lock: true });
	if (held.revision === null) return { kind: "stale" };
	if (held.open !== null) return { kind: "busy" };
	const expected = input.expectedRevision;
	if (entry.kind === "create-table") {
		/* A create is planned over no ledger: the destination is new, or holds
		 * an earlier create that did not land, and no row. */
		if (
			held.ledger !== null ||
			(expected !== null && expected !== held.revision)
		)
			return { kind: "stale" };
		await tx
			.updateTable("lookup_json_destinations")
			.set({
				tag: entry.tag,
				definition_digest: entry.definitionDigest,
				updated_at: new Date(),
			})
			.where("project_id", "=", key.projectId)
			.where("server", "=", key.server)
			.where("domain", "=", key.domain)
			.where("table_id", "=", key.tableId)
			.execute();
	} else if (held.ledger === null || expected !== held.revision)
		return { kind: "stale" };
	const inserted = await tx
		.insertInto("lookup_json_operations")
		.values({
			project_id: key.projectId,
			server: key.server,
			domain: key.domain,
			table_id: key.tableId,
			app_id: input.appId,
			actor_user_id: input.actorUserId,
			kind: entry.kind,
			row_id:
				entry.kind === "create-table" ? null : (entry.rowId as LookupRowId),
			remote_id:
				entry.kind === "update-row" || entry.kind === "delete-row"
					? entry.remoteId
					: null,
			intended: JSON.stringify(
				entry.kind === "create-table"
					? { tag: entry.tag, definitionDigest: entry.definitionDigest }
					: entry.kind === "delete-row"
						? {}
						: { sortKey: entry.sortKey, digest: entry.digest },
			),
			before:
				entry.kind === "update-row" || entry.kind === "delete-row"
					? JSON.stringify(entry.before)
					: null,
			state: "admitted",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { kind: "journaled", operationId: inserted.id };
}

/**
 * Settle a journaled operation, and where CommCare HQ applied it, move the
 * ledger in the same transaction: a create records the id CommCare HQ gave
 * (`remoteId`) and, for a row, the rank it chose (`sortKey`); an update
 * records the row's new rank and content; a delete forgets the row. Every
 * applied write moves the destination's revision. `uncertain` and `review`
 * leave the operation open. Answers the destination's revision after.
 */
export async function settleLookupJsonOperationInTransaction(
	tx: Transaction<AppDatabase>,
	key: LookupJsonDestinationKey,
	operationId: string,
	settlement: LookupJsonSettlement,
): Promise<string> {
	const held = await readLookupJsonDestination(tx, key, { lock: true });
	const open = held.open;
	if (held.revision === null || open === null || open.id !== operationId)
		throw new Error(
			"A lookup table's JSON operation was settled after another took its place.",
		);
	const now = new Date();
	if (settlement.kind === "uncertain" || settlement.kind === "review") {
		await tx
			.updateTable("lookup_json_operations")
			.set({ state: settlement.kind })
			.where("id", "=", operationId)
			.execute();
		return held.revision;
	}
	if (settlement.kind === "not-applied") {
		await tx
			.updateTable("lookup_json_operations")
			.set({ state: "not-applied", settled_at: now })
			.where("id", "=", operationId)
			.execute();
		return held.revision;
	}
	const keyed = {
		project_id: key.projectId,
		server: key.server,
		domain: key.domain,
		table_id: key.tableId,
	};
	switch (open.kind) {
		case "create-table": {
			if (settlement.remoteId === undefined)
				throw new Error("An applied table create needs the table's id.");
			await tx
				.updateTable("lookup_json_destinations")
				.set({ remote_table_id: settlement.remoteId })
				.where("project_id", "=", key.projectId)
				.where("server", "=", key.server)
				.where("domain", "=", key.domain)
				.where("table_id", "=", key.tableId)
				.execute();
			break;
		}
		case "create-row": {
			if (settlement.remoteId === undefined || settlement.sortKey === undefined)
				throw new Error("An applied row create needs the row's id and rank.");
			await tx
				.insertInto("lookup_json_destination_rows")
				.values({
					...keyed,
					row_id: open.rowId as LookupRowId,
					remote_row_id: settlement.remoteId,
					sort_key: settlement.sortKey,
					digest: open.digest,
				})
				.execute();
			break;
		}
		case "update-row": {
			const updated = await tx
				.updateTable("lookup_json_destination_rows")
				.set({ sort_key: open.sortKey, digest: open.digest })
				.where("project_id", "=", key.projectId)
				.where("server", "=", key.server)
				.where("domain", "=", key.domain)
				.where("table_id", "=", key.tableId)
				.where("row_id", "=", open.rowId as LookupRowId)
				.where("remote_row_id", "=", open.remoteId)
				.executeTakeFirst();
			if (Number(updated.numUpdatedRows) !== 1)
				throw new Error("An applied row update names a row the ledger lost.");
			break;
		}
		case "delete-row": {
			await tx
				.deleteFrom("lookup_json_destination_rows")
				.where("project_id", "=", key.projectId)
				.where("server", "=", key.server)
				.where("domain", "=", key.domain)
				.where("table_id", "=", key.tableId)
				.where("row_id", "=", open.rowId as LookupRowId)
				.where("remote_row_id", "=", open.remoteId)
				.execute();
			break;
		}
	}
	const moved = await tx
		.updateTable("lookup_json_destinations")
		.set({ revision: sql`revision + 1`, updated_at: now })
		.where("project_id", "=", key.projectId)
		.where("server", "=", key.server)
		.where("domain", "=", key.domain)
		.where("table_id", "=", key.tableId)
		.returning("revision")
		.executeTakeFirstOrThrow();
	await tx
		.updateTable("lookup_json_operations")
		.set({
			state: "applied",
			settled_at: now,
			result_remote_id: settlement.remoteId ?? null,
		})
		.where("id", "=", operationId)
		.execute();
	return String(moved.revision);
}
