/**
 * Deployment prerequisite for the complete media-bucket policy.
 *
 * Cloud Build runs this as a blocking Cloud Run Job before migration/deploy,
 * so capture code never ships ahead of its staging lifecycle or signed-header
 * CORS allowlist.
 */

import {
	applyMediaBucketCors,
	applyMediaBucketLifecycle,
} from "@/lib/storage/media";

async function main(): Promise<void> {
	if (!process.env.NOVA_MEDIA_BUCKET) {
		throw new Error("NOVA_MEDIA_BUCKET is required.");
	}
	const origins = (process.env.NOVA_UPLOAD_CORS_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
	if (origins.length === 0) {
		throw new Error("NOVA_UPLOAD_CORS_ORIGINS is required.");
	}
	await applyMediaBucketLifecycle();
	await applyMediaBucketCors(origins);
	console.log(
		`[media-policy] lifecycle and CORS applied for ${origins.join(", ")}`,
	);
}

main().catch((err: unknown) => {
	console.error("[media-policy] failed:", err);
	process.exit(1);
});
