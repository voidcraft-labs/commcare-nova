// lib/agent/resolveAttachments.ts
//
// Server-side resolution of chat attachment REFERENCES into model-ready content,
// the replacement for the legacy in-request `prepareAttachments` base64 path.
// The composer sends asset-id refs in message metadata; this walks EVERY message
// (not just the last) and appends, per ref:
//
//   - document (pdf/text/docx/xlsx) → the stored requirements EXTRACT as a text
//     part. The extract is normally produced eagerly at upload; if it isn't
//     ready (or is a stale version), a lazy backstop extracts it inline here and
//     persists it for reuse — so a turn never blocks on a missing extract.
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
// The lazy backstop extracts through the chat run's own `GenerationContext` (an
// `AttachmentCondenser`), so a backstop extraction is usage-tracked like any
// other sub-generation; the eager upload route uses the standalone Gemini
// condenser instead. Both call the one `extractDocument` core.

import type { AttachmentRef, NovaUIMessage } from "@/lib/chat/attachmentRefs";
import {
	loadAssetsByIds,
	type MediaAssetRecord,
	setAssetExtractStatus,
} from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	type AssetId,
	asAssetId,
	type DocumentKind,
	extractGcsObjectKeyFor,
	isDocumentKind,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import {
	downloadAssetBytes,
	readTextObject,
	writeTextObject,
} from "@/lib/storage/media";
import {
	type AttachmentCondenser,
	CONDENSER_MODEL,
	EXTRACT_MAX_BYTES,
	EXTRACTOR_VERSION,
	extractDocument,
	wrapAttachment,
} from "./documentExtraction";

type Part = NovaUIMessage["parts"][number];

const textPart = (text: string): Part => ({ type: "text", text });

/** Read this message's attachment refs (empty when none / not a user message). */
function refsOf(message: NovaUIMessage): AttachmentRef[] {
	return message.metadata?.attachments ?? [];
}

/**
 * Count the document attachments on the LAST user message — the new turn's docs.
 * The chat route uses this to bracket the resolve step with the "Reading your
 * documents" status only when there's a document to read (images resolve
 * instantly; a turn with none does no narrate-worthy work).
 */
export function countAttachments(messages: NovaUIMessage[]): number {
	const last = messages.at(-1);
	if (!last || last.role !== "user") return 0;
	return refsOf(last).filter((r) => isDocumentKind(r.kind)).length;
}

/**
 * The document's requirements extract: the stored text if a current-version
 * extract exists, else a lazy inline extraction (persisted best-effort for the
 * next turn). Throws on a hard failure — the caller turns that into a placeholder
 * so the attachment is never silently dropped.
 */
async function ensureExtract(
	asset: MediaAssetRecord,
	documentKind: DocumentKind,
	condenser: AttachmentCondenser,
): Promise<{ text: string; truncated: boolean }> {
	const key = extractGcsObjectKeyFor(
		asset.owner,
		asset.contentHash,
		EXTRACTOR_VERSION,
	);
	const stored = await readTextObject(key, EXTRACT_MAX_BYTES);
	if (stored !== null) {
		return { text: stored, truncated: asset.extract?.truncated ?? false };
	}

	// Backstop: no current-version extract (the eager upload-time job hasn't run,
	// is still running, failed, or is a stale version). Extract inline so the SA
	// gets the content THIS turn, and persist it so later turns reuse it.
	const bytes = await downloadAssetBytes(
		asset.gcsObjectKey,
		ASSET_SIZE_CAPS_BYTES[asset.kind],
	);
	const { text, truncated } = await extractDocument({
		bytes,
		mimeType: asset.mimeType,
		kind: documentKind,
		filename: asset.originalFilename,
		condenser,
	});
	// Best-effort persistence — a write failure must not fail the turn (we already
	// have the text the SA needs). The eager route owns the durable path.
	await writeTextObject(key, text).catch(() => undefined);
	await setAssetExtractStatus(asset.id, {
		status: "ready",
		version: EXTRACTOR_VERSION,
		model: CONDENSER_MODEL,
		truncated,
		charCount: text.length,
	}).catch(() => undefined);
	return { text, truncated };
}

/**
 * Resolve ONE ref to a single model-ready part. Self-contained + failure-safe:
 * any error (missing/foreign asset, decode/extract failure) resolves to a
 * placeholder text part rather than throwing, so a bad attachment never breaks
 * the turn and the SA always learns it was present.
 */
async function resolveRef(
	ref: AttachmentRef,
	asset: MediaAssetRecord | undefined,
	condenser: AttachmentCondenser,
): Promise<Part> {
	if (!asset) {
		return textPart(
			`<<Attachment ${ref.filename} couldn't be loaded — it may have been deleted. Re-attach it if you still need it.>>`,
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
		`<<Attachment ${ref.filename} (${asset.kind}) can't be read by the assistant.>>`,
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
	ownerId: string,
	condenser: AttachmentCondenser,
): Promise<NovaUIMessage[]> {
	// Unique asset ids across the whole history.
	const ids = new Set<string>();
	for (const m of messages) {
		for (const ref of refsOf(m)) ids.add(ref.assetId);
	}
	if (ids.size === 0) return messages;

	// One owner-gated batch load; a foreign/missing id is simply absent from the
	// map (→ placeholder), never leaked. A TOTAL load failure (a Firestore
	// outage) must not throw out of here — that would fail the whole turn from a
	// spot outside the route's try/finally, losing the usage + log flush and
	// breaking the never-drop invariant. Degrade to an empty map so every ref
	// becomes a placeholder, exactly as a per-asset miss does; the SA still
	// learns an attachment was present, and the run completes + flushes normally.
	let records: MediaAssetRecord[] = [];
	try {
		records = await loadAssetsByIds(ownerId, [...ids]);
	} catch (err) {
		log.error("[resolveAttachments] batch asset load failed", {
			ownerId,
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
			p = resolveRef(ref, assetById.get(asAssetId(ref.assetId)), condenser);
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
