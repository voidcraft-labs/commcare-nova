/**
 * Transactional production seam for schema-drift repair.
 *
 * The app row stays locked from the exact Blueprint read through every
 * schema/data Phase-A write. A concurrent Blueprint edit therefore lands
 * either wholly before this repair (and is what we derive) or wholly after it
 * (and performs its own monotone schema sync); a stale Blueprint can never
 * overwrite a newer schema while retaining the newer watermark.
 */

import type { Transaction } from "kysely";
import {
	buildCaseTypeMap,
	type MigrationReport,
	type TransactionalSchemaCaseStore,
} from "../../lib/case-store";
import type { Database } from "../../lib/case-store/postgres/connection";
import { loadAppInTransaction } from "../../lib/db/apps";
import type { AppDatabase } from "../../lib/db/pg";
import { type CaseTypeDrift, computeSchemaDrift } from "./schemaDrift";

export interface PreparedSchemaDriftRepair {
	readonly appName: string;
	readonly drifts: readonly CaseTypeDrift[];
	readonly repairs: readonly {
		readonly drift: CaseTypeDrift;
		readonly report: MigrationReport;
	}[];
	readonly completeAfterCommit: () => Promise<void>;
}

export async function prepareSchemaDriftRepairInAppTransaction(
	tx: Transaction<AppDatabase>,
	store: TransactionalSchemaCaseStore,
	appId: string,
): Promise<PreparedSchemaDriftRepair | null> {
	const app = await loadAppInTransaction(tx, appId);
	if (app === null) return null;
	const caseTx = tx as unknown as Transaction<Database>;
	const drifts = await computeSchemaDrift(caseTx, appId, app.blueprint);
	if (drifts.length === 0) {
		return {
			appName: app.app_name,
			drifts,
			repairs: [],
			completeAfterCommit: async () => {},
		};
	}
	const orderedDrifts = [...drifts].sort((left, right) =>
		left.caseType.localeCompare(right.caseType),
	);
	const unresolvable = orderedDrifts.flatMap((drift) =>
		drift.unresolvable.map(
			(property) => `${drift.caseType}.${property.property}`,
		),
	);
	if (unresolvable.length > 0) {
		throw new Error(
			`Unresolvable stored schema specs require an owner decision: ${unresolvable.join(", ")}`,
		);
	}

	const caseTypeSchemas = buildCaseTypeMap(app.blueprint);
	const repairs: Array<{
		drift: CaseTypeDrift;
		report: MigrationReport;
	}> = [];
	const completions: Array<() => Promise<void>> = [];
	for (const drift of orderedDrifts) {
		// The versioned shared primitive detects every stored-to-derived
		// transition itself. Supplying the freshly locked app sequence makes a
		// stale repair a monotone no-op instead of the unversioned overwrite the
		// historical script used to perform.
		const prepared = await store.applySchemaChangePhaseA(caseTx, {
			appId,
			caseType: drift.caseType,
			caseTypeSchemas,
			syncedSeq: app.mutation_seq,
		});
		repairs.push({ drift, report: prepared.report });
		completions.push(prepared.completeAfterCommit);
	}

	return {
		appName: app.app_name,
		drifts: orderedDrifts,
		repairs,
		completeAfterCommit: async () => {
			for (const complete of completions) await complete();
		},
	};
}
