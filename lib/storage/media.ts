/**
 * Google Cloud Storage client for media assets.
 *
 * Lazily-initialized singleton matching the Postgres connection
 * singleton pattern in `lib/case-store/postgres/connection.ts`. Credentials are Application
 * Default Credentials everywhere: the attached service account on
 * Cloud Run, the developer's `gcloud auth application-default`
 * identity locally. Local dev points at the dev project's real
 * bucket (`GOOGLE_CLOUD_PROJECT` + `NOVA_MEDIA_BUCKET` in `.env`) so
 * dev exercises the same client against the same wire behavior as
 * prod — Postgres rows and stored bytes live in the same project
 * and can never disagree about what exists.
 *
 * The bucket name comes from `NOVA_MEDIA_BUCKET` at first call.
 * Throwing here (rather than at module load) lets the build step
 * import this module without env vars present.
 */

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
	type Bucket,
	type BucketMetadata,
	type LifecycleRule,
	Storage,
} from "@google-cloud/storage";
import mediaBucketPolicy from "@/config/media-bucket-policy.json";
import { STAGED_CAPTURE_PREFIX } from "@/lib/domain/captureFormats";

let _storage: Storage | null = null;
let _bucket: Bucket | null = null;
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
const STORAGE_RETRY_TOTAL_TIMEOUT_SECONDS = 30;

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
		_storage = new Storage({
			projectId: process.env.GOOGLE_CLOUD_PROJECT,
			// A GCS call is often inside a form-entry serialization boundary.
			// Bound both one HTTP attempt and the library's complete retry loop;
			// a socket that never settles must not hold Submit or scheduled
			// cleanup indefinitely.
			timeout: STORAGE_REQUEST_TIMEOUT_MS,
			retryOptions: {
				maxRetries: 3,
				totalTimeout: STORAGE_RETRY_TOTAL_TIMEOUT_SECONDS,
			},
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
				"NOVA_MEDIA_BUCKET is unset. Multimedia upload and read routes need this env var to know which GCS bucket holds the bytes. Set it to e.g. `nova-multimedia-prod` (production) or `commcare-nova-dev-multimedia` (local dev).",
			);
		}
		_bucket = getStorage().bucket(name);
	}
	return _bucket;
}

// Shared with the read-only deployment prerequisite and explicit infra apply.
const MEDIA_BUCKET_LIFECYCLE_RULES: LifecycleRule[] =
	mediaBucketPolicy.lifecycle.rule.map((rule) => {
		if (rule.action.type !== "Delete")
			throw new Error("Unsupported media lifecycle action.");
		return { ...rule, action: { type: rule.action.type } };
	});

/**
 * Prove the capture-maintenance identity can perform its complete storage
 * lifecycle without touching authoring media.
 *
 * This is the same create-only staged→durable copy used by form submission,
 * followed by exact-generation metadata/byte verification and deletion on
 * both sides. The staged source remains lifecycle-covered if the process dies;
 * the durable destination is unguessable and strict cleanup failures fail the
 * pretraffic job. No list permission is needed.
 */
