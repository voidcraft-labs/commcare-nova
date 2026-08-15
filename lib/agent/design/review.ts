/** Independent review and blocking-finding dispositions for Design v1. */

import { z } from "zod";
import {
	type AppDesignContract,
	appDesignContractSchema,
	collectContractIds,
} from "@/lib/agent/design/contract";
import { type SourceRef, sourceRefSchema } from "@/lib/agent/design/evidence";
import { designIdSchema } from "@/lib/agent/design/ids";
import { deriveFindingHandleBindings } from "@/lib/agent/design/reviewVocabulary";

export const designFindingSeveritySchema = z.enum([
	"critical",
	"important",
	"advisory",
]);
export type DesignFindingSeverity = z.infer<typeof designFindingSeveritySchema>;

/** What happens next: a design correction blocks at critical/important
 * severity, an unresolved user decision always blocks, and a note (readiness
 * work outside construction, or an optional improvement) never does. */
export const designFindingDispositionClassSchema = z.enum([
	"design-correction",
	"user-decision",
	"note",
]);
export type DesignFindingDispositionClass = z.infer<
	typeof designFindingDispositionClassSchema
>;

export const designFindingSchema = z
	.object({
		id: designIdSchema,
		severity: designFindingSeveritySchema,
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
		dispositionClass: DesignFindingDispositionClass;
		evidenceRefs: SourceRef[];
		affectedElementIds: string[];
	},
	ctx: z.RefinementCtx,
): void {
	const gatedSeverity =
		finding.severity === "critical" || finding.severity === "important";
	if (
		gatedSeverity &&
		finding.evidenceRefs.length === 0 &&
		finding.affectedElementIds.length === 0
	) {
		ctx.addIssue({
			code: "custom",
			path: ["evidenceRefs"],
			message:
				"A critical or important finding must ground itself: cite the exact source or platform constraint that establishes it, or name the affected contract elements when the contract contradicts itself.",
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

export const findingDispositionSchema = z
	.object({
		findingId: designIdSchema,
		status: z.enum(["accepted", "rejected", "deferred"]),
		rationale: z.string().min(1),
	})
	.strict();
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
	/* Every issue names the finding by its printed `@f` handle — the model's
	 * only vocabulary for findings. A positional `dispositions.<index>` path
	 * alone reads as a finding number and sends the correction at the wrong
	 * entry, and each wrong removal reindexes the array so the next rejection
	 * moves the target (observed live as a nonconvergent three-strike chase). */
	const handles = new Map(
		deriveFindingHandleBindings(reviews).map((binding) => [
			binding.designId,
			binding.handle,
		]),
	);
	const nameFinding = (findingId: string) => handles.get(findingId);
	const required = new Set(
		[...findings.values()]
			.filter(findingBlocksAcceptance)
			.map((finding) => finding.id),
	);
	const seen = new Set<string>();
	result.dispositions.forEach((disposition, index) => {
		const finding = findings.get(disposition.findingId);
		if (finding === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", index, "findingId"],
				message:
					"This disposition names a finding that does not exist on this review. Remove it, and disposition only the blocking findings by their printed @f handles.",
			});
			return;
		}
		if (!findingBlocksAcceptance(finding)) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", index, "findingId"],
				message: `The finding ${nameFinding(finding.id) ?? finding.id} does not block acceptance, and only blocking design corrections and unresolved user decisions receive dispositions. Remove the disposition whose findingId is ${nameFinding(finding.id) ?? finding.id}.`,
			});
			return;
		}
		if (seen.has(disposition.findingId)) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", index, "findingId"],
				message: `The blocking finding ${nameFinding(finding.id) ?? finding.id} already has a disposition; a blocking finding may be dispositioned only once. Remove the duplicate.`,
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
			disposition.status === "deferred" &&
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
				message: `The blocking finding ${nameFinding(id) ?? id} has no disposition yet, and every blocking finding requires exactly one.`,
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
