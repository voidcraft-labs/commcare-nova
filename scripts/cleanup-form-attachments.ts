/**
 * Scheduled form-capture maintenance entrypoint.
 *
 * Each run first retires expired attempts, then leases bounded preparation
 * and discard batches. Preparing rows copy+verify immutable bytes before
 * acceptance; discarding rows delete exact source/final generations before
 * metadata removal. GCS lifecycle remains the independent backstop for
 * abandoned staging-prefix bytes.
 */

import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { preparePendingFormAttachments } from "@/lib/db/formAttachmentPreparation";
import { purgeExpiredFormAttachments } from "@/lib/db/formAttachments";
import { deleteAsset, deleteAssetGeneration } from "@/lib/storage/media";

const BATCH_SIZE = 100;
const MAX_BATCHES = 10;
const TEARDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
	let expiredRows = 0;
	let objectDeleteFailures = 0;
	for (let batch = 0; batch < MAX_BATCHES; batch++) {
		const objects = await purgeExpiredFormAttachments(BATCH_SIZE);
		expiredRows += objects.length;
		const deletes = await Promise.allSettled(
			objects.map((object) =>
				object.objectGeneration === null
					? deleteAsset(object.objectKey)
					: deleteAssetGeneration(object.objectKey, object.objectGeneration),
			),
		);
		objectDeleteFailures += deletes.filter(
			(result) => result.status === "rejected",
		).length;
		if (objects.length < BATCH_SIZE) break;
	}

	let prepared = 0;
	let discarded = 0;
	let preparationFailures = 0;
	for (let batch = 0; batch < MAX_BATCHES; batch++) {
		const result = await preparePendingFormAttachments({ limit: BATCH_SIZE });
		prepared += result.prepared;
		discarded += result.discarded;
		preparationFailures += result.failed;
		if (result.prepared + result.discarded + result.failed < BATCH_SIZE) break;
	}

	console.log(
		JSON.stringify({
			severity:
				preparationFailures > 0 || objectDeleteFailures > 0
					? "WARNING"
					: "INFO",
			message: "[attachments] scheduled maintenance complete",
			prepared,
			discarded,
			preparationFailures,
			expiredRows,
			objectDeleteFailures,
		}),
	);
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