export async function probeCaptureStorageAuthority(): Promise<void> {
	const probeId = randomUUID();
	const probeProjectId = `_health-${probeId}`;
	const sourceObjectKey = `${STAGED_CAPTURE_PREFIX}${probeProjectId}/${probeId}.probe`;
	const destinationObjectKey = `projects/${probeProjectId}/captures/${probeId}.probe`;
	const expected = Buffer.from("nova-capture-storage-authority-v1", "utf8");
	const expectedContentType = "application/octet-stream";
	const source = getBucket().file(sourceObjectKey);
	let sourceGeneration: string | undefined;
	let destinationGeneration: string | undefined;
	let sourceCreateCompleted = false;
	let operationError: unknown;
	const cleanupErrors: unknown[] = [];
	const resolveGenerationForCleanup = async (
		objectKey: string,
	): Promise<string | undefined> => {
		try {
			const [metadata] = await getBucket().file(objectKey).getMetadata();
			const generation =
				metadata.generation === undefined || metadata.generation === null
					? undefined
					: String(metadata.generation);
			if (generation === undefined || generation.length === 0) {
				throw new Error(
					`The capture storage authority probe found ${objectKey} without an immutable generation for cleanup.`,
				);
			}
			return generation;
		} catch (error) {
			const code = (error as { code?: number | string } | null)?.code;
			if (code === 404 || code === "404") {
				return undefined;
			}
			throw error;
		}
	};

	try {
		await source.save(expected, {
			resumable: false,
			contentType: expectedContentType,
			preconditionOpts: { ifGenerationMatch: 0 },
		});
		sourceCreateCompleted = true;
		const [sourceMetadata] = await source.getMetadata();
		sourceGeneration =
			sourceMetadata.generation === undefined
				? undefined
				: String(sourceMetadata.generation);
		if (
			!sourceGeneration ||
			Number(sourceMetadata.size) !== expected.byteLength ||
			sourceMetadata.crc32c === undefined ||
			sourceMetadata.contentType !== expectedContentType
		) {
			throw new Error(
				"The capture storage authority probe created staged bytes without the expected immutable metadata.",
			);
		}
		const [stagedBytes] = await getBucket()
			.file(sourceObjectKey, { generation: sourceGeneration })
			.download();
		if (!stagedBytes.equals(expected)) {
			throw new Error(
				"The capture storage authority probe did not read back the staged bytes it created.",
			);
		}

		const copied = await copyAssetObjectIfAbsent({
			sourceGcsObjectKey: sourceObjectKey,
			sourceGeneration,
			destinationGcsObjectKey: destinationObjectKey,
			expectedSize: expected.byteLength,
			expectedChecksum: sourceMetadata.crc32c,
			expectedContentType,
		});
		destinationGeneration = copied.destinationGeneration;
		if (copied.replay) {
			throw new Error(
				"The capture storage authority probe unexpectedly replayed an existing durable object.",
			);
		}

		const destination = getBucket().file(destinationObjectKey, {
			generation: destinationGeneration,
		});
		const [destinationMetadata] = await destination.getMetadata();
		if (
			String(destinationMetadata.generation ?? "") !== destinationGeneration ||
			Number(destinationMetadata.size) !== expected.byteLength ||
			destinationMetadata.crc32c !== sourceMetadata.crc32c ||
			destinationMetadata.contentType !== expectedContentType
		) {
			throw new Error(
				"The capture storage authority probe copied durable bytes without the expected immutable metadata.",
			);
		}
		const [durableBytes] = await destination.download();
		if (!durableBytes.equals(expected)) {
			throw new Error(
				"The capture storage authority probe did not read back the durable bytes it copied.",
			);
		}
	} catch (error) {
		operationError = error;
	} finally {
		if (sourceGeneration === undefined) {
			try {
				sourceGeneration = await resolveGenerationForCleanup(sourceObjectKey);
				if (sourceCreateCompleted && sourceGeneration === undefined) {
					cleanupErrors.push(
						new Error(
							"The capture storage authority probe could not resolve the staged generation it created for exact cleanup.",
						),
					);
				}
			} catch (metadataError) {
				cleanupErrors.push(metadataError);
			}
		}
		if (destinationGeneration === undefined) {
			try {
				destinationGeneration =
					await resolveGenerationForCleanup(destinationObjectKey);
			} catch (metadataError) {
				cleanupErrors.push(metadataError);
			}
		}
		const cleanupTargets = [
			...(destinationGeneration === undefined
				? []
				: [
						{
							objectKey: destinationObjectKey,
							generation: destinationGeneration,
						},
					]),
			...(sourceGeneration === undefined
				? []
				: [
						{
							objectKey: sourceObjectKey,
							generation: sourceGeneration,
						},
					]),
		];
		const cleanupResults = await Promise.allSettled(
			cleanupTargets.map(({ objectKey, generation }) =>
				getBucket()
					.file(objectKey, { generation })
					.delete({ ignoreNotFound: true }),
			),
		);
		for (const result of cleanupResults) {
			if (result.status === "rejected") cleanupErrors.push(result.reason);
		}
	}

	if (operationError !== undefined && cleanupErrors.length > 0) {
		throw new AggregateError(
			[operationError, ...cleanupErrors],
			"The capture storage authority probe failed and could not clean up every exact object generation.",
		);
	}
	if (operationError !== undefined) throw operationError;
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			cleanupErrors,
			"The capture storage authority probe could not clean up every exact object generation.",
		);
	}
}

