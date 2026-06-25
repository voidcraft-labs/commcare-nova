/**
 * Apply the media bucket's CORS policy for browser direct uploads.
 *
 * Browser uploads are a cross-origin V4 signed PUT, and the PUT now carries a
 * signed `x-goog-content-length-range` header that binds a maximum body length
 * (`lib/storage/media.ts::createSignedUploadUrl`) so GCS rejects an oversized
 * write at the storage boundary. A PUT always triggers a CORS preflight, and a
 * SIGNED request header the preflight doesn't allow is stripped — so the bucket
 * CORS MUST allow `x-goog-content-length-range` (alongside `Content-Type`) or
 * every upload 403s. THIS SCRIPT MUST RUN BEFORE the size-bound upload code
 * ships, or uploads break.
 *
 * `setCorsConfiguration` REPLACES the bucket's CORS, so pass the COMPLETE set
 * of app origins the browser uploads from. The media bucket is dedicated, so
 * it owns no other CORS rule to preserve. The rule itself lives in
 * `lib/storage/media.ts::applyMediaBucketCors` so the allowed methods/headers
 * stay coupled to the upload code.
 *
 * Run against the real bucket, with ADC configured for an identity allowed to
 * set bucket metadata (`storage.buckets.update`):
 *
 *   NOVA_MEDIA_BUCKET=nova-multimedia-prod \
 *   GOOGLE_CLOUD_PROJECT=<project> \
 *   NOVA_UPLOAD_CORS_ORIGINS="https://app.example.org,https://example.org" \
 *   npx tsx scripts/infra/apply-media-bucket-cors.ts
 *
 * Idempotent — re-running sets the same single rule.
 */

import { applyMediaBucketCors } from "@/lib/storage/media";

async function main(): Promise<void> {
	const bucket = process.env.NOVA_MEDIA_BUCKET;
	if (!bucket) {
		console.error(
			"NOVA_MEDIA_BUCKET is unset — set it to the target bucket (e.g. nova-multimedia-prod) before running.",
		);
		process.exit(1);
	}

	const origins = (process.env.NOVA_UPLOAD_CORS_ORIGINS ?? "")
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);
	if (origins.length === 0) {
		console.error(
			"NOVA_UPLOAD_CORS_ORIGINS is empty — set it to the comma-separated app origins the browser uploads from (e.g. https://app.example.org). This REPLACES the bucket CORS, so list every origin.",
		);
		process.exit(1);
	}

	console.log(
		`Applying upload CORS to gs://${bucket} for origins: ${origins.join(", ")} …`,
	);
	await applyMediaBucketCors(origins);
	console.log(
		"Done — the bucket now allows cross-origin PUT with Content-Type + x-goog-content-length-range.",
	);
}

main().catch((err: unknown) => {
	console.error("Failed to apply the CORS policy:", err);
	process.exit(1);
});
