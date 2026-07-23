/**
 * Real-Postgres proof of the media attach/delete winner protocol.
 *
 * App writers lock newly introduced asset rows `FOR SHARE` and insert the
 * reverse edge in their app transaction. Deletion locks the asset `FOR UPDATE`
 * and re-walks persisted blueprints without taking app locks. These tests hold
 * each winner immediately before commit so the loser must wake and re-evaluate
 * current state rather than accepting a stale preflight.
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