/**
 * Apply the media bucket's COMPLETE temporary-object retention policy.
 *
 * ## Why this function owns all of them
 *
 * Lifecycle Delete is not a hard byte-retention boundary by itself. Cloud
 * Storage soft-deletes by default, versioning can turn deletion into a
 * noncurrent generation, and bucket retention/default holds can defer it.
 * One metageneration-fenced metadata PATCH therefore owns the complete
 * contract: the exact lifecycle, soft delete disabled, versioning disabled,
 * and no default event-based hold. A bucket retention policy is an operator
 * protection, so its presence fails closed instead of silently removing it.
 *
 * Two prefixes need one:
 *
 *  - `pending/` — abandoned browser upload attempts, described below.
 *  - `captures-staged/` — a worker's form attachment whose form was never
 *    submitted. This is the retention backstop: rows carry an `expires_at`
 *    swept by the scheduled worker and opportunistically on initiation, but
 *    row hygiene is not a byte-retention guarantee. An idle Project must stop
 *    holding photographs even if its database worker is unavailable, which
 *    only a traffic-independent bucket rule delivers.
 *
 * Browser uploads PUT to a per-attempt key via a V4 signed URL. The signed
 * URL binds a body-length range (exact for capture attempts, a maximum for
 * authoring-media attempts) through the
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
 * Idempotent: the PATCH sends the exact lifecycle and values every time, then
 * a fresh GET verifies them. `ifMetagenerationMatch` makes a concurrent
 * operator edit block the deploy rather than get overwritten. Operational,
 * not on the request path — the explicit infrastructure command applies it when policy changes.
 */
export async function applyMediaBucketStoragePolicy(): Promise<void> {
	const bucket = getBucket();
	const [before] = await bucket.getMetadata();
	if (before.retentionPolicy !== undefined && before.retentionPolicy !== null) {
		throw new Error(
			`The media bucket has a${before.retentionPolicy.isLocked ? " locked" : ""} retention policy. Nova will not remove an operator protection; remove it explicitly before applying Nova's hard temporary-object retention policy.`,
		);
	}
	if (before.metageneration === undefined || before.metageneration === null) {
		throw new Error(
			"The media bucket metadata did not include a metageneration, so Nova cannot safely converge policy without overwriting a concurrent operator edit.",
		);
	}

	await bucket.setMetadata(
		{
			lifecycle: { rule: MEDIA_BUCKET_LIFECYCLE_RULES },
			softDeletePolicy: { retentionDurationSeconds: 0 },
			versioning: { enabled: false },
			defaultEventBasedHold: false,
		},
		{ ifMetagenerationMatch: before.metageneration },
	);

	const [after] = await bucket.getMetadata();
	verifyMediaBucketStoragePolicy(after);
}

function canonicalJson(value: unknown): string {
	const normalize = (current: unknown): unknown => {
		if (Array.isArray(current)) {
			return current.map(normalize);
		}
		if (current !== null && typeof current === "object") {
			return Object.fromEntries(
				Object.entries(current)
					.filter(([, child]) => child !== undefined)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, child]) => [key, normalize(child)]),
			);
		}
		return current;
	};
	return JSON.stringify(normalize(value));
}

function canonicalLifecycle(rules: readonly LifecycleRule[]): string[] {
	return rules.map(canonicalJson).toSorted();
}

