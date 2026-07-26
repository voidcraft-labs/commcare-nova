/**
 * Apply the media bucket's complete temporary-object storage policy.
 *
 * Browser uploads PUT to `pending/<project>/...` via a V4 signed URL. That URL
 * binds the allowed body length (exact for captures and capped for authoring
 * media) plus a create-only precondition, so GCS rejects an invalid or reused
 * attempt at the boundary. This idempotent operation installs both GCS
 * lifecycle rules that reap abandoned media attempts under `pending/` after
 * one day and staged capture sources after their seven-day preparation window.
 * The same metageneration-fenced policy disables soft delete, versioning, and
 * default event holds, and refuses to overwrite a bucket retention policy, so
 * those windows are hard byte-retention backstops rather than hints.
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
		"Done — GCS will hard-delete abandoned media attempts and staged captures on their configured windows.",
	);
}

main().catch((err: unknown) => {
	console.error("Failed to apply the media bucket storage policy:", err);
	process.exit(1);
});
