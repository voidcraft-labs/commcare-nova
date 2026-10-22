/**
 * What each planned case-schema change meets in the stored cases (part 09
 * §8), read on the plan's own `REPEATABLE READ, READ ONLY` transaction with
 * plain `SELECT`s, so the scan's read-only identity runs it and it takes no
 * lock.
 *
 * - **Declared** (step `declare-read-properties`): a declaration is not a
 *   same-name transition, so the drift writer would not park an orphan value
 *   under the new key. Every case of the app and type that holds the key is
 *   counted, and any is the blocker `declared-property-has-stored-values`,
 *   for a person to look at.
 * - **Inferred**: the drift writer's retype parks every value that does not
 *   cast. The count is `SchemaCaseStore.conversionImpact`'s own, computed
 *   with the migration's cast; it is stated in the notice and never blocks.
 */

import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import type { AppDatabase } from "@/lib/db/pg";
import type { PlannedSchemaChange } from "./types";

/** One planned change with what the stored cases hold of it. */
export interface SchemaChangeImpact {
	readonly change: PlannedSchemaChange;
	/** Declared: the cases of the type that hold the key. Inferred: zero. */
	readonly storedValues: number;
	/** Inferred: the values the retype cannot cast, which park. Declared: zero. */
	readonly uncastable: number;
}

/**
 * Each planned change's impact over one app's stored cases, in the order
 * given, on the caller's transaction.
 */
export async function readSchemaChangeImpacts(
	tx: Transaction<AppDatabase>,
	appId: string,
	changes: readonly PlannedSchemaChange[],
): Promise<SchemaChangeImpact[]> {
	if (changes.length === 0) return [];
	/* A schema-only store over the caller's transaction: `conversionImpact`
	 * reads through `this.db`, so its two SELECTs see the plan's snapshot. */
	const store = new PostgresCaseStore({
		projectId: null,
		actorUserId: null,
		ownerId: null,
		db: tx as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
	const impacts: SchemaChangeImpact[] = [];
	for (const change of changes) {
		if (change.source === "declared") {
			const row = await sql<{ count: string }>`
				SELECT count(*)::text AS count FROM cases
				WHERE app_id = ${appId} AND case_type = ${change.caseType}
					AND properties ? ${change.property}
			`.execute(tx);
			impacts.push({
				change,
				storedValues: Number(row.rows[0]?.count ?? "0"),
				uncastable: 0,
			});
			continue;
		}
		const impact = await store.conversionImpact({
			appId,
			caseType: change.caseType,
			property: change.property,
			toType: change.to,
		});
		impacts.push({ change, storedValues: 0, uncastable: impact.uncastable });
	}
	return impacts;
}
