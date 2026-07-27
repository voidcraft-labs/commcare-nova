/**
 * READ-ONLY — prove the order-key migration is invisible, fleet-wide.
 *
 * Ordering is moving from a fractional `order` key on each entity to plain
 * array position. That is only safe if the migrated arrays hold exactly the
 * sequence each app displays today — and today's arrays do NOT, because a
 * same-parent reorder writes only the moved entity's key and leaves the array
 * untouched. Every app that has ever been reordered therefore carries stale
 * membership arrays and stale `ordinal` values, and reinterpreting position
 * without migrating would silently reorder it on every surface, including its
 * exported CommCare artifacts.
 *
 * This script runs the migration transform in memory and compares the result
 * against the sequence the app currently renders, read through the production
 * comparators. It reports every divergence and exits nonzero if any app has
 * one. It never writes.
 *
 * A clean run over the fleet is the gate the implementation is blocked behind:
 * no product code lands until this reports zero divergences.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL` locally,
 * the Cloud SQL connector in the migrate-job image); `--prod` targets the
 * production instance over its public IP (see `./lib/prodDb.ts`). Run with
 * `--help` for flags.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadApp } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import type { BlueprintDoc } from "@/lib/domain";
import {
	derivedSequences,
	migrateDocToArrayOrder,
	sequenceDivergences,
} from "./lib/arrayOrderMigration";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
	app?: string;
	verbose?: boolean;
}

const program = new Command();
program
	.name("scan-array-order-migration")
	.description(
		"Read-only proof that migrating order keys to array position preserves every app's displayed sequence exactly. Exits nonzero on any divergence or unreadable blueprint.",
	)
	.option("--prod", "read the production database (read-only)")
	.option("--app <id>", "scan a single app instead of the whole fleet")
	.option("--verbose", "print every collection checked, not only divergences")
	.parse();

const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();

	let appQuery = db.selectFrom("apps").select("id");
	if (opts.app !== undefined) appQuery = appQuery.where("id", "=", opts.app);
	const appRows = await appQuery.execute();
	if (opts.app !== undefined && appRows.length === 0) {
		console.error(`App ${opts.app} not found.`);
		process.exit(1);
	}

	console.log(
		`Checking ${appRows.length} app(s): does array position reproduce today's displayed sequence?\n`,
	);

	let clean = 0;
	let collectionsChecked = 0;
	const divergentApps: string[] = [];
	const unreadableApps: string[] = [];

	for (const { id } of appRows) {
		const loaded = await loadApp(id).catch((err: unknown) => {
			unreadableApps.push(id);
			console.log(
				`${id}\n  ✗ COULDN'T CHECK — the stored blueprint couldn't be assembled:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return null;
		});
		if (loaded === null) continue;

		const doc = loaded.blueprint as unknown as BlueprintDoc;
		const before = derivedSequences(doc);
		collectionsChecked += before.size;

		const divergences = sequenceDivergences(
			before,
			migrateDocToArrayOrder(doc),
		);
		if (divergences.length === 0) {
			clean += 1;
			if (opts.verbose === true) {
				console.log(
					`${id}\n  ✓ ${before.size} collection(s) reproduce exactly`,
				);
			}
			continue;
		}

		divergentApps.push(id);
		console.log(
			`${id}\n  ✗ ${divergences.length} collection(s) would reorder:`,
		);
		for (const d of divergences) {
			console.log(`      ${d.path}`);
			console.log(
				`        renders today : ${d.before.join(", ") || "(empty)"}`,
			);
			console.log(
				`        after migration: ${d.after.join(", ") || "(empty)"}`,
			);
		}
		console.log("");
	}

	console.log(
		`\n${clean}/${appRows.length} app(s) reproduce exactly, across ${collectionsChecked} collection(s).`,
	);
	if (unreadableApps.length > 0) {
		console.log(`${unreadableApps.length} app(s) could not be read.`);
	}
	if (divergentApps.length > 0) {
		console.log(
			`\n${divergentApps.length} app(s) would be reordered by this migration. ` +
				`That is the migration being wrong, not the app: the transform must ` +
				`reproduce what each app renders today, and these do not.`,
		);
	}
	if (divergentApps.length > 0 || unreadableApps.length > 0) process.exit(1);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
