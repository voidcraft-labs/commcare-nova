/**
 * The migration's own proof, run against real rows.
 *
 * `sequencesFromStoredRows` reads every ordered collection two ways: `sorted`
 * derives it through the frozen comparators — what the migration will decide —
 * and unsorted reads plain array position, which is what every reader does once
 * the keys are gone. Running both AROUND the migration is the proof that it
 * changed nothing: for each collection the sorted reading of the stored rows
 * must equal the unsorted reading of the migrated rows.
 *
 * Checking only that each case list ends up with two full column sequences is
 * a COVERAGE check, not this proof: it passes while a collection is silently
 * reverted, because it never compares the two readings.
 */

import {
	migrateNested,
	type StoredEntityRow,
	sequencesFromStoredRows,
} from "@/lib/case-store/migrations/20260727120000_sequence_is_array_position";
import { targetProdDb } from "./lib/prodDb";

/** Apply what `up()` applies to one row's data, in place. */
function migrateRow(row: StoredEntityRow): void {
	migrateNested(row.kind, row.data);
}

async function main(): Promise<void> {
	if (process.argv.includes("--prod")) targetProdDb();
	const { getCaseStorePool } = await import(
		"@/lib/case-store/postgres/connection"
	);
	const pool = await getCaseStorePool();
	const { rows } = await pool.query<StoredEntityRow>(
		`SELECT app_id, uuid, kind, parent_uuid, ordinal, data
		 FROM blueprint_entities
		 ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid`,
	);

	const byApp = new Map<string, StoredEntityRow[]>();
	for (const row of rows) {
		const bucket = byApp.get(row.app_id);
		if (bucket === undefined) byApp.set(row.app_id, [row]);
		else bucket.push(row);
	}

	let apps = 0;
	let collections = 0;
	let disagreements = 0;
	for (const [appId, stored] of byApp) {
		apps++;
		// What the migration decides, read off the stored rows.
		const before = sequencesFromStoredRows(stored, { sorted: true });
		// What a reader sees afterwards: array position, no comparator.
		const migrated = stored.map((row) => ({
			...row,
			data: structuredClone(row.data),
		}));
		for (const row of migrated) migrateRow(row);
		// `up()` also rewrites `ordinal` to the sorted position for the top-level
		// kinds; mirror that here so the unsorted reading sees the migrated order.
		const order = sequencesFromStoredRows(stored, { sorted: true });
		const rank = new Map<string, number>();
		for (const uuids of order.values()) {
			uuids.forEach((uuid, index) => {
				rank.set(uuid, index);
			});
		}
		for (const row of migrated) row.ordinal = rank.get(row.uuid) ?? row.ordinal;
		migrated.sort(
			(a, b) =>
				a.kind.localeCompare(b.kind) ||
				(a.parent_uuid ?? "").localeCompare(b.parent_uuid ?? "") ||
				a.ordinal - b.ordinal ||
				a.uuid.localeCompare(b.uuid),
		);
		const after = sequencesFromStoredRows(migrated, { sorted: false });

		for (const [key, expected] of before) {
			collections++;
			const got = after.get(key);
			if (got === undefined || got.join(",") !== expected.join(",")) {
				disagreements++;
				console.log(
					`app ${appId} ${key}\n  before: ${expected.join(",")}\n  after:  ${(got ?? []).join(",")}`,
				);
			}
		}
	}
	console.log(
		`apps=${apps} rows=${rows.length} collections=${collections} disagreements=${disagreements}`,
	);
	await pool.end();
	process.exit(disagreements === 0 ? 0 : 1);
}

void main();
