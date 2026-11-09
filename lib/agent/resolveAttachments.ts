// Resolve conversation refs into model content. New references arrive with the
// request-local content verified by incomingSources before a run was claimed.
// Historical refs retain the existing per-asset fallback: a missing old file is
// represented explicitly rather than blocking every future edit. This does not
// freeze historical evidence across extractor or library changes.
//
// The input messages are never mutated. Repeated historical refs share a read.
// Any historical preparation runs inside the current metered, authorized run.

import {
	type AttachmentRef,
	documentNeedsRead,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	asMediaAssetId,
	type DocumentKind,
	imageFormatNoun,
	isDocumentKind,
	isModelReadableImageMimeType,
	type MediaAssetId,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { downloadAssetBytes } from "@/lib/storage/media";
import { type AttachmentCondenser, wrapAttachment } from "./documentExtraction";
import { ensureStoredExtract } from "./documentExtractionStore";
import type { AdmittedSources } from "./incomingSources";
import type { SourceDocumentRuntime } from "./sourceDocuments";

type Part = NovaUIMessage["parts"][number];

const textPart = (text: string): Part => ({ type: "text", text });

class DocumentExtractUnavailableError extends Error {}

/** Read this message's attachment refs (empty when none / not a user message). */
function refsOf(message: NovaUIMessage): AttachmentRef[] {
	return message.metadata?.attachments ?? [];
}

/** Historical documents that may need preparation. Newly admitted documents
 * already have their text, regardless of the caller's display-only title. */
export function countDocumentsNeedingRead(
	messages: NovaUIMessage[],
	admittedSources: AdmittedSources = new Map(),
): number {
	const last = messages.at(-1);
	if (last?.role !== "user") return 0;
	return refsOf(last).filter(
		(ref) => !admittedSources.has(ref.assetId) && documentNeedsRead(ref),
	).length;
}

/**
 * The document's requirements extract for the SA, resolved through the shared
 * single-flight store with `onInflight: "wait"`: a send that races an in-flight
 * eager extraction REUSES that job's result instead of launching a second model
 * call — and is never slower, since the eager job started when the document was
 * attached, before this send. The store returns the ready extract, or a `failed`
 * result when the document genuinely can't be condensed; we throw on failure so
 * `resolveRef` falls back to a human-readable placeholder and the attachment is
 * never silently dropped.
 */
async function ensureExtract(
	asset: MediaAssetRecord,
	documentKind: DocumentKind,
	condenser: AttachmentCondenser,
	onProgress?: (deltaChars: number) => void,
	runtime?: SourceDocumentRuntime,
): Promise<{ text: string; truncated: boolean }> {
	const result = runtime?.prepare
		? await runtime.prepare(asset, documentKind, runtime.signal, onProgress)
		: await ensureStoredExtract({
				asset,
				documentKind,
				condenser,
				onInflight: "wait",
				// Live read-progress (signal grid) — fires only when the backstop actually
				// runs the model here; the common reuse/wait-on-eager-job path emits nothing.
				onProgress,
				signal: runtime?.signal,
			});
	if (result.status === "ready") {
		return { text: result.text, truncated: result.truncated };
	}
	// "wait" never returns "extracting"; "failed" is a genuine condense failure.
	throw new DocumentExtractUnavailableError(
		result.status === "failed"
			? result.reason
			: "extraction did not resolve to a ready extract",
	);
}

/**
 * Resolve one HISTORICAL ref to a single model-ready part.
 * any error (missing/out-of-Project asset, decode/extract failure) resolves to a
 * placeholder text part rather than throwing, so a bad attachment never breaks
 * an unrelated new turn and the SA always learns it was present.
 */
async function resolveRef(
	ref: AttachmentRef,
	asset: MediaAssetRecord | undefined,
	condenser: AttachmentCondenser,
	onProgress?: (deltaChars: number) => void,
	runtime?: SourceDocumentRuntime,
): Promise<Part> {
	runtime?.signal?.throwIfAborted();
	if (!asset) {
		return textPart(
			`<<Attachment ${ref.filename} couldn't be loaded — it may have been deleted. Re-attach it if you still need it.>>`,
		);
	}

	// A non-ready (still-uploading) asset hasn't passed confirm-time validation —
	// its bytes may be unvalidated or not yet in storage. Treat it like a missing
	// asset: a placeholder, never a download or extraction. Mirrors the bytes
	// proxy (404 on non-ready) and the extract route (409). The picker only ever
	// stages ready assets, so this guards a crafted/replayed ref or a
	// not-yet-confirmed race, not the normal flow.
	if (asset.status !== "ready") {
		return textPart(
			`<<Attachment ${ref.filename} is still being prepared — it isn't ready to read yet. Try again once its upload finishes.>>`,
		);
	}

	// An image the model can't read (a BMP, which the upload gate accepts for
	// an app's media) reaches it as a placeholder, never under its own MIME.
	if (asset.kind === "image" && !isModelReadableImageMimeType(asset.mimeType)) {
		return textPart(
			`<<Attachment ${ref.filename} is ${imageFormatNoun(asset.mimeType)}, which the assistant can't read yet. A PNG or JPEG of it works.>>`,
		);
	}

	if (asset.kind === "image") {
		try {
			const bytes = await downloadAssetBytes(
				asset.gcsObjectKey,
				ASSET_SIZE_CAPS_BYTES.image,
				runtime?.signal,
			);
			return {
				type: "file",
				mediaType: asset.mimeType,
				url: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
				filename: ref.filename,
			};
		} catch {
			runtime?.signal?.throwIfAborted();
			return textPart(
				`<<Attachment ${ref.filename} (image) couldn't be loaded. Re-attach it if you still need it.>>`,
			);
		}
	}

	if (isDocumentKind(asset.kind)) {
		try {
			const { text, truncated } = await ensureExtract(
				asset,
				asset.kind,
				condenser,
				onProgress,
				runtime,
			);
			return textPart(wrapAttachment(ref.filename, text, truncated));
		} catch (error) {
			runtime?.signal?.throwIfAborted();
			if (
				runtime?.prepare &&
				!(error instanceof DocumentExtractUnavailableError)
			)
				throw error;
			return textPart(
				`<<Attachment ${ref.filename} couldn't be read. Retry preparation in the Library, or choose another source. The uploaded file is still saved.>>`,
			);
		}
	}

	// audio/video aren't chat attachment kinds (CHAT_ATTACHMENT_KINDS excludes
	// them); defensively note rather than drop if one ever arrives.
	return textPart(
		`<<Attachment ${ref.filename} (${asset.kind}) can't be read as a document.>>`,
	);
}

/**
 * Resolve every message's attachment refs into appended parts. Returns a fresh
 * array; messages without refs pass through untouched. Each referenced asset is
 * loaded + resolved exactly once (deduped by id) and its resolved part reused
 * wherever the ref appears, so cross-turn repeats cost one GCS read and stay
 * byte-identical.
 */
export async function resolveAttachments(
	messages: NovaUIMessage[],
	projectId: string,
	condenser: AttachmentCondenser,
	/** Live read-progress (output char deltas) forwarded to each document's
	 *  extraction, so the chat route can pulse the signal grid while the SEND-time
	 *  backstop reads a not-yet-extracted document. Fires only when the backstop
	 *  runs the model — a reused/awaited eager extraction emits nothing here. */
	onProgress?: (deltaChars: number) => void,
	runtime?: SourceDocumentRuntime,
	/** New inputs were read before the run was claimed. Historical misses alone
	 * may degrade to placeholders; admitted input is never read a second time. */
	admittedSources: AdmittedSources = new Map(),
): Promise<NovaUIMessage[]> {
	// Unique asset ids across the whole history.
	const ids = new Set<MediaAssetId>();
	for (const m of messages) {
		for (const ref of refsOf(m)) ids.add(ref.assetId);
	}
	if (ids.size === 0) return messages;

	// Only historical refs reach this batch. New source admission already failed
	// closed on storage errors, before a claim, and supplies its verified bytes.
	// Historical misses stay visible as placeholders in later edit context.
	let records: MediaAssetRecord[] = [];
	try {
		const unresolvedIds = [...ids].filter((id) => !admittedSources.has(id));
		if (unresolvedIds.length > 0)
			records = await loadAssetsByIds(unresolvedIds, projectId);
	} catch (err) {
		log.error("[resolveAttachments] batch asset load failed", err, {
			projectId,
			count: ids.size,
		});
	}
	const assetById = new Map<MediaAssetId, MediaAssetRecord>(
		records.map((r) => [r.id, r]),
	);

	// Resolve each unique asset once. Cache the promise so the same id referenced
	// in multiple messages shares a single resolution (and a single GCS read).
	const resolvedById = new Map<string, Promise<Part>>();
	const partFor = (ref: AttachmentRef): Promise<Part> => {
		const admitted = admittedSources.get(ref.assetId);
		if (admitted) {
			if (
				admitted.asset.project_id !== projectId ||
				admitted.asset.kind !== ref.kind
			)
				throw new Error("Admitted attachment scope changed");
			const content = admitted.content;
			return Promise.resolve(
				content.kind === "document"
					? textPart(
							wrapAttachment(ref.filename, content.text, content.truncated),
						)
					: {
							type: "file",
							mediaType: content.mediaType,
							url: content.dataUrl,
							filename: ref.filename,
						},
			);
		}
		let p = resolvedById.get(ref.assetId);
		if (!p) {
			p = resolveRef(
				ref,
				assetById.get(asMediaAssetId(ref.assetId)),
				condenser,
				onProgress,
				runtime,
			);
			resolvedById.set(ref.assetId, p);
		}
		return p;
	};

	return Promise.all(
		messages.map(async (m) => {
			const refs = refsOf(m);
			if (refs.length === 0) return m;
			const appended = await Promise.all(refs.map(partFor));
			return { ...m, parts: [...m.parts, ...appended] };
		}),
	);
}
