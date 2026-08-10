/**
 * The design source package — the ONE boundary that turns a thread's
 * messages and attachments into model input for the design pipeline
 * (plan §6.14).
 *
 * Two shapes, deliberately:
 *
 *  - `DesignSourcePackage` is the IN-MEMORY projection the author and
 *    reviewer calls consume: bounded message blocks, bounded attachment
 *    extracts, image projections, and the platform-constraint entries,
 *    every block labeled with its opaque source reference. `packageDigest`
 *    is the canonical digest over this exact projection (image bytes bound
 *    through their content digest, not re-hashed base64) — the proof of
 *    what the models saw.
 *  - `persistedSourcePackageSchema` is what `design_source_packages` rows
 *    store: the digest, the normalized claims, and the labeled source
 *    INDEX. Raw extracts, transcripts, and attachment bodies are never
 *    duplicated into design tables — the reference is the persisted fact,
 *    and re-reading the material goes through its own authorized boundary.
 *
 * `buildDesignSourcePackage` is the builder: it walks the caller-authorized
 * transcript's USER messages, resolves attachment references against the
 * Project (`loadAssetsByIds` filters cross-Project ids out, and a reference
 * that does not resolve is a loud error — design evidence is never silently
 * dropped), reads document extracts through the existing single-flight
 * extraction store, bounds every projection by explicit per-source and
 * total limits, and REJECTS an over-bound source honestly instead of
 * silently clipping the tail away.
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
import {
	PLATFORM_CONSTRAINTS,
	type PlatformConstraint,
} from "@/lib/agent/design/platformConstraints";
import {
	attachmentRefSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	asMediaAssetId,
	type DocumentKind,
	EXTRACTOR_VERSION,
	isDocumentKind,
	type MediaAssetId,
	mediaAssetIdSchema,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/* ---- bounds ------------------------------------------------------- */

/** Per-part clip for a user message's text. */
export const MAX_REQUEST_BLOCK_CHARS = 20_000;
/** Per-document clip for a projected extract. */
export const MAX_ATTACHMENT_EXTRACT_CHARS = 80_000;
/** How many document attachments one design source may carry. */
export const MAX_DOCUMENT_ATTACHMENTS = 8;
/** How many image attachments one design source may carry. */
export const MAX_IMAGE_ATTACHMENTS = 4;
/** Ceiling for the whole projected text (request blocks + extracts). */
export const MAX_TOTAL_PROJECTED_CHARS = 400_000;
/** Per-image byte ceiling for the vision projection. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The source material cannot be projected within the design bounds — the
 *  honest rejection (§22.11): never silently drop evidence. */
export class SourcePackageError extends Error {
	readonly name = "SourcePackageError";
}

/* ---- shapes ------------------------------------------------------- */

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
		/** True when the projection clipped the part at its per-part bound. */
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
		/** True when the stored extract was itself truncated OR the
		 *  projection clipped it at its bound. */
		truncated: z.boolean(),
	})
	.strict();
export type AuthorizedAttachmentProjection = z.infer<
	typeof authorizedAttachmentProjectionSchema
>;

/** One authorized image, content-bound by its byte digest. The `dataUrl`
 *  is transport for the model call; the digest is what the package digest
 *  covers. */
export interface AuthorizedImage {
	assetId: MediaAssetId;
	mediaType: string;
	filename: string;
	bytesDigest: string;
	dataUrl: string;
}

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
	images: AuthorizedImage[];
	platformConstraints: PlatformConstraint[];
	/** The labeled index of every projected source — request blocks, document
	 *  extracts, and images — as the closed set of references a reviewer may
	 *  cite (plus catalog constraints). An image's entry carries the digest of
	 *  the exact bytes projected, so a citation binds to that content. */
	sources: Array<{ ref: z.infer<typeof sourceRefSchema> }>;
}

/** A claim seeded by the source projection itself (deterministic
 *  normalization, e.g. from an answered question round) — same shape as an
 *  authored claim. */
export type SourceClaimSeed = z.infer<typeof sourceClaimSchema>;

/** What `design_source_packages.payload` stores: references and normalized
 *  claims only — no extract bodies, no transcripts, no image bytes. */
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
		imageCount: z.number().int().nonnegative(),
		projectedBytes: z.number().int().nonnegative(),
	})
	.strict();
