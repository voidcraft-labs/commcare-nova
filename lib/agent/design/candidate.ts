import { z } from "zod";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** The only design information stored beside the executable Blueprint. */
export const designBriefV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		appName: z.string().min(1),
		objective: z.string().min(1),
		decisions: z.array(z.string().min(1)),
		externalRequirements: z.array(z.string().min(1)),
		unsupportedRequests: z.array(z.string().min(1)),
		openQuestions: z.array(z.string().min(1)),
	})
	.strict();

export type DesignBriefV1 = z.infer<typeof designBriefV1Schema>;

export const blueprintCoordinateSchema = z
	.object({
		kind: z.enum([
			"app",
			"module",
			"form",
			"field",
			"case-type",
			"case-property",
			"case-operation",
			"case-list",
			"search",
			"user-type",
			"persona",
			"organization",
			"automation",
			"external-requirement",
		]),
		ref: z.string().min(1),
	})
	.strict();

export const candidateReviewFindingSchema = z
	.object({
		id: z.string().min(1),
		severity: z.enum(["critical", "important", "advisory"]),
		category: z.enum([
			"requirement-coverage",
			"workflow",
			"data-model",
			"access",
			"privacy",
			"usability",
			"capability-boundary",
			"external-readiness",
			"unnecessary-complexity",
		]),
		claim: z.string().min(1),
		proposedResolution: z.string().min(1).optional(),
		affected: z.array(blueprintCoordinateSchema),
	})
	.strict();

export const candidateReviewSchema = z
	.object({
		schemaVersion: z.literal(1),
		summary: z.string().min(1),
		findings: z.array(candidateReviewFindingSchema),
	})
	.strict();

export type CandidateReview = z.infer<typeof candidateReviewSchema>;

export function candidateReviewBlocksAcceptance(
	review: CandidateReview,
): boolean {
	return review.findings.some(
		(finding) =>
			finding.severity === "critical" || finding.severity === "important",
	);
}

export function designBriefDigest(brief: DesignBriefV1): string {
	return canonicalJsonDigest(designBriefV1Schema.parse(brief));
}
