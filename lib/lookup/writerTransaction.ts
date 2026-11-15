import "server-only";

import {
	type Selectable,
	sql,
	type Transaction,
	type Updateable,
} from "kysely";
import {
	type AppDatabase,
	type LookupTablesTable,
	notifyLookupProject,
} from "@/lib/db/pg";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { managedLookupTableRefusal } from "@/lib/publish/managedData";
import { LookupError } from "./errors";
import { maxLookupRevision, parseLookupRevision } from "./schema";
import type { LookupRevision, LookupTableRevisions } from "./types";

export type StoredLookupTable = Selectable<LookupTablesTable>;

export interface LockedLookupProjectState {
	revision: LookupRevision;
}

export function lookupTableRevisions(
	table: StoredLookupTable,
): LookupTableRevisions {
	const definitionRevision = parseLookupRevision(table.definition_revision);
	const rowsRevision = parseLookupRevision(table.rows_revision);
	return {
		definitionRevision,
		rowsRevision,
		tableRevision: maxLookupRevision(definitionRevision, rowsRevision),
	};
}

export async function lockLookupProjectState(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<LockedLookupProjectState> {
	await tx
		.insertInto("lookup_project_state")
		.values({ project_id: projectId })
		.onConflict((conflict) => conflict.column("project_id").doNothing())
		.execute();
	const state = await tx
		.selectFrom("lookup_project_state")
		.select("revision")
		.where("project_id", "=", projectId)
		.forUpdate()
		.executeTakeFirst();
	if (!state) {
		throw new Error(
			"Lookup Project state disappeared after its locked upsert.",
		);
	}
	return { revision: parseLookupRevision(state.revision) };
}

/** Why a writer locks a table, which decides what a table CommCare HQ manages allows. */
export type LookupWritePurpose =
	/** A person, the SA or an MCP client changing a table. Refused while CommCare HQ manages it. */
	| "author"
	/** Removing Nova's copy of a table. Allowed in every state: it changes nothing in CommCare HQ. */
	| "remove-table"
	/** Bringing CommCare HQ's content into the copy (`managed.ts`). */
	| "hq-refresh"
	/** Changing who manages the table (`managed.ts`). */
	| "hq-management";

/**
 * Lock one table `FOR UPDATE` for a write, in this order: the row, or
 * `not_found`; for an `author` write, the refusal of a table CommCare HQ
 * manages (`hq_server` set, no takeover); then the revision compare. The
 * managed check comes first, so a stale tab learns the table is managed
 * rather than being sent to reload. Only `hq-refresh` and `hq-management`
 * skip the compare, with a null `expectedRevision`: a refresh is no edit of
 * what a person loaded, and the lock it holds makes its read current.
 */
export async function lockLookupTableForUpdate(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	expectedRevision: LookupRevision | null,
	purpose: LookupWritePurpose,
): Promise<StoredLookupTable> {
	if (
		expectedRevision === null &&
		(purpose === "author" || purpose === "remove-table")
	) {
		throw new Error(
			`A lookup table write for "${purpose}" must name the revision it was loaded at.`,
		);
	}
	const table = await tx
		.selectFrom("lookup_tables")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("id", "=", tableId)
		.forUpdate()
		.executeTakeFirst();
	if (!table) {
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	if (
		purpose === "author" &&
		table.hq_server !== null &&
		table.hq_taken_over_at === null
	) {
		if (table.hq_domain === null) {
			throw new Error(
				"A lookup table's CommCare HQ origin was stored only in part.",
			);
		}
		throw new LookupError(
			"managed_in_hq",
			managedLookupTableRefusal(table.name, table.hq_domain),
		);
	}
	if (expectedRevision === null) return table;
	const currentRevisions = lookupTableRevisions(table);
	if (currentRevisions.tableRevision !== expectedRevision) {
		throw new LookupError(
			"conflict",
			"This lookup table changed since it was loaded. Refresh and try again.",
			{ currentRevisions },
		);
	}
	return table;
}

export async function advanceLookupProjectRevision(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<LookupRevision> {
	const row = await tx
		.updateTable("lookup_project_state")
		.set({
			revision: sql<string>`revision + 1`,
			updated_at: new Date(),
		})
		.where("project_id", "=", projectId)
		.returning("revision")
		.executeTakeFirst();
	if (!row) {
		throw new Error(
			"Lookup Project state disappeared while advancing revision.",
		);
	}
	return parseLookupRevision(row.revision);
}

export async function updateLockedLookupTable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	values: Updateable<LookupTablesTable>,
): Promise<StoredLookupTable> {
	const table = await tx
		.updateTable("lookup_tables")
		.set(values)
		.where("project_id", "=", projectId)
		.where("id", "=", tableId)
		.returningAll()
		.executeTakeFirst();
	if (!table) {
		throw new Error("Locked lookup table disappeared before its update.");
	}
	return table;
}

export async function notifyCommittedLookupMutation(
	tx: Transaction<AppDatabase>,
	projectId: string,
	projectRevision: LookupRevision,
): Promise<void> {
	await notifyLookupProject(tx, projectId, projectRevision);
}