export type PersistedSourcePackage = z.infer<
	typeof persistedSourcePackageSchema
>;

/* ---- digest ------------------------------------------------------- */

/**
 * The canonical digest over the exact in-memory projection: everything
 * except the digest field itself, with each image reduced to its identity +
 * content digest (the base64 transport is bound through `bytesDigest`, not
 * re-hashed).
 */
export function computeSourcePackageDigest(
	pkg: Omit<DesignSourcePackage, "packageDigest">,
): string {
	return canonicalJsonDigest({
		...pkg,
		images: pkg.images.map(({ dataUrl: _transport, ...identity }) => identity),
	});
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
		imageCount: pkg.images.length,
		projectedBytes,
	});
}

/* ---- builder ------------------------------------------------------ */

/** The injectable resource seams. The production seams live in
 *  `sourcePackageDeps.ts` — a separate module on purpose: the extraction
 *  store's import graph carries the office parsers (mammoth's bluebird
 *  allocates a promise at module load), and this pure builder must stay
 *  importable without them. */
export interface SourcePackageDeps {
	loadAssets(
		ids: readonly MediaAssetId[],
		projectId: string,
	): Promise<MediaAssetRecord[]>;
	readExtract(
		asset: MediaAssetRecord,
		kind: DocumentKind,
	): Promise<{ text: string; truncated: boolean }>;
	loadImage(
		asset: MediaAssetRecord,
	): Promise<{ mediaType: string; dataUrl: string; bytesDigest: string }>;
}

export interface BuildSourcePackageArgs {
	designSessionId: string;
	projectId: string;
	threadId: string;
	/** The caller-authorized transcript (the caller resolved the thread
	 *  through its own authority; this boundary never loads threads). */
	messages: readonly NovaUIMessage[];
	/** Deterministically seeded claims (e.g. from an answered question
	 *  round); the author mints the rest. */
	claims?: readonly SourceClaimSeed[];
	deps: SourcePackageDeps;
}

/**
 * Build the bounded, digest-sealed source package. Throws
 * `SourcePackageError` when the source cannot be projected honestly:
 * no user request text, more attachments than the bounds admit, an
 * attachment that no longer resolves in the Project, or a total
 * projection over the ceiling.
 */
