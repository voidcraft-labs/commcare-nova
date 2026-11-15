import "server-only";

/**
 * The two functions of a bring-in's lookup tables that reach a store: the
 * read of CommCare HQ's tables the app may read, and the birth's write of the
 * tables it reads into the Project. Every decision is `lookupTables.ts`'s.
 */

import type { Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type {
	CommCareApiError,
	CommCareCredentials,
} from "@/lib/commcare/hq/http";
import {
	listHqLookupTables,
	readHqLookupTableRows,
} from "@/lib/commcare/hq/lookupTables";
import type { AppDatabase } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { LOOKUP_MAX_ROWS } from "@/lib/lookup/constants";
import { readLookupFixtureDataInTransaction } from "@/lib/lookup/fixtureSnapshot";
import {
	createManagedLookupTablesInTransaction,
	type ManagedOriginWrite,
	refreshManagedLookupTableInTransaction,
} from "@/lib/lookup/managed";
import type { ManagedLookupContent } from "@/lib/lookup/managedRules";
import type { LookupScope } from "@/lib/lookup/types";
import { lockLookupProjectState } from "@/lib/lookup/writerTransaction";
import { canonicalLookupTable } from "../../hqResourceBaseline";
import { readSiblingLookupMappings } from "../../store";
import { isDeploymentServer } from "../../types";
import {
	type BroughtInTableWrite,
	candidateLookupTags,
	type HqLookupTableRead,
	lookupTableStanding,
	managedLookupContentOf,
} from "./lookupTables";

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** Whether a failed row read is sent once more: an answered status of 500 or more that the
 *  edge did not give, or no answer at all. */
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
 * One list read; then, for each table whose tag the source names
 * (`candidateLookupTags`), its rows, one table at a time, stopping once the
 * first page names more rows than Nova holds.
 *
 * A row read that fails with an answered status of 500 or more, or with no
 * answer, is sent once more. Where both answers are a status of 500 or more
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
	readonly sourceText: string;
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
	const candidates = new Set(candidateLookupTags(input.sourceText, list));
	const tables: HqLookupTableRead[] = [];
	for (const table of list) {
		if (!candidates.has(table.tag)) continue;
		candidates.delete(table.tag);
		const readRows = () =>
			readHqLookupTableRows(creds, domain, table.id, {
				cancel,
				stopPast: LOOKUP_MAX_ROWS,
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
			tables.push({
				kind: "over-row-limit",
				table,
				totalCount: answer.totalCount,
			});
			continue;
		}
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
 * Write the tables a bring-in's app reads, inside the birth's transaction,
 * after its app row is inserted and before the gate reads the Project's
 * lookup definitions.
 *
 * Under the Project's lookup lock it reads the Project's tables of the written
 * tags with their rows and derives each standing again, with the sibling
 * mappings read on the same transaction. Where a standing's kind is no longer
 * the one its binding was made for, an answered offer is no longer offered,
 * or a Project table's revisions moved since the read, it throws
 * `BroughtInTableChangedError` and the birth rolls back whole. Otherwise one
 * create for the `new` tables, a refresh for each `same-managed` and an adopt
 * for each `use-commcare-hq`; nothing for a table used as it stands. A
 * `choice` with no answer never reaches here.
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
		readonly at: Date;
	},
): Promise<void> {
	if (write.tables.length === 0) return;
	const { origin } = write;
	if (!isDeploymentServer(origin.server)) {
		throw new Error(
			`A bring-in names the CommCare HQ server "${origin.server}", which Nova does not know.`,
		);
	}
	const role = await projectRoleForInTransaction(
		tx,
		scope.actorUserId,
		scope.projectId,
	);
	if (role === null || !roleAllowsApp(role, "edit")) {
		throw new Error(
			"The birth's writer of lookup tables runs for a member who may edit the Project.",
		);
	}
	const lookupScope: LookupScope = {
		projectId: scope.projectId,
		actorId: scope.actorUserId,
		role,
	};
	const mayAdminister = roleAllowsApp(role, "delete");

	await lockLookupProjectState(tx, scope.projectId);
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

	const created: Parameters<
		typeof createManagedLookupTablesInTransaction
	>[2][number][] = [];
	const refreshes: {
		readonly tableId: string;
		readonly mode: "refresh" | "adopt";
		readonly content: ManagedLookupContent;
		readonly origin: ManagedOriginWrite;
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
		});
		if (standing.kind !== table.standing.kind) {
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
					throw new Error(
						`The lookup table ${tag} reached the birth with no answer to its choice.`,
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
		// The fields the Project table has no column for take the ids the
		// binding gave them, so the document's reads name the columns made.
		const wireNames = new Set(
			definition.columns.map((column) => column.wireName),
		);
		refreshes.push({
			tableId: definition.id,
			mode,
			content,
			origin: managedOrigin,
			newColumnIds: Object.fromEntries(
				Object.entries(table.binding.columns).filter(
					([field]) => !wireNames.has(field),
				),
			),
		});
	}

	if (created.length > 0) {
		await createManagedLookupTablesInTransaction(
			tx,
			lookupScope,
			created,
			write.at,
		);
	}
	for (const refresh of refreshes) {
		await refreshManagedLookupTableInTransaction(tx, lookupScope, {
			tableId: lookupTableIdSchema.parse(refresh.tableId),
			content: refresh.content,
			origin: refresh.origin,
			at: write.at,
			mode: refresh.mode,
			newColumnIds: refresh.newColumnIds,
		});
	}
}
