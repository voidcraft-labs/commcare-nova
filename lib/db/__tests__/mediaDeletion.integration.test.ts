/**
 * Real-Postgres proof of the media attach/delete winner protocol.
 *
 * App writers lock newly introduced asset rows `FOR SHARE` and insert the
 * reverse edge in their app transaction. Deletion locks the asset `FOR UPDATE`
 * and re-walks persisted carriers without taking app locks. These tests hold
 * each winner immediately before commit so the loser must wake and re-evaluate
 * current state rather than accepting a stale preflight. The carrier-relocation
 * regression also pins roots + normalized entities to one statement snapshot.
 */

import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import { asAssetId } from "@/lib/domain/multimedia";
import { setupAppStateTestDb } from "./appStateTestDb";
import { createPerTestAppDb } from "./perTestAppDb";

const { commitGuardedBatch, loadApp } = await import("../apps");
const { BlueprintCommitRejectedError } = await import("../commitGuard");
const {
	deletePendingAssetForActor,
	publishClaimedAssetExtract,
	publishPendingAssetForActor,
} = await import("../mediaAssets");
const { deleteMediaAssetForActor, deleteMediaAssetMetadataInTransaction } =
	await import("../mediaDeletion");

const PROJECT = "media-project";
const ACTOR = "media-owner";
const h = setupAppStateTestDb("media_delete_");

async function seedReadyAsset(id = crypto.randomUUID()): Promise<string> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: ACTOR,
			content_hash: id.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 100,
			dimensions: JSON.stringify({ width: 16, height: 16 }),
			duration_ms: null,
			kind: "image",
			gcs_object_key: `projects/${PROJECT}/${id}.png`,
			original_filename: "logo.png",
			display_name: "Logo",
			status: "ready",
			extract: null,
		})
		.execute();
	return id;
}

async function seedPendingAsset(id = crypto.randomUUID()): Promise<string> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: ACTOR,
			content_hash: id.replaceAll("-", "").padEnd(64, "b").slice(0, 64),
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 100,
			dimensions: null,
			duration_ms: null,
			kind: "image",
			gcs_object_key: `pending/${PROJECT}/${id}.png`,
			original_filename: "logo.png",
			display_name: "Logo",
			status: "pending",
			extract: null,
		})
		.execute();
	return id;
}

async function seedExtractingDocumentAsset(id = crypto.randomUUID()): Promise<{
	id: string;
	claim: { version: number; model: string; extractedAt: number };
}> {
	const claim = {
		version: 3,
		model: "extract-model",
		extractedAt: 1_700_000_000_000,
	};
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: ACTOR,
			content_hash: id.replaceAll("-", "").padEnd(64, "c").slice(0, 64),
			mime_type: "application/pdf",
			extension: ".pdf",
			size_bytes: 100,
			dimensions: null,
			duration_ms: null,
			kind: "pdf",
			gcs_object_key: `projects/${PROJECT}/${id}.pdf`,
			original_filename: "requirements.pdf",
			display_name: "Requirements",
			status: "ready",
			extract: JSON.stringify({
				status: "extracting",
				...claim,
				truncated: false,
				charCount: 0,
			}),
		})
		.execute();
	return { id, claim };
}

async function seedApp(): Promise<{
	appId: string;
	doc: ReturnType<typeof buildDoc>;
}> {
	const doc = buildDoc({ appName: "Media race" });
	const appId = await h.seedAppWithBlueprint(doc, {
		owner: ACTOR,
		projectId: PROJECT,
	});
	return { appId, doc: { ...doc, appId } };
}

function attachLogo(assetId: string): Mutation[] {
	return [{ kind: "setAppLogo", logo: asAssetId(assetId) }];
}

