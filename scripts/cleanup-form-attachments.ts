/**
 * Scheduled form-capture maintenance entrypoint.
 *
 * Each run first retires expired attempts, then leases bounded preparation
 * and discard batches. Preparing rows copy+verify immutable bytes before
 * acceptance; discarding rows delete exact source/final generations before
 * metadata removal. GCS lifecycle remains the independent backstop for
 * abandoned staging-prefix bytes. Each execution first audits the shared
 * database settings and hard login-role caps, then a session advisory lock held
 * for the whole run collapses Scheduler/build overlap to one active worker.
 */

import type { PoolClient } from "pg";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	assertStrictCaptureMaintenance,
	type CaptureCleanupMode,
	type CaptureMaintenanceSummary,
	readCaptureCleanupMode,
} from "@/lib/db/captureCleanupGate";
import {
	CAPTURE_CLEANUP_STRICT_ADMISSION_TIMEOUT_MS,
	CAPTURE_CLEANUP_STRICT_LOCK_TIMEOUT_MS,
	CAPTURE_CLEANUP_STRICT_RETRY_MS,
	connectCaptureCleanupAuditSession,
	withExclusiveCaptureCleanupWorker,
} from "@/lib/db/captureCleanupLease";
import { preparePendingFormAttachments } from "@/lib/db/formAttachmentPreparation";
import { purgeExpiredFormAttachments } from "@/lib/db/formAttachments";
import {
	deleteAsset,
	deleteAssetGeneration,
	probeCaptureStorageAuthority,
} from "@/lib/storage/media";
import {
	readDatabaseCapacityRoleConfig,
	runDatabaseCapacityPreflight,
} from "@/scripts/infra/databaseCapacityPreflight";

const BATCH_SIZE = 100;
const MAX_BATCHES = 10;
const TEARDOWN_TIMEOUT_MS = 10_000;

async function runMaintenance(mode: CaptureCleanupMode): Promise<void> {
	let expiredRows = 0;
	let transitionedExpiredRows = 0;
	let objectDeleteFailures = 0;
	for (let batch = 0; batch < MAX_BATCHES; batch++) {
		const purged = await purgeExpiredFormAttachments(BATCH_SIZE);
		expiredRows += purged.processed;
		transitionedExpiredRows += purged.transitioned;
		const deletes = await Promise.allSettled(
			purged.objects.map((object) =>
				object.objectGeneration === null
					? deleteAsset(object.objectKey)
					: deleteAssetGeneration(object.objectKey, object.objectGeneration),
			),
		);
		objectDeleteFailures += deletes.filter(
			(result) => result.status === "rejected",
		).length;
		if (purged.processed < BATCH_SIZE) break;
	}

	let prepared = 0;
	let discarded = 0;
	let preparationFailures = 0;
	let supersededPreparations = 0;
	for (let batch = 0; batch < MAX_BATCHES; batch++) {
		const result = await preparePendingFormAttachments({ limit: BATCH_SIZE });
		prepared += result.prepared;
		discarded += result.discarded;
		preparationFailures += result.failed;
		supersededPreparations += result.superseded;
		if (
			result.prepared + result.discarded + result.failed + result.superseded <
			BATCH_SIZE
		)
			break;
	}

	const summary: CaptureMaintenanceSummary = {
		prepared,
		discarded,
		preparationFailures,
		supersededPreparations,
		expiredRows,
		transitionedExpiredRows,
		objectDeleteFailures,
	};
	console.log(
		JSON.stringify({
			severity:
				preparationFailures > 0 || objectDeleteFailures > 0
					? "WARNING"
					: "INFO",
			message: "[attachments] scheduled maintenance complete",
			...summary,
		}),
	);
	if (mode === "strict") assertStrictCaptureMaintenance(summary);
}

async function main(): Promise<void> {
	const mode = readCaptureCleanupMode();
	const strictOptions =
		mode === "strict"
			? {
					admissionTimeoutMs: CAPTURE_CLEANUP_STRICT_ADMISSION_TIMEOUT_MS,
					lockTimeoutMs: CAPTURE_CLEANUP_STRICT_LOCK_TIMEOUT_MS,
					contentionRetryMs: CAPTURE_CLEANUP_STRICT_RETRY_MS,
				}
			: {};
	const pool = await getCaseStorePool();
	const capacityClient: PoolClient | null =
		await connectCaptureCleanupAuditSession(pool, strictOptions);
	if (capacityClient === null) {
		if (mode === "strict") {
			throw new Error(
				"Strict capture maintenance could not reserve a database capacity-audit session before its deadline.",
			);
		}
		console.log(
			JSON.stringify({
				severity: "INFO",
				message:
					"[attachments] scheduled maintenance skipped; database connection capacity is saturated before capacity audit",
			}),
		);
		return;
	}
	try {
		await runDatabaseCapacityPreflight(
			capacityClient,
			readDatabaseCapacityRoleConfig(),
		);
	} finally {
		capacityClient.release();
	}

	if (mode === "strict") {
		// This create/read/exact-generation-delete probe uses a capture-only key
		// beneath the staged lifecycle prefix. It proves the deploy identity's
		// complete GCS authority before the release can move traffic.
		await probeCaptureStorageAuthority();
	}

	const result = await withExclusiveCaptureCleanupWorker(
		() => runMaintenance(mode),
		strictOptions,
	);
	if (result.kind !== "ran") {
		if (mode === "strict") {
			throw new Error(
				result.kind === "already-running"
					? "Strict capture maintenance timed out waiting for an overlapping cleanup lease."
					: "Strict capture maintenance timed out waiting for database connection capacity.",
			);
		}
		console.log(
			JSON.stringify({
				severity: "INFO",
				message:
					result.kind === "already-running"
						? "[attachments] scheduled maintenance skipped; another execution owns the lease"
						: "[attachments] scheduled maintenance skipped; database connection capacity is saturated",
			}),
		);
	}
}

async function finish(code: number): Promise<never> {
	try {
		await Promise.race([
			closeCaseStoreDatabase(),
			new Promise((resolve) => setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
		]);
	} catch (err) {
		console.error("[attachments] maintenance teardown error (ignored):", err);
	}
	process.exit(code);
}

main().then(
	() => finish(0),
	(err: unknown) => {
		console.error("[attachments] scheduled maintenance failed:", err);
		return finish(1);
	},
);
