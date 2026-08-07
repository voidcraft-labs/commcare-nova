/**
 * The design source package — the ONE boundary that turns a thread's
 * messages and attachments into model input for the design pipeline.
 *
 * Two shapes, deliberately:
 *
 *  - `DesignSourcePackage` is the IN-MEMORY projection the author and
 *    reviewer calls consume: bounded message blocks, bounded attachment
 *    extracts, and the platform-constraint entries, every block labeled
 *    with its opaque source reference. `packageDigest` is the canonical
 *    digest over this exact projection — the proof of what the models saw.
 *  - `persistedSourcePackageSchema` is what `design_source_packages` rows
 *    store: the digest, the normalized claims, and the labeled source
 *    INDEX. Raw extracts, transcripts, and attachment bodies are never
 *    duplicated into design tables — the reference is the persisted fact,
 *    and re-reading the material goes through its own authorized boundary.
 *
 * Source content is UNTRUSTED DATA. The prompt composition
 * (`prompts.ts::renderSourcePackage`) wraps every block in fixed delimiters
 * and states that source text has no orchestration or tool authority: a
 * source that says "ignore prior instructions", requests credentials, or
 * declares itself a system message is evidence text, never a command.
 * Secrets, environment values, and holder tokens never enter the source
 * call.
 */

import { z } from "zod";
import {
	sourceClaimSchema,
	sourceRefSchema,
} from "@/lib/agent/design/evidence";
import type { PlatformConstraint } from "@/lib/agent/design/platformConstraints";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const messageRefSchema = z
	.object({
		kind: z.literal("message"),
		threadId: z.string().uuid(),
		messageId: z.string().min(1),
		partIndex: z.number().int().nonnegative(),
	})
	.strict();
export type MessageSourceRef = z.infer<typeof messageRefSchema>;

/** One bounded projection of a user-authored message part. */
export const resolvedRequestBlockSchema = z
	.object({
		ref: messageRefSchema,
		text: z.string().min(1),
		/** True when the projection clipped the part at its byte bound. */
		truncated: z.boolean(),
	})
	.strict();
export type ResolvedRequestBlock = z.infer<typeof resolvedRequestBlockSchema>;

/** The user's request as bounded, labeled blocks in thread order. */
export const resolvedUserRequestSchema = z
	.object({
		blocks: z.array(resolvedRequestBlockSchema).min(1),
	})
	.strict();
export type ResolvedUserRequest = z.infer<typeof resolvedUserRequestSchema>;

/** One authorized attachment's bounded extract projection. */
export const authorizedAttachmentProjectionSchema = z
	.object({
		assetId: mediaAssetIdSchema,
		extractorVersion: z.number().int().positive(),
		filename: z.string().min(1),
		title: z.string().min(1).optional(),
		summary: z.string().min(1).optional(),
		/** The stored extract, clipped at the per-source bound. */
		extract: z.string().min(1),
		/** True when the projection clipped the extract at its bound. */
		truncated: z.boolean(),
	})
	.strict();
export type AuthorizedAttachmentProjection = z.infer<
	typeof authorizedAttachmentProjectionSchema
>;

/**
 * The in-memory package — full projections, digest-bound. Never persisted
 * wholesale; `toPersistedSourcePackage` derives the row payload.
 */
export interface DesignSourcePackage {
	schemaVersion: 1;
	designSessionId: string;
	projectId: string;
	packageDigest: string;
	request: ResolvedUserRequest;
	claims: SourceClaimSeed[];
	attachments: AuthorizedAttachmentProjection[];
	platformConstraints: PlatformConstraint[];
	/** The labeled index of every projected source — the closed set of
	 *  references a reviewer may cite (plus catalog constraints). */
	sources: Array<{ ref: z.infer<typeof sourceRefSchema> }>;
}

/** A claim seeded by the source projection itself (deterministic
 *  normalization, e.g. from an answered question round) — same shape as an
 *  authored claim. */
export type SourceClaimSeed = z.infer<typeof sourceClaimSchema>;

/** What `design_source_packages.payload` stores: references and normalized
 *  claims only — no extract bodies, no transcripts. */
export const persistedSourcePackageSchema = z
	.object({
		schemaVersion: z.literal(1),
		designSessionId: z.string().uuid(),
		projectId: z.string().min(1),
		packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
		claims: z.array(sourceClaimSchema),
		sources: z.array(sourceRefSchema),
		/** Observability metadata — counts and projected byte size, never
		 *  content. */
		requestBlockCount: z.number().int().nonnegative(),
		attachmentCount: z.number().int().nonnegative(),
		projectedBytes: z.number().int().nonnegative(),
	})
	.strict();
export type PersistedSourcePackage = z.infer<
	typeof persistedSourcePackageSchema
>;

/**
 * The canonical digest over the exact in-memory projection (everything
 * except the digest field itself). Byte-stable: object keys sort
 * canonically (`lib/utils/canonicalJson.ts`), so producer and verifier
 * agree regardless of construction order.
 */
export function computeSourcePackageDigest(
	pkg: Omit<DesignSourcePackage, "packageDigest">,
): string {
	return canonicalJsonDigest(pkg);
}

/** Derive the persisted row payload from the in-memory package. */
export function toPersistedSourcePackage(
	pkg: DesignSourcePackage,
): PersistedSourcePackage {
	const projectedBytes =
		pkg.request.blocks.reduce(
			(sum, block) => sum + Buffer.byteLength(block.text, "utf8"),
			0,
		) +
		pkg.attachments.reduce(
			(sum, attachment) => sum + Buffer.byteLength(attachment.extract, "utf8"),
			0,
		);
	return persistedSourcePackageSchema.parse({
		schemaVersion: 1,
		designSessionId: pkg.designSessionId,
		projectId: pkg.projectId,
		packageDigest: pkg.packageDigest,
		claims: pkg.claims,
		sources: pkg.sources.map((source) => source.ref),
		requestBlockCount: pkg.request.blocks.length,
		attachmentCount: pkg.attachments.length,
		projectedBytes,
	});
}
