/**
 * Scheduled form-capture maintenance entrypoint.
 *
 * Each run first retires expired attempts, then leases bounded preparation
 * and discard batches. Preparing rows copy+verify immutable bytes before
 * acceptance; discarding rows delete exact source/final generations before
 * metadata removal. GCS lifecycle remains the independent backstop for
 * abandoned staging-prefix bytes. A session advisory lock held for the whole
 * run collapses at-least-once Scheduler delivery to one active worker.
 */

import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { withExclusiveCaptureCleanupWorker } from "@/lib/db/captureCleanupLease";
import { runCaptureCleanupSchemaProbe } from "@/lib/db/captureCleanupSchemaProbe";
import { preparePendingFormAttachments } from "@/lib/db/formAttachmentPreparation";
import { purgeExpiredFormAttachments } from "@/lib/db/formAttachments";
import { deleteAsset, deleteAssetGeneration } from "@/lib/storage/media";

const BATCH_SIZE = 100;
const MAX_BATCHES = 10;
const TEARDOWN_TIMEOUT_MS = 10_000;

async function runMaintenance(): Promise<void> {
	// Run under the worker's own identity, after acquiring the advisory lock
	// and prewarming its second connection. No separate deploy-time execution.
	await runCaptureCleanupSchemaProbe();
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

	const summary = {
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
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--probe-schema") {
		const result = await runCaptureCleanupSchemaProbe();
		console.log(
			JSON.stringify({
				severity: "INFO",
				message: "[attachments] cleanup schema probe passed",
				...result,
			}),
		);
		return;
	}
	if (args.length !== 0) {
		throw new Error(`Unknown capture-cleanup argument(s): ${args.join(", ")}`);
	}

	const result = await withExclusiveCaptureCleanupWorker(runMaintenance);
	if (result.kind !== "ran") {
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
