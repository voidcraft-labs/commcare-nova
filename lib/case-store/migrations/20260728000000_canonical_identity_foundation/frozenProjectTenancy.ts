/**
 * Frozen, read-only Project-tenancy inventory used by the advisory scanner and
 * the one reviewed orphan-app deletion. This is not a generic tenant repair:
 * the table catalog, row ordering, JSON projection, and auth-candidate queries
 * are all closed over the production shape observed before the cutover.
 */

import { type Kysely, type RawBuilder, sql } from "kysely";
import {
	frozenExactDigest,
	parseFrozenExactJson,
} from "./frozenOccurrenceDispatcher";
import {
	FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST,
	FROZEN_PROJECT_ORPHAN_APP_ID_TABLES,
	FROZEN_PROJECT_ORPHAN_APP_ROW_DIGEST,
	FROZEN_PROJECT_ORPHAN_APP_ROWS_DIGEST,
	FROZEN_PROJECT_ORPHAN_AUTH_CLOSURES,
	FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
	FROZEN_PROJECT_ORPHAN_DEPENDENCY_INVENTORY_DIGEST,
	FROZEN_PROJECT_ORPHAN_FULL_DISPOSITION_DIGEST,
	FROZEN_PROJECT_ORPHAN_TABLE_CLOSURES,
} from "./frozenRepairManifest";
import { canonicalIdentityDigest } from "./frozenTransform";

export interface FrozenQualifiedTable {
	readonly schema: string;
	readonly table: string;
}

export interface FrozenProjectOrphanInventory {
	readonly appRows: readonly unknown[];
	readonly appIdCatalog: readonly string[];
	readonly tables: readonly {
		readonly schema: string;
		readonly table: string;
		readonly rows: readonly unknown[];
	}[];
	readonly authCandidates: readonly {
		readonly table: string;
		readonly rows: readonly unknown[];
	}[];
}

export interface FrozenProjectOrphanSummary {
	readonly appDigest: string;
	readonly appRowCount: number;
	readonly appRowDigest: string;
	readonly appRowsDigest: string;
	readonly tableClosures: readonly {
		readonly qualifiedTable: string;
		readonly count: number;
		readonly digest: string;
	}[];
	readonly authClosures: readonly {
		readonly table: string;
		readonly count: number;
		readonly digest: string;
	}[];
	readonly dependencyInventoryDigest: string;
	readonly fullDispositionDigest: string;
}

function splitQualifiedTable(value: string): FrozenQualifiedTable {
	const [schema, table, extra] = value.split(".");
	if (
		schema === undefined ||
		table === undefined ||
		extra !== undefined ||
		schema.length === 0 ||
		table.length === 0
	) {
		throw new Error(`Invalid frozen qualified table ${value}.`);
	}
	return { schema, table };
}

async function canonicalRows<DB>(
	db: Kysely<DB>,
	table: FrozenQualifiedTable,
	predicate: RawBuilder<unknown>,
): Promise<readonly unknown[]> {
	const result = await sql<{ row_text: string }>`
		SELECT to_jsonb(source_row)::text AS row_text
		FROM ${sql.id(table.schema, table.table)} AS source_row
		WHERE ${predicate}
		ORDER BY convert_to(to_jsonb(source_row)::text, 'UTF8')
	`.execute(db);
	return result.rows.map((row) => parseFrozenExactJson(row.row_text));
}

async function actualAppIdCatalog<DB>(
	db: Kysely<DB>,
): Promise<readonly string[]> {
	const result = await sql<{ schema_name: string; table_name: string }>`
		SELECT namespace.nspname AS schema_name, relation.relname AS table_name
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		JOIN pg_attribute AS attribute
		  ON attribute.attrelid = relation.oid
		 AND attribute.attname = 'app_id'
		 AND attribute.attnum > 0
		 AND NOT attribute.attisdropped
		WHERE namespace.nspname IN ('public', 'nova_case_runtime')
		  AND relation.relkind IN ('r', 'p')
		ORDER BY
			convert_to(namespace.nspname, 'UTF8'),
			convert_to(relation.relname, 'UTF8')
	`.execute(db);
	return result.rows.map((row) => `${row.schema_name}.${row.table_name}`);
}

async function assertAuthCatalog<DB>(db: Kysely<DB>): Promise<void> {
	const actual = await sql<{ table_name: string }>`
		SELECT relation.relname AS table_name
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND relation.relkind IN ('r', 'p')
		  AND relation.relname = ANY(${sql.val([...FROZEN_PROJECT_ORPHAN_AUTH_TABLES])})
		ORDER BY convert_to(relation.relname, 'UTF8')
	`.execute(db);
	if (
		JSON.stringify(actual.rows.map((row) => row.table_name)) !==
		JSON.stringify([...FROZEN_PROJECT_ORPHAN_AUTH_TABLES])
	) {
		throw new Error(
			"Frozen Project-orphan auth-candidate table catalog drifted.",
		);
	}
}

/**
 * Capture exact source bytes as Postgres canonical JSONB values. Every table is
 * ordered by `to_jsonb(row)::text`; the outer table arrays use the manifest's
 * schema-qualified lexical order. Digests therefore have one stable
 * serialization contract shared by production discovery, scan, repair, and
 * tests.
 */
