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

const receiving = (runtimeReaderVersion: number) => async () => [
	{
		revision: `reader-${runtimeReaderVersion}`,
		runtimeReaderVersion,
	},
];

describe("rollout compatibility service", () => {
	test("migrations seed the final maintenance floors with every flag off", async () => {
		const status = await readRolloutCompatibilityStatus();
		expect(status.compatibility).toMatchObject({
			minimumWriterVersion: 1,
			minimumStreamReceiverVersion: 2,
			minimumRuntimeReaderVersion: 0,
			runHolderNonceEnforced: false,
			carrierCommitsEnabled: false,
			destructiveSchemaActionsEnabled: false,
			projectMovesEnabled: false,
		});
	});

	test("invalidates runtime epochs above the receiving minimum and never auto-resurrects them", async () => {
		const targetOne = await prepareRuntimeReaderTrafficEpoch(1, receiving(2));
		await prepareRuntimeReaderTrafficEpoch(2, receiving(2));
		const compatible = await reconcileReceivingRevisionCapabilities(
			receiving(1),
		);
		expect(compatible.runtimeTrafficEpochs).toEqual([targetOne]);

		const incompatible = await reconcileReceivingRevisionCapabilities(
			receiving(0),
		);
		expect(incompatible.runtimeTrafficEpochs).toEqual([]);

		const restored = await reconcileReceivingRevisionCapabilities(receiving(2));
		expect(restored.runtimeTrafficEpochs).toEqual([]);
		expect(restored.compatibility).toMatchObject({
			carrierCommitsEnabled: false,
			destructiveSchemaActionsEnabled: false,
			projectMovesEnabled: false,
		});
	});

	test("requires compatible traffic to prepare and preserves an idempotent epoch", async () => {
		await expect(
			prepareRuntimeReaderTrafficEpoch(2, receiving(1)),
		).rejects.toMatchObject({ code: "receiving_revision_incompatible" });

		const prepared = await prepareRuntimeReaderTrafficEpoch(2, receiving(2));
		const repeated = await prepareRuntimeReaderTrafficEpoch(2, receiving(3));
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

	test("stream receiver floor raises monotonically with no epoch prerequisite", async () => {
		await expect(raiseMinimumStreamReceiverVersion(1)).rejects.toMatchObject({
			code: "floor_cannot_decrease",
		});

		const unchanged = await raiseMinimumStreamReceiverVersion(2);
		expect(unchanged.minimumStreamReceiverVersion).toBe(2);

		const raised = await raiseMinimumStreamReceiverVersion(3);
		expect(raised).toMatchObject({
			minimumStreamReceiverVersion: 3,
			carrierCommitsEnabled: false,
			destructiveSchemaActionsEnabled: false,
			projectMovesEnabled: false,
		});
	});
});
