/**
 * Google Cloud Storage client for media assets.
 *
 * Lazily-initialized singleton matching the Firestore singleton
 * pattern in `lib/db/firestore.ts`. Credentials: Application Default
 * Credentials (the attached service account) on Cloud Run; locally, a
 * `fake-gcs-server` emulator (`compose.yaml`) — set `NOVA_MEDIA_EMULATOR_HOST`
 * and the client talks to it with NO auth, so local-dev media needs no
 * real GCS, no signed-URL signing, and no service-account impersonation.
 * Pointing local dev at the real `nova-multimedia-dev` bucket still works
 * if ADC is configured, but the emulator is the default local path.
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
		// Local dev (fake-gcs-server emulator): pass the emulator host as an
		// explicit `apiEndpoint`. A custom `apiEndpoint` reroutes EVERY
		// operation to the emulator and skips ADC (the client's default
		// `useAuthWithCustomEndpoint: false`), so local media needs no
		// credentials, no signed-URL signing, and no impersonation. `projectId`
		// is a placeholder the emulator ignores; prod sets no emulator host, so
		// it uses real GCS with ADC and the real `GOOGLE_CLOUD_PROJECT`.
		//
		// We deliberately use our own `NOVA_MEDIA_EMULATOR_HOST`, NOT the
		// conventional `STORAGE_EMULATOR_HOST`: the client auto-detects the
		// latter and rewrites read / copy / delete paths to a prefix-less form
		// (`/b/<bucket>/o/...` instead of `/storage/v1/b/...`) that
		// fake-gcs-server answers 404 for, and `apiEndpoint` can't override it.
		// A non-hijacked var + `apiEndpoint` keeps every path correct.
		const emulatorHost = process.env.NOVA_MEDIA_EMULATOR_HOST;
		_storage = new Storage({
			projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "nova-local",
			...(emulatorHost ? { apiEndpoint: emulatorHost } : {}),
		});
	}
	return _storage;
}

/**
 * Idempotently create the media bucket in the local emulator before the
 * first write. Prod buckets are provisioned out-of-band against real GCS;
 * the emulator starts empty, so the first upload of a session creates the
 * bucket. A no-op (and zero network) outside emulator mode. The guard
 * promise runs the create at most once per process; an "already exists"
 * response is the expected steady state and is swallowed.
 */
let _emulatorBucketReady: Promise<void> | null = null;
async function ensureEmulatorBucket(): Promise<void> {
	const emulator = process.env.NOVA_MEDIA_EMULATOR_HOST;
	if (!emulator) return;
	if (!_emulatorBucketReady) {
		const name = process.env.NOVA_MEDIA_BUCKET;
		// Create the bucket with the raw GCS JSON-API shape rather than the
		// client's `createBucket()`: the client method posts to an endpoint
		// fake-gcs-server answers 404 for, while the plain `POST /storage/v1/b`
		// below is the request the emulator actually implements. A 409 (already
		// exists) or any other response is fine — this only needs to run once
		// per process, and a network blip falls through to the upload's own
		// error. The `project` query param is required by the emulator but
		// ignored by it.
		const project = process.env.GOOGLE_CLOUD_PROJECT ?? "nova-local";
		_emulatorBucketReady = name
			? fetch(
					`${emulator.replace(/\/$/, "")}/storage/v1/b?project=${encodeURIComponent(
						project,
					)}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name }),
					},
				)
					.then(() => undefined)
					.catch(() => undefined)
			: Promise.resolve();
	}
	return _emulatorBucketReady;
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
 *  - the destination object key (path the bytes land at — browser
 *    uploads use `pending/<owner>/<assetId>.<ext>`; the owner segment
 *    keeps a different owner's namespace structurally unreachable),
 *  - the request `Content-Type` header (the upload must declare
 *    the same MIME the route's pre-screen accepted).
 *
 * A 5-minute TTL keeps a leaked URL short-lived. Confirm-time
 * validation is the authoritative tamper protection: the confirm step
 * downloads the bytes from `gcsObjectKey`, re-computes the sha256, and
 * rejects if the actual hash doesn't match the row's claimed hash.
 * There's no server-side body-hash binding here — we'd need a separate
 * canonical-request mechanism, and the confirm-time re-validation
 * already covers it.
 */
export async function createSignedUploadUrl(args: {
	gcsObjectKey: string;
	contentType: string;
}): Promise<{ url: string; expiresAtMs: number }> {
	const ttlMs = 5 * 60 * 1000;
	const expiresAtMs = Date.now() + ttlMs;

	// Local dev (fake-gcs-server emulator): the browser can't PUT straight to
	// the emulator (cross-origin) and there's no SA key to mint a real V4
	// signed URL with. Instead the browser PUTs to a same-origin local-dev
	// proxy route that writes the bytes to the emulator server-side — no
	// signing, no credentials, no impersonation. Hard-gated on the same env
	// var, so the route 404s in prod. Prod keeps the real signed URL below.
	if (process.env.NOVA_MEDIA_EMULATOR_HOST) {
		const url = `/api/media/upload/emulator-put?key=${encodeURIComponent(
			args.gcsObjectKey,
		)}`;
		return { url, expiresAtMs };
	}

	const [url] = await getBucket().file(args.gcsObjectKey).getSignedUrl({
		version: "v4",
		action: "write",
		expires: expiresAtMs,
		contentType: args.contentType,
	});
	return { url, expiresAtMs };
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
	await ensureEmulatorBucket();
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
 * concurrency ever makes that ceiling tight, the validator's
 * container parse can run off a stream instead of a full buffer
 * (music-metadata reads from a tokenizer / web stream), so the
 * bytes never fully reside in memory.
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
