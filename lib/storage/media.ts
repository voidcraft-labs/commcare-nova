/**
 * Google Cloud Storage client for media assets.
 *
 * Lazily-initialized singleton matching the Firestore singleton
 * pattern in `lib/case-store/postgres/connection.ts`. Credentials are Application
 * Default Credentials everywhere: the attached service account on
 * Cloud Run, the developer's `gcloud auth application-default`
 * identity locally. Local dev points at the dev project's real
 * bucket (`GOOGLE_CLOUD_PROJECT` + `NOVA_MEDIA_BUCKET` in `.env`) so
 * dev exercises the same client against the same wire behavior as
 * prod — Firestore rows and stored bytes live in the same project
 * and can never disagree about what exists.
 *
 * The bucket name comes from `NOVA_MEDIA_BUCKET` at first call.
 * Throwing here (rather than at module load) lets the build step
 * import this module without env vars present.
 */

import type { Readable } from "node:stream";
import { type Bucket, Storage } from "@google-cloud/storage";
import { PENDING_OBJECT_PREFIX } from "@/lib/domain/multimedia";

let _storage: Storage | null = null;
let _bucket: Bucket | null = null;

/**
 * Returns the GCS Storage client singleton. First call resolves the
 * configured bucket; subsequent calls reuse it. Throws on missing
 * env vars at first use.
 */
function getStorage(): Storage {
	if (!_storage) {
		// `projectId` is read from the env when set (local dev names the dev
		// project explicitly); on Cloud Run it is omitted and the client
		// resolves it from the metadata server.
		_storage = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
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
				"NOVA_MEDIA_BUCKET is unset — multimedia upload and read routes need this env var to know which GCS bucket holds the bytes. Set it to e.g. `nova-multimedia-prod` (production) or `commcare-nova-dev-multimedia` (local dev).",
			);
		}
		_bucket = getStorage().bucket(name);
	}
	return _bucket;
}

/**
 * Days a pending upload object lives before the bucket lifecycle rule
 * reaps it. GCS lifecycle `age` is day-granular (its minimum), so 1 day is
 * the tightest reap. Short by design: a confirm completes seconds after
 * the PUT, so anything still in `pending/` a day later is abandoned.
 */
const PENDING_OBJECT_TTL_DAYS = 1;

/**
 * Apply the bucket lifecycle rule that auto-deletes abandoned upload
 * objects under the `pending/` prefix.
 *
 * Browser uploads PUT to a per-attempt `pending/<project>/...` key via a V4
 * signed URL. The signed URL now binds a MAXIMUM body length (the
 * `x-goog-content-length-range` extension header — see
 * `createSignedUploadUrl`), so GCS rejects an oversized write at the storage
 * boundary; what still accumulates is the WITHIN-cap object whose client
 * never calls confirm (confirm promotes validated bytes out of `pending/`).
 * This rule is the backstop for those abandoned attempts: GCS itself deletes
 * any `pending/` object older than `PENDING_OBJECT_TTL_DAYS` with no
 * server-side cron. Ready objects are never touched — confirm promotes
 * validated bytes OUT of `pending/` to the content-hash key before flipping
 * the row to ready.
 *
 * Idempotent: `append: false` replaces the bucket's lifecycle with this
 * single rule. The media bucket is dedicated, so it owns no other rules to
 * preserve, and re-running yields the same state. Operational, not on the
 * request path — run once per bucket (and after any prefix change) via
 * `scripts/infra/apply-media-bucket-lifecycle.ts`.
 */
export async function applyPendingObjectLifecycle(): Promise<void> {
	await getBucket().addLifecycleRule(
		{
			action: { type: "Delete" },
			condition: {
				age: PENDING_OBJECT_TTL_DAYS,
				matchesPrefix: [PENDING_OBJECT_PREFIX],
			},
		},
		{ append: false },
	);
}

/**
 * Generates a V4 signed PUT URL the browser uses to push bytes
 * directly to GCS. The URL is bound to:
 *
 *  - the destination object key (path the bytes land at — browser
 *    uploads use `pending/<projectId>/<assetId>.<ext>`; the Project segment
 *    keeps a different tenant's namespace structurally unreachable),
 *  - the request `Content-Type` header (the upload must declare
 *    the same MIME the route's pre-screen accepted),
 *  - a MAXIMUM body length, via the signed `x-goog-content-length-range`
 *    extension header (`0,<maxBytes>`). Because the header is part of the V4
 *    signature, the client MUST send it verbatim (returned in
 *    `requiredHeaders`) and GCS REJECTS a body outside the range at the
 *    storage boundary — so a client can't push an over-cap object into
 *    `pending/` by lying about its size at initiate (CWE-770). The bucket
 *    CORS must allow this request header or the browser preflight strips it
 *    and the PUT 403s — see {@link applyMediaBucketCors} (a deploy
 *    prerequisite).
 *
 * A 5-minute TTL keeps a leaked URL short-lived. Confirm-time validation
 * still re-downloads + re-hashes the bytes as the authoritative content
 * check; the byte-range binding is what stops an oversized object from ever
 * existing, even unconfirmed.
 */
