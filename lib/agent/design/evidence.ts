/**
 * Source evidence — the pointer vocabulary that ties every Design Contract
 * statement back to authorized source material.
 *
 * A source reference is a POINTER, never a copy: message references name a
 * thread/message/part coordinate, attachment references name an asset's
 * versioned extract coordinate, and platform references name a catalogued
 * constraint code. Raw source bodies, transcripts, and model reasoning are
 * never duplicated into design artifacts — the reference is what persists,
 * and reading the material back goes through its own authorized boundary.
 *
 * Source CONTENT is untrusted data everywhere it appears (the source-package
 * builder's delimiter contract, `sourcePackage.ts`): a reference proves where
 * a claim came from; it grants no orchestration or tool authority.
 */

import { z } from "zod";
import { designIdSchema } from "@/lib/agent/design/ids";
import { PLATFORM_CONSTRAINT_CODES } from "@/lib/agent/design/platformConstraints";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";

/**
 * One opaque pointer into authorized source material.
 *
 * - `message` — a part of one durable thread message (`threads.messages`
 *   coordinates: the client-minted thread UUID, the message id, and the
 *   part index within the message's `parts` array).
 * - `attachment-extract` — a location inside one media asset's stored
 *   document extract, keyed by the extractor version that produced it.
 *   `sectionPath` names the `##` section headings down to the cited text;
 *   `figureMarker` names a `<nova:figure index="N"/>` marker when the cited
 *   content is a figure finding.
 * - `platform-constraint` — a catalogued Nova/CommCare platform fact. The
 *   `code` is closed (`platformConstraints.ts`); `sourceAnchor` names the
 *   repository/doc anchor that states the constraint.
 * - `image` — one projected image, named by its asset id and the digest of
 *   the exact bytes the model was shown. A requirement visible only in an
 *   attached image cites the image itself; the digest binds the citation to
 *   that content, so re-projected or replaced bytes never inherit it.
 */
export const sourceRefSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("message"),
			threadId: z.string().uuid(),
			messageId: z.string().min(1),
			partIndex: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("attachment-extract"),
			assetId: mediaAssetIdSchema,
			extractorVersion: z.number().int().positive(),
			sectionPath: z.array(z.string().min(1)).default([]),
			figureMarker: z.string().min(1).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("platform-constraint"),
			code: z.enum(PLATFORM_CONSTRAINT_CODES),
			sourceAnchor: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("image"),
			assetId: mediaAssetIdSchema,
			/** SHA-256 of the exact projected image bytes — binds the citation to
			 *  the content the model actually saw. */
			bytesDigest: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.strict(),
]);
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * The canonical identity key of one source reference — the coordinate that
 * makes two references "the same citation". Attachment `sectionPath` /
 * `figureMarker` deliberately stay out of the key: they narrow WHERE inside
 * an extract a citation points, not WHICH source it cites.
 */
export function sourceRefKey(ref: SourceRef): string {
	switch (ref.kind) {
		case "message":
			return `message:${ref.threadId}:${ref.messageId}:${ref.partIndex}`;
		case "attachment-extract":
			return `attachment:${ref.assetId}:${ref.extractorVersion}`;
		case "platform-constraint":
			return `platform:${ref.code}`;
		case "image":
			return `image:${ref.assetId}:${ref.bytesDigest}`;
	}
}

/**
 * One normalized requirement claim: a statement in Nova's own words plus the
 * source coordinates that carry it. Claims are DETERMINISTIC SERVER OUTPUT —
 * the answered-question seeding in `loop/claimSeeding.ts` is the only
 * producer, so the shape holds exactly what that producer states and its
 * consumers read (the claims dump in the prompts, the citable-ref set). No
 * epistemic-status grade and no confidence score: one producer hardcoded
 * both, nothing read either, and the author prompt itself forbids
 * confidence scores.
 */
export const sourceClaimSchema = z
	.object({
		id: designIdSchema,
		statement: z.string().min(1),
		sourceRefs: z.array(sourceRefSchema).min(1),
	})
	.strict();
export type SourceClaim = z.infer<typeof sourceClaimSchema>;
