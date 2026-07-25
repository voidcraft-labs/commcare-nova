/**
 * The named compatibility operations behind the lookup-reference rollout.
 *
 * Deliberately carries no `server-only` marker: this is a control-plane
 * service, and the tsx rollout controller — not a route or a component — is the
 * caller of every operation here except `readStreamReceiverCompatibilityForShare`
 * (the one request-path export, used by stream registration). The marker would
 * throw the instant the controller loaded it, the same trade `lookupActivation.ts`
 * and `threads.ts` document.
 */

import { sql, type Transaction } from "kysely";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";
import { lockDeploymentCutoverGate } from "./deploymentCutoverGate";
import { LEASE_COLUMNS, leaseView } from "./leaseView";
import { RolloutCompatibilityError } from "./lookupActivation";
import { type AppDatabase, getAppDb, withAppTx } from "./pg";
import { runLeaseState } from "./runLiveness";
import {
	type RuntimeHolderState,
	runtimeHolderBlocksTarget,
	runtimeHolderState,
} from "./runtimeReaderHolders";

const RUNTIME_FLOOR_EPOCH_SECONDS = RUNTIME_CAPABILITIES.cloudRunRequestSeconds;

export interface ReceivingRevisionCapability {
	readonly revision: string;
	readonly runtimeReaderVersion: number;
}

export interface LookupReferenceCompatibilityState {
	readonly minimumWriterVersion: number;
	readonly minimumStreamReceiverVersion: number;
	readonly minimumRuntimeReaderVersion: number;
	readonly runHolderNonceEnforced: boolean;
	readonly carrierCommitsEnabled: boolean;
	readonly destructiveSchemaActionsEnabled: boolean;
	readonly projectMovesEnabled: boolean;
	readonly caseOperationsEnabled: boolean;
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
	| "project_moves_enabled"
	| "case_operations_enabled";

/**
 * Perform a fresh read of the exact effective Cloud Run traffic split when
 * invoked. Closing over or returning a previously captured snapshot violates
 * this contract; the type can enforce invocation order, not data provenance.
 */
export type ReadReceivingRevisionCapabilities = () => Promise<
	readonly ReceivingRevisionCapability[]
>;

export {
	RolloutCompatibilityError,
	type RolloutCompatibilityErrorCode,
} from "./lookupActivation";

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
	}
}

type CompatibilityRow = {
	readonly minimum_writer_version: number;
	readonly minimum_stream_receiver_version: number;
	readonly minimum_runtime_reader_version: number;
	readonly run_holder_nonce_enforced: boolean;
	readonly carrier_commits_enabled: boolean;
	readonly destructive_schema_actions_enabled: boolean;
	readonly project_moves_enabled: boolean;
	readonly case_operations_enabled: boolean;
	readonly updated_at: Date;
};

