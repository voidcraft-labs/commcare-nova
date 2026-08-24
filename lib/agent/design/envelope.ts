/**
 * The immutable design-artifact envelope — the metadata wrapper every
 * persisted design artifact rides in (plan §6.12).
 *
 * `artifactDigest` is the canonical-JS digest (`lib/utils/canonicalJson.ts`)
 * over every authoritative envelope field EXCEPT the digest itself — never
 * `JSON.stringify` of a live object with implementation-dependent key order.
 * Producer metadata is operational provenance, not a determinism claim. Raw
 * prompts, raw model output, hidden reasoning, provider response bodies, and
 * source documents are never stored in an envelope.
 *
 * An artifact row is insert-only: `accepted`, `superseded`, and `active` are
 * relationships or pointers stored elsewhere, never mutations of the body.
 * A prompt/schema version change produces a NEW artifact revision; it never
 * silently reinterprets an old persisted JSONB body.
 */

import { z } from "zod";
import type { DesignComplexityEvidence } from "@/lib/agent/design/complexity";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);

export const DESIGN_ARTIFACT_TYPES = [
	"design-contract",
	"design-review",
	"design-build-plan",
] as const;
export type DesignArtifactType = (typeof DESIGN_ARTIFACT_TYPES)[number];

export const artifactProducerSchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		finishReason: z.string().nullable(),
	})
	.strict();
export type ArtifactProducer = z.infer<typeof artifactProducerSchema>;

/** The deterministic complexity evidence persisted with a contract draft
 *  (plan §7.4 — the depth decision is auditable). Optional: only contract
 *  envelopes carry it. */
export const designComplexityEvidenceSchema = z
	.object({
		score: z.number().int().nonnegative(),
		components: z.record(z.string(), z.union([z.number(), z.boolean()])),
		depth: z.enum(["compact", "standard", "extended"]),
		algorithmVersion: z.union([z.literal(1), z.literal(2)]),
	})
	.strict();

/**
 * The envelope schema, bound to one artifact type and payload schema. Every
 * producer and reader of a given artifact family shares the schema this
 * factory returns; unknown keys fail closed.
 */
export function designArtifactEnvelopeSchema<T extends z.ZodTypeAny>(
	artifactType: DesignArtifactType,
	payload: T,
) {
	return z
		.object({
			artifactType: z.literal(artifactType),
			artifactSchemaVersion: z.number().int().positive(),
			artifactId: z.string().uuid(),
			artifactDigest: sha256HexSchema,
			designSessionId: z.string().uuid(),
			revision: z.number().int().positive(),
			parentArtifactId: z.string().uuid().nullable(),
			sourcePackageDigest: sha256HexSchema,
			inputArtifactDigests: z.array(sha256HexSchema),
			promptVersion: z.string().min(1),
			producer: artifactProducerSchema,
			createdAt: z.string().datetime(),
			/** Deterministic complexity evidence — contract envelopes only. */
			complexity: designComplexityEvidenceSchema.optional(),
			payload,
		})
		.strict();
}

export interface DesignArtifactEnvelope<P> {
	artifactType: DesignArtifactType;
	artifactSchemaVersion: number;
	artifactId: string;
	artifactDigest: string;
	designSessionId: string;
	revision: number;
	parentArtifactId: string | null;
	sourcePackageDigest: string;
	inputArtifactDigests: string[];
	promptVersion: string;
	producer: ArtifactProducer;
	createdAt: string;
	complexity?: DesignComplexityEvidence;
	payload: P;
}

/** Everything the digest covers — the envelope minus its own digest. */
export type UnsealedDesignArtifactEnvelope<P> = Omit<
	DesignArtifactEnvelope<P>,
	"artifactDigest"
>;

/** Canonical digest over the unsealed envelope. */
export function computeArtifactDigest<P>(
	unsealed: UnsealedDesignArtifactEnvelope<P>,
): string {
	return canonicalJsonDigest(unsealed);
}

/** Seal an envelope: compute and attach its digest. */
export function sealArtifactEnvelope<P>(
	unsealed: UnsealedDesignArtifactEnvelope<P>,
): DesignArtifactEnvelope<P> {
	return { ...unsealed, artifactDigest: computeArtifactDigest(unsealed) };
}

export class DesignArtifactIntegrityError extends Error {
	readonly name = "DesignArtifactIntegrityError";
}

/**
 * Verify a (parsed) envelope's digest against its own content. Every store
 * write verifies before insert and every read verifies after parse — a
 * digest mismatch is integrity corruption, never something to repair in
 * place.
 */
export function verifyArtifactEnvelope<P>(
	envelope: DesignArtifactEnvelope<P>,
): void {
	const { artifactDigest, ...unsealed } = envelope;
	const computed = computeArtifactDigest(unsealed);
	if (computed !== artifactDigest) {
		throw new DesignArtifactIntegrityError(
			`The ${envelope.artifactType} artifact ${envelope.artifactId} does not match its recorded digest — its stored body has drifted from what was sealed. Refuse the artifact and investigate; never repair a digest in place.`,
		);
	}
}
