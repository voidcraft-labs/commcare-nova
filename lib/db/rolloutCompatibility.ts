import "server-only";

import { sql, type Transaction } from "kysely";
import {
	RUNTIME_CAPABILITIES,
	STREAM_LEASE_TTL_SECONDS,
} from "@/lib/runtimeCapabilities";
import { lockDeploymentCutoverGate } from "./deploymentCutoverGate";
import { LEASE_COLUMNS, leaseView } from "./leaseView";
import { type AppDatabase, getAppDb, withAppTx } from "./pg";
import { runLeaseState } from "./runLiveness";
import {
	type RuntimeHolderState,
	runtimeHolderBlocksTarget,
	runtimeHolderState,
} from "./runtimeReaderHolders";

const STREAM_REGISTRY_VERSION_WITH_LEASES = 1;
const RUNTIME_FLOOR_EPOCH_SECONDS = RUNTIME_CAPABILITIES.cloudRunRequestSeconds;

export interface ReceivingRevisionCapability {
	readonly revision: string;
	readonly runtimeReaderVersion: number;
	readonly streamRegistryVersion: number;
}

export interface LookupReferenceCompatibilityState {
	readonly minimumWriterVersion: number;
	readonly minimumStreamReceiverVersion: number;
	readonly minimumRuntimeReaderVersion: number;
	readonly continuousRegistryTrafficSince: Date | null;
	readonly runHolderNonceEnforced: boolean;
	readonly carrierCommitsEnabled: boolean;
	readonly destructiveSchemaActionsEnabled: boolean;
	readonly projectMovesEnabled: boolean;
	readonly updatedAt: Date;
}

export interface RuntimeReaderTrafficEpoch {
	readonly targetVersion: number;
	readonly continuousTrafficSince: Date;
}

export type PresentRuntimeHolderState = Extract<
	RuntimeHolderState,
	{ kind: "present" }
>;

export interface RuntimeHolderCensusEntry {
	readonly appId: string;
	readonly projectId: string | null;
	readonly deletedAt: Date | null;
	readonly holder: PresentRuntimeHolderState;
}

export interface StreamCapabilityLeaseStatus {
	readonly appId: string;
	readonly connectionId: string;
	readonly receiverVersion: number;
	readonly expiresAt: Date;
}

export interface RolloutCompatibilityStatus {
	readonly observedAt: Date;
	readonly compatibility: LookupReferenceCompatibilityState;
	readonly runtimeTrafficEpochs: readonly RuntimeReaderTrafficEpoch[];
	readonly runtimeHolders: readonly RuntimeHolderCensusEntry[];
	readonly activeStreamLeases: readonly StreamCapabilityLeaseStatus[];
}

export type LookupReferenceActivationFlag =
	| "carrier_commits_enabled"
	| "destructive_schema_actions_enabled"
	| "project_moves_enabled";

/**
 * Perform a fresh read of the exact effective Cloud Run traffic split when
 * invoked. Closing over or returning a previously captured snapshot violates
 * this contract; the type can enforce invocation order, not data provenance.
 */
export type ReadReceivingRevisionCapabilities = () => Promise<
	readonly ReceivingRevisionCapability[]
>;

export type RolloutCompatibilityErrorCode =
	| "compatibility_state_missing"
	| "invalid_version"
	| "receiving_revisions_required"
	| "receiving_revision_incompatible"
	| "floor_cannot_decrease"
	| "runtime_epoch_missing"
	| "runtime_epoch_too_young"
	| "runtime_holders_not_drained"
	| "registry_epoch_missing"
	| "registry_epoch_too_young";

export class RolloutCompatibilityError extends Error {
	readonly code: RolloutCompatibilityErrorCode;
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(
		code: RolloutCompatibilityErrorCode,
		message: string,
		details?: Readonly<Record<string, unknown>>,
	) {
		super(message);
		this.name = "RolloutCompatibilityError";
		this.code = code;
		this.details = details;
	}
}

