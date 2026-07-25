import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import {
	DeploymentCutoverGateHeldError,
	withDeploymentCutoverSession,
} from "../deploymentCutoverGate";
import { type AppDatabase, getAppDb } from "../pg";
import {
	type ActivationSwitch,
	disableLookupReferenceActivationFlag,
	enableLookupReferenceActivationInTransaction,
	prepareRuntimeReaderTrafficEpoch,
	raiseMinimumRuntimeReaderVersion,
	raiseMinimumStreamReceiverVersion,
	readRolloutCompatibilityStatus,
	reconcileReceivingRevisionCapabilities,
} from "../rolloutCompatibility";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("rollout_compat_");

const receiving =
	(runtimeReaderVersion: number, streamReceiverVersion = 3) =>
	async () => [
		{
			revision: `reader-${runtimeReaderVersion}`,
			runtimeReaderVersion,
			streamReceiverVersion,
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

const ALL_SWITCHES: readonly ActivationSwitch[] = [
	"carrier_commits_enabled",
	"destructive_schema_actions_enabled",
	"project_moves_enabled",
	"case_operations_enabled",
	"run_holder_nonce_enforced",
];

/** Drive the enable transaction the way the controller does: under the session
 *  gate, on the one pinned connection whose transactions re-take the gate. */
async function activate(
	switches: readonly ActivationSwitch[] = ALL_SWITCHES,
): Promise<Awaited<ReturnType<typeof raiseMinimumStreamReceiverVersion>>> {
	const db = await getAppDb();
	return withDeploymentCutoverSession(db, (session) =>
		session
			.transaction()
			.execute((tx) =>
				enableLookupReferenceActivationInTransaction(tx, switches),
			),
	);
}

async function raiseFloorsToActivationTargets(): Promise<void> {
	await raiseMinimumStreamReceiverVersion(3);
	await sql`
		INSERT INTO runtime_reader_traffic_epochs (
			target_version,
			continuous_traffic_since
		) VALUES (1, clock_timestamp() - interval '2 hours')
	`.execute(await getAppDb());
	await raiseMinimumRuntimeReaderVersion(1);
}

describe("activation switches", () => {
	test("refuses every switch whose floor is unmet", async () => {
		// Moves are omitted: their floors (writer 1, receiver 1) are already met.
		await expect(activate()).rejects.toMatchObject({
			code: "activation_floor_unmet",
			details: {
				current: { writer: 1, receiver: 2, reader: 0 },
				unmet: [
					{ name: "carrier_commits_enabled" },
					{ name: "case_operations_enabled" },
					{ name: "run_holder_nonce_enforced" },
				],
			},
		});

		// The schema switch alone needs only writer v1, which is already met.
		const enabled = await activate(["destructive_schema_actions_enabled"]);
		expect(enabled).toMatchObject({
			destructiveSchemaActionsEnabled: true,
			carrierCommitsEnabled: false,
			projectMovesEnabled: false,
			caseOperationsEnabled: false,
			runHolderNonceEnforced: false,
		});
	});

	test("refuses while an unexpired below-floor stream lease is still held", async () => {
		const appId = await h.seedApp({ id: "leaseholder" });
		await raiseFloorsToActivationTargets();
		await sql`
			INSERT INTO lookup_stream_capability_leases (
				app_id, receiver_version, expires_at
			) VALUES (${appId}, 2, clock_timestamp() + interval '10 minutes')
		`.execute(await getAppDb());

		await expect(activate()).rejects.toMatchObject({
			code: "activation_receivers_not_drained",
			details: {
				receiverFloor: 3,
				staleLeases: [expect.objectContaining({ appId, receiverVersion: 2 })],
			},
		});

		// A lapsed lease holds nothing; only liveness blocks the cutoff.
		await sql`
			UPDATE lookup_stream_capability_leases
			SET created_at = clock_timestamp() - interval '2 hours',
				expires_at = clock_timestamp() - interval '1 second'
		`.execute(await getAppDb());
		await expect(activate()).resolves.toMatchObject({
			carrierCommitsEnabled: true,
		});
	});

	test("flips every switch at once and keeps nonce enforcement irreversible", async () => {
		await raiseFloorsToActivationTargets();
		expect(await activate()).toMatchObject({
			minimumWriterVersion: 1,
			minimumStreamReceiverVersion: 3,
			minimumRuntimeReaderVersion: 1,
			carrierCommitsEnabled: true,
			destructiveSchemaActionsEnabled: true,
			projectMovesEnabled: true,
			caseOperationsEnabled: true,
			runHolderNonceEnforced: true,
		});

		// The emergency path still turns a feature flag back off …
		expect(
			await disableLookupReferenceActivationFlag("case_operations_enabled"),
		).toMatchObject({
			caseOperationsEnabled: false,
			carrierCommitsEnabled: true,
			runHolderNonceEnforced: true,
		});
		// … but the nonce switch is one-way at the database.
		await expect(
			sql`
				UPDATE lookup_reference_compatibility
				SET run_holder_nonce_enforced = false
				WHERE id = 1
			`.execute(await getAppDb()),
		).rejects.toMatchObject({
			message: expect.stringContaining("irreversible"),
		});
	});

	test("names no switch at all rather than committing an empty activation", async () => {
		await expect(activate([])).rejects.toMatchObject({
			code: "invalid_version",
		});
	});
});

describe("deployment cutover session", () => {
	test("refuses a second holder instead of queueing behind the first", async () => {
		const db = await getAppDb();
		// A genuinely separate backend: the per-test handle pools one connection,
		// and the gate is a session lock, so contention needs a second client.
		const rival = new Kysely<AppDatabase>({
			dialect: new PostgresDialect({
				pool: new Pool({ connectionString: h.uri(), max: 1 }),
			}),
		});
		try {
			await withDeploymentCutoverSession(db, async () => {
				await expect(
					withDeploymentCutoverSession(rival, async () => "unreachable"),
				).rejects.toBeInstanceOf(DeploymentCutoverGateHeldError);
			});

			// The gate is free for the next cutover once the session returns.
			expect(
				await withDeploymentCutoverSession(rival, async () => "held"),
			).toBe("held");
		} finally {
			await rival.destroy();
		}
	});

	test("releases the gate even when the cutover body throws", async () => {
		const db = await getAppDb();
		await expect(
			withDeploymentCutoverSession(db, async () => {
				throw new Error("phase failed");
			}),
		).rejects.toThrow("phase failed");
		expect(await withDeploymentCutoverSession(db, async () => "free")).toBe(
			"free",
		);
	});
});
