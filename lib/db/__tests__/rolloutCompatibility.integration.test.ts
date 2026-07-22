import { sql } from "kysely";
import { describe, expect, test } from "vitest";
import {
	prepareRuntimeReaderTrafficEpoch,
	raiseMinimumRuntimeReaderVersion,
	raiseMinimumStreamReceiverVersion,
	readRolloutCompatibilityStatus,
	reconcileReceivingRevisionCapabilities,
} from "../rolloutCompatibility";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("rollout_compat_");

const receiving =
	(runtimeReaderVersion: number, streamRegistryVersion: number) => async () => [
		{
			revision: `reader-${runtimeReaderVersion}-registry-${streamRegistryVersion}`,
			runtimeReaderVersion,
			streamRegistryVersion,
		},
	];

describe("rollout compatibility service", () => {
	test("preserves registry time, invalidates runtime epochs, and never auto-resurrects them", async () => {
		const first = await reconcileReceivingRevisionCapabilities(receiving(2, 1));
		expect(first.compatibility.continuousRegistryTrafficSince).toBeInstanceOf(
			Date,
		);
		const forcedRegistryStart = await sql<{ since: Date }>`
			UPDATE lookup_reference_compatibility
			SET continuous_registry_traffic_since =
				clock_timestamp() - interval '2 hours'
			WHERE id = 1
			RETURNING continuous_registry_traffic_since AS since
		`.execute(h.db());
		const registryStarted = forcedRegistryStart.rows[0]?.since;
		if (!registryStarted) throw new Error("forced registry timestamp missing");

		const targetOne = await prepareRuntimeReaderTrafficEpoch(
			1,
			receiving(2, 1),
		);
		await prepareRuntimeReaderTrafficEpoch(2, receiving(2, 1));
		const compatible = await reconcileReceivingRevisionCapabilities(
			receiving(1, 1),
		);
		expect(
			compatible.compatibility.continuousRegistryTrafficSince?.getTime(),
		).toBe(registryStarted.getTime());
		expect(compatible.runtimeTrafficEpochs).toEqual([targetOne]);

		const incompatible = await reconcileReceivingRevisionCapabilities(
			receiving(0, 0),
		);
		expect(
			incompatible.compatibility.continuousRegistryTrafficSince,
		).toBeNull();
		expect(incompatible.runtimeTrafficEpochs).toEqual([]);

		const restored = await reconcileReceivingRevisionCapabilities(
			receiving(2, 1),
		);
		expect(
			restored.compatibility.continuousRegistryTrafficSince,
		).toBeInstanceOf(Date);
		expect(
			restored.compatibility.continuousRegistryTrafficSince?.getTime(),
		).toBeGreaterThan(registryStarted.getTime());
		expect(restored.runtimeTrafficEpochs).toEqual([]);
		expect(restored.compatibility).toMatchObject({
			carrierCommitsEnabled: false,
			destructiveSchemaActionsEnabled: false,
			projectMovesEnabled: false,
		});
	});

	test("requires compatible traffic to prepare and preserves an idempotent epoch", async () => {
		await expect(
			prepareRuntimeReaderTrafficEpoch(2, receiving(1, 1)),
		).rejects.toMatchObject({ code: "receiving_revision_incompatible" });

		const prepared = await prepareRuntimeReaderTrafficEpoch(2, receiving(2, 1));
		const repeated = await prepareRuntimeReaderTrafficEpoch(2, receiving(3, 1));
		expect(repeated.continuousTrafficSince.getTime()).toBe(
			prepared.continuousTrafficSince.getTime(),
		);
	});

	test("status includes deleted and stale holders and blocks their lower version", async () => {
		const appId = await h.seedApp({
			id: "deleted-stale-holder",
			status: "generating",
			run_id: "build-v0",
			deleted_at: new Date(Date.now() - 60_000),
			updated_at: new Date(Date.now() - 60 * 60_000),
		});
		await sql`
			INSERT INTO runtime_reader_traffic_epochs (
				target_version,
				continuous_traffic_since
			) VALUES (1, clock_timestamp() - interval '2 hours')
		`.execute(h.db());

		const status = await readRolloutCompatibilityStatus();
		expect(status.runtimeHolders).toEqual([
			expect.objectContaining({
				appId,
				deletedAt: expect.any(Date),
				holder: expect.objectContaining({
					effectiveVersion: 0,
					lifecycle: "reapable-stale-build",
				}),
			}),
		]);
		await expect(raiseMinimumRuntimeReaderVersion(1)).rejects.toMatchObject({
			code: "runtime_holders_not_drained",
		});

		await sql`
			UPDATE apps
			SET status = 'complete',
				res_period = NULL,
				res_run_id = NULL,
				lock_run_id = NULL
			WHERE id = ${appId}
		`.execute(h.db());
		const raised = await raiseMinimumRuntimeReaderVersion(1);
		expect(raised).toMatchObject({
			minimumRuntimeReaderVersion: 1,
			carrierCommitsEnabled: false,
			destructiveSchemaActionsEnabled: false,
			projectMovesEnabled: false,
		});
	});

	test("requires the full registry interval for the initial receiver cutoff", async () => {
		await expect(raiseMinimumStreamReceiverVersion(1)).rejects.toMatchObject({
			code: "registry_epoch_missing",
		});

		await sql`
			UPDATE lookup_reference_compatibility
			SET continuous_registry_traffic_since =
				clock_timestamp() - interval '2 hours'
			WHERE id = 1
		`.execute(h.db());
		const raised = await raiseMinimumStreamReceiverVersion(1);
		expect(raised).toMatchObject({
			minimumStreamReceiverVersion: 1,
			carrierCommitsEnabled: false,
			destructiveSchemaActionsEnabled: false,
			projectMovesEnabled: false,
		});
	});
});
