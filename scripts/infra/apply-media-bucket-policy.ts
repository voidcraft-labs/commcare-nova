/**
 * Explicit maintenance entrypoint for the complete media-bucket policy.
 *
 * Ordinary deployment only reads the policy. Operators can apply it through
 * this maintenance image entrypoint or manage-deployment.py media --apply.
 */

import {
	applyMediaBucketCors,
	applyMediaBucketStoragePolicy,
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
	await applyMediaBucketStoragePolicy();
	await applyMediaBucketCors(origins);
	console.log(
		`[media-policy] hard temporary-object retention and CORS applied for ${origins.join(", ")}`,
	);
}

main().catch((err: unknown) => {
	console.error("[media-policy] failed:", err);
	process.exit(1);
});