export async function createSignedUploadUrl(args: {
	gcsObjectKey: string;
	contentType: string;
	maxBytes: number;
}): Promise<{
	url: string;
	expiresAtMs: number;
	requiredHeaders: Record<string, string>;
}> {
	const ttlMs = 5 * 60 * 1000;
	const expiresAtMs = Date.now() + ttlMs;

	// The byte range the write must fall within — the GCS XML-API
	// `x-goog-content-length-range: <min>,<max>` form.
	const contentLengthRange = `0,${args.maxBytes}`;

	// Local dev: developer ADC is a user credential with no private key, so
	// it cannot mint a V4 signature (prod's runtime service account signs
	// via the IAM credentials API). The browser instead PUTs to a
	// same-origin dev-only route that writes the bytes through this
	// module's storage client. That proxy enforces the same cap server-side
	// via the `max` query param (it writes the bytes itself, so there's no
	// signed GCS write to bind the range onto). The rest of the upload flow
	// (initiate → PUT → confirm → validate → promote) stays byte-identical
	// to prod — only the signed-PUT hop is swapped. The route 404s outside
	// development.
	if (process.env.NODE_ENV === "development") {
		const url = `/api/media/upload/dev-put?key=${encodeURIComponent(
			args.gcsObjectKey,
		)}&max=${args.maxBytes}`;
		return { url, expiresAtMs, requiredHeaders: {} };
	}

	const [url] = await getBucket()
		.file(args.gcsObjectKey)
		.getSignedUrl({
			version: "v4",
			action: "write",
			expires: expiresAtMs,
			contentType: args.contentType,
			extensionHeaders: { "x-goog-content-length-range": contentLengthRange },
		});
	return {
		url,
		expiresAtMs,
		requiredHeaders: { "x-goog-content-length-range": contentLengthRange },
	};
}

/**
 * Apply the media bucket's CORS policy for browser direct uploads.
 *
 * A browser upload is a cross-origin V4 signed PUT, so the bucket must allow
 * the PUT method and EVERY request header the upload sends: `Content-Type`
 * AND `x-goog-content-length-range` (the signed max-length binding from
 * {@link createSignedUploadUrl}). A PUT is never a CORS-"simple" request, so
 * the browser always preflights — and if `x-goog-content-length-range` isn't
 * in this allowlist the preflight drops it, the client can't send the signed
 * header, and the PUT 403s. This MUST be applied (with the size-bound upload's
 * header added to the pre-existing CORS) BEFORE that code ships, or uploads
 * break.
 *
 * `setCorsConfiguration` REPLACES the bucket's CORS, so `origins` must be the
 * COMPLETE set of app origins the browser uploads from. The media bucket is
 * dedicated, so it owns no other CORS rule to preserve. Operational, not on
 * the request path — run via `scripts/infra/apply-media-bucket-cors.ts`.
 */
export async function applyMediaBucketCors(origins: string[]): Promise<void> {
	await getBucket().setCorsConfiguration([
		{
			origin: origins,
			method: ["PUT", "OPTIONS"],
			responseHeader: ["Content-Type", "x-goog-content-length-range"],
			maxAgeSeconds: 3600,
		},
	]);
}

/**
 * Upload a byte buffer directly to GCS from the server. The browser
 * flow never needs this — it PUTs to a signed URL — but the MCP
 * `upload_media_asset` tool decodes base64 bytes inline (Claude Code
 * et al can't run the hash → signed-PUT → confirm dance), so the
 * server holds the bytes and writes them itself.
 *
 * `resumable: false` forces a single multipart write rather than GCS's
 * resumable-session protocol: the payloads here are small (bounded by
 * the per-kind size caps), and a one-shot write avoids the extra
 * session-handshake round trip a resumable upload pays for. The
 * `contentType` is set on the object so the proxy GET route serves the
 * right `Content-Type` later.
 */
export async function uploadAssetBytes(args: {
	gcsObjectKey: string;
	bytes: Buffer;
	contentType: string;
}): Promise<void> {
	await getBucket().file(args.gcsObjectKey).save(args.bytes, {
		resumable: false,
		contentType: args.contentType,
	});
}

/**
 * Copy a validated pending object to its final storage key.
 *
 * Browser signed-PUT uploads land at a per-attempt pending key so stale
 * signed URLs cannot overwrite a ready content-hash object. Confirm-time
 * validation calls this after the bytes have passed the hash/MIME/parser
 * checks, promoting the object to the deduped final key that ready rows
 * serve.
 */
