/**
 * WRITER — replace stored lookup reference edges with each app's structural
 * target set wherever the read-only edge scan reports a mismatch.
 *
 * Dry-run by default; nothing writes without `--execute`. Run
 * scan-lookup-reference-edges.ts first for sizing, execute this against the
 * intended environment, then re-run the scan to zero. Each repair runs under
 * its own app row lock through the authoritative maintenance writer, so
 * concurrent commits serialize normally and an app that converged on its own
 * reports `unchanged`. Unassemblable apps and operational scan errors abort
 * before any write.
 */

import "dotenv/config";
import { Command } from "commander";
import type { Selectable, Transaction } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { repairLookupReferenceEdges } from "@/lib/db/apps";
import { assembleBlueprint, type EntityRow } from "@/lib/db/blueprintRows";
import { readStoredLookupReferenceTargets } from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, type AppsTable, getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import {
	buildLookupReferenceScanReport,
	type LookupReferenceScanObservation,
	type LookupReferenceScanReport,
	renderLookupReferenceScanReport,
	type StoredLookupReferenceRead,
	type StructuralLookupReferenceRead,
} from "./lib/lookupReferenceEdgeScan";
import { runMain } from "./lib/main";

interface MigrateOptions {
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-lookup-reference-edges")
	.description(
		"Replace stored lookup reference edges with structural targets for scan-mismatched apps. Dry-run by default; --execute writes. Run scan-lookup-reference-edges.ts before and after.",
	)
	.option("--execute", "write the repairs (default: print the plan only)")
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Uses the database selected by NOVA_DB_LOCAL_URL or the Cloud SQL\n" +
			"  connector environment. There is intentionally no --prod writer\n" +
			"  shortcut; production execution requires an explicit write-capable env.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-lookup-reference-edges.ts\n" +
			"  $ npx tsx scripts/migrate-lookup-reference-edges.ts --execute\n",
	);
program.parse();
const opts = program.opts<MigrateOptions>();

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
		return { kind: "unassemblable", message: errorMessage(error) };
	}

	try {
		return { kind: "ok", targets: extractLookupReferenceTargets(doc) };
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

/** One repeatable-read snapshot of every persisted app, scan-identical. */
async function collectReport(): Promise<LookupReferenceScanReport> {
	const db = await getAppDb();
	const observations = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
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
			for (const row of appRows) {
				results.push({
					app: {
						appId: row.id,
						projectId: row.project_id,
						appName: row.app_name,
						deletedAt: row.deleted_at?.toISOString() ?? null,
					},
					structural: await readStructuralTargets(tx, row),
					stored: await readStoredTargets(tx, row.id),
				});
			}
			return results;
		});
	return buildLookupReferenceScanReport(observations);
}

async function main(): Promise<void> {
	try {
		const before = await collectReport();
		if (
			before.unassemblableApps.length > 0 ||
			before.operationalErrors.length > 0
		) {
			console.log(renderLookupReferenceScanReport(before));
			throw new Error(
				"edge repair requires a scan free of unassemblable apps and operational errors; fix those first, then re-run",
			);
		}

		console.log(
			opts.execute === true
				? `Repairing ${before.mismatches.length} mismatched app(s)…`
				: `DRY RUN — would repair ${before.mismatches.length} mismatched app(s). Nothing writes without --execute.`,
		);
		for (const mismatch of before.mismatches) {
			console.log(
				`  ${mismatch.appId} (${mismatch.projectId ?? "no Project"})`,
			);
		}
		if (opts.execute !== true) return;

		for (const mismatch of before.mismatches) {
			const result = await repairLookupReferenceEdges(mismatch.appId);
			console.log(`  ${mismatch.appId}: ${result.kind}`);
		}

		const after = await collectReport();
		console.log(`\n${renderLookupReferenceScanReport(after)}`);
		if (after.exitCode !== 0) {
			throw new Error(
				"edge repair did not converge to a clean rescan; investigate concurrent writers and re-run scan-lookup-reference-edges.ts",
			);
		}
		console.log(
			"Re-run scan-lookup-reference-edges.ts in the same environment to record the clean post-check.",
		);
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