function assertVersion(value: number, label: string, positive = false): void {
	if (
		!Number.isSafeInteger(value) ||
		value < (positive ? 1 : 0) ||
		value > 2_147_483_647
	) {
		throw new RolloutCompatibilityError(
			"invalid_version",
			`${label} must be ${positive ? "a positive" : "a nonnegative"} int4`,
			{ label, value },
		);
	}
}

function assertReceivingRevisions(
	revisions: readonly ReceivingRevisionCapability[],
): void {
	if (revisions.length === 0) {
		throw new RolloutCompatibilityError(
			"receiving_revisions_required",
			"At least one traffic-receiving revision is required.",
		);
	}
	for (const revision of revisions) {
		assertVersion(
			revision.runtimeReaderVersion,
			`${revision.revision} runtime reader version`,
		);
		assertVersion(
			revision.streamRegistryVersion,
			`${revision.revision} stream registry version`,
		);
	}
}

type CompatibilityRow = {
	readonly minimum_writer_version: number;
	readonly minimum_stream_receiver_version: number;
	readonly minimum_runtime_reader_version: number;
	readonly continuous_registry_traffic_since: Date | null;
	readonly run_holder_nonce_enforced: boolean;
	readonly carrier_commits_enabled: boolean;
	readonly destructive_schema_actions_enabled: boolean;
	readonly project_moves_enabled: boolean;
	readonly updated_at: Date;
};

function compatibilityState(
	row: CompatibilityRow,
): LookupReferenceCompatibilityState {
	return {
		minimumWriterVersion: row.minimum_writer_version,
		minimumStreamReceiverVersion: row.minimum_stream_receiver_version,
		minimumRuntimeReaderVersion: row.minimum_runtime_reader_version,
		continuousRegistryTrafficSince: row.continuous_registry_traffic_since,
		runHolderNonceEnforced: row.run_holder_nonce_enforced,
		carrierCommitsEnabled: row.carrier_commits_enabled,
		destructiveSchemaActionsEnabled: row.destructive_schema_actions_enabled,
		projectMovesEnabled: row.project_moves_enabled,
		updatedAt: row.updated_at,
	};
}

async function readCompatibilityRow(
	tx: Transaction<AppDatabase>,
	lock: "none" | "update" = "none",
): Promise<CompatibilityRow> {
	let query = tx
		.selectFrom("lookup_reference_compatibility")
		.select([
			"minimum_writer_version",
			"minimum_stream_receiver_version",
			"minimum_runtime_reader_version",
			"continuous_registry_traffic_since",
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"updated_at",
		])
		.where("id", "=", 1);
	if (lock === "update") query = query.forUpdate();
	const row = await query.executeTakeFirst();
	if (!row) {
		throw new RolloutCompatibilityError(
			"compatibility_state_missing",
			"Lookup-reference compatibility state is missing.",
		);
	}
	return row;
}

export interface StreamReceiverCompatibility {
	readonly minimumStreamReceiverVersion: number;
}

/**
 * Composable registration cutoff read. The caller supplies its existing app-
 * scoped transaction after locking the app and membership decision; this port
 * then holds the compatibility singleton FOR SHARE through lease insertion.
 */
export async function readStreamReceiverCompatibilityForShare(
	tx: Transaction<AppDatabase>,
): Promise<StreamReceiverCompatibility> {
	const row = await tx
		.selectFrom("lookup_reference_compatibility")
		.select("minimum_stream_receiver_version")
		.where("id", "=", 1)
		.forShare()
		.executeTakeFirst();
	if (!row) {
		throw new RolloutCompatibilityError(
			"compatibility_state_missing",
			"Lookup-reference compatibility state is missing.",
		);
	}
	return {
		minimumStreamReceiverVersion: row.minimum_stream_receiver_version,
	};
}

