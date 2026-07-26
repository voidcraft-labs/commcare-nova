/**
 * Apply the media bucket's complete temporary-object lifecycle policy.
 *
 * Browser uploads PUT to `pending/<project>/...` via a V4 signed URL. That URL
 * binds the allowed body length (exact for captures and capped for authoring
 * media) plus a create-only precondition, so GCS rejects an invalid or reused
 * attempt at the boundary. This idempotent operation installs both GCS
 * lifecycle rules: abandoned media attempts under `pending/` after one day
 * and staged capture sources after their seven-day preparation window. The
 * complete rule set lives in
 * `lib/storage/media.ts::applyMediaBucketLifecycle` so the prefix + TTL
 * stay coupled to the upload code.
 *
 * Run against the real bucket, with ADC configured for an identity allowed
 * to set bucket metadata (`storage.buckets.update`):
 *
 *   NOVA_MEDIA_BUCKET=nova-multimedia-prod \
 *   GOOGLE_CLOUD_PROJECT=<project> \
 *   npx tsx scripts/infra/apply-media-bucket-lifecycle.ts
 *
 * Idempotent — re-running replaces the bucket policy with the same complete
 * rule set.
 */

import { applyMediaBucketLifecycle } from "@/lib/storage/media";

async function main(): Promise<void> {
	const bucket = process.env.NOVA_MEDIA_BUCKET;
	if (!bucket) {
		console.error(
			"NOVA_MEDIA_BUCKET is unset — set it to the target bucket (e.g. nova-multimedia-prod) before running.",
		);
		process.exit(1);
	}

	console.log(`Applying temporary-object lifecycle policy to gs://${bucket} …`);
	await applyMediaBucketLifecycle();
	console.log(
		"Done — GCS will now reap abandoned media attempts and staged captures on their configured windows.",
	);
}

main().catch((err: unknown) => {
	console.error("Failed to apply the lifecycle rule:", err);
	process.exit(1);
});
