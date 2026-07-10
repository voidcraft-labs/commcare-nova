/**
 * Apply the media bucket's pending-object lifecycle rule.
 *
 * Browser uploads PUT to `pending/<project>/...` via a V4 signed URL. That URL
 * now binds a maximum body length (the `x-goog-content-length-range` header —
 * see `createSignedUploadUrl`), so GCS rejects an OVERSIZED write at the
 * boundary; what still accumulates is a WITHIN-cap object whose client never
 * calls confirm (confirm promotes validated bytes out of `pending/`). This
 * idempotent operation installs the GCS lifecycle rule that reaps any
 * `pending/` object older than a day — the backstop for those abandoned
 * attempts. The rule itself lives in
 * `lib/storage/media.ts::applyPendingObjectLifecycle` so the prefix + TTL
 * stay coupled to the upload code.
 *
 * Run against the real bucket, with ADC configured for an identity allowed
 * to set bucket metadata (`storage.buckets.update`):
 *
 *   NOVA_MEDIA_BUCKET=nova-multimedia-prod \
 *   GOOGLE_CLOUD_PROJECT=<project> \
 *   npx tsx scripts/infra/apply-media-bucket-lifecycle.ts
 *
 * Idempotent — re-running sets the same single rule.
 */

import { applyPendingObjectLifecycle } from "@/lib/storage/media";

async function main(): Promise<void> {
	const bucket = process.env.NOVA_MEDIA_BUCKET;
	if (!bucket) {
		console.error(
			"NOVA_MEDIA_BUCKET is unset — set it to the target bucket (e.g. nova-multimedia-prod) before running.",
		);
		process.exit(1);
	}

	console.log(`Applying pending-object lifecycle rule to gs://${bucket} …`);
	await applyPendingObjectLifecycle();
	console.log(
		"Done — GCS will now auto-delete objects under `pending/` older than 1 day.",
	);
}

main().catch((err: unknown) => {
	console.error("Failed to apply the lifecycle rule:", err);
	process.exit(1);
});