function compatibilityState(
	row: CompatibilityRow,
): LookupReferenceCompatibilityState {
	return {
		minimumWriterVersion: row.minimum_writer_version,
		minimumStreamReceiverVersion: row.minimum_stream_receiver_version,
		minimumRuntimeReaderVersion: row.minimum_runtime_reader_version,
		runHolderNonceEnforced: row.run_holder_nonce_enforced,
		carrierCommitsEnabled: row.carrier_commits_enabled,
		destructiveSchemaActionsEnabled: row.destructive_schema_actions_enabled,
		projectMovesEnabled: row.project_moves_enabled,
		caseOperationsEnabled: row.case_operations_enabled,
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
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"case_operations_enabled",
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
 * Reconcile durable runtime epochs to the exact set of traffic-receiving
 * revisions. Epochs are deletion-only here and never auto-resurrect after
 * compatibility returns.
 */
export async function reconcileReceivingRevisionCapabilitiesInTransaction(
	tx: Transaction<AppDatabase>,
	readReceivingRevisions: ReadReceivingRevisionCapabilities,
): Promise<ReconciledTrafficState> {
	await lockDeploymentCutoverGate(tx);
	const revisions = await readReceivingRevisions();
	assertReceivingRevisions(revisions);
	const minimumRuntimeReaderVersion = Math.min(
		...revisions.map((revision) => revision.runtimeReaderVersion),
	);

	// The FOR UPDATE row read serializes epoch deletion against a concurrent
	// runtime-floor raise, which reads its epoch only after locking this row.
	await readCompatibilityRow(tx, "update");
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
 * Pool-backed reconciliation seam. The capability callback is invoked only
 * after the transaction owns the cutover gate, and MUST perform its read then
 * rather than return cached data. A future explicitly approved activation
 * mechanism that already holds the session gate on a dedicated backend must
 * use the in-transaction form instead.
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
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"case_operations_enabled",
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

/**
 * Raise the receiver admission floor. Raising it never evicts an admitted
 * lease — cadence reauthorization deliberately does not re-read the floor —
 * so the cutoff applies to registrations only.
 */
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
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"case_operations_enabled",
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

/** Floors each switch needs before it may turn on, mirroring the DB CHECKs. */
const ACTIVATION_FLOORS: Readonly<
	Record<
		LookupReferenceActivationFlag | "run_holder_nonce_enforced",
		{ writer: number; receiver: number; reader: number }
	>
> = {
	carrier_commits_enabled: { writer: 1, receiver: 3, reader: 1 },
	case_operations_enabled: { writer: 0, receiver: 3, reader: 1 },
	destructive_schema_actions_enabled: { writer: 1, receiver: 0, reader: 0 },
	project_moves_enabled: { writer: 1, receiver: 1, reader: 0 },
	run_holder_nonce_enforced: { writer: 0, receiver: 0, reader: 1 },
};

export type ActivationSwitch =
	| LookupReferenceActivationFlag
	| "run_holder_nonce_enforced";

const ACTIVATION_COLUMNS = {
	carrier_commits_enabled: "carrier_commits_enabled",
	case_operations_enabled: "case_operations_enabled",
	destructive_schema_actions_enabled: "destructive_schema_actions_enabled",
	project_moves_enabled: "project_moves_enabled",
	run_holder_nonce_enforced: "run_holder_nonce_enforced",
} as const satisfies Record<ActivationSwitch, string>;

/**
 * Turn on the requested activation switches once this transaction has itself
 * re-proved every precondition. The database CHECKs already refuse a switch
 * below its floor; re-proving here turns that into a person-readable code, and
 * the drain proofs close the window between the controller's preflight and this
 * write — outside one transaction they are only a recent observation.
 *
 * The lease drain is proved here because raising the receiver floor
 * deliberately does NOT evict an admitted lease, so below-floor connections
 * legitimately outlive the raise and still hold pre-cutoff bundles. The runtime
 * holder census is NOT re-proved: the floor raise already drained it under the
 * same `FOR UPDATE` cutoff, and the stamp trigger then refuses every new
 * below-floor holder, so a blocker here is unrepresentable rather than merely
 * unlikely. The controller reports the census and the audit scans, which read
 * state this transaction does not lock.
 */
export async function enableLookupReferenceActivationInTransaction(
	tx: Transaction<AppDatabase>,
	switches: readonly ActivationSwitch[],
): Promise<LookupReferenceCompatibilityState> {
	if (switches.length === 0) {
		throw new RolloutCompatibilityError(
			"invalid_version",
			"Name at least one activation switch to enable.",
		);
	}
	await lockDeploymentCutoverGate(tx);
	const current = await readCompatibilityRow(tx, "update");

	const unmet = switches
		.map((name) => ({ name, floors: ACTIVATION_FLOORS[name] }))
		.filter(
			({ floors }) =>
				current.minimum_writer_version < floors.writer ||
				current.minimum_stream_receiver_version < floors.receiver ||
				current.minimum_runtime_reader_version < floors.reader,
		);
	if (unmet.length > 0) {
		throw new RolloutCompatibilityError(
			"activation_floor_unmet",
			"Raise the compatibility floors before enabling these switches.",
			{
				unmet,
				current: {
					writer: current.minimum_writer_version,
					receiver: current.minimum_stream_receiver_version,
					reader: current.minimum_runtime_reader_version,
				},
			},
		);
	}

	const observedAt = await databaseNow(tx);
	const staleLeases = await tx
		.selectFrom("lookup_stream_capability_leases")
		.select(["app_id", "connection_id", "receiver_version", "expires_at"])
		.where("receiver_version", "<", current.minimum_stream_receiver_version)
		.where("expires_at", ">", observedAt)
		.orderBy("expires_at", "asc")
		.limit(16)
		.execute();
	if (staleLeases.length > 0) {
		throw new RolloutCompatibilityError(
			"activation_receivers_not_drained",
			"Unexpired below-floor stream leases still hold pre-cutoff bundles.",
			{
				receiverFloor: current.minimum_stream_receiver_version,
				staleLeases: staleLeases.map((lease) => ({
					appId: lease.app_id,
					connectionId: lease.connection_id,
					receiverVersion: lease.receiver_version,
					expiresAt: lease.expires_at,
				})),
			},
		);
	}

	const updated = await tx
		.updateTable("lookup_reference_compatibility")
		.set({
			...Object.fromEntries(
				switches.map((name) => [ACTIVATION_COLUMNS[name], true]),
			),
			updated_at: sql<Date>`clock_timestamp()`,
		})
		.where("id", "=", 1)
		.returning([
			"minimum_writer_version",
			"minimum_stream_receiver_version",
			"minimum_runtime_reader_version",
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"case_operations_enabled",
			"updated_at",
		])
		.executeTakeFirstOrThrow();
	return compatibilityState(updated);
}

/**
 * Emergency rollback operation. There is deliberately no pool-backed enable
 * sibling: activation belongs to the controller's dedicated cutover session,
 * which drives the in-transaction form above under the session gate.
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
	} else if (flag === "case_operations_enabled") {
		update = update.set({ case_operations_enabled: false });
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
			"run_holder_nonce_enforced",
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
			"case_operations_enabled",
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