async function readRuntimeTrafficEpochs(
	tx: Transaction<AppDatabase>,
): Promise<RuntimeReaderTrafficEpoch[]> {
	const rows = await tx
		.selectFrom("runtime_reader_traffic_epochs")
		.select(["target_version", "continuous_traffic_since"])
		.orderBy("target_version", "asc")
		.execute();
	return rows.map((row) => ({
		targetVersion: row.target_version,
		continuousTrafficSince: row.continuous_traffic_since,
	}));
}

async function readRuntimeHolderCensus(
	tx: Transaction<AppDatabase>,
	observedAt: Date,
): Promise<RuntimeHolderCensusEntry[]> {
	const rows = await tx
		.selectFrom("apps")
		.select([
			"id",
			"project_id",
			"deleted_at",
			"run_runtime_reader_version",
			...LEASE_COLUMNS,
		])
		.where((eb) =>
			eb.or([
				eb("status", "=", "generating"),
				eb("lock_run_id", "is not", null),
			]),
		)
		.orderBy("id", "asc")
		.execute();

	return rows.map((row) => {
		const holder = runtimeHolderState(
			// `leaseView` is the single sanctioned flat-column projection.
			// `runLeaseState` remains the single liveness/identity reader.
			runLeaseState(leaseView(row), observedAt.getTime()),
			row.run_runtime_reader_version,
		);
		if (holder.kind !== "present") {
			throw new Error("Runtime holder census selected an absent holder.");
		}
		return {
			appId: row.id,
			projectId: row.project_id,
			deletedAt: row.deleted_at,
			holder,
		};
	});
}

async function databaseNow(tx: Transaction<AppDatabase>): Promise<Date> {
	const result = await sql<{ observed_at: Date }>`
		SELECT pg_catalog.clock_timestamp()::timestamptz(3) AS observed_at
	`.execute(tx);
	const observedAt = result.rows[0]?.observed_at;
	if (!observedAt) throw new Error("Database clock query returned no row.");
	return observedAt;
}

async function readStreamLeases(
	tx: Transaction<AppDatabase>,
	observedAt: Date,
): Promise<StreamCapabilityLeaseStatus[]> {
	const rows = await tx
		.selectFrom("lookup_stream_capability_leases")
		.select(["app_id", "connection_id", "receiver_version", "expires_at"])
		.where("expires_at", ">", observedAt)
		.orderBy("app_id", "asc")
		.orderBy("connection_id", "asc")
		.execute();
	return rows.map((row) => ({
		appId: row.app_id,
		connectionId: row.connection_id,
		receiverVersion: row.receiver_version,
		expiresAt: row.expires_at,
	}));
}

export async function readRolloutCompatibilityStatusInTransaction(
	tx: Transaction<AppDatabase>,
): Promise<RolloutCompatibilityStatus> {
	const observedAt = await databaseNow(tx);
	const compatibility = compatibilityState(await readCompatibilityRow(tx));
	const runtimeTrafficEpochs = await readRuntimeTrafficEpochs(tx);
	const runtimeHolders = await readRuntimeHolderCensus(tx, observedAt);
	const activeStreamLeases = await readStreamLeases(tx, observedAt);
	return {
		observedAt,
		compatibility,
		runtimeTrafficEpochs,
		runtimeHolders,
		activeStreamLeases,
	};
}

/** Compatibility, epochs, holder census, and stream leases from one snapshot. */
export async function readRolloutCompatibilityStatus(): Promise<RolloutCompatibilityStatus> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(readRolloutCompatibilityStatusInTransaction);
}

export interface ReconciledTrafficState {
	readonly compatibility: LookupReferenceCompatibilityState;
	readonly runtimeTrafficEpochs: readonly RuntimeReaderTrafficEpoch[];
}

/**
 * Reconcile durable epochs to the exact set of traffic-receiving revisions.
 * Registry-compatible traffic preserves/starts its interval; any incompatible
 * traffic clears it. Runtime epochs are deletion-only here and never
 * auto-resurrect after compatibility returns.
 */
