import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import { OWNERSHIP } from "@/lib/deployment/__tests__/adoptedBirth";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { CompletionMigration } from "../lib/completionWorkspaces";
import { sameRepresentationFold } from "../lib/deploymentFoldArtifacts";
import {
	applyCompletion,
	type CompletionStorage,
	completionPlanSchema,
	scanCompletion,
} from "../lib/hqRoundTripCompletion";

const h = setupAppStateTestDb("completion_transaction_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: "20261203",
	poolMax: 2,
});
const projectId = "completion-project";
const owner = "completion-owner";
const marker = "fold-baseline:hq-round-trip-completion";
const completion = "20261209000000_test_completion";

/** The fixture has no workspaces to convert. It uses the real workspace and
 * reference migrations and commits a distinct document through the same
 * horizon writer. Its final DDL represents retirement independently of
 * Connect's pending SQL carrier change. */
const migration: CompletionMigration = {
	...sameRepresentationFold,
	provenance: "2".repeat(64),
	conversionSettings: { reviewed: true },
	async releasedLookups(tx, projectId, tableIds) {
		expect(tableIds).toEqual([]);
		const row = await tx
			.selectFrom("lookup_project_state")
			.select("revision")
			.where("project_id", "=", projectId)
			.executeTakeFirst();
		return {
			projectId,
			projectRevision: parseLookupRevision(String(row?.revision ?? "0")),
			definitions: [],
		};
	},
	convert(snapshot, coordinate) {
		if (!snapshot || typeof snapshot !== "object" || !("appId" in snapshot))
			throw new Error("Missing original app.");
		expect(snapshot.appId).toBe(coordinate.appId);
		return { ...snapshot, appName: "Preserved through the horizon" };
	},
	privateBase() {
		throw new Error("The fixture has no private work.");
	},
	privateStep() {
		throw new Error("The fixture has no private work.");
	},
	privateOverlay() {
		throw new Error("The fixture has no private work.");
	},
};

