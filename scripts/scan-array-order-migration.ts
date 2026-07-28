/**
 * READ-ONLY — prove the sequence migration reproduces what every app renders.
 *
 * Ordering is moving from a fractional `order` key to plain array position.
 * `lib/case-store/migrations/20260727120000_sequence_is_array_position.ts` does
 * that rewrite, and it carries its own FROZEN copies of the comparators
 * production sorts through today (it has to: the change that adds it deletes the
 * originals). A frozen copy that disagrees with the original would silently
 * reorder apps, so this compares the two on real stored data.
 *
 * Two modes, because the proof has two halves:
 *
 *   (default)   For every app, derive each collection's sequence from RAW entity
 *               rows using the migration's comparators, and compare it against
 *               the sequence the live production readers derive from the loaded
 *               document. Any disagreement is the migration being wrong. Run
 *               this BEFORE migrating — it is the gate.
 *
 *   --verify    Run AFTER migrating. Re-reads the rows and asserts that plain
 *               array position now equals the sequence captured by `--capture`,
 *               which is what every post-migration reader will do.
 *
 *   --capture <file>  Write the pre-migration sequences for `--verify` to read.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL` locally);
 * `--prod` targets production over its public IP (see `./lib/prodDb.ts`).
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { sql } from "kysely";
// Imported from the migration itself, not re-implemented: the risk in freezing a
// comparator is that the copy drifts from the original, so the scan has to drive
// the code that actually runs.
import {
	type StoredEntityRow,
	sequencesFromStoredRows,
} from "@/lib/case-store/migrations/20260727120000_sequence_is_array_position";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadApp } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import type { BlueprintDoc } from "@/lib/domain";
import { derivedSequences } from "./lib/arrayOrderMigration";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
	app?: string;
	verify?: boolean;
	capture?: string;
	verbose?: boolean;
}

const program = new Command();
program
	.name("scan-array-order-migration")
	.description(
		"Read-only proof that the sequence migration reproduces every app's displayed order exactly. Exits nonzero on any disagreement.",
	)
	.option("--prod", "read the production database (read-only)")
	.option("--app <id>", "check a single app instead of the whole fleet")
	.option("--capture <file>", "write pre-migration sequences to a file")
	.option("--verify", "assert stored array position matches a captured file")
	.option("--verbose", "print every collection checked")
	.parse();

const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

/** Every entity row, grouped by app — the migration's own input. */
async function storedRowsByApp(
	appId?: string,
): Promise<Map<string, StoredEntityRow[]>> {
	const db = await getAppDb();
	const filter = appId === undefined ? sql`` : sql`WHERE app_id = ${appId}`;
	const result = await sql<StoredEntityRow>`
		SELECT app_id, uuid, kind, parent_uuid, ordinal, data
		FROM blueprint_entities
		${filter}
		ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid
	`.execute(db);
	const byApp = new Map<string, StoredEntityRow[]>();
	for (const row of result.rows) {
		const bucket = byApp.get(row.app_id);
		if (bucket === undefined) byApp.set(row.app_id, [row]);
		else bucket.push(row);
	}
	return byApp;
}

function compare(
	label: string,
	expected: ReadonlyMap<string, readonly string[]>,
	actual: ReadonlyMap<string, readonly string[]>,
): string[] {
	const problems: string[] = [];
	for (const path of [
		...new Set([...expected.keys(), ...actual.keys()]),
	].sort()) {
		const a = expected.get(path) ?? [];
		const b = actual.get(path) ?? [];
		if (a.length === b.length && a.every((uuid, i) => uuid === b[i])) continue;
		problems.push(
			`      ${path}\n        ${label} : ${a.join(", ") || "(empty)"}\n        stored   : ${b.join(", ") || "(empty)"}`,
		);
	}
	return problems;
}

async function main(): Promise<void> {
	const byApp = await storedRowsByApp(opts.app);
	if (opts.app !== undefined && byApp.size === 0) {
		console.error(`App ${opts.app} not found.`);
		process.exit(1);
	}

	const captured = new Map<string, Record<string, string[]>>();
	let clean = 0;
	let collectionsChecked = 0;
	const failed: string[] = [];
	const unreadable: string[] = [];

	if (opts.verify === true) {
		if (opts.capture === undefined) {
			console.error("--verify needs --capture <file> naming the captured run.");
			process.exit(1);
		}
		const priorSequences = JSON.parse(
			readFileSync(opts.capture, "utf8"),
		) as Record<string, Record<string, string[]>>;

		console.log(
			`Verifying ${byApp.size} app(s): does stored array position match what they rendered before?\n`,
		);
		for (const [appId, rows] of byApp) {
			const before = priorSequences[appId];
			if (before === undefined) {
				console.log(`${appId}\n  ✗ no captured sequence for this app\n`);
				failed.push(appId);
				continue;
			}
			// Post-migration, array position IS the sequence — read it the way every
			// reader now will, with no comparator involved.
			const after = sequencesFromStoredRows(rows, { sorted: false });
			collectionsChecked += after.size;
			const problems = compare(
				"rendered",
				new Map(Object.entries(before)),
				after,
			);
			if (problems.length === 0) {
				clean += 1;
				continue;
			}
			failed.push(appId);
			console.log(
				`${appId}\n  ✗ ${problems.length} collection(s) changed:\n${problems.join("\n")}\n`,
			);
		}
	} else {
		console.log(
			`Checking ${byApp.size} app(s): do the migration's frozen comparators agree with production's?\n`,
		);
		for (const [appId, rows] of byApp) {
			// What the migration will decide, from raw rows and its own comparators.
			const migrationView = sequencesFromStoredRows(rows, { sorted: true });
			collectionsChecked += migrationView.size;
			if (opts.capture !== undefined) {
				captured.set(
					appId,
					Object.fromEntries(
						[...migrationView].map(([k, v]) => [k, [...v]]),
					) as Record<string, string[]>,
				);
			}

			// What the app renders today, through the live production readers.
			const loaded = await loadApp(appId).catch((err: unknown) => {
				unreadable.push(appId);
				console.log(
					`${appId}\n  ✗ COULDN'T CHECK — the stored blueprint couldn't be assembled:\n      ${err instanceof Error ? err.message : String(err)}\n`,
				);
				return null;
			});
			if (loaded === null) continue;

			const productionView = derivedSequences(
				loaded.blueprint as unknown as BlueprintDoc,
			);
			const problems = compare("renders", productionView, migrationView);
			if (problems.length === 0) {
				clean += 1;
				if (opts.verbose === true) {
					console.log(
						`${appId}\n  ✓ ${migrationView.size} collection(s) agree`,
					);
				}
				continue;
			}
			failed.push(appId);
			console.log(
				`${appId}\n  ✗ ${problems.length} collection(s) disagree:\n${problems.join("\n")}\n`,
			);
		}
	}

	if (opts.capture !== undefined && opts.verify !== true) {
		writeFileSync(
			opts.capture,
			JSON.stringify(Object.fromEntries(captured), null, "\t"),
		);
		console.log(`\nCaptured ${captured.size} app(s) to ${opts.capture}`);
	}

	console.log(
		`\n${clean}/${byApp.size} app(s) reproduce exactly, across ${collectionsChecked} collection(s).`,
	);
	if (unreadable.length > 0) {
		console.log(`${unreadable.length} app(s) could not be read.`);
	}
	if (failed.length > 0) {
		console.log(
			`\n${failed.length} app(s) would be reordered. That is the migration being wrong, not the app.`,
		);
	}
	if (failed.length > 0 || unreadable.length > 0) process.exit(1);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