export async function reconcileReceivingRevisionCapabilitiesInTransaction(
	tx: Transaction<AppDatabase>,
	readReceivingRevisions: ReadReceivingRevisionCapabilities,
): Promise<ReconciledTrafficState> {
	await lockDeploymentCutoverGate(tx);
	const revisions = await readReceivingRevisions();
	assertReceivingRevisions(revisions);
	const allRegistryCapable = revisions.every(
		(revision) =>
			revision.streamRegistryVersion >= STREAM_REGISTRY_VERSION_WITH_LEASES,
	);
	const minimumRuntimeReaderVersion = Math.min(
		...revisions.map((revision) => revision.runtimeReaderVersion),
	);

	const current = await readCompatibilityRow(tx, "update");
	if (
		allRegistryCapable &&
		current.continuous_registry_traffic_since === null
	) {
		await tx
			.updateTable("lookup_reference_compatibility")
			.set({
				continuous_registry_traffic_since: sql<Date>`clock_timestamp()`,
				updated_at: sql<Date>`clock_timestamp()`,
			})
			.where("id", "=", 1)
			.executeTakeFirstOrThrow();
	} else if (
		!allRegistryCapable &&
		current.continuous_registry_traffic_since !== null
	) {
		await tx
			.updateTable("lookup_reference_compatibility")
			.set({
				continuous_registry_traffic_since: null,
				updated_at: sql<Date>`clock_timestamp()`,
			})
			.where("id", "=", 1)
			.executeTakeFirstOrThrow();
	}

	await tx
		.deleteFrom("runtime_reader_traffic_epochs")
		.where("target_version", ">", minimumRuntimeReaderVersion)
		.execute();

	return {
		compatibility: compatibilityState(await readCompatibilityRow(tx)),
		runtimeTrafficEpochs: await readRuntimeTrafficEpochs(tx),
	};
}

/**
 * Pool-backed reconciliation seam. The control-plane callback is invoked only
 * after the transaction owns the cutover gate, and MUST perform its read then
 * rather than return cached data. S02c2's controller instead calls the in-
 * transaction form on the SAME dedicated backend that already holds the
 * session gate.
 */
export async function reconcileReceivingRevisionCapabilities(
	readReceivingRevisions: ReadReceivingRevisionCapabilities,
): Promise<ReconciledTrafficState> {
	return withAppTx((tx) =>
		reconcileReceivingRevisionCapabilitiesInTransaction(
			tx,
			readReceivingRevisions,
		),
	);
}

/** Explicitly start—or idempotently preserve—one compatible runtime epoch. */
export async function prepareRuntimeReaderTrafficEpochInTransaction(
	tx: Transaction<AppDatabase>,
	targetVersion: number,
	readReceivingRevisions: ReadReceivingRevisionCapabilities,
): Promise<RuntimeReaderTrafficEpoch> {
	assertVersion(targetVersion, "runtime reader target", true);
	await lockDeploymentCutoverGate(tx);
	const revisions = await readReceivingRevisions();
	assertReceivingRevisions(revisions);
	const incompatible = revisions
		.filter((revision) => revision.runtimeReaderVersion < targetVersion)
		.map((revision) => revision.revision);
	if (incompatible.length > 0) {
		throw new RolloutCompatibilityError(
			"receiving_revision_incompatible",
			"Every traffic-receiving revision must support the runtime target.",
			{ targetVersion, incompatibleRevisions: incompatible },
		);
	}

	await readCompatibilityRow(tx, "update");
	await tx
		.insertInto("runtime_reader_traffic_epochs")
		.values({ target_version: targetVersion })
		.onConflict((conflict) => conflict.column("target_version").doNothing())
		.execute();
	const epoch = await tx
		.selectFrom("runtime_reader_traffic_epochs")
		.select(["target_version", "continuous_traffic_since"])
		.where("target_version", "=", targetVersion)
		.executeTakeFirstOrThrow();
	return {
		targetVersion: epoch.target_version,
		continuousTrafficSince: epoch.continuous_traffic_since,
	};
}

