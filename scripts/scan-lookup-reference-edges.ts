/**
 * READ-ONLY — verify that every persisted app's complete structural lookup
 * target set exactly matches its complete stored reference-edge set.
 *
 * This is the scan side of the lookup-carrier scan-then-migrate workflow. It
 * intentionally walks every app row, including soft-deleted/restorable apps,
 * because those apps retain edges until physical deletion. Structural targets
 * come from the production extractor registry; the registry is empty in S02b
 * and gains real carriers in S05 without this inspector changing.
 *
 * The script never repairs or mutates. Any mismatch, unassemblable blueprint,
 * extractor failure, or stored-edge read failure makes the process nonzero.
 */

import "dotenv/config";
import { Command } from "commander";
import type { Selectable, Transaction } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { assembleBlueprint, type EntityRow } from "@/lib/db/blueprintRows";
import { readStoredLookupReferenceTargets } from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, type AppsTable, getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import {
	buildLookupReferenceScanReport,
	type LookupReferenceScanApp,
	type LookupReferenceScanObservation,
	renderLookupReferenceScanReport,
	type StoredLookupReferenceRead,
	type StructuralLookupReferenceRead,
} from "./lib/lookupReferenceEdgeScan";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-lookup-reference-edges")
	.description(
		"Read-only fleet audit of structural lookup targets against stored app reference edges. Scans every persisted app, including soft-deleted/restorable apps, and exits nonzero on any mismatch or scan failure.",
	)
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Scans NOVA_DB_LOCAL_URL by default. --prod targets production via\n" +
			"  scripts/lib/prodDb.ts; neither mode grants or performs writes.\n" +
			"\nWorkflow:\n" +
			"  Run before the matching lookup-edge migration and again afterward.\n" +
			"  A clean rescan is required before carrier/schema-action activation.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-lookup-reference-edges.ts\n" +
			"  $ npx tsx scripts/scan-lookup-reference-edges.ts --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

type PersistedAppRow = Pick<
	Selectable<AppsTable>,
	| "id"
	| "project_id"
	| "app_name"
	| "connect_type"
	| "case_types"
	| "logo"
	| "deleted_at"
>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appIdentity(row: PersistedAppRow): LookupReferenceScanApp {
	return {
		appId: row.id,
		projectId: row.project_id,
		appName: row.app_name,
		deletedAt: row.deleted_at?.toISOString() ?? null,
	};
}

/**
 * Assemble and hydrate through the same stored-blueprint boundary production
 * uses, then invoke the shared production extractor. The extractor's default
 * registry is intentional: S05 carrier registration must automatically become
 * visible to this durable inspector.
 */
async function readStructuralTargets(
	tx: Transaction<AppDatabase>,
	row: PersistedAppRow,
): Promise<StructuralLookupReferenceRead> {
	let entityRows: EntityRow[];
	try {
		entityRows = (await tx
			.selectFrom("blueprint_entities")
			.select(["uuid", "kind", "parent_uuid", "ordinal", "data"])
			.where("app_id", "=", row.id)
			.execute()) as EntityRow[];
	} catch (error) {
		return {
			kind: "error",
			stage: "read-blueprint-rows",
			message: errorMessage(error),
		};
	}

	let doc: ReturnType<typeof hydratePersistedBlueprint>;
	try {
		const persisted = assembleBlueprint(
			row.id,
			{
				app_name: row.app_name,
				connect_type: row.connect_type,
				case_types: row.case_types,
				logo: row.logo,
			},
			entityRows,
		);
		doc = hydratePersistedBlueprint(persisted);
	} catch (error) {
		return {
			kind: "unassemblable",
			message: errorMessage(error),
		};
	}

	try {
		return {
			kind: "ok",
			targets: extractLookupReferenceTargets(doc),
		};
	} catch (error) {
		return {
			kind: "error",
			stage: "extract-structural-targets",
			message: errorMessage(error),
		};
	}
}

async function readStoredTargets(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<StoredLookupReferenceRead> {
	try {
		return {
			kind: "ok",
			targets: await readStoredLookupReferenceTargets(tx, appId),
		};
	} catch (error) {
		return {
			kind: "error",
			stage: "read-stored-targets",
			message: errorMessage(error),
		};
	}
}

async function inspectApp(
	tx: Transaction<AppDatabase>,
	row: PersistedAppRow,
): Promise<LookupReferenceScanObservation> {
	// Run both reads even if assembly fails so one bad blueprint cannot hide a
	// separate stored-edge integrity/operational failure for the same app.
	const structural = await readStructuralTargets(tx, row);
	const stored = await readStoredTargets(tx, row.id);
	return { app: appIdentity(row), structural, stored };
}

async function main(): Promise<void> {
	try {
		const db = await getAppDb();
		const observations = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				// Postgres enforces the inspector's no-write promise. The repeatable-
				// read snapshot also prevents a concurrent app commit from manufacturing
				// a cross-version structural/edge mismatch.
				const appRows = await tx
					.selectFrom("apps")
					.select([
						"id",
						"project_id",
						"app_name",
						"connect_type",
						"case_types",
						"logo",
						"deleted_at",
					])
					.orderBy("id", "asc")
					.execute();
				const results: LookupReferenceScanObservation[] = [];
				// Deliberately sequential: this is an operator audit over one shared
				// snapshot, not a fan-out workload. It keeps connection/memory pressure
				// bounded on developer machines and production alike.
				for (const row of appRows) {
					results.push(await inspectApp(tx, row));
				}
				return results;
			});

		const report = buildLookupReferenceScanReport(observations);
		console.log(renderLookupReferenceScanReport(report));
		process.exitCode = report.exitCode;
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
