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
import {
	builtinIconPublicPath,
	isBuiltinIconRef,
	parseBuiltinIconSlug,
} from "@/lib/domain/builtinIcons";
import {
	type AssetKind,
	EXTRACTOR_VERSION,
	type Media,
	type MediaKind,
	resolveUploadMimeType,
} from "@/lib/domain/multimedia";

/** The asset shape the API returns and the UI renders. */
export type MediaAssetView = WireMediaAsset;

/** A completed extraction's metadata — the wire `extract` shape (status +
 *  title/summary + counts). Returned by `triggerAssetExtraction` so a caller can
 *  refresh a staged asset's snapshot the instant extraction finishes. */
export type ExtractMeta = NonNullable<WireMediaAsset["extract"]>;

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
	// Built-in icon refs (`nova-icon:<slug>`) aren't Firestore assets — their
	// bytes ship statically at `/nova-icons/<slug>.png`. A known slug resolves to
	// that static URL; an unknown/stale slug falls through to the API route, which
	// 404s — the same broken-image outcome as a deleted upload, surfaced to fix.
	if (isBuiltinIconRef(assetId)) {
		const slug = parseBuiltinIconSlug(assetId);
		if (slug) return builtinIconPublicPath(slug);
	}
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
	/** Extra signed headers the PUT MUST send verbatim — the
	 *  `x-goog-content-length-range` byte-cap binding. Absent/empty in dev. */
	uploadHeaders?: Record<string, string>;
	expiresAtMs?: number;
}

/** Options for `uploadMediaAsset`. Both serve the staged-slot flow: the
 *  slot chip shows real byte progress and its cancel aborts the transfer. */
export interface UploadMediaOptions {
	/** Abort the whole flow (hash / initiate / PUT / confirm). The promise
	 *  rejects with an `AbortError` `DOMException`, matching fetch. */
	signal?: AbortSignal;
	/** Byte-level progress of the storage PUT, 0..1. Supplying this routes
	 *  the PUT through `XMLHttpRequest` — fetch exposes no upload-progress
	 *  events. The dedup fast path never PUTs, so it reports nothing. */
	onProgress?: (fraction: number) => void;
}

/**
 * Run the full client-side upload: hash → initiate → (PUT bytes →
 * confirm) and resolve to the stored asset. On a dedup hit the
 * server returns the existing asset and the PUT/confirm steps are
 * skipped entirely. The resolved asset is always `ready` — confirm is
 * what flips the row — so a caller can hand its id straight to an
 * attach.
 *
 * Throws an `Error` carrying the server's Elm-shaped message on any
 * rejection, so the caller can surface it verbatim.
 */
export async function uploadMediaAsset(
	file: File,
	options: UploadMediaOptions = {},
): Promise<MediaAssetView> {
	const { signal, onProgress } = options;
	const contentHash = await sha256Hex(file);
	signal?.throwIfAborted();
	const initiate = await postJson<InitiateResponse>(
		"/api/media/upload",
		{
			filename: file.name,
			// Browsers set `File.type` unreliably (empty / `application/octet-stream`
			// for `.md` and some office files), and the initiate route validates the
			// claim — so derive a usable MIME from the extension when the browser's is
			// missing. Confirm re-derives the authoritative type from the bytes anyway.
			mimeType: resolveUploadMimeType(file.type, file.name),
			sizeBytes: file.size,
			contentHash,
		},
		signal,
	);

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
	// not the raw `file.type`, or GCS rejects the signature. Any
	// `uploadHeaders` (the `x-goog-content-length-range` byte-cap binding)
	// are also signed, so they must be sent verbatim too. With a progress
	// callback the PUT rides XHR (fetch can't observe upload bytes); without
	// one, plain fetch.
	const extraHeaders = initiate.uploadHeaders ?? {};
	if (onProgress) {
		await putBytesWithProgress(initiate.uploadUrl, initiate.uploadContentType, {
			body: file,
			signal,
			onProgress,
			extraHeaders,
		});
	} else {
		const putRes = await fetch(initiate.uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": initiate.uploadContentType, ...extraHeaders },
			body: file,
			signal,
		});
		if (!putRes.ok) {
			throw new Error(
				`The file couldn't be uploaded to storage (status ${putRes.status}). Check your connection and try again.`,
			);
		}
	}

	const confirmed = await postJson<{ ok: true; asset: MediaAssetView }>(
		`/api/media/upload/${initiate.assetId}/confirm`,
		undefined,
		signal,
	);
	return confirmed.asset;
}

