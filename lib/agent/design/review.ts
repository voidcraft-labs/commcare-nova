/** Independent review and blocking-finding dispositions for Design v1. */

import { z } from "zod";
import {
	type AppDesignContract,
	appDesignContractSchema,
	collectContractIds,
} from "@/lib/agent/design/contract";
import { type SourceRef, sourceRefSchema } from "@/lib/agent/design/evidence";
import { designIdSchema } from "@/lib/agent/design/ids";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";

export const designFindingCategorySchema = z.enum([
	"requirement-coverage",
	"workflow-gap",
	"data-model",
	"access-and-actor",
	"privacy-and-sensitivity",
	"usability",
	"unsupported-assumption",
	"unnecessary-complexity",
	"platform-constraint",
]);
export type DesignFindingCategory = z.infer<typeof designFindingCategorySchema>;

export const designFindingSeveritySchema = z.enum([
	"critical",
	"important",
	"advisory",
]);
export type DesignFindingSeverity = z.infer<typeof designFindingSeveritySchema>;

export const designFindingBasisSchema = z.enum([
	"source-supported",
	"contract-internal",
	"platform-constraint",
	"heuristic",
]);
export type DesignFindingBasis = z.infer<typeof designFindingBasisSchema>;

export const designFindingDispositionClassSchema = z.enum([
	"design-correction",
	"user-decision",
	"external-readiness",
	"runtime-readiness",
	"deployment-readiness",
	"advisory",
]);
export type DesignFindingDispositionClass = z.infer<
	typeof designFindingDispositionClassSchema
>;

export const designFindingSchema = z
	.object({
		id: designIdSchema,
		category: designFindingCategorySchema,
		severity: designFindingSeveritySchema,
		basis: designFindingBasisSchema,
		dispositionClass: designFindingDispositionClassSchema,
		claim: z.string().min(1),
		/** The review is the contract's only attribution surface. */
		evidenceRefs: z.array(sourceRefSchema),
		affectedElementIds: z.array(designIdSchema),
		proposedResolution: z.string().min(1).optional(),
	})
	.strict()
	.superRefine(validateFindingEvidence);
export type DesignFinding = z.infer<typeof designFindingSchema>;

export function findingBlocksAcceptance(finding: DesignFinding): boolean {
	if (finding.dispositionClass === "user-decision") return true;
	return (
		finding.dispositionClass === "design-correction" &&
		(finding.severity === "critical" || finding.severity === "important")
	);
}

export function validateFindingEvidence(
	finding: {
		severity: DesignFindingSeverity;
		basis: DesignFindingBasis;
		dispositionClass: DesignFindingDispositionClass;
		evidenceRefs: SourceRef[];
		affectedElementIds: string[];
	},
	ctx: z.RefinementCtx,
): void {
	const gatedSeverity =
		finding.severity === "critical" || finding.severity === "important";
	if (finding.basis === "heuristic" && finding.severity === "critical") {
		ctx.addIssue({
			code: "custom",
			path: ["severity"],
			message: "A heuristic finding cannot be critical.",
		});
	}
	if (gatedSeverity && finding.evidenceRefs.length === 0) {
		ctx.addIssue({
			code: "custom",
			path: ["evidenceRefs"],
			message:
				"A critical or important finding must cite the exact source or platform constraint that supports it.",
		});
	}
	if (!gatedSeverity && finding.evidenceRefs.length > 0) {
		ctx.addIssue({
			code: "custom",
			path: ["evidenceRefs"],
			message:
				"Advisory findings do not carry source attribution; reserve citations for critical and important outcomes.",
		});
	}
	if (
		finding.basis === "platform-constraint" &&
		!finding.evidenceRefs.some((ref) => ref.kind === "platform-constraint")
	) {
		ctx.addIssue({
			code: "custom",
			path: ["evidenceRefs"],
			message: "A platform finding must cite a catalogued constraint.",
		});
	}
	if (
		finding.dispositionClass === "advisory" &&
		finding.severity !== "advisory"
	) {
		ctx.addIssue({
			code: "custom",
			path: ["dispositionClass"],
			message: "An advisory classification must have advisory severity.",
		});
	}
}

export const designReviewSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: designIdSchema,
		summary: z.string().min(1),
		findings: z.array(designFindingSchema),
	})
	.strict();
export type DesignReview = z.infer<typeof designReviewSchema>;

export function designReviewSchemaFor(
	contract: AppDesignContract,
	sourcePackage: DesignSourcePackage,
) {
	const knownIds = collectContractIds(contract);
	const allowed = allowedSourceRefKeys(sourcePackage);
	return designReviewSchema.superRefine((review, ctx) => {
		review.findings.forEach((finding, findingIndex) => {
			finding.affectedElementIds.forEach((id, index) => {
				if (!knownIds.has(id)) {
					ctx.addIssue({
						code: "custom",
						path: ["findings", findingIndex, "affectedElementIds", index],
						message:
							"This finding names an element absent from the reviewed design.",
					});
				}
			});
			finding.evidenceRefs.forEach((ref, index) => {
				if (
					ref.kind !== "platform-constraint" &&
					!allowed.has(sourceRefKey(ref))
				) {
					ctx.addIssue({
						code: "custom",
						path: ["findings", findingIndex, "evidenceRefs", index],
						message:
							"This citation is not part of the exact source package under review.",
					});
				}
			});
		});
	});
}

