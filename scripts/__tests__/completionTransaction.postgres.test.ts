import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it, vi } from "vitest";
import { rehydrateChangeSet } from "@/lib/agent/change-set/runtime";
import { loadChangeSet } from "@/lib/agent/change-set/store";
import { readReleasedFoldSnapshot } from "@/lib/case-store/migrations/20261208000000_connect_activity_roles";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import { OWNERSHIP } from "@/lib/deployment/__tests__/adoptedBirth";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { CompletionMigration } from "../lib/completionWorkspaces";
import {
	applyCompletion,
	completionArtifacts,
	completionPlanSchema,
	scanCompletion,
} from "../lib/hqRoundTripCompletion";
import {
	freezeCompletionSettings,
	step7CompletionStorage as storage,
} from "../lib/step7CompletionStorage";

const h = setupAppStateTestDb("completion_transaction_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: "20261203",
	poolMax: 2,
});
const projectId = "completion-project";
const owner = "completion-owner";
const hqMenu = "a".repeat(32);
async function artifacts(folder: string) {
	const directory = join(folder, "artifacts");
	const args = [
		"scripts/prepare-hq-round-trip-artifacts.mjs",
		"--source",
		".",
		"--output",
		directory,
	];
	const supplied = process.env.NOVA_COMPLETION_TEST_READER;
	if (supplied) {
		const reader = resolve(supplied);
		args.push(
			"--reader",
			reader,
			"--reader-sha256",
			createHash("sha256")
				.update(await readFile(reader))
				.digest("hex"),
		);
	}
	execFileSync(process.execPath, args, {
		timeout: 180_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	return join(directory, "artifacts.json");
}

async function releasedApp(id: string, role?: "deliver") {
	await h.seedApp({
		id,
		owner,
		project_id: projectId,
		app_name: "Released app",
	});
	await h.withTransaction(async (tx) => {
		await sql`UPDATE apps SET mutation_seq = 1 WHERE id = ${id}`.execute(tx);
		if (role) {
			await sql`UPDATE apps SET connect_type = ${role},
				app_settings = app_settings || '{"runsOnlyOn":"android"}'::jsonb WHERE id = ${id}`.execute(
				tx,
			);
		}
		await sql`UPDATE blueprint_entities SET data = CASE
			WHEN kind = 'form' AND ${role ?? null}::text IS NOT NULL
			THEN data || '{"connect":{"deliver_unit":{"id":"visit","name":"Visit"}}}'::jsonb
			ELSE data END WHERE app_id = ${id}`.execute(tx);
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
	const { uuid: moduleUuid } = await h
		.db()
		.selectFrom("blueprint_entities")
		.select("uuid")
		.where("app_id", "=", appId)
		.where("kind", "=", "module")
		.executeTakeFirstOrThrow();
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
			ownership: "adopted",
			adopted_by: owner,
			adopted_at: new Date(),
			pushed_revision: 1,
		})
		.execute();
	await h
		.db()
		.insertInto("app_deployment_identities")
		.values({
			deployment_id: target.id,
			entity_kind: "module",
			nova_entity_uuid: moduleUuid,
			unique_id: hqMenu,
			xmlns: null,
		})
		.execute();
	const source = JSON.stringify({
		doc_type: "Application",
		name: "Clinic",
		modules: [
			{
				doc_type: "Module",
				unique_id: hqMenu,
				search_config: { instance_name: "ClinicSearch" },
			},
		],
		_attachments: {},
		profile: {},
		langs: ["en"],
		build_spec: { version: "2.57.0" },
		build_profiles: {},
		translations: {},
		add_ons: {},
		use_grid_menus: true,
		auto_gps_capture: true,
	});
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
	return moduleUuid;
}

async function releasedWorkspace(appId: string, reader: CompletionMigration) {
	const root = await h.withTransaction((tx) =>
		readReleasedFoldSnapshot(tx, appId),
	);
	const baseDigest = canonicalJsonDigest(reader.readHead(root));
	const id = crypto.randomUUID(),
		session = crypto.randomUUID();
	const mutations = [
		{ kind: "setAppName", name: "Held private visit" },
		{ kind: "setConnectType", connectType: null },
	];
	await h.withTransaction(async (tx) => {
		await sql`INSERT INTO authoring_sessions (id, actor_user_id, project_id, origin, app_id, app_name, begin_request_id, begin_input_digest)
			VALUES (${session}, ${owner}, ${projectId}, 'mcp', ${appId}, 'Private visit', ${id}, ${canonicalJsonDigest(id)})`.execute(
			tx,
		);
		await sql`INSERT INTO authoring_workspaces (id, authoring_session_id, kind, app_id, base_seq, base_project_id, base_snapshot_digest, revision, next_ordinal, owner_user_id, status)
			VALUES (${id}, ${session}, 'app-edit', ${appId}, 1, ${projectId}, ${baseDigest}, 1, 1, ${owner}, 'open')`.execute(
			tx,
		);
		await sql`UPDATE authoring_sessions SET active_candidate_id = ${id} WHERE id = ${session}`.execute(
			tx,
		);
		// A receipt and its original instructions stay immutable. The fold
		// stores only the changed candidate projection and expanded stage range.
		await sql`INSERT INTO authoring_requests (change_set_id, request_id, tool_name, input_digest, expected_revision, resulting_revision, status, receipt)
			VALUES (${id}, 'edit', 'updateApp', ${canonicalJsonDigest(id)}, 0, 1, 'staged', '{}')`.execute(
			tx,
		);
		await sql`INSERT INTO authoring_steps (change_set_id, ordinal, request_id, tool_name, mutations, mutation_digest)
			VALUES (${id}, 0, 'edit', 'updateApp', ${JSON.stringify(mutations)}::jsonb, ${canonicalJsonDigest(mutations)})`.execute(
			tx,
		);
		await sql`INSERT INTO authoring_step_stages (change_set_id, step_ordinal, stage_ordinal, stage_name, mutation_start, mutation_count)
			VALUES (${id}, 0, 0, 'Update app', 0, 2)`.execute(tx);
	});
	return id;
}

it("rolls back pending DDL and the first app when the second app refuses, then verifies a committed retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nova-completion-"));
	vi.stubEnv("NOVA_DB_LOCAL_URL", h.uri());
	try {
		const manifest = await artifacts(directory);
		const released = await completionArtifacts(manifest);
		await releasedApp("completion-a");
		await releasedApp("completion-b", "deliver");
		const moduleUuid = await releasedTarget("completion-a");
		const workspace = await releasedWorkspace("completion-a", released);
		const config = await freezeCompletionSettings(h.db(), released);
		expect(config.menuLayouts.decisions).toHaveLength(1);
		expect(config.searchResults.targets[0]?.menus).toEqual([
			{ menu: moduleUuid, uniqueId: hqMenu, name: "ClinicSearch" },
		]);
		const migration = await completionArtifacts(manifest, config);
		const scanned = await scanCompletion(h.db(), migration, storage);
		const plan = completionPlanSchema.parse(
			JSON.parse(JSON.stringify(scanned)),
		);
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
			message:
				"Saved apps or open private work still need the reviewed HQ round-trip conversion.",
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
			expect(loaded?.mutation_seq).toBe(entry.headSeq + 1);
			if (entry.appId === "completion-a") {
				expect(loaded?.blueprint.connectRoles).toEqual([]);
				expect(loaded?.blueprint.modules[moduleUuid]?.searchResultsName).toBe(
					"ClinicSearch",
				);
				expect(loaded?.blueprint.appSettings).toMatchObject({
					captureLocation: true,
					firstMenuLayout: "grid",
				});
			} else {
				expect(loaded?.blueprint.connectRoles).toEqual(["deliver"]);
				expect(Object.values(loaded?.blueprint.fields ?? {})).toContainEqual(
					expect.objectContaining({ kind: "connect_activity" }),
				);
			}
		}
		const reopened = await loadChangeSet(workspace);
		if (!reopened) throw new Error("The original private work disappeared.");
		const overlay = await rehydrateChangeSet(reopened);
		expect(overlay.overlay.doc.appName).toBe("Held private visit");
		expect(overlay.overlay.doc.appSettings.firstMenuLayout).toBe("grid");
		expect(overlay.overlay.doc.modules[moduleUuid]?.searchResultsName).toBe(
			"ClinicSearch",
		);
		const retired = await sql<{ old_column: boolean }>`SELECT EXISTS (
		SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'apps' AND column_name = 'connect_type'
	) AS old_column`.execute(h.db());
		expect(retired.rows).toEqual([{ old_column: false }]);
	} finally {
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	}
}, 240_000);