function verifyMediaBucketStoragePolicy(metadata: BucketMetadata): void {
	const findings: string[] = [];
	if (
		canonicalJson(canonicalLifecycle(metadata.lifecycle?.rule ?? [])) !==
		canonicalJson(canonicalLifecycle(MEDIA_BUCKET_LIFECYCLE_RULES))
	) {
		findings.push("the lifecycle rule set is not exact");
	}
	const softDeleteSeconds = metadata.softDeletePolicy?.retentionDurationSeconds;
	if (
		metadata.softDeletePolicy !== undefined &&
		metadata.softDeletePolicy !== null &&
		(softDeleteSeconds === undefined ||
			!Number.isFinite(Number(softDeleteSeconds)) ||
			Number(softDeleteSeconds) !== 0)
	) {
		findings.push("soft delete is not disabled");
	}
	if (metadata.versioning?.enabled === true) {
		findings.push("object versioning is enabled");
	}
	if (metadata.defaultEventBasedHold === true) {
		findings.push("the default event-based hold is enabled");
	}
	if (
		metadata.retentionPolicy !== undefined &&
		metadata.retentionPolicy !== null
	) {
		findings.push("a bucket retention policy is present");
	}
	if (findings.length > 0) {
		throw new Error(
			`Media bucket policy verification failed: ${findings.join("; ")}.`,
		);
	}
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
 *  - a body-length range, via the signed `x-goog-content-length-range`
 *    extension header (`<minBytes>,<maxBytes>`). Because the header is part of the V4
 *    signature, the client MUST send it verbatim (returned in
 *    `requiredHeaders`) and GCS REJECTS a body outside the range at the
 *    storage boundary. Capture initiation sets min=max to bind the exact
 *    selected file; authoring media uses the kind cap as its maximum. The bucket
 *    CORS must allow this request header or the browser preflight strips it
 *    and the PUT 403s — see {@link applyMediaBucketCors} (a deploy
 *    prerequisite).
 *  - creation generation zero, via signed
 *    `x-goog-if-generation-match: 0`, so the URL cannot overwrite bytes
 *    after confirm records their immutable generation.
 *
 * A 5-minute TTL keeps a leaked URL short-lived. Confirm-time validation
 * still re-downloads + re-hashes the bytes as the authoritative content
 * check; the byte-range binding is what stops an oversized object from ever
 * existing, even unconfirmed.
 */
export async function createSignedUploadUrl(args: {
	gcsObjectKey: string;
	contentType: string;
	minBytes?: number;
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
	const contentLengthRange = `${args.minBytes ?? 0},${args.maxBytes}`;

	// Local dev: developer ADC is a user credential with no private key, so
	// it cannot mint a V4 signature (prod's runtime service account signs
	// via the IAM credentials API). The browser instead PUTs to a
	// same-origin dev-only route that writes the bytes through this
	// module's storage client. That proxy enforces the same cap server-side
	// via the `max` query param for authoring media and the exact pending-row
	// metadata for captures (it writes the bytes itself, so there's no signed
	// GCS write to bind the range onto). The rest of the upload flow stays
	// byte-identical to prod — only the signed-PUT hop is swapped. The route
	// 404s outside development.
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
			// A signed attempt is create-only for its whole lifetime. Without
			// this precondition the same URL could overwrite the generation
			// confirm measured before settlement copied it.
			extensionHeaders: {
				"x-goog-content-length-range": contentLengthRange,
				"x-goog-if-generation-match": "0",
			},
		});
	return {
		url,
		expiresAtMs,
		requiredHeaders: {
			"x-goog-content-length-range": contentLengthRange,
			"x-goog-if-generation-match": "0",
		},
	};
}

/**
 * Apply the media bucket's CORS policy for browser direct uploads.
 *
 * A browser upload is a cross-origin V4 signed PUT, so the bucket must allow
 * the PUT method and EVERY request header the upload sends: `Content-Type`
 * `x-goog-content-length-range` and `x-goog-if-generation-match` (the signed
 * range and create-only bindings from {@link createSignedUploadUrl}). A PUT
 * is never a CORS-"simple" request, so the browser always preflights; omitting
 * either header from this allowlist makes the signed PUT fail.
 *
 * `setCorsConfiguration` REPLACES the bucket's CORS, so `origins` must be the
 * COMPLETE set of app origins the browser uploads from. The media bucket is
 * dedicated, so it owns no other CORS rule to preserve. Operational, not on
 * the request path — run via `scripts/infra/apply-media-bucket-cors.ts`.
 */
export async function applyMediaBucketCors(origins: string[]): Promise<void> {
	await getBucket().setCorsConfiguration(
		mediaBucketPolicy.cors.map((rule) => ({ ...rule, origin: origins })),
	);
}

