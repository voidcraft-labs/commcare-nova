// lib/agent/resolveAttachments.ts
//
// Server-side resolution of chat attachment REFERENCES into model-ready content,
// the replacement for the legacy in-request `prepareAttachments` base64 path.
// The composer sends asset-id refs in message metadata; this walks EVERY message
// (not just the last) and appends, per ref:
//
//   - document (pdf/text/docx/xlsx) → the stored requirements EXTRACT as a text
//     part, resolved through the shared single-flight store. The extract is
//     normally produced eagerly when the document is attached; if it isn't ready
//     yet, the store either waits on that in-flight job and reuses its result,
//     or (when none is running) extracts inline — so a turn never blocks on a
//     missing extract and never double-runs the model.
//   - image → the bytes as a data-URL file part for the model's vision pass.
//
// Walking all messages is what fixes the multi-turn crash: history carries refs
// + resolved text, never raw `text/markdown` file parts Anthropic rejects.
//
// Two invariants:
//   - Never mutate the input array; return fresh messages.
//   - Never DROP an attachment — every failure path appends a human-readable
//     placeholder so the SA always learns the attachment existed.
//
// Determinism: a resolved part is a pure function of the asset (stable extract
// text for a version, stable image bytes), and each asset resolves exactly once
// per pass (deduped by id). So re-resolving history every turn produces
// byte-identical prefixes — the prompt-cache the chat route engineers for stays
// hit.
//
// When the store runs the extraction here (no eager job to reuse), it does so
// through the chat run's own `GenerationContext` (an `AttachmentCondenser`), so
// that inline run is usage-tracked like any other sub-generation; the eager
// route passes the standalone Gemini condenser instead. Reusing an in-flight
// job's result meters nothing — only an actual inline run does.

import {
	type AttachmentRef,
	documentNeedsRead,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	type AssetId,
	asAssetId,
	type DocumentKind,
	isDocumentKind,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { downloadAssetBytes } from "@/lib/storage/media";
import { type AttachmentCondenser, wrapAttachment } from "./documentExtraction";
import { ensureStoredExtract } from "./documentExtractionStore";

type Part = NovaUIMessage["parts"][number];

const textPart = (text: string): Part => ({ type: "text", text });

/** Read this message's attachment refs (empty when none / not a user message). */
function refsOf(message: NovaUIMessage): AttachmentRef[] {
	return message.metadata?.attachments ?? [];
}

/**
 * Count the document attachments on the LAST user message that still NEED reading
 * — a document whose extract wasn't ready when it was attached (`documentNeedsRead`).
 * The chat route uses this to bracket the resolve step with the "Reading your
 * documents" status ONLY when a document will actually block the first Opus token
 * on extraction. A document Nova already read resolves from its stored extract
 * instantly, so it doesn't count — which is what stops every doc-bearing turn from
 * flashing the status over already-read files. Images resolve instantly too and
 * never count.
 */
export function countDocumentsNeedingRead(messages: NovaUIMessage[]): number {
	const last = messages.at(-1);
	if (last?.role !== "user") return 0;
	return refsOf(last).filter(documentNeedsRead).length;
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
): Promise<{ text: string; truncated: boolean }> {
	const result = await ensureStoredExtract({
		asset,
		documentKind,
		condenser,
		onInflight: "wait",
		// Live read-progress (signal grid) — fires only when the backstop actually
		// runs the model here; the common reuse/wait-on-eager-job path emits nothing.
		onProgress,
	});
	if (result.status === "ready") {
		return { text: result.text, truncated: result.truncated };
	}
	// "wait" never returns "extracting"; "failed" is a genuine condense failure.
	throw new Error(
		result.status === "failed"
			? result.reason
			: "extraction did not resolve to a ready extract",
	);
}

/**
 * Resolve ONE ref to a single model-ready part. Self-contained + failure-safe:
 * any error (missing/out-of-Project asset, decode/extract failure) resolves to a
 * placeholder text part rather than throwing, so a bad attachment never breaks
 * the turn and the SA always learns it was present.
 */
async function resolveRef(
	ref: AttachmentRef,
	asset: MediaAssetRecord | undefined,
	condenser: AttachmentCondenser,
	onProgress?: (deltaChars: number) => void,
): Promise<Part> {
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

	if (asset.kind === "image") {
		try {
			const bytes = await downloadAssetBytes(
				asset.gcsObjectKey,
				ASSET_SIZE_CAPS_BYTES.image,
			);
			return {
				type: "file",
				mediaType: asset.mimeType,
				url: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
				filename: ref.filename,
			};
		} catch {
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
			);
			return textPart(wrapAttachment(ref.filename, text, truncated));
		} catch {
			return textPart(
				`<<Attachment ${ref.filename} couldn't be read. Re-attach it, or paste the key details into the chat.>>`,
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
): Promise<NovaUIMessage[]> {
	// Unique asset ids across the whole history.
	const ids = new Set<string>();
	for (const m of messages) {
		for (const ref of refsOf(m)) ids.add(ref.assetId);
	}
	if (ids.size === 0) return messages;

	// One Project-gated batch load; an out-of-Project/missing id is simply absent
	// from the map (→ placeholder), never leaked. A TOTAL load failure (a Firestore
	// outage) must not throw out of here — that would fail the whole turn from a
	// spot outside the route's try/finally, losing the usage + log flush and
	// breaking the never-drop invariant. Degrade to an empty map so every ref
	// becomes a placeholder, exactly as a per-asset miss does; the SA still
	// learns an attachment was present, and the run completes + flushes normally.
	let records: MediaAssetRecord[] = [];
	try {
		records = await loadAssetsByIds([...ids], projectId);
	} catch (err) {
		log.error("[resolveAttachments] batch asset load failed", {
			projectId,
			count: ids.size,
			err,
		});
	}
	const assetById = new Map<AssetId, MediaAssetRecord>(
		records.map((r) => [r.id, r]),
	);

	// Resolve each unique asset once. Cache the promise so the same id referenced
	// in multiple messages shares a single resolution (and a single GCS read).
	const resolvedById = new Map<string, Promise<Part>>();
	const partFor = (ref: AttachmentRef): Promise<Part> => {
		let p = resolvedById.get(ref.assetId);
		if (!p) {
			p = resolveRef(
				ref,
				assetById.get(asAssetId(ref.assetId)),
				condenser,
				onProgress,
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