export async function captureFrozenProjectOrphanInventory<DB>(
	db: Kysely<DB>,
	appId: string,
	ownerId: string,
	projectId: string | null,
): Promise<FrozenProjectOrphanInventory> {
	const appIdCatalog = await actualAppIdCatalog(db);
	if (
		JSON.stringify(appIdCatalog) !==
		JSON.stringify(FROZEN_PROJECT_ORPHAN_APP_ID_TABLES)
	) {
		throw new Error("Frozen Project-orphan app_id table catalog drifted.");
	}
	await assertAuthCatalog(db);

	const appRows = await canonicalRows(
		db,
		{ schema: "public", table: "apps" },
		sql`id = ${appId}`,
	);
	const tables = [];
	for (const qualifiedTable of FROZEN_PROJECT_ORPHAN_APP_ID_TABLES) {
		const table = splitQualifiedTable(qualifiedTable);
		tables.push({
			...table,
			rows: await canonicalRows(db, table, sql`app_id = ${appId}`),
		});
	}

	const projectCandidate = projectId ?? "";
	const authCandidates = [
		{
			table: "auth_account",
			rows: await canonicalRows(
				db,
				{ schema: "public", table: "auth_account" },
				sql`"userId" = ${ownerId}`,
			),
		},
		{
			table: "auth_apikey",
			rows: await canonicalRows(
				db,
				{ schema: "public", table: "auth_apikey" },
				sql`"referenceId" = ${ownerId}`,
			),
		},
		{
			table: "auth_invitation",
			rows: await canonicalRows(
				db,
				{ schema: "public", table: "auth_invitation" },
				sql`email = ${ownerId} OR "inviterId" = ${ownerId}
				    OR "organizationId" = ${projectCandidate}`,
			),
		},
		{
			table: "auth_member",
			rows: await canonicalRows(
				db,
				{ schema: "public", table: "auth_member" },
				sql`"userId" = ${ownerId} OR "organizationId" = ${projectCandidate}`,
			),
		},
		{
			table: "auth_organization",
			rows: await canonicalRows(
				db,
				{ schema: "public", table: "auth_organization" },
				sql`id = ${projectCandidate}`,
			),
		},
		{
			table: "auth_session",
			rows: await canonicalRows(
				db,
				{ schema: "public", table: "auth_session" },
				sql`"userId" = ${ownerId}
				    OR "activeOrganizationId" = ${projectCandidate}`,
			),
		},
		{
			table: "auth_user",
			rows: await canonicalRows(
				db,
				{ schema: "public", table: "auth_user" },
				sql`id = ${ownerId} OR email = ${ownerId}`,
			),
		},
	] as const;

	return { appRows, appIdCatalog, tables, authCandidates };
}

export function summarizeFrozenProjectOrphanInventory(
	appId: string,
	inventory: FrozenProjectOrphanInventory,
): FrozenProjectOrphanSummary {
	const appRow = inventory.appRows[0];
	const dependencyInventory = {
		appIdCatalog: inventory.appIdCatalog,
		tables: inventory.tables,
		authCandidates: inventory.authCandidates,
	};
	return {
		appDigest: canonicalIdentityDigest(appId),
		appRowCount: inventory.appRows.length,
		appRowDigest: frozenExactDigest(appRow),
		appRowsDigest: frozenExactDigest(inventory.appRows),
		tableClosures: inventory.tables.map((entry) => ({
			qualifiedTable: `${entry.schema}.${entry.table}`,
			count: entry.rows.length,
			digest: frozenExactDigest(entry.rows),
		})),
		authClosures: inventory.authCandidates.map((entry) => ({
			table: entry.table,
			count: entry.rows.length,
			digest: frozenExactDigest(entry.rows),
		})),
		dependencyInventoryDigest: frozenExactDigest(dependencyInventory),
		fullDispositionDigest: frozenExactDigest({
			appRows: inventory.appRows,
			dependencyInventory,
		}),
	};
}

export function assertFrozenProjectOrphanSummary(
	summary: FrozenProjectOrphanSummary,
): void {
	const expectedTables = FROZEN_PROJECT_ORPHAN_TABLE_CLOSURES.map(
		([qualifiedTable, count, digest]) => ({ qualifiedTable, count, digest }),
	);
	const expectedAuth = FROZEN_PROJECT_ORPHAN_AUTH_CLOSURES.map(
		([table, count, digest]) => ({ table, count, digest }),
	);
	if (
		summary.appDigest !== FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST ||
		summary.appRowCount !== 1 ||
		summary.appRowDigest !== FROZEN_PROJECT_ORPHAN_APP_ROW_DIGEST ||
		summary.appRowsDigest !== FROZEN_PROJECT_ORPHAN_APP_ROWS_DIGEST ||
		JSON.stringify(summary.tableClosures) !== JSON.stringify(expectedTables) ||
		JSON.stringify(summary.authClosures) !== JSON.stringify(expectedAuth) ||
		summary.dependencyInventoryDigest !==
			FROZEN_PROJECT_ORPHAN_DEPENDENCY_INVENTORY_DIGEST ||
		summary.fullDispositionDigest !==
			FROZEN_PROJECT_ORPHAN_FULL_DISPOSITION_DIGEST
	) {
		throw new Error("Frozen Project-orphan source inventory drifted.");
	}
}
