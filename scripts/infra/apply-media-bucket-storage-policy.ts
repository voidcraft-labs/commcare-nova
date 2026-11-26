/**
 * Apply the media bucket's complete temporary-object storage policy.
 *
 * Browser uploads PUT to `pending/<project>/...` via a V4 signed URL. That URL
 * binds the allowed body length (exact for captures and capped for authoring
 * media) plus a create-only precondition, so GCS rejects an invalid or reused
 * attempt at the boundary. This idempotent operation installs the GCS
 * lifecycle rules that reap abandoned media attempts under `pending/` after
 * one day, private export parts after one day and staged capture sources after seven days.
 * The same metageneration-fenced policy disables soft delete, versioning, and
 * default event holds, and refuses to overwrite a bucket retention policy, so
 * the asynchronous rules can retire eligible objects even if the service is idle.
 *
 * Run against the real bucket, with ADC configured for an identity allowed
 * to set bucket metadata (`storage.buckets.update`):
 *
 *   NOVA_MEDIA_BUCKET=nova-multimedia-prod \
 *   GOOGLE_CLOUD_PROJECT=<project> \
 *   npx tsx scripts/infra/apply-media-bucket-storage-policy.ts
 *
 * Idempotent — re-running replaces the bucket policy with the same complete
 * rule set.
 */

import { applyMediaBucketStoragePolicy } from "@/lib/storage/media";

async function main(): Promise<void> {
	const bucket = process.env.NOVA_MEDIA_BUCKET;
	if (!bucket) {
		console.error(
			"NOVA_MEDIA_BUCKET is unset — set it to the target bucket (e.g. nova-multimedia-prod) before running.",
		);
		process.exit(1);
	}

	console.log(`Applying temporary-object storage policy to gs://${bucket} …`);
	await applyMediaBucketStoragePolicy();
	console.log(
		"Verified the bucket’s temporary upload, capture and export cleanup rules.",
	);
}

main().catch((err: unknown) => {
	console.error("Failed to apply the media bucket storage policy:", err);
	process.exit(1);
});