export const findingDispositionSchema = z
	.object({
		findingId: designIdSchema,
		status: z.enum([
			"accepted",
			"rejected-with-rationale",
			"deferred-with-user-visible-consequence",
		]),
		rationale: z.string().min(1),
		userVisibleConsequence: z.string().min(1).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.status === "deferred-with-user-visible-consequence" &&
			value.userVisibleConsequence === undefined
		) {
			ctx.addIssue({
				code: "custom",
				path: ["userVisibleConsequence"],
				message:
					"An unresolved user decision must state its visible consequence.",
			});
		}
	});
export type FindingDisposition = z.infer<typeof findingDispositionSchema>;

export const designRevisionResultSchema = z
	.object({
		contract: appDesignContractSchema,
		dispositions: z.array(findingDispositionSchema),
	})
	.strict();
export type DesignRevisionResult = z.infer<typeof designRevisionResultSchema>;

export function designRevisionResultSchemaFor(
	reviews: readonly DesignReview[],
) {
	return designRevisionResultSchema.superRefine((result, ctx) =>
		validateDispositionClosure(result, reviews, ctx),
	);
}

export function validateDispositionClosure(
	result: DesignRevisionResult,
	reviews: readonly DesignReview[],
	ctx: z.RefinementCtx,
): void {
	const findings = new Map(
		reviews
			.flatMap((review) => review.findings)
			.map((finding) => [finding.id, finding]),
	);
	const required = new Set(
		[...findings.values()]
			.filter(findingBlocksAcceptance)
			.map((finding) => finding.id),
	);
	const seen = new Set<string>();
	result.dispositions.forEach((disposition, index) => {
		const finding = findings.get(disposition.findingId);
		if (finding === undefined || !findingBlocksAcceptance(finding)) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", index, "findingId"],
				message:
					"Only blocking design corrections and unresolved user decisions receive dispositions.",
			});
			return;
		}
		if (seen.has(disposition.findingId)) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", index, "findingId"],
				message: "A blocking finding may be dispositioned only once.",
			});
		}
		seen.add(disposition.findingId);
		const relatedBlockingQuestions = result.contract.openQuestions.filter(
			(question) =>
				question.blocking &&
				(finding.affectedElementIds.length === 0 ||
					question.relatedElementIds.some((id) =>
						finding.affectedElementIds.includes(id),
					)),
		);
		if (
			finding.dispositionClass === "user-decision" &&
			disposition.status === "accepted" &&
			relatedBlockingQuestions.length > 0
		) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", index, "status"],
				message:
					"A user decision is not resolved while the revised contract still carries a blocking question.",
			});
		}
		if (
			finding.dispositionClass === "user-decision" &&
			disposition.status === "deferred-with-user-visible-consequence" &&
			relatedBlockingQuestions.length === 0
		) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", index, "status"],
				message:
					"A deferred user decision must remain represented by a related blocking question.",
			});
		}
	});
	for (const id of required) {
		if (!seen.has(id)) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions"],
				message: "Every blocking finding requires exactly one disposition.",
			});
		}
	}
}

export function validateSensitivityNotSilentlyLowered(
	parent: AppDesignContract,
	result: DesignRevisionResult,
	reviews: readonly DesignReview[] = [],
): string[] {
	const rank = { ordinary: 0, sensitive: 1, "highly-sensitive": 2 } as const;
	const parentProperties = new Map(
		parent.records.flatMap((record) =>
			record.properties.map((property) => [property.id, property] as const),
		),
	);
	const resolvedFindingIds = new Set(
		result.dispositions
			.filter((disposition) => disposition.status === "accepted")
			.map((disposition) => disposition.findingId),
	);
	const justifiedPropertyIds = new Set(
		reviews.flatMap((review) =>
			review.findings
				.filter((finding) => resolvedFindingIds.has(finding.id))
				.flatMap((finding) => finding.affectedElementIds),
		),
	);
	return result.contract.records.flatMap((record) =>
		record.properties.flatMap((property) => {
			const before = parentProperties.get(property.id);
			return before !== undefined &&
				rank[property.sensitivity] < rank[before.sensitivity] &&
				!justifiedPropertyIds.has(property.id)
				? [
						`The property "${property.name}" was quietly downgraded from ${before.sensitivity} to ${property.sensitivity}.`,
					]
				: [];
		}),
	);
}

export { collectContractIds };

function sourceRefKey(ref: SourceRef): string {
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

function allowedSourceRefKeys(
	sourcePackage: DesignSourcePackage,
): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const source of sourcePackage.sources)
		keys.add(sourceRefKey(source.ref));
	for (const claim of sourcePackage.claims) {
		for (const ref of claim.sourceRefs) keys.add(sourceRefKey(ref));
	}
	return keys;
}
