import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import {
	writeHorizonInTransaction,
	writeHqRoundTripCaseWritesHorizon,
	writeHqRoundTripHorizon,
} from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { caseStoreMigrationProvider } from "@/lib/case-store/migrations";
import { commitGuardedBatchProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp, restoreApp, softDeleteApp } from "@/lib/db/apps";
import { parseFoldBaselineSnapshot } from "@/lib/db/canonicalMutationFold";
import { OWNERSHIP } from "@/lib/deployment/__tests__/adoptedBirth";
import { readAppBaseline } from "@/lib/deployment/store";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import {
	type DeploymentFoldInventory,
	scanDeploymentFold,
	writeDeploymentAwareFold,
} from "@/scripts/lib/deploymentFold";
import {
	type DeploymentFoldMigration,
	openDeploymentFoldMigration,
	sameRepresentationFold,
} from "@/scripts/lib/deploymentFoldArtifacts";
import { loadReferenceDocument } from "../reference";

const h = setupAppStateTestDb("fold_scan_before_ddl_", {
	authSchema: "migrated",
	// The deployed tree ends at 20261202000000_hq_bring_in_project_data.
	// Companion migrations in the candidate may sort before the certificate DDL.
	caseStoreMigrationsBefore: "20261203",
});
const projectId = "clinic-project",
	owner = "clinic-owner";

/** The candidate's whole tree: the fold write runs the candidate's own code,
 * which reads every table its later migrations add, as a deploy does once
 * every migration has applied. */
async function installCandidate() {
	const result = await new Migrator({
		db: h.db(),
		provider: caseStoreMigrationProvider,
	}).migrateToLatest();
	if (result.error !== undefined) throw result.error;
}

async function fixture(
	dialect: DeploymentFoldMigration = sameRepresentationFold,
) {
	const appId = await h.seedApp({ project_id: projectId, owner });
	const headSeq = await writeHqRoundTripHorizon(h.db(), appId, "Clinic");
	const input = {
		appId,
		projectId,
		headSeq,
		migration: dialect,
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
	return { appId, scan, write, headSeq, input };
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
	expect(
		await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select(["readback_push_token", "readback_source_digest"])
			.execute(),
	).toEqual([
		{ readback_push_token: null, readback_source_digest: null },
		{ readback_push_token: null, readback_source_digest: null },
	]);
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

async function selectedMigration(prefix: string) {
	async function artifact(name: string) {
		const path = join(
			process.cwd(),
			"lib/deployment/hqChanges/__tests__/fixtures",
			name,
		);
		return {
			path,
			sha256: createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		};
	}
	return openDeploymentFoldMigration({
		sourceRevision: "1".repeat(40),
		sourceTree: "2".repeat(40),
		sourceLockSha256: "3".repeat(64),
		reader: await artifact("visit-title-source.mjs"),
		converter: await artifact("visit-title-converter.mjs"),
		settings: { prefix },
	});
}

/** Install the old release's root projection while preserving the candidate
 * definition for the converted writer. Both actually execute over app rows. */
async function installEarlierProjection() {
	const def = (
		await sql<{
			definition: string;
		}>`SELECT pg_get_functiondef('public.nova_current_app_change_fold_snapshot(text)'::regprocedure) AS definition`.execute(
			h.db(),
		)
	).rows[0]?.definition;
	if (!def) throw new Error("Missing root projection.");
	await sql
		.raw(
			def.replace(
				"FUNCTION public.nova_current_app_change_fold_snapshot(",
				"FUNCTION public.witness_candidate_snapshot(",
			),
		)
		.execute(h.db());
	await sql`CREATE OR REPLACE FUNCTION public.nova_current_app_change_fold_snapshot(text)
		RETURNS jsonb LANGUAGE sql STABLE AS $f$
		SELECT (doc - 'appName') || jsonb_build_object('visitTitle', doc->'appName')
		FROM (SELECT public.witness_candidate_snapshot($1) AS doc) AS candidate $f$`.execute(
		h.db(),
	);
	return def;
}

async function oldEdit(appId: string, title: string, seq: number) {
	await h.withTransaction(async (tx) => {
		await tx
			.updateTable("apps")
			.set({
				app_name: title,
				app_name_lower: title.toLowerCase(),
				mutation_seq: seq,
			})
			.where("id", "=", appId)
			.execute();
		await tx
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq,
				batch_id: crypto.randomUUID(),
				actor_id: owner,
				run_id: null,
				kind: "autosave",
				mutations: JSON.stringify([{ kind: "setVisitTitle", title }]),
				from_project_id: null,
				to_project_id: null,
			})
			.execute();
	});
}

