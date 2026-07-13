// lib/chat/attachmentRefs.ts
//
// The canonical shape for a chat attachment: a REFERENCE to a stored media
// asset, not its bytes. One shape flows across every surface — the live message
// metadata the composer sends, the event-log manifest, and the stored-thread
// record — so a single render path (ChatMessage reading `metadata.attachments`)
// draws the chip regardless of where the message came from, and the chip always
// has what it needs to open a preview (the `assetId` + `kind`).
//
// Why metadata, not file parts: attachments live in the per-owner media store
// now. The chat carries asset-id refs, and the server resolves each ref to the
// stored requirements EXTRACT (documents) or the image bytes (vision). This
// kills the old base64-in-the-request path (and the blob/CSP corruption it
// caused) and fixes the multi-turn crash — history carries refs + resolved
// text, never the raw `text/markdown` file parts the provider rejects.

import type { UIMessage } from "ai";
import { z } from "zod";
import {
	ASSET_KINDS,
	DOCUMENT_KINDS,
	isDocumentKind,
} from "@/lib/domain/multimedia";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./limits";

/**
 * A reference to one attached asset. `assetId` is the durable pointer (the
 * bytes live at `/api/media/{assetId}`, the extract at
 * `/api/media/{assetId}/extract`); `kind` drives how the server resolves it and
 * how the chip renders; `filename` + `mimeType` + `title` + `summary` are
 * display-only. No URL is stored — it's derived from `assetId`, so the ref can't
 * drift from the route layout.
 *
 * Every string field is length-capped. The metadata rides untrusted from the
 * client and is re-resolved server-side every turn (and persisted into the event
 * log), so the caps bound both the I/O each ref drives and the log bloat a
 * crafted request could inject. The ceilings sit well above legitimate values:
 * an asset id is a UUID (36 chars), filenames + MIME types are short, and an
 * extracted title is ~ten words / a summary two-to-four sentences.
 */
export const attachmentRefSchema = z.object({
	assetId: z.string().min(1).max(128),
	kind: z.enum(ASSET_KINDS),
	filename: z.string().min(1).max(255),
	mimeType: z.string().min(1).max(255),
	/** A document's extracted title/summary, snapshotted at attach time so the
	 *  transcript chip's preview header has them the instant it opens — no fetch.
	 *  Display-only (the server re-derives what it needs from `assetId`); absent
	 *  for media and for a document not yet extracted when it was attached. */
	title: z.string().max(200).optional(),
	summary: z.string().max(2_000).optional(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/**
 * Whether a DOCUMENT attachment still needs reading (extraction) at send time —
 * the gate for the "Reading your documents" status, so it shows ONLY for a real
 * wait, never as a flash over a document Nova has already read.
 *
 * The readiness proxy is the ref's `title`: the composer snapshots a title onto
 * the ref only from a `ready` extract, and the extraction store writes the GCS
 * extract object BEFORE it marks the status ready — so a `ready` snapshot implies
 * the extract object exists, which is exactly the condition that makes the
 * send-time resolve a fast stored-extract read. A document ref WITHOUT a title is
 * therefore the only case where the resolve can actually block on the summarizer.
 * A document already read (title present), or any non-document, needs no reading.
 *
 * The one accepted decoupling is an `EXTRACTOR_VERSION` bump between attach and
 * send (a deploy mid-composer-session): the ref carries an old-version title while
 * the new-version extract object is absent, so the resolve re-extracts with no
 * status shown. That degrades to the pre-signal baseline (no progress feedback
 * during a rare re-extract), never worse — so the title proxy is the proportionate
 * gate rather than a server round-trip per send.
 */
export function documentNeedsRead(ref: AttachmentRef): boolean {
	return isDocumentKind(ref.kind) && !ref.title;
}

/**
 * Per-message metadata the composer attaches via `sendMessage({ text, metadata })`.
 * The AI SDK rides it on the `UIMessage` and POSTs the whole message, so the
 * route reads `body.messages[i].metadata.attachments` and the refs persist in
 * history across turns — which is what lets the server re-resolve every turn's
 * attachments (not just the last), closing the multi-turn gap. The per-message
 * array is capped (`MAX_ATTACHMENTS_PER_MESSAGE`); the request-wide total is the
 * stronger bound, enforced by `validateChatMessages`.
 */
export const messageMetadataSchema = z.object({
	attachments: z
		.array(attachmentRefSchema)
		.max(MAX_ATTACHMENTS_PER_MESSAGE)
		.optional(),
});
export type NovaMessageMetadata = z.infer<typeof messageMetadataSchema>;

/** The app's `UIMessage`, carrying Nova's attachment metadata. Typing the chat
 *  with this is what makes `sendMessage`'s `metadata` field accept our shape. */
export type NovaUIMessage = UIMessage<NovaMessageMetadata>;

/**
 * Asset kinds the chat composer accepts: images (read directly by the model's
 * vision pass) plus the library-only document kinds (condensed to a requirements
 * extract). Deliberately NOT audio/video — those are CommCare carriers, not
 * things the Solutions Architect reads. Passed to `MediaPickerDialog` as the
 * allowed `kinds`.
 */
export const CHAT_ATTACHMENT_KINDS = ["image", ...DOCUMENT_KINDS] as const;
