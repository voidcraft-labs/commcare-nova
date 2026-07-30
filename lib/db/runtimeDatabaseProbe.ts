import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { AppDatabase } from "@/lib/db/pg";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { commitGuardedBatchInTransaction, loadAppInTransaction } from "./apps";
import { projectRoleForInTransaction } from "./projectMembership";

interface RuntimeProbeCandidateRow {
	readonly app_id: string;
	readonly project_id: string;
	readonly user_id: string;
	readonly role: string;
}

interface RuntimeProbeAppRow {
	readonly id: string;
}

interface RuntimeProbeRollbackVerificationRow {
	readonly mutation_seq: string | number;
	readonly probe_rows: string | number;
}

export interface CanonicalRuntimeDatabaseProbeReport {
	readonly parsedAppCount: number;
	readonly parserFindingCount: 0;
	readonly snapshotDigest: string;
	readonly rollbackVerified: true;
}

const RUNTIME_PROBE_CANDIDATE_LIMIT = 1_000;

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([left], [right]) => left.localeCompare(right),
	);
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
}

export function chooseRuntimeProbeCandidate(
	rows: readonly RuntimeProbeCandidateRow[],
): RuntimeProbeCandidateRow {
	const candidate = rows.find((row) => roleAllowsApp(row.role, "edit"));
	if (candidate === undefined) {
		throw new Error(
			"The runtime database probe requires an existing editable Project app membership.",
		);
	}
	return candidate;
}

class IntentionalRuntimeProbeRollback extends Error {}

/**
 * Prove the post-migration serving identity against the exact production read
 * and write paths without committing probe data.
 *
 * The migration connection SET ROLEs inside one transaction, strictly
 * assembles every persisted app through the steady-state schema, authorizes an
 * existing editable Project member, and drives an empty mutation through the
 * real guarded writer. The sentinel rollback then must remove both the stream
 * latch and app-row sequence advance; a migration-role read proves that before
 * the probe can report success.
 */
export async function runCanonicalRuntimeDatabaseProbe(
	database: Kysely<unknown>,
	runtimeRole: string,
): Promise<CanonicalRuntimeDatabaseProbeReport> {
	const db = database as unknown as Kysely<AppDatabase>;
	const batchId = randomUUID();
	let report:
		| (Omit<CanonicalRuntimeDatabaseProbeReport, "rollbackVerified"> & {
				readonly candidateAppId: string;
				readonly candidateBaseSeq: number;
		  })
		| undefined;
	const rollback = new IntentionalRuntimeProbeRollback(
		"intentional runtime database probe rollback",
	);

	try {
		await db.transaction().execute(async (tx) => {
			await sql`SET LOCAL ROLE ${sql.id(runtimeRole)}`.execute(tx);

			const appRows = await tx
				.selectFrom("apps")
				.select("id")
				.orderBy("id")
				.execute();
			const digest = createHash("sha256");
			for (const row of appRows as RuntimeProbeAppRow[]) {
				const app = await loadAppInTransaction(tx, row.id);
				if (app === null) {
					throw new Error(
						"The runtime database probe lost an app inside its transaction.",
					);
				}
				digest.update(
					canonicalJson([
						row.id,
						app.mutation_seq,
						app.project_id,
						app.blueprint,
					]),
				);
			}

			const candidates = await sql<RuntimeProbeCandidateRow>`
				SELECT
					app.id AS app_id,
					app.project_id AS project_id,
					member."userId" AS user_id,
					member.role
				FROM apps AS app
				JOIN auth_member AS member
					ON member."organizationId" = app.project_id
				WHERE app.project_id IS NOT NULL
					AND app.deleted_at IS NULL
				ORDER BY app.id, member."userId"
				LIMIT ${RUNTIME_PROBE_CANDIDATE_LIMIT}
			`.execute(tx);
			const candidate = chooseRuntimeProbeCandidate(candidates.rows);
			const role = await projectRoleForInTransaction(
				tx,
				candidate.user_id,
				candidate.project_id,
			);
			if (role === null || !roleAllowsApp(role, "edit")) {
				throw new Error(
					"The runtime database probe candidate lost edit authority.",
				);
			}
			const app = await loadAppInTransaction(tx, candidate.app_id);
			if (app === null || app.project_id !== candidate.project_id) {
				throw new Error(
					"The runtime database probe candidate app changed tenancy.",
				);
			}

			const write = await commitGuardedBatchInTransaction(tx, {
				appId: candidate.app_id,
				expectedProjectId: candidate.project_id,
				batchId,
				mutations: admitMutationBatch([
					{ kind: "setAppName", name: app.blueprint.appName },
				]),
				actorUserId: candidate.user_id,
				kind: "migration",
			});
			if (write.deduped || write.seq !== app.mutation_seq + 1) {
				throw new Error(
					"The runtime database probe did not exercise one fresh guarded write.",
				);
			}

			report = {
				parsedAppCount: appRows.length,
				parserFindingCount: 0,
				snapshotDigest: digest.digest("hex"),
				candidateAppId: candidate.app_id,
				candidateBaseSeq: app.mutation_seq,
			};
			throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	}

	if (report === undefined) {
		throw new Error("The runtime database probe did not reach its rollback.");
	}
	const verification = await sql<RuntimeProbeRollbackVerificationRow>`
		SELECT
			app.mutation_seq,
			(
				SELECT count(*)
				FROM accepted_mutations
				WHERE app_id = ${report.candidateAppId}
					AND batch_id = ${batchId}
			) AS probe_rows
		FROM apps AS app
		WHERE app.id = ${report.candidateAppId}
	`.execute(db);
	const row = verification.rows[0];
	if (
		row === undefined ||
		Number(row.mutation_seq) !== report.candidateBaseSeq ||
		Number(row.probe_rows) !== 0
	) {
		throw new Error(
			"The runtime database probe rollback left a mutation sequence or stream row behind.",
		);
	}

	return {
		parsedAppCount: report.parsedAppCount,
		parserFindingCount: 0,
		snapshotDigest: report.snapshotDigest,
		rollbackVerified: true,
	};
}