/**
 * PUT a blob via `XMLHttpRequest`, reporting upload-byte progress —
 * the one capability fetch lacks. Abort via `signal` rejects with an
 * `AbortError` `DOMException` so callers branch on cancellation the
 * same way they would for an aborted fetch.
 */
function putBytesWithProgress(
	url: string,
	contentType: string,
	opts: {
		body: Blob;
		signal?: AbortSignal;
		onProgress: (fraction: number) => void;
		/** Extra signed headers to send verbatim (the byte-cap binding). */
		extraHeaders?: Record<string, string>;
	},
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(new DOMException("The upload was canceled.", "AbortError"));
			return;
		}
		const xhr = new XMLHttpRequest();
		const onAbort = () => xhr.abort();
		const cleanup = () => opts.signal?.removeEventListener("abort", onAbort);
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		xhr.open("PUT", url);
		xhr.setRequestHeader("Content-Type", contentType);
		for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
			xhr.setRequestHeader(name, value);
		}
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && e.total > 0) {
				opts.onProgress(e.loaded / e.total);
			}
		};
		xhr.onload = () => {
			cleanup();
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
			} else {
				reject(
					new Error(
						`The file couldn't be uploaded to storage (status ${xhr.status}). Check your connection and try again.`,
					),
				);
			}
		};
		xhr.onerror = () => {
			cleanup();
			reject(
				new Error(
					"The file couldn't be uploaded to storage. Check your connection and try again.",
				),
			);
		};
		xhr.onabort = () => {
			cleanup();
			reject(new DOMException("The upload was canceled.", "AbortError"));
		};
		xhr.send(opts.body);
	});
}

/**
 * Fetch a document's requirements extract — the text Nova reads
 * ("What Nova reads"). Returns `null` when no current extract exists yet
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
			"Couldn't load what Nova reads from this document.",
		);
	}
	return res.text();
}

/**
 * Fetch just a document's extract HEADER metadata (title/summary), without the
 * body. The preview uses this to fill its header when the in-band snapshot it
 * was opened with lacks them — a message attachment sent before extraction
 * finished froze its ref empty. Returns `null` on any failure (the caller falls
 * back to the filename alone), and `{}`/partial when the doc isn't ready yet.
 */
export async function fetchAssetExtractMeta(
	assetId: string,
): Promise<{ title?: string; summary?: string } | null> {
	try {
		const res = await fetch(`/api/media/${assetId}/extract?meta=1`);
		if (!res.ok) return null;
		const body = (await res.json()) as { title?: string; summary?: string };
		return { title: body.title, summary: body.summary };
	} catch {
		return null;
	}
}

/**
 * Trigger (or confirm) a document's feature extraction and resolve to its FINAL
 * extract metadata (status + title/summary when ready). The route STREAMS NDJSON:
 * `{type:"progress",chars}` lines while the model runs, then one `{type:"done",
 * extract}`. `onProgress` fires per progress line with that chunk's character
 * count — real read progress the caller pulses onto the signal grid. The promise
 * settles with the `done` line's `ExtractMeta` (the indicator shows it while
 * pending AND the caller uses it to refresh its staged snapshot, so the chip
 * preview gets the title/summary the instant extraction finishes).
 *
 * Best-effort single-flight: a concurrent job rides the `done` line as
 * `extracting` (poll again); a server-side condense failure as `failed`. A
 * transport error — or an `abort` (the caller unmounted) — maps to `failed` too;
 * the file is saved and the chat's lazy backstop re-reads it on send. Pass
 * `signal` so an unmount aborts the in-flight read (no dangling stream reader).
 */
