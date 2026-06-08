/**
 * Apply the media bucket's pending-object lifecycle rule.
 *
 * Browser uploads PUT their bytes to `pending/<owner>/...` and then call
 * confirm, which promotes the validated bytes out of `pending/`. A client
 * that PUTs and never calls confirm (tab closed, crash) leaves the object
 * sitting in `pending/`. This idempotent operation installs the GCS lifecycle
 * rule that reaps any `pending/` object older than a day — the backstop for
 * those abandoned uploads, with no server-side cron. The rule itself lives in
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
 * Idempotent — re-running sets the same single rule. Targets real GCS
 * only: it refuses to run with `NOVA_MEDIA_EMULATOR_HOST` set, since the
 * local fake-gcs-server has no lifecycle support.
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
	if (process.env.NOVA_MEDIA_EMULATOR_HOST) {
		console.error(
			"NOVA_MEDIA_EMULATOR_HOST is set — this applies a real GCS lifecycle rule and must not target the emulator. Unset it and retry.",
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