export async function copyAssetObject(
	sourceGcsObjectKey: string,
	destinationGcsObjectKey: string,
): Promise<void> {
	await getBucket()
		.file(sourceGcsObjectKey)
		.copy(getBucket().file(destinationGcsObjectKey));
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
 * without downloading the body. Returns `null` if the object
 * doesn't exist.
 *
 * Callers use it for two jobs. Size-gating before a download: the
 * confirm step (and `readTextObject`) checks BEFORE
 * `downloadAssetBytes` so an oversized object (a client that
 * initiated with a small claimed size, then PUT a huge body to the
 * signed URL) is rejected before we ever pull it into memory —
 * otherwise a single request could OOM the instance. And the
 * pre-stream check on the serve route: a ready row whose object is
 * gone becomes a clean 404 instead of a truncated 200, and
 * Content-Length matches the bytes actually stored.
 *
 * One metadata request, with the not-found mapped from the error,
 * rather than `exists()` followed by `getMetadata()` — `exists()`
 * is itself a metadata fetch, and the serve route sits on the hot
 * path of every inline media load.
 */
export async function getStoredObjectSize(
	gcsObjectKey: string,
): Promise<number | null> {
	const file = getBucket().file(gcsObjectKey);
	try {
		const [metadata] = await file.getMetadata();
		// GCS reports `size` as a string of bytes.
		return metadata.size === undefined ? null : Number(metadata.size);
	} catch (err) {
		if ((err as { code?: number } | null)?.code === 404) return null;
		throw err;
	}
}

/**
 * Drain a GCS object into memory, enforcing a byte ceiling AS IT READS.
 * The cap lives in this streamed read (a running counter that destroys
 * the stream past `maxBytes`), NOT in a separate `getStoredObjectSize`
 * metadata check beforehand: a signed PUT URL is a reusable write
 * credential for its whole TTL, so a client can overwrite the pending
 * object with a huge body in the window between a metadata size-check and
 * the download. Capping the read itself closes that TOCTOU — at most
 * `maxBytes` ever resides in memory, whatever the object grew to.
 *
 * Runs only at confirm time (one shot per upload) and the compile bundle,
 * never on the hot read path — that streams straight through via
 * `streamAsset`. Callers pass the kind's `ASSET_SIZE_CAPS_BYTES` entry.
 */
export async function downloadAssetBytes(
	gcsObjectKey: string,
	maxBytes: number,
): Promise<Buffer> {
	const stream = getBucket().file(gcsObjectKey).createReadStream();
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.length;
		if (total > maxBytes) {
			stream.destroy();
			throw new Error(
				`The stored file is larger than the ${(maxBytes / 1024 / 1024).toFixed(0)} MB cap for its kind — it may have been overwritten after the upload started. Upload it again.`,
			);
		}
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
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

/**
 * Write a UTF-8 text object (a document's requirements extract). A thin
 * wrapper over `uploadAssetBytes` so the extract sibling-object is stored
 * the same way as the bytes, with a `charset=utf-8` content type so the
 * proxy GET serves it readably. Server-side only — the browser never PUTs
 * an extract.
 */
export async function writeTextObject(
	gcsObjectKey: string,
	text: string,
): Promise<void> {
	await uploadAssetBytes({
		gcsObjectKey,
		bytes: Buffer.from(text, "utf8"),
		contentType: "text/markdown; charset=utf-8",
	});
}

/**
 * Read a UTF-8 text object back, or `null` if it doesn't exist (the common
 * "not extracted yet / stale version key" case — the caller treats a miss as
 * "no current extract"). Bounded by `maxBytes` like every other download:
 * an extract is small, but the cap keeps a corrupted/oversized object from
 * pulling unbounded bytes into the request's memory.
 */
export async function readTextObject(
	gcsObjectKey: string,
	maxBytes: number,
): Promise<string | null> {
	// Existence probe first: `downloadAssetBytes` streams and would surface a
	// missing object as a stream error, not a clean null. The metadata HEAD is
	// cheap and lets a not-extracted-yet read return null without a throw.
	const size = await getStoredObjectSize(gcsObjectKey);
	if (size === null) return null;
	try {
		const bytes = await downloadAssetBytes(gcsObjectKey, maxBytes);
		return bytes.toString("utf8");
	} catch (err) {
		// The object existed at the probe but is gone now (a delete raced between
		// the HEAD and the stream open). Keep the null-on-miss contract
		// unconditional rather than letting a GCS 404 escape as an unhandled
		// throw — the caller maps null to a clean not-found, a stray throw to a 500.
		if ((err as { code?: number } | null)?.code === 404) return null;
		throw err;
	}
}
