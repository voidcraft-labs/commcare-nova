/**
 * READ-ONLY — report case rows holding a JSONB property key the stored
 * `case_type_schemas` row does not declare (the `additionalProperties`
 * stranding bucket — a rename or removal whose rows never migrated).
 *
 * Such a key is provably orphaned: every row write validates against
 * the then-stored schema, so a key can outlive its declaration but
 * never precede it. The store sheds orphans lazily on each row's next
 * properties write (`PostgresCaseStore.update`'s merged-write strip),
 * so a non-zero count here is residue awaiting that write — it blocks
 * nothing — but a GROWING count means some write path is stranding
 * rows without a migration and deserves a look.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command();
program
	.name("scan-orphan-property-keys")
	.description(
		"Report rows carrying JSONB keys their stored schema does not declare (read-only).",
	)
	.option("--prod", "scan production Cloud SQL via gcloud IAM identity");
program.parse(process.argv);
const opts = program.opts<{ prod?: boolean }>();

runMain(async () => {
	if (opts.prod) targetProdDb();
	const db = await getCaseStoreDatabase();
	try {
		const schemas = await db
			.selectFrom("case_type_schemas")
			.select(["app_id", "case_type", "schema"])
			.execute();
		let schemasScanned = 0;
		let rowsScanned = 0;
		let strandedRows = 0;
		const buckets = new Map<string, number>();
		for (const s of schemas) {
			schemasScanned++;
			const declared = new Set(
				Object.keys(
					(s.schema as { properties?: Record<string, unknown> }).properties ??
						{},
				),
			);
			const rows = await db
				.selectFrom("cases")
				.select(["case_id", "properties"])
				.where("app_id", "=", s.app_id)
				.where("case_type", "=", s.case_type)
				.execute();
			for (const row of rows) {
				rowsScanned++;
				const orphans = Object.keys(row.properties ?? {}).filter(
					(k) => !declared.has(k),
				);
				if (orphans.length > 0) {
					strandedRows++;
					for (const k of orphans) {
						const key = `${s.app_id}/${s.case_type}.${k}`;
						buckets.set(key, (buckets.get(key) ?? 0) + 1);
					}
				}
			}
		}
		console.log(
			`Scanned ${schemasScanned} schemas, ${rowsScanned} rows; stranded: ${strandedRows}`,
		);
		for (const [key, count] of [...buckets.entries()].sort(
			(a, b) => b[1] - a[1],
		)) {
			console.log(`  ${key}: ${count} rows`);
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