it.each([false, true])(
	"converts old roots, old edits and independently published revisions with a prior certificate = %s",
	async (hasCertificate) => {
		const candidateDef = await installEarlierProjection();
		const migration = await selectedMigration("Converted ");
		const { appId, headSeq, input } = await fixture(migration);
		await h.seedProjectMember(owner, projectId, "owner");
		const head = () =>
			sql<{
				snapshot: string;
			}>`SELECT public.nova_current_app_change_fold_snapshot(${appId})::text AS snapshot`
				.execute(h.db())
				.then((r) => r.rows[0]?.snapshot ?? "");
		const oldHead = await head();
		expect(() => parseFoldBaselineSnapshot(oldHead)).toThrow();
		expect(JSON.parse(oldHead)).toMatchObject({ visitTitle: "Clinic" });
		const east = await h
			.db()
			.selectFrom("app_deployments")
			.select("id")
			.where("domain", "=", "east")
			.executeTakeFirstOrThrow();
		const west = await h
			.db()
			.selectFrom("app_deployments")
			.select("id")
			.where("domain", "=", "west")
			.executeTakeFirstOrThrow();
		let seq = headSeq;
		if (hasCertificate) {
			await installCandidate();
			// A later old release issued a certificate for West in this same old
			// dialect. East published again above that horizon.
			seq = await writeHqRoundTripCaseWritesHorizon(
				h.db(),
				appId,
				"Later old horizon",
			);
			const mapping = await h
				.db()
				.selectFrom("app_deployment_resources")
				.select("id")
				.where("deployment_id", "=", west.id)
				.executeTakeFirstOrThrow();
			const baseline = await h
				.db()
				.selectFrom("app_deployment_baselines")
				.select("source_digest")
				.where("deployment_id", "=", west.id)
				.executeTakeFirstOrThrow();
			if (!baseline.source_digest) throw new Error("Missing original digest");
			await h
				.db()
				.insertInto("app_deployment_fold_references")
				.values({
					deployment_id: west.id,
					app_id: appId,
					published_revision: headSeq,
					fold_seq: seq,
					mapping_id: mapping.id,
					original_source_digest: baseline.source_digest,
					state: JSON.stringify({
						kind: "ok",
						doc: JSON.parse(oldHead),
						projectId,
						actors: ["previous reviewer"],
						editorBefore: true,
						renamesSince: [],
					}),
				})
				.execute();
			await h
				.db()
				.updateTable("app_deployment_baselines")
				.set({
					reference_fold_seq: seq,
					reference_source_digest: baseline.source_digest,
				})
				.where("deployment_id", "=", west.id)
				.execute();
		}
		const publishedEast = ++seq;
		await oldEdit(appId, "East revision", seq);
		await h
			.db()
			.updateTable("app_deployment_resources")
			.set({ pushed_revision: seq })
			.where("deployment_id", "=", east.id)
			.execute();
		await h
			.db()
			.updateTable("app_deployment_baselines")
			.set({ nova_revision: seq })
			.where("deployment_id", "=", east.id)
			.execute();
		await oldEdit(appId, "Unpublished name", ++seq);
		await softDeleteApp(appId, owner);
		const source = { ...input, headSeq: seq };
		const scan = (selected = source) =>
			h
				.db()
				.transaction()
				.setAccessMode("read only")
				.setIsolationLevel("repeatable read")
				.execute((tx) => scanDeploymentFold(tx, selected));
		await expect(
			scan({ ...source, projectId: "a different Project" }),
		).rejects.toThrow();
		const receipt = await scan();
		expect(receipt.usable).toBe(2);
		if (!hasCertificate) await installCandidate();
		expect(await scan()).toEqual(receipt);
		const write = (selected: typeof source) =>
			h.withTransaction((tx) =>
				writeDeploymentAwareFold(tx, selected, receipt, async (doc, at) => {
					await sql.raw(candidateDef).execute(tx);
					await writeHorizonInTransaction(
						tx,
						appId,
						doc,
						at,
						"hq-round-trip-expressions",
					);
				}),
			);
		await expect(
			write({ ...source, migration: await selectedMigration("Different ") }),
		).rejects.toThrow("changed after the fold scan");
		expect(JSON.parse(await head())).toMatchObject({
			visitTitle: "Unpublished name",
		});
		await write(source);
		expect(blueprintDocSchema.parse(JSON.parse(await head())).appName).toBe(
			"Converted Unpublished name",
		);
		const scope = { appId, projectId, actorUserId: owner, role: "owner" };
		await expect(
			readAppBaseline(scope, { server: "india", domain: "east" }),
		).rejects.toThrow();
		await expect(restoreApp(appId, owner)).resolves.toEqual({
			stoppedPublishing: [],
		});
		await commitGuardedBatchProposal({
			appId,
			expectedProjectId: projectId,
			batchId: crypto.randomUUID(),
			actorUserId: owner,
			kind: "autosave",
			mutations: [{ kind: "setAppName", name: "Fresh candidate edit" }],
		});
		const saved = await loadApp(appId);
		if (!saved) throw new Error("Missing restored app");
		expect(saved.blueprint.appName).toBe("Fresh candidate edit");
		for (const [domain, revision, name, actors] of [
			[
				"west",
				headSeq,
				"Converted Clinic",
				hasCertificate ? ["previous reviewer", owner] : [owner],
			],
			["east", publishedEast, "Converted East revision", [owner]],
		] as const) {
			const baseline = await readAppBaseline(scope, {
				server: "india",
				domain,
			});
			if (!baseline || baseline.origin === "unread" || !baseline.foldBinding)
				throw new Error("Missing certified deployment");
			expect(baseline.novaRevision).toBe(revision);
			expect(baseline.sourceDigest).toBe(
				createHash("sha256")
					.update(JSON.stringify({ name: domain }))
					.digest("hex"),
			);
			const binding = baseline.foldBinding;
			const read = (project: string) =>
				loadReferenceDocument({
					appId,
					novaRevision: revision,
					binding: { ...binding, projectId: project },
					head: {
						seq: saved.mutation_seq,
						doc: hydratePersistedBlueprint(saved.blueprint),
					},
				});
			await expect(read("a different Project")).rejects.toThrow(
				"comparison changed",
			);
			expect(await read(projectId)).toMatchObject({
				kind: "ok",
				doc: { appName: name },
				identityDoc: { appName: name },
				actors,
			});
		}
	},
);