const storage: CompletionStorage = {
	migrations: {
		...caseStoreMigrations,
		[completion]: {
			async up(db) {
				const finished = await sql<{ count: number }>`
					SELECT count(*)::int AS count FROM app_changes WHERE batch_id = ${marker}
				`.execute(db);
				if (finished.rows[0]?.count !== 2)
					throw new Error("Stored apps still need the reviewed conversion.");
				await sql`CREATE TABLE hq_round_trip_completion_receipt (
					singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
					plan_digest text NOT NULL,
					source_provenance text NOT NULL
				)`.execute(db);
			},
		},
	},
	completionMigration: completion,
	async readReleasedHead(tx, appId) {
		const { rows } = await sql<{ snapshot: string }>`
			SELECT public.nova_current_app_change_fold_snapshot(${appId})::text AS snapshot
		`.execute(tx);
		if (!rows[0]) throw new Error("Missing released head.");
		return rows[0].snapshot;
	},
	async checkSourceFacts(tx) {
		const { rows } = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM apps
		`.execute(tx);
		expect(rows).toEqual([{ count: 2 }]);
	},
};

async function releasedApp(id: string) {
	await h.seedApp({
		id,
		owner,
		project_id: projectId,
		app_name: "Released app",
	});
	await h.withTransaction(async (tx) => {
		await sql`UPDATE apps SET mutation_seq = 1 WHERE id = ${id}`.execute(tx);
		await sql`UPDATE blueprint_entities SET data = data WHERE app_id = ${id}`.execute(
			tx,
		);
		await sql`INSERT INTO app_changes (app_id, seq, batch_id, actor_id, kind, mutations)
			VALUES (${id}, 1, 'fold-baseline:hq-round-trip-case-writes', 'system:hq-round-trip-case-writes', 'fold-baseline', '[]')`.execute(
			tx,
		);
		await sql`INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
			SELECT ${id}, 1, ${projectId}, doc, public.nova_app_change_fold_snapshot_digest(doc)
			FROM (SELECT public.nova_current_app_change_fold_snapshot(${id}) AS doc) AS snapshot`.execute(
			tx,
		);
	});
}

async function releasedTarget(appId: string) {
	const target = await h
		.db()
		.insertInto("app_deployments")
		.values({
			app_id: appId,
			project_id: projectId,
			server: "india",
			domain: "clinic",
			state: "uploaded",
			phases: "{}",
			created_by: owner,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	await h
		.db()
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: target.id,
			kind: "app",
			nova_resource_id: appId,
			remote_id: "released-clinic-app",
			ownership: "nova-created",
			pushed_revision: 1,
		})
		.execute();
	const source = JSON.stringify({ name: "Clinic" });
	await h
		.db()
		.insertInto("app_deployment_baselines")
		.values({
			deployment_id: target.id,
			origin: "push",
			remote_app_id: "released-clinic-app",
			observed_by: owner,
			observed_at: new Date(),
			ownership: JSON.stringify(OWNERSHIP),
			nova_revision: 1,
			source_gzip: gzipSync(source),
			source_digest: createHash("sha256").update(source).digest("hex"),
			source_bytes: Buffer.byteLength(source),
		})
		.execute();
}

it("rolls back pending DDL and the first app when the second app refuses, then verifies a committed retry", async () => {
	await releasedApp("completion-a");
	await releasedApp("completion-b");
	await releasedTarget("completion-a");
	const scanned = await scanCompletion(h.db(), migration, storage);
	const plan = completionPlanSchema.parse(JSON.parse(JSON.stringify(scanned)));
	expect(plan.apps.map((app) => app.appId)).toEqual([
		"completion-a",
		"completion-b",
	]);
	expect(plan.apps[0].inventory).toMatchObject({ usable: 1, unavailable: 0 });
	const original = await h
		.db()
		.selectFrom("apps")
		.select(["id", "mutation_seq", "app_name"])
		.orderBy("id")
		.execute();

	const ordinary = await new Migrator({
		db: h.db(),
		provider: { getMigrations: async () => storage.migrations },
	}).migrateToLatest();
	expect(ordinary.error).toMatchObject({
		message: "Stored apps still need the reviewed conversion.",
	});
	await sql`ALTER TABLE app_changes ADD CONSTRAINT rehearsal_blocks_second_horizon
		CHECK (app_id <> 'completion-b' OR batch_id <> 'fold-baseline:hq-round-trip-completion') NOT VALID`.execute(
		h.db(),
	);
	try {
		await expect(
			applyCompletion(h.db(), migration, plan, storage),
		).rejects.toThrow("rehearsal_blocks_second_horizon");
		expect(
			await h
				.db()
				.selectFrom("apps")
				.select(["id", "mutation_seq", "app_name"])
				.orderBy("id")
				.execute(),
		).toEqual(original);
		const { rows } = await sql<{ tables_installed: boolean; locks: number }>`
			SELECT
				to_regclass('public.authoring_workspace_folds') IS NOT NULL AS tables_installed,
				(SELECT count(*)::int FROM pg_locks
					WHERE locktype = 'advisory' AND granted
						AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS locks
		`.execute(h.db());
		expect(rows).toEqual([{ tables_installed: false, locks: 0 }]);
	} finally {
		await sql`ALTER TABLE app_changes DROP CONSTRAINT rehearsal_blocks_second_horizon`.execute(
			h.db(),
		);
	}

	expect(await applyCompletion(h.db(), migration, plan, storage)).toBe(
		"converted",
	);
	expect(await applyCompletion(h.db(), migration, plan, storage)).toBe(
		"verified",
	);
	const wrong = structuredClone(plan);
	wrong.apps[0].inventory.digest = "0".repeat(64);
	await expect(
		applyCompletion(h.db(), migration, wrong, storage),
	).rejects.toThrow(
		"The stored completion receipt does not match the reviewed source plan.",
	);
	const baseline = await h
		.db()
		.selectFrom("app_deployment_baselines")
		.select("reference_fold_seq")
		.executeTakeFirstOrThrow();
	expect(Number(baseline.reference_fold_seq)).toBe(plan.apps[0].headSeq + 1);
	for (const entry of plan.apps) {
		const loaded = await h.withTransaction((tx) =>
			loadAppInTransaction(tx, entry.appId),
		);
		expect(loaded?.blueprint.appName).toBe("Preserved through the horizon");
		expect(loaded?.mutation_seq).toBe(entry.headSeq + 1);
	}
});
