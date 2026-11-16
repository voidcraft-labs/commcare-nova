/**
 * WRITER: repair every saved app holding a worker read the gate refuses: a
 * read, from the session and by name, of a worker field the app does not
 * declare (`undeclared-worker-field`, issue #913), or a read by name, from
 * the session or the worker's record, of a slug the app declares
 * (`worker-property-read-by-name`). `scan-undeclared-worker-fields.ts` lists
 * them with the same finder. Each undeclared field becomes a worker property
 * `{ uuid, slug, label: slug }`, and every read by name of a declared slug is
 * rebound to the property's identity, which prints the same path, so every
 * export keeps its bytes (`lib/undeclaredWorkerFieldRepair.ts`).
 *
 * Dry run by default: each app is planned and proved (commit gate, replay,
 * byte-for-byte exports) from a read-only snapshot and nothing is written.
 * `--execute` writes each proved app in its own transaction, fenced on the
 * sequence and document its plan read, as one `blueprint-migration` batch by
 * `system:undeclared-worker-fields`. An app edited since its plan, or held by
 * a run, is skipped and reported. A second run finds nothing.
 *
 * Output names app ids and counts alone, never a field name, a label, an
 * expression or any other content of an app. Exit 0 when every app needing
 * the repair was planned (and, with `--execute`, written), 1 otherwise.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import {
	applyUndeclaredWorkerFieldRepair,
	inspectUndeclaredWorkerFields,
} from "./lib/undeclaredWorkerFieldMigration";

interface Options {
	app?: string;
	execute?: boolean;
	prod?: boolean;
}

const program = new Command();
program
	.name("migrate-undeclared-worker-fields")
	.description(
		"Declare each worker field an app's expressions read from the session without declaring it, and rebind those reads to it. Dry run by default.",
	)
	.option("--app <appId>", "scope the repair to one app")
	.option("--execute", "write the proved repairs")
	.option(
		"--prod",
		"target production Cloud SQL through your gcloud IAM identity (scripts/lib/prodDb.ts)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-undeclared-worker-fields.ts\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-undeclared-worker-fields.ts --app <appId>\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-undeclared-worker-fields.ts --prod\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function selectedAppIds(): Promise<string[]> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.orderBy("id").execute();
	if (options.app !== undefined && rows.length === 0)
		throw new Error("No app matched --app.");
	return rows.map((row) => row.id);
}

/** An unexpected error's class name: its message may quote app content. */
function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

async function main(): Promise<void> {
	const execute = options.execute === true;
	const appIds = await selectedAppIds();
	let planned = 0;
	let refused = 0;
	let failed = 0;
	let written = 0;
	let skipped = 0;
	for (const appId of appIds) {
		let inspection: Awaited<ReturnType<typeof inspectUndeclaredWorkerFields>>;
		try {
			inspection = await inspectUndeclaredWorkerFields(appId);
		} catch (error) {
			failed += 1;
			console.log(`${appId} failed to plan (${errorName(error)})`);
			continue;
		}
		if (inspection.kind === "missing" || inspection.kind === "clean") continue;
		if (inspection.kind === "refused") {
			refused += 1;
			console.log(
				`${appId} refused: ${inspection.reason}${
					inspection.codes.length > 0 ? ` (${inspection.codes.join(", ")})` : ""
				}`,
			);
			continue;
		}
		const { plan } = inspection;
		planned += 1;
		const summary = `declares ${plan.declaredCount} worker propert${
			plan.declaredCount === 1 ? "y" : "ies"
		}, rebinds ${plan.reboundReads} read${plan.reboundReads === 1 ? "" : "s"}, keeps ${plan.translationsKeptCurrent} translation${plan.translationsKeptCurrent === 1 ? "" : "s"} current, gate clean, ${plan.comparedArtifacts} export artifacts unchanged`;
		if (!execute) {
			console.log(`${appId} at seq ${plan.expectedBaseSeq}: ${summary}`);
			continue;
		}
		try {
			const result = await applyUndeclaredWorkerFieldRepair(plan);
			if (
				result.status === "skipped-changed" ||
				result.status === "skipped-held"
			) {
				skipped += 1;
				console.log(
					`${appId} ${result.status === "skipped-changed" ? "skipped: changed since its plan" : "skipped: a run holds it"}`,
				);
			} else {
				written += 1;
				console.log(
					`${appId} ${result.status} at seq ${result.seq}: ${summary}`,
				);
			}
		} catch (error) {
			failed += 1;
			console.log(`${appId} failed to write (${errorName(error)})`);
		}
	}
	console.log(
		execute
			? `\nscanned ${appIds.length} apps · ${planned} planned · ${written} written · ${skipped} skipped · ${refused} refused · ${failed} failed`
			: `\nDRY RUN: nothing written. scanned ${appIds.length} apps · ${planned} would be repaired · ${refused} refused · ${failed} failed. Pass --execute to apply.`,
	);
	process.exitCode =
		refused > 0 || failed > 0 || (execute && skipped > 0) ? 1 : 0;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