export async function triggerAssetExtraction(
	assetId: string,
	opts: {
		onProgress?: (deltaChars: number) => void;
		signal?: AbortSignal;
	} = {},
): Promise<ExtractMeta> {
	const failed: ExtractMeta = {
		status: "failed",
		version: EXTRACTOR_VERSION,
		truncated: false,
		charCount: 0,
	};
	try {
		const res = await fetch(`/api/media/${assetId}/extract`, {
			method: "POST",
			signal: opts.signal,
		});
		if (!res.ok || !res.body) return failed;

		// Parse the NDJSON line stream. `progress` → pulse; `done` → the final
		// ExtractMeta. The reader is released in `finally` so an abort mid-read
		// leaves no live stream handle (the async-leak gate).
		const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += value;
				let nl = buffer.indexOf("\n");
				while (nl >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line) {
						const msg = JSON.parse(line) as {
							type?: string;
							chars?: number;
							extract?: ExtractMeta;
						};
						if (msg.type === "progress" && typeof msg.chars === "number") {
							opts.onProgress?.(msg.chars);
						} else if (msg.type === "done" && msg.extract) {
							return msg.extract;
						}
					}
					nl = buffer.indexOf("\n");
				}
			}
			return failed; // stream ended without a `done` line
		} finally {
			reader.releaseLock();
		}
	} catch {
		return failed;
	}
}

/** A page of the owner's media library. */
export interface MediaLibraryPage {
	assets: MediaAssetView[];
	nextCursor: string | null;
}

/**
 * Fetch one page of the owner's `ready` assets, newest first.
 * Optionally filtered to a SET of `kinds` (repeated `?kind=` on the
 * wire) — a picker passes its carrier's allowed kinds so the server
 * returns only attachable assets; `cursor` resumes from a prior
 * page's `nextCursor`. An empty/omitted `kinds` fetches every kind.
 */
export async function fetchMediaLibrary(
	options: { kinds?: readonly AssetKind[]; cursor?: string } = {},
): Promise<MediaLibraryPage> {
	const params = new URLSearchParams();
	for (const kind of options.kinds ?? []) params.append("kind", kind);
	if (options.cursor) params.set("cursor", options.cursor);
	const res = await fetch(`/api/media/library?${params.toString()}`);
	if (!res.ok) {
		throw await errorFromResponse(res, "Couldn't load your media library.");
	}
	return res.json();
}

/** Ids per resolve request — keeps the repeated-`id` URL well under
 *  request-header limits; the server caps the per-request total anyway. */
const RESOLVE_IDS_CHUNK = 50;

/**
 * Resolve specific asset ids to their wire rows — the library route's
 * resolve mode (repeated `?id=`). Owner-filtered server-side: a missing
 * or foreign id is simply absent from the result, never an error. The
 * attach budget check uses this to learn the byte sizes of referenced
 * assets this session hasn't otherwise loaded. Chunked so a
 * reference-heavy doc can't overflow a request URL.
 */
export async function fetchAssetsByIds(
	ids: readonly string[],
): Promise<MediaAssetView[]> {
	const unique = [...new Set(ids)];
	const out: MediaAssetView[] = [];
	for (let i = 0; i < unique.length; i += RESOLVE_IDS_CHUNK) {
		const params = new URLSearchParams();
		for (const id of unique.slice(i, i + RESOLVE_IDS_CHUNK)) {
			params.append("id", id);
		}
		const res = await fetch(`/api/media/library?${params.toString()}`);
		if (!res.ok) {
			throw await errorFromResponse(
				res,
				"Couldn't look up the attached files' details.",
			);
		}
		const page = (await res.json()) as MediaLibraryPage;
		out.push(...page.assets);
	}
	return out;
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
async function postJson<T>(
	url: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		signal,
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
