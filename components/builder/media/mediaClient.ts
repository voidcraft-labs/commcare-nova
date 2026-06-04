// components/builder/media/mediaClient.ts
//
// Client-side data layer for the media authoring UI. The codebase
// has no React Query / SWR, so these are plain `fetch` helpers the
// hooks wrap with local state. The upload flow inherently runs in
// the browser (the bytes PUT directly to a GCS signed URL), so a
// server-action shape wouldn't fit — fetch is the right tool here.
//
// `WireMediaAsset` is imported as a type only (erased at compile),
// so this client module never pulls the server-only `lib/db`
// runtime (Firestore SDK) into the browser bundle.

import type { WireMediaAsset } from "@/lib/db/mediaAssets";
import type {
	AssetKind,
	Media,
	MediaExtractStatus,
	MediaKind,
} from "@/lib/domain/multimedia";

/** The asset shape the API returns and the UI renders. */
export type MediaAssetView = WireMediaAsset;

/**
 * Set one kind's asset on a `Media` bundle, preserving the other
 * slots. Pure — returned fresh so callers can hand it straight to a
 * doc mutation.
 */
export function setMediaSlot(
	value: Media | undefined,
	kind: MediaKind,
	assetId: string,
): Media {
	return { ...value, [kind]: assetId };
}

/**
 * Clear one kind's asset from a `Media` bundle. Returns `undefined`
 * when that was the last populated slot — so the carrier's optional
 * `media` becomes absent rather than an empty `{}` (which would
 * round-trip as "present but empty" and clutter the doc).
 */
