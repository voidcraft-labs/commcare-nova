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

import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
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
 * Browser uploads PUT their bytes to a per-attempt `pending/<owner>/...`
 * key; confirm normally promotes the validated bytes OUT of `pending/` to
 * the content-hash key within seconds. A client that PUTs and never calls
 * confirm (tab closed, crash) leaves the object stranded. This rule is the
 * backstop: GCS deletes any `pending/` object older than
 * `PENDING_OBJECT_TTL_DAYS` with no server-side cron. Ready objects are
 * never touched.
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
 * Raised by `uploadAssetStream` when the incoming body exceeds the byte
 * ceiling mid-stream. The byte-PUT route maps it to a 413 — distinct from a
 * generic storage failure, which is a 500.
 */
export class AssetUploadTooLargeError extends Error {
	constructor(readonly maxBytes: number) {
		super(
			`The upload exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MB ceiling for a single file.`,
		);
		this.name = "AssetUploadTooLargeError";
	}
}

/**
 * Stream a browser upload's request body to its pending GCS key, capping the
 * byte count AS IT READS so an oversized body never fully buffers in the
 * instance. The byte-PUT route (`/api/media/upload/bytes`) is the only
 * caller; confirm later validates and promotes the stored bytes.
 *
 * `resumable: false` is a one-shot multipart write. On a cap breach the guard
 * errors, `pipeline` tears down the write stream so no object is finalized,
 * and the caller surfaces `AssetUploadTooLargeError`.
 */
export async function uploadAssetStream(args: {
	gcsObjectKey: string;
	body: ReadableStream<Uint8Array>;
	contentType: string;
	maxBytes: number;
}): Promise<void> {
	await ensureEmulatorBucket();
	const writeStream = getBucket().file(args.gcsObjectKey).createWriteStream({
		resumable: false,
		contentType: args.contentType,
	});
	let total = 0;
	const capGuard = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			total += chunk.length;
			if (total > args.maxBytes) {
				callback(new AssetUploadTooLargeError(args.maxBytes));
				return;
			}
			callback(null, chunk);
		},
	});
	// `req.body` is the DOM `ReadableStream`; `Readable.fromWeb` wants the
	// `node:stream/web` one. They're structurally the same web stream — the
	// cast just reconciles the two lib type declarations.
	await pipeline(
		Readable.fromWeb(args.body as NodeReadableStream<Uint8Array>),
		capGuard,
		writeStream,
	);
}

/**
 * Upload a byte buffer to GCS from the server — used where the bytes are
 * already in hand: the MCP `upload_media_asset` tool (it decodes base64
 * inline, since Claude Code et al can't run the browser hash → PUT → confirm
 * dance) and `writeTextObject` (the document extract sibling). The browser
 * upload path streams instead (`uploadAssetStream`), so an oversized body
 * never fully buffers.
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
 * Browser uploads land at a per-attempt pending key so a late/duplicate PUT
 * can't overwrite a ready content-hash object. Confirm-time validation calls
 * this after the bytes have passed the hash/MIME/parser checks, promoting the
 * object to the deduped final key that ready rows serve.
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
 * `downloadAssetBytes` so an oversized object (a client that PUT a body past
 * the route's stream cap, or PUT twice) is rejected before we ever pull it
 * into memory — otherwise a single request could OOM the instance. Returns
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
 * Drain a GCS object into memory, enforcing a byte ceiling AS IT READS.
 * The cap lives in this streamed read (a running counter that destroys
 * the stream past `maxBytes`), NOT in a separate `getStoredObjectSize`
 * metadata check beforehand: a client can overwrite the pending object with a
 * huge body (a second PUT) in the window between a metadata size-check and the
 * download. Capping the read itself closes that TOCTOU — at most `maxBytes`
 * ever resides in memory, whatever the object grew to.
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
