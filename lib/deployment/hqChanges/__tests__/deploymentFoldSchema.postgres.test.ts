import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import {
	writeHorizonInTransaction,
	writeHqRoundTripHorizon,
} from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { caseStoreMigrationProvider } from "@/lib/case-store/migrations";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { OWNERSHIP } from "@/lib/deployment/__tests__/adoptedBirth";
import { readAppBaseline } from "@/lib/deployment/store";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import {
	type DeploymentFoldInventory,
	scanDeploymentFold,
	writeDeploymentAwareFold,
} from "@/scripts/lib/deploymentFold";

const migration = "20261204000000_deployment_fold_references";
const h = setupAppStateTestDb("fold_scan_before_ddl_", {
	authSchema: "migrated",
	// The deployed tree ends at 20261202000000_hq_bring_in_project_data.
	// Companion migrations in the candidate may sort before the certificate DDL.
	caseStoreMigrationsBefore: "20261203",
});
const projectId = "clinic-project",
	owner = "clinic-owner";

async function installCandidate() {
	const result = await new Migrator({
		db: h.db(),
		provider: caseStoreMigrationProvider,
	}).migrateTo(migration);
	if (result.error !== undefined) throw result.error;
}

async function fixture() {
	const appId = await h.seedApp({ project_id: projectId, owner });
	const headSeq = await writeHqRoundTripHorizon(h.db(), appId, "Clinic");
	const app = await loadApp(appId);
	if (!app) throw new Error("The previous database has no saved app.");
	const input = {
		appId,
		projectId,
		headSeq,
		oldHead: hydratePersistedBlueprint(app.blueprint),
		convert: (doc: PersistableDoc) => doc,
	};
	for (const domain of ["east", "west"]) {
		const source = JSON.stringify({ name: domain });
		// The previous revision could name only these columns. Both rows
		// have an independently verified source and a real published revision.
		const deployment = await h
			.db()
			.insertInto("app_deployments")
			.values({
				app_id: appId,
				project_id: projectId,
				server: "india",
				domain,
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
				deployment_id: deployment.id,
				kind: "app",
				nova_resource_id: appId,
				remote_id: domain,
				ownership: "nova-created",
				pushed_revision: headSeq,
			})
			.execute();
		await h
			.db()
			.insertInto("app_deployment_baselines")
			.values({
				deployment_id: deployment.id,
				origin: "push",
				remote_app_id: domain,
				observed_by: owner,
				source_gzip: gzipSync(source),
				source_bytes: Buffer.byteLength(source),
				source_digest: createHash("sha256").update(source).digest("hex"),
				ownership: JSON.stringify(OWNERSHIP),
				observed_at: new Date(),
				nova_revision: headSeq,
			})
			.execute();
	}
	const scan = () =>
		h
			.db()
			.transaction()
			.setAccessMode("read only")
			.setIsolationLevel("repeatable read")
			.execute((tx) => scanDeploymentFold(tx, input));
	const write = (receipt: DeploymentFoldInventory) =>
		h.withTransaction((tx) =>
			writeDeploymentAwareFold(tx, input, receipt, (doc, seq) =>
				writeHorizonInTransaction(
					tx,
					appId,
					doc,
					seq,
					"hq-round-trip-expressions",
				),
			),
		);
	return { appId, scan, write, headSeq };
}

it("scans the deployed storage read-only and uses its receipt after DDL, rolling a partial multi-target write back before retry", async () => {
	const { appId, scan, write, headSeq } = await fixture();
	const before = await scan();
	expect(before).toMatchObject({ usable: 2, unavailable: 0 });
	await expect(
		readAppBaseline(
			{ appId, projectId, actorUserId: owner, role: "owner" },
			{ server: "india", domain: "west" },
		),
	).rejects.toThrow(/does not exist/);
	await expect(write(before)).rejects.toThrow(
		"Install the deployment fold migration",
	);
	await installCandidate();
	expect(await scan()).toEqual(before);
	await sql`CREATE FUNCTION refuse_second_certificate() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN
		IF EXISTS (SELECT FROM app_deployment_fold_references) THEN RAISE EXCEPTION 'second target'; END IF;
		RETURN NEW; END $$;
		CREATE TRIGGER refuse_second_certificate BEFORE INSERT ON app_deployment_fold_references
		FOR EACH ROW EXECUTE FUNCTION refuse_second_certificate()`.execute(h.db());
	await expect(write(before)).rejects.toThrow("second target");
	expect(
		await h
			.db()
			.selectFrom("app_deployment_fold_references")
			.select("deployment_id")
			.execute(),
	).toEqual([]);
	expect(
		await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select("reference_fold_seq")
			.execute(),
	).toEqual([{ reference_fold_seq: null }, { reference_fold_seq: null }]);
	expect((await loadApp(appId))?.mutation_seq).toBe(headSeq);
	expect(await scan()).toEqual(before);
	await sql`DROP TRIGGER refuse_second_certificate ON app_deployment_fold_references`.execute(
		h.db(),
	);
	expect(await write(before)).toEqual(before);
	const rows = await h
		.db()
		.selectFrom("app_deployment_fold_references")
		.select(["published_revision", "fold_seq", "state"])
		.execute();
	expect(rows).toHaveLength(2);
	for (const row of rows) {
		expect(Number(row.published_revision)).toBe(headSeq);
		expect(Number(row.fold_seq)).toBe(headSeq + 1);
		expect(row.state).toMatchObject({ kind: "ok", doc: { appName: "Clinic" } });
	}
});

it("includes the release instant on the previous schema where no claim trigger rotates the push token", async () => {
	const { appId, scan } = await fixture();
	const releaseAt = (at: string) =>
		h
			.db()
			.updateTable("app_deployment_resources")
			.set({ released_at: new Date(at) })
			.where("nova_resource_id", "=", appId)
			.where("remote_id", "=", "east")
			.returning("push_token")
			.executeTakeFirstOrThrow();
	const firstMapping = await releaseAt("2026-11-20T12:00:00.000Z");
	const first = await scan();
	expect(first).toMatchObject({ usable: 1, unavailable: 1 });
	expect(await releaseAt("2026-11-20T12:00:01.000Z")).toEqual(firstMapping);
	const second = await scan();
	expect(second).toMatchObject({ usable: 1, unavailable: 1 });
	expect(second.digest).not.toBe(first.digest);
});

it("refuses a partial install and a broken constraint even when the migration is recorded", async () => {
	const { scan } = await fixture();
	await sql`ALTER TABLE app_deployment_baselines ADD COLUMN reference_fold_seq bigint`.execute(
		h.db(),
	);
	await expect(scan()).rejects.toThrow("schema is incomplete");
	await sql`ALTER TABLE app_deployment_baselines DROP COLUMN reference_fold_seq`.execute(
		h.db(),
	);
	await installCandidate();
	await sql`ALTER TABLE app_deployment_baselines DROP CONSTRAINT app_deployment_baselines_reference_pair,
		ADD CONSTRAINT app_deployment_baselines_reference_pair CHECK (true)`.execute(
		h.db(),
	);
	await expect(scan()).rejects.toThrow("schema is incomplete");
});