export async function buildDesignSourcePackage(
	args: BuildSourcePackageArgs,
): Promise<DesignSourcePackage> {
	const blocks: ResolvedRequestBlock[] = [];
	const documentRefs: Array<{
		assetId: MediaAssetId;
		filename: string;
		kind: DocumentKind;
	}> = [];
	const imageRefs: Array<{ assetId: MediaAssetId; filename: string }> = [];
	const seenAssets = new Set<string>();

	for (const message of args.messages) {
		if (message.role !== "user") continue;
		message.parts.forEach((part, partIndex) => {
			if (part.type !== "text") return;
			const text = part.text.trim();
			if (text.length === 0) return;
			blocks.push({
				ref: {
					kind: "message",
					threadId: args.threadId,
					messageId: message.id,
					partIndex,
				},
				text: text.slice(0, MAX_REQUEST_BLOCK_CHARS),
				truncated: text.length > MAX_REQUEST_BLOCK_CHARS,
			});
		});
		for (const raw of message.metadata?.attachments ?? []) {
			const parsed = attachmentRefSchema.safeParse(raw);
			if (!parsed.success) {
				log.warn("[sourcePackage] skipping malformed attachment ref", {
					threadId: args.threadId,
					messageId: message.id,
				});
				continue;
			}
			const ref = parsed.data;
			if (seenAssets.has(ref.assetId)) continue;
			seenAssets.add(ref.assetId);
			if (isDocumentKind(ref.kind)) {
				documentRefs.push({
					assetId: asMediaAssetId(ref.assetId),
					filename: ref.filename,
					kind: ref.kind,
				});
			} else {
				imageRefs.push({
					assetId: asMediaAssetId(ref.assetId),
					filename: ref.filename,
				});
			}
		}
	}

	if (blocks.length === 0) {
		throw new SourcePackageError(
			"The conversation contains no user request text to design from — a design source needs at least one user message.",
		);
	}
	if (documentRefs.length > MAX_DOCUMENT_ATTACHMENTS) {
		throw new SourcePackageError(
			`This request carries ${documentRefs.length} documents, but a design source is bounded at ${MAX_DOCUMENT_ATTACHMENTS}. Remove documents (or consolidate them) so every source can actually be read.`,
		);
	}
	if (imageRefs.length > MAX_IMAGE_ATTACHMENTS) {
		throw new SourcePackageError(
			`This request carries ${imageRefs.length} images, but a design source is bounded at ${MAX_IMAGE_ATTACHMENTS}. Remove images so every source can actually be read.`,
		);
	}

	const assetIds = [...documentRefs, ...imageRefs].map((ref) => ref.assetId);
	const assets = await args.deps.loadAssets(assetIds, args.projectId);
	const assetById = new Map(assets.map((asset) => [asset.id as string, asset]));
	const requireAsset = (assetId: string, filename: string) => {
		const asset = assetById.get(assetId);
		if (!asset) {
			throw new SourcePackageError(
				`The attachment "${filename}" is no longer available in this Project, so it cannot ground the design. Remove it from the request or re-attach it.`,
			);
		}
		return asset;
	};

	const attachments: AuthorizedAttachmentProjection[] = [];
	for (const ref of documentRefs) {
		const asset = requireAsset(ref.assetId, ref.filename);
		const extract = await args.deps.readExtract(asset, ref.kind);
		const text = extract.text.trim();
		if (text.length === 0) {
			throw new SourcePackageError(
				`The document "${ref.filename}" produced an empty extract — it holds nothing a design can be grounded on.`,
			);
		}
		attachments.push(
			authorizedAttachmentProjectionSchema.parse({
				assetId: ref.assetId,
				extractorVersion: EXTRACTOR_VERSION,
				filename: ref.filename,
				title: asset.extract?.title,
				summary: asset.extract?.summary,
				extract: text.slice(0, MAX_ATTACHMENT_EXTRACT_CHARS),
				truncated:
					extract.truncated || text.length > MAX_ATTACHMENT_EXTRACT_CHARS,
			}),
		);
	}

	/* The text ceiling depends only on blocks + extracts, so it runs BEFORE
	 * the image downloads — an over-bound source must not pay for megabytes
	 * of image bytes just to be rejected. */
	const totalChars =
		blocks.reduce((sum, block) => sum + block.text.length, 0) +
		attachments.reduce((sum, a) => sum + a.extract.length, 0);
	if (totalChars > MAX_TOTAL_PROJECTED_CHARS) {
		throw new SourcePackageError(
			`The projected source material is ${totalChars.toLocaleString()} characters, over the ${MAX_TOTAL_PROJECTED_CHARS.toLocaleString()} design ceiling. Trim the request or its documents so the whole source can be read together.`,
		);
	}

	const images: AuthorizedImage[] = [];
	for (const ref of imageRefs) {
		const asset = requireAsset(ref.assetId, ref.filename);
		const image = await args.deps.loadImage(asset);
		images.push({
			assetId: ref.assetId,
			mediaType: image.mediaType,
			filename: ref.filename,
			bytesDigest: image.bytesDigest,
			dataUrl: image.dataUrl,
		});
	}

	const unsealed: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: args.designSessionId,
		projectId: args.projectId,
		request: { blocks },
		claims: (args.claims ?? []).map((claim) => sourceClaimSchema.parse(claim)),
		attachments,
		images,
		platformConstraints: Object.values(PLATFORM_CONSTRAINTS),
		sources: [
			...blocks.map((block) => ({ ref: block.ref })),
			...attachments.map((attachment) => ({
				ref: {
					kind: "attachment-extract" as const,
					assetId: attachment.assetId,
					extractorVersion: attachment.extractorVersion,
					sectionPath: [],
				},
			})),
			...images.map((image) => ({
				ref: {
					kind: "image" as const,
					assetId: image.assetId,
					bytesDigest: image.bytesDigest,
				},
			})),
		],
	};
	return { ...unsealed, packageDigest: computeSourcePackageDigest(unsealed) };
}