/** Pool-backed prepare with the control-plane read inside the cutover gate. */
export async function prepareRuntimeReaderTrafficEpoch(
	targetVersion: number,
	readReceivingRevisions: ReadReceivingRevisionCapabilities,
): Promise<RuntimeReaderTrafficEpoch> {
	return withAppTx((tx) =>
		prepareRuntimeReaderTrafficEpochInTransaction(
			tx,
			targetVersion,
			readReceivingRevisions,
		),
	);
}

function assertFloorCanAdvance(current: number, target: number): void {
	if (target < current) {
		throw new RolloutCompatibilityError(
			"floor_cannot_decrease",
			"Compatibility floors are monotonic.",
			{ current, target },
		);
	}
}

/**
 * Raise the runtime-reader floor after its request-length epoch and exact
 * holder census have drained. The census takes no app row locks: this preserves
 * the app-first claim order while the locked compatibility row is the cutoff.
 */
export async function raiseMinimumRuntimeReaderVersionInTransaction(
	tx: Transaction<AppDatabase>,
	targetVersion: number,
): Promise<LookupReferenceCompatibilityState> {
	assertVersion(targetVersion, "runtime reader floor");
	await lockDeploymentCutoverGate(tx);
	const current = await readCompatibilityRow(tx, "update");
	assertFloorCanAdvance(current.minimum_runtime_reader_version, targetVersion);
	if (targetVersion === current.minimum_runtime_reader_version) {
		return compatibilityState(current);
	}

	const epoch = await tx
		.selectFrom("runtime_reader_traffic_epochs")
		.select("continuous_traffic_since")
		.where("target_version", "=", targetVersion)
		.executeTakeFirst();
	if (!epoch) {
		throw new RolloutCompatibilityError(
			"runtime_epoch_missing",
			"Prepare an uninterrupted traffic epoch for this runtime target first.",
			{ targetVersion },
		);
	}
	const observedAt = await databaseNow(tx);
	const ageMs = observedAt.getTime() - epoch.continuous_traffic_since.getTime();
	if (ageMs < RUNTIME_FLOOR_EPOCH_SECONDS * 1_000) {
		throw new RolloutCompatibilityError(
			"runtime_epoch_too_young",
			"The runtime traffic epoch has not reached the request cap.",
			{
				targetVersion,
				continuousTrafficSince: epoch.continuous_traffic_since,
				observedAt,
				requiredSeconds: RUNTIME_FLOOR_EPOCH_SECONDS,
			},
		);
	}

	const census = await readRuntimeHolderCensus(tx, observedAt);
	const blockers = census.filter((entry) =>
		runtimeHolderBlocksTarget(entry.holder, targetVersion),
	);
	if (blockers.length > 0) {
		throw new RolloutCompatibilityError(
			"runtime_holders_not_drained",
			"Present lower-version runtime holders still block this floor.",
			{ targetVersion, blockers },
		);
	}

	const updated = await tx
		.updateTable("lookup_reference_compatibility")
		.set({
			minimum_runtime_reader_version: targetVersion,
			updated_at: sql<Date>`clock_timestamp()`,
		})
		.where("id", "=", 1)
		.returning([
			"minimum_writer_version",
			"minimum_stream_receiver_version",
			"minimum_runtime_reader_version",
			"continuous_registry_traffic_since",
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"updated_at",
		])
		.executeTakeFirstOrThrow();
	return compatibilityState(updated);
}

export async function raiseMinimumRuntimeReaderVersion(
	targetVersion: number,
): Promise<LookupReferenceCompatibilityState> {
	return withAppTx((tx) =>
		raiseMinimumRuntimeReaderVersionInTransaction(tx, targetVersion),
	);
}