export function clearMediaSlot(
	value: Media | undefined,
	kind: MediaKind,
): Media | undefined {
	if (!value) return undefined;
	const next = { ...value };
	delete next[kind];
	return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * The session-authed proxy URL for an asset's bytes. The GET route
 * validates the session from cookies, so a plain `<img src>` /
 * `<audio src>` / `<video src>` works without extra wiring.
 *
 * Takes a plain `string`: carrier slots (`Media`, `module.icon`)
 * infer their id type as `string` from the Zod schema (the `AssetId`
 * brand is a server-side type only), and `MediaAssetView.id` is
 * assignable to it.
 */
export function mediaSrc(assetId: string): string {
	return `/api/media/${assetId}`;
}

/**
 * SHA-256 (lowercase hex) of a byte buffer, via SubtleCrypto. The pure
 * hashing core — separated from `sha256Hex` so the byte→hex transform
 * can be unit-tested without reading a `Blob` (whose `arrayBuffer()`
 * leaves a BLOBREADER async resource the leak detector flags).
 */
export async function sha256HexOfBytes(bytes: BufferSource): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * SHA-256 (lowercase hex) of a file's bytes, computed in the browser
 * via SubtleCrypto. Sent at upload-initiate so the server can
 * dedup-skip the bytes push when the owner already holds this exact
 * content — and matched against the server's own hash at confirm.
 * A thin `Blob` adapter over `sha256HexOfBytes`.
 */
export async function sha256Hex(file: Blob): Promise<string> {
	return sha256HexOfBytes(await file.arrayBuffer());
}

/** Initiate response shape — discriminated by `deduplicated`. */
interface InitiateResponse {
	assetId: string;
	deduplicated: boolean;
	/** Present iff `deduplicated` — the existing asset to reuse. */
	asset?: MediaAssetView;
	/** Present iff NOT `deduplicated` — the GCS signed PUT URL. */
	uploadUrl?: string;
	/** The exact `Content-Type` the PUT must send (the normalized MIME). */
	uploadContentType?: string;
	expiresAtMs?: number;
}

/**
 * Run the full client-side upload: hash → initiate → (PUT bytes →
 * confirm) and resolve to the stored asset. On a dedup hit the
 * server returns the existing asset and the PUT/confirm steps are
 * skipped entirely.
 *
 * Throws an `Error` carrying the server's Elm-shaped message on any
 * rejection, so the caller can surface it verbatim.
 */
export async function uploadMediaAsset(file: File): Promise<MediaAssetView> {
	const contentHash = await sha256Hex(file);
	const initiate = await postJson<InitiateResponse>("/api/media/upload", {
		filename: file.name,
		mimeType: file.type,
		sizeBytes: file.size,
		contentHash,
	});

	if (initiate.deduplicated) {
		if (!initiate.asset) {
			throw new Error(
				"The server reported this file is already in your library but didn't return it. Try refreshing the library.",
			);
		}
		return initiate.asset;
	}

	if (!initiate.uploadUrl || !initiate.uploadContentType) {
		throw new Error(
			"The upload couldn't start — the server didn't return a storage URL. Try again.",
		);
	}

	// PUT the bytes straight to GCS. The `Content-Type` MUST match the
	// value the signed URL was bound to (the server's normalized MIME),
	// not the raw `file.type`, or GCS rejects the signature.
	const putRes = await fetch(initiate.uploadUrl, {
		method: "PUT",
		headers: { "Content-Type": initiate.uploadContentType },
		body: file,
	});
	if (!putRes.ok) {
		throw new Error(
			`The file couldn't be uploaded to storage (status ${putRes.status}). Check your connection and try again.`,
		);
	}

	const confirmed = await postJson<{ ok: true; asset: MediaAssetView }>(
		`/api/media/upload/${initiate.assetId}/confirm`,
		undefined,
	);
	return confirmed.asset;
}

/**
 * Fetch a document's requirements extract — the text the assistant reads
 * ("What the AI reads"). Returns `null` when no current extract exists yet
 * (the route 404s until extraction finishes), so the caller shows a
 * not-ready state rather than an error. Throws only on an unexpected failure.
 */
export async function fetchAssetExtract(
	assetId: string,
): Promise<string | null> {
	const res = await fetch(`/api/media/${assetId}/extract`);
	if (res.status === 404) return null;
	if (!res.ok) {
		throw await errorFromResponse(
			res,
			"Couldn't load what the assistant reads from this document.",
		);
	}
	return res.text();
}

/**
 * Trigger (or confirm) a document's feature extraction and resolve to its
 * resulting status. The route is idempotent + best-effort single-flight: it
 * returns `ready` immediately for a current extract, `extracting` (202) when a
 * job is already in flight, and otherwise runs the extraction to completion
 * before resolving — so this promise settles with the FINAL status, which the
 * file-manager indicator shows while it's pending. A failure server-side is
 * recorded as `failed`; a transport error maps to `failed` too (the file is
 * saved — the chat's lazy backstop will re-read it on send).
 */
export async function triggerAssetExtraction(
	assetId: string,
): Promise<MediaExtractStatus> {
	try {
		const res = await fetch(`/api/media/${assetId}/extract`, {
			method: "POST",
		});
		if (res.ok || res.status === 202) {
			const body = (await res.json()) as {
				extract?: { status?: MediaExtractStatus };
			};
			return body.extract?.status ?? "ready";
		}
		return "failed";
	} catch {
		return "failed";
	}
}

/** A page of the owner's media library. */
export interface MediaLibraryPage {
	assets: MediaAssetView[];
	nextCursor: string | null;
}

/**
 * Fetch one page of the owner's `ready` assets, newest first.
 * Optionally filtered to a `kind` (any `AssetKind` — the chat file
 * manager filters by document kinds, the carrier pickers by media
 * kinds); `cursor` resumes from a prior page's `nextCursor`.
 */
export async function fetchMediaLibrary(
	options: { kind?: AssetKind; cursor?: string } = {},
): Promise<MediaLibraryPage> {
	const params = new URLSearchParams();
	if (options.kind) params.set("kind", options.kind);
	if (options.cursor) params.set("cursor", options.cursor);
	const res = await fetch(`/api/media/library?${params.toString()}`);
	if (!res.ok) {
		throw await errorFromResponse(res, "Couldn't load your media library.");
	}
	return res.json();
}

/**
 * Delete an asset from the owner's library. Resolves on success (the route
 * returns 204); throws with the server's message on a refusal — a 409 when the
 * asset is still referenced by one of the user's apps (the message names the
 * carriers) — or any other failure, so the caller can tell the user WHY a delete
 * was blocked rather than failing silently.
 */
export async function deleteMediaAsset(assetId: string): Promise<void> {
	const res = await fetch(`/api/media/${assetId}`, { method: "DELETE" });
	if (!res.ok) {
		throw await errorFromResponse(res, "Couldn't delete this file. Try again.");
	}
}

/** POST JSON (or an empty body) and parse the JSON response, mapping a non-2xx to the server's message. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		...(body === undefined
			? {}
			: {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
	if (!res.ok) {
		throw await errorFromResponse(
			res,
			`Request failed (status ${res.status}).`,
		);
	}
	return res.json();
}

/** Lift a non-2xx response into an `Error` carrying the route's `{ error }` message when present. */
async function errorFromResponse(
	res: Response,
	fallback: string,
): Promise<Error> {
	const body = (await res.json().catch(() => null)) as {
		error?: string;
	} | null;
	return new Error(body?.error ?? fallback);
}