/**
 * Upload a byte buffer directly to GCS from the server. The MCP
 * `upload_media_asset` tool uses this for its decoded base64 payload
 * (Claude Code et al can't run the signed-PUT flow). Browser confirm also
 * uses it after downloading and validating the pending object: writing that
 * exact buffer, rather than copying the still-mutable signed-PUT key, keeps
 * the final content-addressed object byte-identical to what validation saw.
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
	/** Create-only write, used by the dev signed-PUT surrogate. */
	ifAbsent?: boolean;
}): Promise<void> {
	await getBucket()
		.file(args.gcsObjectKey)
		.save(args.bytes, {
			resumable: false,
			contentType: args.contentType,
			...(args.ifAbsent ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
		});
}

/**
 * Copy an already-validated immutable object to another storage key.
 *
 * Cross-Project asset moves use this for ready objects and ready document
 * extracts. Browser confirm deliberately does not: its signed pending key
 * remains mutable after validation, so confirm uploads the exact validated
 * buffer to the content-addressed final key instead.
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
 * Copy one immutable source generation to a create-only destination.
 *
 * A verified existing destination is success for an idempotent retry:
 * attachment ids make the destination unique, so a pre-existing object is
 * the prior copy whose metadata update may have failed. That same independent
 * verification also recovers after the staging lifecycle has reaped the named
 * source generation. A missing or mismatched destination still fails closed.
 */
export async function copyAssetObjectIfAbsent(args: {
	sourceGcsObjectKey: string;
	sourceGeneration: string;
	destinationGcsObjectKey: string;
	expectedSize: number;
	expectedChecksum: string;
	expectedContentType: string;
}): Promise<{ destinationGeneration: string; replay: boolean }> {
	const destination = getBucket().file(args.destinationGcsObjectKey);
	const verifyDestination = async (replay: boolean) => {
		const [metadata] = await destination.getMetadata();
		const generation =
			metadata.generation === undefined || metadata.generation === null
				? null
				: String(metadata.generation);
		if (
			generation === null ||
			generation.length === 0 ||
			Number(metadata.size) !== args.expectedSize ||
			metadata.crc32c !== args.expectedChecksum ||
			metadata.contentType !== args.expectedContentType
		) {
			throw new Error(
				"An existing capture destination does not match the staged source generation.",
			);
		}
		return {
			destinationGeneration: generation,
			replay,
		};
	};
	try {
		await getBucket()
			.file(args.sourceGcsObjectKey, { generation: args.sourceGeneration })
			.copy(destination, {
				preconditionOpts: { ifGenerationMatch: 0 },
			});
		return await verifyDestination(false);
	} catch (err) {
		const code = (err as { code?: number | string } | null)?.code;
		if (code === 412 || code === "412" || code === 404 || code === "404") {
			return await verifyDestination(true);
		}
		throw err;
	}
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

/** Immutable identity captured by attachment confirm. */
export async function getStoredObjectMetadata(gcsObjectKey: string): Promise<{
	size: number;
	generation: string;
	checksum: string;
	contentType: string;
} | null> {
	const file = getBucket().file(gcsObjectKey);
	try {
		const [metadata] = await file.getMetadata();
		if (
			metadata.size === undefined ||
			metadata.generation === undefined ||
			metadata.crc32c === undefined ||
			metadata.contentType === undefined
		) {
			return null;
		}
		return {
			size: Number(metadata.size),
			generation: String(metadata.generation),
			checksum: metadata.crc32c,
			contentType: metadata.contentType,
		};
	} catch (err) {
		if ((err as { code?: number } | null)?.code === 404) return null;
		throw err;
	}
}

/**
 * Drain a GCS object into memory, enforcing a byte ceiling AS IT READS.
 * The cap lives in this streamed read (a running counter that destroys the
 * stream past `maxBytes`), not only in separate metadata. Signed uploads are
 * now create-only and range-bound, but this remains the authoritative
 * fail-closed boundary for server-written and legacy objects: at most
 * `maxBytes` ever resides in memory, whatever metadata claimed.
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
				`The stored file is larger than the ${(maxBytes / 1024 / 1024).toFixed(0)} MB cap for its kind, it may have been overwritten after the upload started. Upload it again.`,
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

/** Delete only the generation confirm measured; never a later replacement. */
export async function deleteAssetGeneration(
	gcsObjectKey: string,
	generation: string,
): Promise<void> {
	await getBucket()
		.file(gcsObjectKey, { generation })
		.delete({ ignoreNotFound: true });
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
