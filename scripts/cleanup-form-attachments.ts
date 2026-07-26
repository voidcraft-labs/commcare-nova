/**
 * Scheduled form-capture maintenance entrypoint.
 *
 * Each run leases bounded promotion batches, retries the immutable staged
 * generation → durable-key copy, then removes expired pending/staged metadata
 * and its exact known generation. GCS lifecycle remains the independent
 * retention backstop for objects written after a row expired.
 */

import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { promotePendingFormAttachments } from "@/lib/db/formAttachmentPromotion";
import { purgeExpiredFormAttachments } from "@/lib/db/formAttachments";
import { deleteAsset, deleteAssetGeneration } from "@/lib/storage/media";

const BATCH_SIZE = 100;
const MAX_BATCHES = 10;
const TEARDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
	let promoted = 0;
	let promotionFailures = 0;
	for (let batch = 0; batch < MAX_BATCHES; batch++) {
		const result = await promotePendingFormAttachments({ limit: BATCH_SIZE });
		promoted += result.promoted;
		promotionFailures += result.failed;
		if (result.promoted + result.failed < BATCH_SIZE) break;
	}

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

	console.log(
		JSON.stringify({
			severity:
				promotionFailures > 0 || objectDeleteFailures > 0 ? "WARNING" : "INFO",
			message: "[attachments] scheduled maintenance complete",
			promoted,
			promotionFailures,
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
