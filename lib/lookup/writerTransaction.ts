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

export async function lockLookupTableForUpdate(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	expectedRevision: LookupRevision,
): Promise<StoredLookupTable> {
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