/** Raise the receiver admission floor; the first cutoff requires registry TTL. */
export async function raiseMinimumStreamReceiverVersionInTransaction(
	tx: Transaction<AppDatabase>,
	targetVersion: number,
): Promise<LookupReferenceCompatibilityState> {
	assertVersion(targetVersion, "stream receiver floor");
	await lockDeploymentCutoverGate(tx);
	const current = await readCompatibilityRow(tx, "update");
	assertFloorCanAdvance(current.minimum_stream_receiver_version, targetVersion);
	if (targetVersion === current.minimum_stream_receiver_version) {
		return compatibilityState(current);
	}

	if (current.minimum_stream_receiver_version === 0 && targetVersion > 0) {
		const since = current.continuous_registry_traffic_since;
		if (since === null) {
			throw new RolloutCompatibilityError(
				"registry_epoch_missing",
				"The initial stream cutoff requires uninterrupted registry traffic.",
			);
		}
		const observedAt = await databaseNow(tx);
		if (
			observedAt.getTime() - since.getTime() <
			STREAM_LEASE_TTL_SECONDS * 1_000
		) {
			throw new RolloutCompatibilityError(
				"registry_epoch_too_young",
				"Registry-capable traffic has not covered the stream lease TTL.",
				{
					continuousRegistryTrafficSince: since,
					observedAt,
					requiredSeconds: STREAM_LEASE_TTL_SECONDS,
				},
			);
		}
	}

	const updated = await tx
		.updateTable("lookup_reference_compatibility")
		.set({
			minimum_stream_receiver_version: targetVersion,
			updated_at: sql<Date>`clock_timestamp()`,
		})
		.where("id", "=", 1)
		.returning([
			"minimum_writer_version",
			"minimum_stream_receiver_version",
			"minimum_runtime_reader_version",
			"continuous_registry_traffic_since",
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"updated_at",
		])
		.executeTakeFirstOrThrow();
	return compatibilityState(updated);
}

export async function raiseMinimumStreamReceiverVersion(
	targetVersion: number,
): Promise<LookupReferenceCompatibilityState> {
	return withAppTx((tx) =>
		raiseMinimumStreamReceiverVersionInTransaction(tx, targetVersion),
	);
}

/**
 * Emergency rollback operation. S02c1 deliberately exposes no enable path:
 * later activation tooling must prove flag-specific request/holder/lease drain
 * and audit scans under the same dedicated cutover session.
 */
export async function disableLookupReferenceActivationFlagInTransaction(
	tx: Transaction<AppDatabase>,
	flag: LookupReferenceActivationFlag,
): Promise<LookupReferenceCompatibilityState> {
	await lockDeploymentCutoverGate(tx);
	await readCompatibilityRow(tx, "update");
	let update = tx.updateTable("lookup_reference_compatibility");
	if (flag === "carrier_commits_enabled") {
		update = update.set({ carrier_commits_enabled: false });
	} else if (flag === "destructive_schema_actions_enabled") {
		update = update.set({ destructive_schema_actions_enabled: false });
	} else {
		update = update.set({ project_moves_enabled: false });
	}
	const updated = await update
		.set({ updated_at: sql<Date>`clock_timestamp()` })
		.where("id", "=", 1)
		.returning([
			"minimum_writer_version",
			"minimum_stream_receiver_version",
			"minimum_runtime_reader_version",
			"continuous_registry_traffic_since",
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"updated_at",
		])
		.executeTakeFirstOrThrow();
	return compatibilityState(updated);
}

export async function disableLookupReferenceActivationFlag(
	flag: LookupReferenceActivationFlag,
): Promise<LookupReferenceCompatibilityState> {
	return withAppTx((tx) =>
		disableLookupReferenceActivationFlagInTransaction(tx, flag),
	);
}
