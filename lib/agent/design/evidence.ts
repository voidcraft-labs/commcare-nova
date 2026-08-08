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
 * One normalized requirement claim. The `statement` is the normalized
 * requirement in Nova's own words — never a raw excerpt, unless an exact
 * label/choice/value is itself the requirement. `status` is the epistemic
 * grade: `explicit` claims restate what the source says and MUST carry a
 * message, attachment, or image reference — the three kinds that point at
 * what the user actually provided; `inferred` claims are derived from source
 * material; `assumption` claims fill a gap the source leaves open. A claim
 * grounded only in platform knowledge uses a `platform-constraint`
 * reference.
 */
export const sourceClaimSchema = z
	.object({
		id: designIdSchema,
		statement: z.string().min(1),
		sourceRefs: z.array(sourceRefSchema).min(1),
		status: z.enum(["explicit", "inferred", "assumption"]),
		confidence: z.number().min(0).max(1),
	})
	.strict()
	.superRefine((claim, ctx) => {
		if (
			claim.status === "explicit" &&
			!claim.sourceRefs.some(
				(ref) =>
					ref.kind === "message" ||
					ref.kind === "attachment-extract" ||
					ref.kind === "image",
			)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["sourceRefs"],
				message:
					"An explicit claim restates what the user provided, so it needs a message, attachment, or image source reference — a platform-constraint reference alone supports an inferred claim or an assumption, not an explicit one.",
			});
		}
	});
export type SourceClaim = z.infer<typeof sourceClaimSchema>;