async function waitForBlockedLocks(
	observer: Client,
	minimum: number,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const result = await observer.query<{ count: string }>(`
			SELECT count(*)::text AS count
			FROM pg_locks AS locks
			JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
			WHERE activity.datname = current_database()
			  AND NOT locks.granted
		`);
		if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${minimum} blocked database lock(s).`);
}

describe("transactional media deletion", () => {
	it("a stale rejection waiting behind publication observes ready as terminal", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const assetId = await seedPendingAsset();
		const finalKey = `projects/${PROJECT}/${assetId}.png`;
		const gateKey = 8_273_639;
		const gate = new Client({ connectionString: h.uri() });
		const publisherDb = createPerTestAppDb(h.uri());
		await gate.connect();
		await gate.query("SELECT pg_advisory_lock($1)", [gateKey]);
		await gate.query(`
			CREATE FUNCTION test_pause_pending_publication() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(${gateKey});
				RETURN NEW;
			END
			$$;
			CREATE TRIGGER test_pause_pending_publication_trigger
				AFTER UPDATE OF status ON media_assets
				FOR EACH ROW
				WHEN (OLD.status = 'pending' AND NEW.status = 'ready')
				EXECUTE FUNCTION test_pause_pending_publication();
		`);

		const publication = publishPendingAssetForActor(
			{
				assetId: asAssetId(assetId),
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
				gcsObjectKey: finalKey,
				mimeType: "image/png",
				extension: ".png",
				dimensions: { width: 16, height: 16 },
			},
			publisherDb.appDb,
		);
		let gateHeld = true;
		let rejection: Promise<unknown> | undefined;
		try {
			await waitForBlockedLocks(gate, 1);
			rejection = deletePendingAssetForActor({
				assetId: asAssetId(assetId),
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
			});
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			gateHeld = false;

			await expect(publication).resolves.toMatchObject({ kind: "published" });
			await expect(rejection).resolves.toMatchObject({ kind: "already_ready" });
		} finally {
			if (gateHeld) {
				await gate
					.query("SELECT pg_advisory_unlock($1)", [gateKey])
					.catch(() => {});
			}
			await Promise.allSettled([
				publication,
				...(rejection ? [rejection] : []),
			]);
			await gate.end().catch(() => {});
			await publisherDb.destroy();
		}

		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select(["status", "gcs_object_key"])
				.where("id", "=", assetId)
				.executeTakeFirst(),
		).toEqual({ status: "ready", gcs_object_key: finalKey });
	}, 15_000);

	it("full-scans persisted carriers while the reverse-index marker is incomplete", async () => {
		const { appId } = await seedApp();
		const assetId = await seedReadyAsset();
		// Simulate a legacy/pre-backfill persisted carrier with no reverse edge.
		await h
			.db()
			.updateTable("apps")
			.set({ logo: assetId })
			.where("id", "=", appId)
			.execute();

		const result = await deleteMediaAssetForActor({
			assetId,
			actorUserId: ACTOR,
			expectedProjectId: PROJECT,
		});

		expect(result).toMatchObject({ kind: "referenced" });
		if (result.kind !== "referenced") throw new Error("expected reference");
		expect(result.references[0]).toContain("the app logo");
		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("id", "=", assetId)
				.executeTakeFirst(),
		).toEqual({ id: assetId });
	});

	it("keeps media carried by a recoverable soft-deleted app so restore stays exact", async () => {
		const { appId } = await seedApp();
		const assetId = await seedReadyAsset();
		// Simulate a recoverable app deleted before the reverse-index backfill. Its
		// blueprint is still the exact state restore will revive, so that dormant
		// carrier remains authoritative even though ordinary app lists hide it.
		await h
			.db()
			.updateTable("apps")
			.set({
				logo: assetId,
				status: "deleted",
				deleted_at: new Date(),
				recoverable_until: new Date(Date.now() + 24 * 60 * 60_000),
			})
			.where("id", "=", appId)
			.execute();

		const result = await deleteMediaAssetForActor({
			assetId,
			actorUserId: ACTOR,
			expectedProjectId: PROJECT,
		});

		expect(result).toMatchObject({ kind: "referenced" });
		if (result.kind !== "referenced") throw new Error("expected reference");
		expect(result.references[0]).toContain("the app logo");
		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("id", "=", assetId)
				.executeTakeFirst(),
		).toEqual({ id: assetId });
	});

	it("keeps media carried by a persisted tombstone until its restore lifecycle is purged", async () => {
		const { appId } = await seedApp();
		const assetId = await seedReadyAsset();
		// App rows currently persist past their displayed recovery deadline, and
		// restore does not yet own an audited deadline/purge fence. Treat the row
		// as authoritative until that lifecycle removes it, or deletion could make
		// a later restore produce a broken live app.
		await h
			.db()
			.updateTable("apps")
			.set({
				logo: assetId,
				status: "deleted",
				deleted_at: new Date(Date.now() - 48 * 60 * 60_000),
				recoverable_until: new Date(Date.now() - 24 * 60 * 60_000),
			})
			.where("id", "=", appId)
			.execute();

		const result = await deleteMediaAssetForActor({
			assetId,
			actorUserId: ACTOR,
			expectedProjectId: PROJECT,
		});

		expect(result).toMatchObject({ kind: "referenced" });
		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("id", "=", assetId)
				.executeTakeFirst(),
		).toEqual({ id: assetId });
	});

	it("publication winner commits its extract pair before metadata deletion proceeds", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const asset = await seedExtractingDocumentAsset();
		const publisherDb = createPerTestAppDb(h.uri());
		const deleterDb = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		await observer.connect();
		let enteredPublication!: () => void;
		const publicationEntered = new Promise<void>((resolve) => {
			enteredPublication = resolve;
		});
		let allowPublication!: () => void;
		const publicationAllowed = new Promise<void>((resolve) => {
			allowPublication = resolve;
		});
		let objectPublished = false;

		const publication = publishClaimedAssetExtract(
			{
				assetId: asAssetId(asset.id),
				claim: asset.claim,
				extract: {
					status: "ready",
					version: asset.claim.version,
					model: asset.claim.model,
					truncated: false,
					charCount: 12,
				},
				publishReadyObject: async () => {
					enteredPublication();
					await publicationAllowed;
					objectPublished = true;
				},
			},
			publisherDb.appDb,
		);
		let deletion: Promise<unknown> | undefined;
		try {
			await publicationEntered;
			deletion = deleterDb.appDb.transaction().execute((tx) =>
				deleteMediaAssetMetadataInTransaction(tx, {
					assetId: asset.id,
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
				}),
			);
			await waitForBlockedLocks(observer, 1);
			allowPublication();

			await expect(publication).resolves.toMatchObject({ kind: "published" });
			await expect(deletion).resolves.toMatchObject({ kind: "deleted" });
		} finally {
			allowPublication();
			await Promise.allSettled([publication, ...(deletion ? [deletion] : [])]);
			await observer.end().catch(() => {});
			await Promise.all([publisherDb.destroy(), deleterDb.destroy()]);
		}

		expect(objectPublished).toBe(true);
		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("id", "=", asset.id)
				.executeTakeFirst(),
		).toBeUndefined();
	}, 15_000);

	it("delete winner makes a waiting extraction publication a no-op before GCS is touched", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const asset = await seedExtractingDocumentAsset();
		const publisherDb = createPerTestAppDb(h.uri());
		const deleterDb = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		await observer.connect();
		let deletedInsideTransaction!: () => void;
		const deletionExecuted = new Promise<void>((resolve) => {
			deletedInsideTransaction = resolve;
		});
		let allowDeleteCommit!: () => void;
		const deleteCommitAllowed = new Promise<void>((resolve) => {
			allowDeleteCommit = resolve;
		});
		let publishCallbackRan = false;

		const deletion = deleterDb.appDb.transaction().execute(async (tx) => {
			const result = await deleteMediaAssetMetadataInTransaction(tx, {
				assetId: asset.id,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
			});
			deletedInsideTransaction();
			await deleteCommitAllowed;
			return result;
		});
		let publication: Promise<unknown> | undefined;
		try {
			await deletionExecuted;
			publication = publishClaimedAssetExtract(
				{
					assetId: asAssetId(asset.id),
					claim: asset.claim,
					extract: {
						status: "ready",
						version: asset.claim.version,
						model: asset.claim.model,
						truncated: false,
						charCount: 12,
					},
					publishReadyObject: async () => {
						publishCallbackRan = true;
					},
				},
				publisherDb.appDb,
			);
			await waitForBlockedLocks(observer, 1);
			allowDeleteCommit();

			await expect(deletion).resolves.toMatchObject({ kind: "deleted" });
			await expect(publication).resolves.toMatchObject({ kind: "not_found" });
		} finally {
			allowDeleteCommit();
			await Promise.allSettled([
				deletion,
				...(publication ? [publication] : []),
			]);
			await observer.end().catch(() => {});
			await Promise.all([publisherDb.destroy(), deleterDb.destroy()]);
		}

		expect(publishCallbackRan).toBe(false);
		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("id", "=", asset.id)
				.executeTakeFirst(),
		).toBeUndefined();
	}, 15_000);

	it("cannot miss an asset atomically relocated from a normalized entity to the app root", async () => {
		const assetId = await seedReadyAsset();
		const doc = buildDoc({
			appName: "Carrier relocation",
			modules: [{ uuid: "module-1", name: "Households", forms: [] }],
		});
		const moduleUuid = doc.moduleOrder[0];
		if (moduleUuid === undefined) throw new Error("module fixture missing");
		const module = doc.modules[moduleUuid];
		if (module === undefined) throw new Error("module fixture missing");
		module.icon = asAssetId(assetId);
		const appId = await h.seedAppWithBlueprint(doc, {
			owner: ACTOR,
			projectId: PROJECT,
		});

		const gateKey = 8_273_641;
		const gate = new Client({ connectionString: h.uri() });
		const contender = createPerTestAppDb(h.uri());
		await gate.connect();
		await gate.query("SELECT pg_advisory_lock($1)", [gateKey]);
		await gate.query(`
			CREATE FUNCTION test_pause_carrier_relocation() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				LOCK TABLE blueprint_entities IN ACCESS EXCLUSIVE MODE;
				PERFORM pg_advisory_xact_lock(${gateKey});
				RETURN NEW;
			END
			$$;
			CREATE TRIGGER test_pause_carrier_relocation_trigger
				BEFORE INSERT ON accepted_mutations
				FOR EACH ROW EXECUTE FUNCTION test_pause_carrier_relocation();
		`);

		const relocation = commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: [
				{
					kind: "setModuleMedia",
					uuid: moduleUuid,
					icon: null,
					audioLabel: null,
				},
				{ kind: "setAppLogo", logo: asAssetId(assetId) },
			],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		let gateHeld = true;
		let deletion: Promise<unknown> | undefined;
		try {
			// The writer has changed BOTH carriers and holds an exclusive relation
			// lock before commit. A legacy split scan can read the old root, then
			// wake after commit and read the new entity — missing both. The coherent
			// query blocks as one statement and sees one side of the relocation.
			await waitForBlockedLocks(gate, 1);
			deletion = contender.appDb.transaction().execute((tx) =>
				deleteMediaAssetMetadataInTransaction(tx, {
					assetId,
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
				}),
			);
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			gateHeld = false;

			await expect(relocation).resolves.toMatchObject({ seq: 1 });
			await expect(deletion).resolves.toMatchObject({ kind: "referenced" });
		} finally {
			if (gateHeld) {
				await gate
					.query("SELECT pg_advisory_unlock($1)", [gateKey])
					.catch(() => {});
			}
			await Promise.allSettled([relocation, ...(deletion ? [deletion] : [])]);
			await gate.end().catch(() => {});
			await contender.destroy();
		}

		const persisted = await loadApp(appId);
		expect(persisted?.blueprint.logo).toBe(assetId);
		expect(persisted?.blueprint.modules[moduleUuid]?.icon).toBeUndefined();
		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("id", "=", assetId)
				.executeTakeFirst(),
		).toEqual({ id: assetId });
	}, 15_000);

	it("attach winner commits its carrier and exact edge before delete re-walks", async () => {
		const { appId } = await seedApp();
		const assetId = await seedReadyAsset();
		const gateKey = 8_273_640;
		const gate = new Client({ connectionString: h.uri() });
		const contender = createPerTestAppDb(h.uri());
		await gate.connect();
		await gate.query("SELECT pg_advisory_lock($1)", [gateKey]);
		await gate.query(`
				CREATE FUNCTION test_pause_media_attach() RETURNS trigger
				LANGUAGE plpgsql AS $$
				BEGIN
					PERFORM pg_advisory_xact_lock(${gateKey});
					RETURN NEW;
				END
				$$;
				CREATE TRIGGER test_pause_media_attach_trigger
				BEFORE INSERT ON accepted_mutations
				FOR EACH ROW EXECUTE FUNCTION test_pause_media_attach();
			`);

		const attach = commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: attachLogo(assetId),
			actorUserId: ACTOR,
			kind: "autosave",
		});
		let gateHeld = true;
		let deletion: Promise<unknown> | undefined;
		try {
			// The writer has already taken the asset share lock when its final
			// mutation-log insert reaches this test-only gate.
			await waitForBlockedLocks(gate, 1);
			deletion = contender.appDb.transaction().execute((tx) =>
				deleteMediaAssetMetadataInTransaction(tx, {
					assetId,
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
				}),
			);
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			gateHeld = false;

			await expect(attach).resolves.toMatchObject({ seq: 1 });
			await expect(deletion).resolves.toMatchObject({ kind: "referenced" });
		} finally {
			if (gateHeld) {
				await gate
					.query("SELECT pg_advisory_unlock($1)", [gateKey])
					.catch(() => {});
			}
			await Promise.allSettled([attach, ...(deletion ? [deletion] : [])]);
			await gate.end().catch(() => {});
			await contender.destroy();
		}

		expect(
			await h
				.db()
				.selectFrom("media_asset_refs")
				.select(["asset_id", "app_id"])
				.where("asset_id", "=", assetId)
				.where("app_id", "=", appId)
				.executeTakeFirst(),
		).toEqual({ asset_id: assetId, app_id: appId });
	}, 15_000);

	it("delete winner commits first and the waiting attach rejects the missing asset", async () => {
		const { appId } = await seedApp();
		const assetId = await seedReadyAsset();
		const contender = createPerTestAppDb(h.uri());
		let markDeleted!: () => void;
		const deletedInsideTransaction = new Promise<void>((resolve) => {
			markDeleted = resolve;
		});
		let allowCommit!: () => void;
		const commitAllowed = new Promise<void>((resolve) => {
			allowCommit = resolve;
		});

		const deletion = contender.appDb.transaction().execute(async (tx) => {
			const result = await deleteMediaAssetMetadataInTransaction(tx, {
				assetId,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
			});
			markDeleted();
			await commitAllowed;
			return result;
		});
		let attach: Promise<unknown> | undefined;
		try {
			await deletedInsideTransaction;
			attach = commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: attachLogo(assetId),
				actorUserId: ACTOR,
				kind: "autosave",
			});
			// The delete has executed inside its open transaction. The attach
			// either waits for that row version or starts after commit; both paths
			// must observe the delete winner and reject.
			allowCommit();

			await expect(deletion).resolves.toMatchObject({ kind: "deleted" });
			await expect(attach).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		} finally {
			allowCommit();
			await Promise.allSettled([deletion, ...(attach ? [attach] : [])]);
			await contender.destroy();
		}
		expect((await loadApp(appId))?.blueprint.logo).toBeUndefined();
		expect(
			await h
				.db()
				.selectFrom("media_asset_refs")
				.select("asset_id")
				.where("app_id", "=", appId)
				.execute(),
		).toEqual([]);
	}, 15_000);
});
