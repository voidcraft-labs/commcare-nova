/**
 * Google Cloud Storage client for media assets.
 *
 * Lazily-initialized singleton matching the Firestore singleton
 * pattern in `lib/db/firestore.ts` — Application Default
 * Credentials on Cloud Run, `gcloud auth application-default login`
 * for local dev. No emulator support today; local-dev media work
 * targets the real `nova-multimedia-dev` bucket.
 *
 * The bucket name comes from `NOVA_MEDIA_BUCKET` at first call.
 * Throwing here (rather than at module load) lets the build step
 * import this module without env vars present.
 */

import type { Readable } from "node:stream";
import { type Bucket, Storage } from "@google-cloud/storage";

let _storage: Storage | null = null;
let _bucket: Bucket | null = null;

/**
 * Returns the GCS Storage client singleton. First call resolves the
 * configured bucket; subsequent calls reuse it. Throws on missing
 * env vars at first use.
 */
function getStorage(): Storage {
	if (!_storage) {
		_storage = new Storage({
			projectId: process.env.GOOGLE_CLOUD_PROJECT,
		});
	}
	return _storage;
}

/**
 * Returns the configured multimedia bucket. The bucket must exist
 * with uniform bucket-level access and public-access prevention
 * enforced — the proxy GET route's ownership check is the only
 * thing standing between a user's bytes and the public internet,
 * so the bucket must never serve objects directly.
 */
function getBucket(): Bucket {
	if (!_bucket) {
		const name = process.env.NOVA_MEDIA_BUCKET;
		if (!name) {
			throw new Error(
				"NOVA_MEDIA_BUCKET is unset — multimedia upload and read routes need this env var to know which GCS bucket holds the bytes. Set it to e.g. `nova-multimedia-prod` (production) or `nova-multimedia-dev` (local).",
			);
		}
		_bucket = getStorage().bucket(name);
	}
	return _bucket;
}

/**
 * Generates a V4 signed PUT URL the browser uses to push bytes
 * directly to GCS. The URL is bound to:
 *
 *  - the destination object key (path the bytes land at — derived
 *    from `users/<owner>/<contentHash>.<ext>`, so a different
 *    owner's namespace is structurally unreachable),
 *  - the request `Content-Type` header (the upload must declare
 *    the same MIME the route's pre-screen accepted).
 *
 * A 5-minute TTL keeps a leaked URL short-lived. The path
 * commitment is the authoritative tamper protection: the confirm
 * step downloads the bytes from `gcsObjectKey`, re-computes the
 * sha256, and rejects if the actual hash doesn't match the path's
 * claimed hash. There's no server-side body-hash binding here —
 * we'd need a separate canonical-request mechanism, and the
 * confirm-time re-validation already covers it.
 */
export async function createSignedUploadUrl(args: {
	gcsObjectKey: string;
	contentType: string;
}): Promise<{ url: string; expiresAtMs: number }> {
	const ttlMs = 5 * 60 * 1000;
	const expiresAtMs = Date.now() + ttlMs;
	const [url] = await getBucket().file(args.gcsObjectKey).getSignedUrl({
		version: "v4",
		action: "write",
		expires: expiresAtMs,
		contentType: args.contentType,
	});
	return { url, expiresAtMs };
}

/**
 * Stream bytes from GCS for the proxy GET route. The caller is
 * responsible for piping into the HTTP response and for closing
 * the stream on early-disconnect.
 *
 * Returns a Node `Readable` stream rather than a Web
 * `ReadableStream` because Cloud Run's Next.js runtime can pipe
 * Node streams directly into the response via
 * `Response.body = Readable.toWeb(stream)`. Converting both ways
 * needlessly doubles the buffer copy.
 */
export function streamAsset(gcsObjectKey: string): Readable {
	return getBucket().file(gcsObjectKey).createReadStream();
}

/**
 * Read the stored object's size in bytes from GCS metadata,
 * without downloading the body. The confirm step calls this BEFORE
 * `downloadAssetBytes` so an oversized object (a client that
 * initiated with a small claimed size, then PUT a huge body to the
 * signed URL) is rejected before we ever pull it into memory —
 * otherwise a single request could OOM the instance. Returns
 * `null` if the object doesn't exist.
 */
export async function getStoredObjectSize(
	gcsObjectKey: string,
): Promise<number | null> {
	const file = getBucket().file(gcsObjectKey);
	const [exists] = await file.exists();
	if (!exists) return null;
	const [metadata] = await file.getMetadata();
	// GCS reports `size` as a string of bytes.
	return metadata.size === undefined ? null : Number(metadata.size);
}

/**
 * Drain the GCS object into memory once for confirm-time
 * validation. The caller MUST size-gate via `getStoredObjectSize`
 * first — this materializes the whole body, so an unbounded object
 * would OOM the instance. Runs only at confirm time (one shot per
 * upload), never on the read path.
 *
 * Memory ceiling: the per-request footprint is bounded by the
 * largest per-kind size cap (video, 50 MB). The deployed instance
 * memory must cover `50 MB × expected concurrent confirms` with
 * headroom — a single confirm is fine on any reasonable instance,
 * but a burst of concurrent video confirms scales linearly. If
 * concurrency ever makes that ceiling tight, switch the video path
 * to stream-to-tmp-file validation (ffprobe already reads a path)
 * so video bytes never fully reside in memory.
 */
export async function downloadAssetBytes(
	gcsObjectKey: string,
): Promise<Buffer> {
	const [buf] = await getBucket().file(gcsObjectKey).download();
	return buf;
}

/**
 * Delete a GCS object. Used at upload-rejection time (validation
 * fails, the object exists at the path it was PUT to). Non-existent
 * objects are silently ignored — concurrent confirm/abort flows can
 * race, and we don't want a 404 to surface as a 500.
 */
export async function deleteAsset(gcsObjectKey: string): Promise<void> {
	await getBucket().file(gcsObjectKey).delete({ ignoreNotFound: true });
}
