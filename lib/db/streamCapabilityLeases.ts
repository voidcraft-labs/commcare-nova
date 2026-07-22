import "server-only";

import { sql, type Transaction } from "kysely";
import {
	resolveAppScopeInTransaction,
	type TransactionalAppScope,
} from "@/lib/db/appAccess";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { readStreamReceiverCompatibilityForShare } from "@/lib/db/rolloutCompatibility";
import { log } from "@/lib/logger";
import { STREAM_LEASE_TTL_SECONDS } from "@/lib/runtimeCapabilities";

/** Maximum expired rows one opportunistic sweep can lock/delete. */
export const STREAM_CAPABILITY_PURGE_BATCH_SIZE = 256;

export interface RegisteredStreamCapabilityLease {
	readonly kind: "registered";
	readonly connectionId: string;
	readonly receiverVersion: number;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly scope: TransactionalAppScope;
}

export interface StreamReceiverBelowFloor {
	readonly kind: "receiver-below-floor";
	readonly receiverVersion: number;
	readonly minimumStreamReceiverVersion: number;
}

export type StreamCapabilityRegistration =
	| RegisteredStreamCapabilityLease
	| StreamReceiverBelowFloor;

export interface RegisterStreamCapabilityLeaseArgs {
	readonly appId: string;
	readonly userId: string;
	readonly receiverVersion: number;
}

/**
 * Register one authorized stream while every admission input remains in the
 * same transaction lock set.
 *
 * Lock order is deliberate: `resolveAppScopeInTransaction` takes the app row
 * FOR SHARE, then the Project-membership serialization gate and membership row;
 * the compatibility read follows FOR SHARE. Only then can the floor verdict or
 * lease insert occur. Authorization therefore wins over any capability verdict.
 */
export async function registerStreamCapabilityLeaseInTransaction(
	tx: Transaction<AppDatabase>,
	args: RegisterStreamCapabilityLeaseArgs,
): Promise<StreamCapabilityRegistration> {
	const scope = await resolveAppScopeInTransaction(
		tx,
		args.appId,
		args.userId,
		"view",
	);
	const compatibility = await readStreamReceiverCompatibilityForShare(tx);
	if (args.receiverVersion < compatibility.minimumStreamReceiverVersion) {
		return {
			kind: "receiver-below-floor",
			receiverVersion: args.receiverVersion,
			minimumStreamReceiverVersion: compatibility.minimumStreamReceiverVersion,
		};
	}

	const inserted = await tx
		.insertInto("lookup_stream_capability_leases")
		.values({
			app_id: args.appId,
			receiver_version: args.receiverVersion,
			/* `now()` is the transaction-start clock and could predate a long lock
			 * wait. Both values instead share the INSERT statement clock, after every
			 * admission lock has been acquired. */
			created_at: sql<Date>`pg_catalog.statement_timestamp()`,
			expires_at: sql<Date>`
				pg_catalog.statement_timestamp()
				+ (${STREAM_LEASE_TTL_SECONDS} * interval '1 second')
			`,
		})
		.returning([
			"connection_id",
			"receiver_version",
			"created_at",
			"expires_at",
		])
		.executeTakeFirstOrThrow();

	return {
		kind: "registered",
		connectionId: inserted.connection_id,
		receiverVersion: inserted.receiver_version,
		createdAt: inserted.created_at,
		expiresAt: inserted.expires_at,
		scope,
	};
}

/** Pool-backed stream registration; registration commits before any SSE frame. */
export async function registerStreamCapabilityLease(
	args: RegisterStreamCapabilityLeaseArgs,
): Promise<StreamCapabilityRegistration> {
	const registration = await withAppTx((tx) =>
		registerStreamCapabilityLeaseInTransaction(tx, args),
	);
	/* Purge only after the admission transaction released its app, membership,
	 * and compatibility locks. Cleanup is bounded and best-effort: an expired
	 * row can delay a rollout census but must never turn an admitted stream into
	 * a failed request. */
	try {
		await purgeExpiredStreamCapabilityLeases();
	} catch (error) {
		log.warn("[streamCapabilityLeases] expired lease purge failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return registration;
}

/**
 * Delete one bounded batch of expired stream leases.
 *
 * The candidate subquery's `expires_at <= statement_timestamp()` predicate plus
 * `ORDER BY expires_at LIMIT ...` is served by
 * `lookup_stream_capability_leases_expiry_idx`. `SKIP LOCKED` lets concurrent
 * registrations/teardowns make progress without serializing their cleanup.
 */
export async function purgeExpiredStreamCapabilityLeases(): Promise<number> {
	const db = await getAppDb();
	const deleted = await sql<{ app_id: string; connection_id: string }>`
		WITH expired AS (
			SELECT app_id, connection_id
			FROM lookup_stream_capability_leases
			WHERE expires_at <= pg_catalog.statement_timestamp()
			ORDER BY expires_at
			LIMIT ${STREAM_CAPABILITY_PURGE_BATCH_SIZE}
			FOR UPDATE SKIP LOCKED
		)
		DELETE FROM lookup_stream_capability_leases AS lease
		USING expired
		WHERE lease.app_id = expired.app_id
			AND lease.connection_id = expired.connection_id
		RETURNING lease.app_id, lease.connection_id
	`.execute(db);
	return deleted.rows.length;
}

/** Fresh serialized Project/role/capability snapshot for cadence or migration. */
export async function reauthorizeStreamScope(
	appId: string,
	userId: string,
): Promise<TransactionalAppScope> {
	return withAppTx((tx) =>
		resolveAppScopeInTransaction(tx, appId, userId, "view"),
	);
}

/** Delete exactly one app-scoped, database-minted connection lease. */
export async function deleteStreamCapabilityLease(
	appId: string,
	connectionId: string,
): Promise<boolean> {
	const db = await getAppDb();
	const deleted = await db
		.deleteFrom("lookup_stream_capability_leases")
		.where("app_id", "=", appId)
		.where("connection_id", "=", connectionId)
		.executeTakeFirst();
	return deleted.numDeletedRows > 0n;
}
