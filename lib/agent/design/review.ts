/**
 * Design review and finding dispositions — the reviewer's typed critique of
 * one exact contract revision, and the reviser's typed resolution of it.
 *
 * The reviewer CANNOT rewrite the contract: a review is findings only, and
 * every critical/important finding must later carry exactly one disposition
 * (`validateDispositionClosure`). Grounding is enforced at parse time:
 * severity is earned by basis — a heuristic can never be critical, a
 * source-supported critical finding must point at authorized evidence, a
 * platform-constraint critical finding must cite a catalogued code.
 *
 * Two schema layers, deliberately:
 *  - the STRUCTURAL schemas (`designReviewSchema`,
 *    `designRevisionResultSchema`) carry every self-contained rule and are
 *    what persisted reads parse — digest binding proves a stored artifact
 *    unchanged since its validated write;
 *  - the FACTORY schemas (`designReviewSchemaFor`,
 *    `designRevisionResultSchemaFor`) additionally bind the cross-artifact
 *    rules (intent existence in the reviewed revision, evidence membership
 *    in the reviewed source package, disposition closure over the review
 *    passes) into the parse, so an ungrounded model response is an invalid
 *    structured output — retriable, never persisted.
 *
 * One rule is deliberately prompt-enforced rather than schema-enforced: "a
 * rejected source-supported finding contains a contradiction/evidence
 * rationale, not 'model disagreed'" judges prose, which no deterministic
 * layer can do honestly. The reviser prompt states it; the disposition
 * schema requires a nonempty rationale and nothing stronger.
 */

import { z } from "zod";
import {
	type AppDesignContract,
	appDesignContractRepairSchema,
	appDesignContractSchema,
} from "@/lib/agent/design/contract";
import { type SourceRef, sourceRefSchema } from "@/lib/agent/design/evidence";
import { designIdSchema } from "@/lib/agent/design/ids";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";

export const designFindingCategorySchema = z.enum([
	"requirement-coverage",
	"workflow-gap",
	"data-model",
	"read-write-coherence",
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

export const designFindingSchema = z
	.object({
		id: designIdSchema,
		category: designFindingCategorySchema,
		severity: designFindingSeveritySchema,
		basis: designFindingBasisSchema,
		claim: z.string().min(1),
		evidenceRefs: z.array(sourceRefSchema),
		affectedIntentIds: z.array(designIdSchema),
		proposedResolution: z.string().min(1).optional(),
		confidence: z.number().min(0).max(1),
	})
	.strict()
	.superRefine(validateFindingEvidence);
export type DesignFinding = z.infer<typeof designFindingSchema>;

/**
 * The self-contained grounding rules — severity is earned by basis:
 *  - a heuristic finding is never critical;
 *  - a source-supported critical/important finding carries a message,
 *    attachment, or image reference — one of the three kinds that point at
 *    what the user actually provided;
 *  - a platform-constraint finding carries a catalogued constraint
 *    reference (the code enum in `sourceRefSchema` closes the vocabulary);
 *  - a contract-internal critical finding names the contradicting intents;
 *  - a missing-intent flag (empty `affectedIntentIds`) is tied to evidence.
 */
export function validateFindingEvidence(
	finding: {
		severity: DesignFindingSeverity;
		basis: DesignFindingBasis;
		evidenceRefs: SourceRef[];
		affectedIntentIds: string[];
	},
	ctx: z.RefinementCtx,
): void {
	const gated =
		finding.severity === "critical" || finding.severity === "important";
	if (finding.basis === "heuristic" && finding.severity === "critical") {
		ctx.addIssue({
			code: "custom",
			path: ["severity"],
			message:
				"A heuristic finding cannot be critical — critical severity requires source, contract-internal, or platform grounding. Downgrade it, or ground it.",
		});
	}
	if (finding.basis === "source-supported" && gated) {
		const sourced = finding.evidenceRefs.some(
			(ref) =>
				ref.kind === "message" ||
				ref.kind === "attachment-extract" ||
				ref.kind === "image",
		);
		if (!sourced) {
			ctx.addIssue({
				code: "custom",
				path: ["evidenceRefs"],
				message:
					"A source-supported critical or important finding must point at the message, attachment, or image evidence that supports it.",
			});
		}
	}
	if (finding.basis === "platform-constraint") {
		const cited = finding.evidenceRefs.some(
			(ref) => ref.kind === "platform-constraint",
		);
		if (!cited) {
			ctx.addIssue({
				code: "custom",
				path: ["evidenceRefs"],
				message:
					"A platform-constraint finding must cite a catalogued constraint code as evidence.",
			});
		}
	}
	if (
		finding.basis === "contract-internal" &&
		finding.severity === "critical" &&
		finding.affectedIntentIds.length === 0
	) {
		ctx.addIssue({
			code: "custom",
			path: ["affectedIntentIds"],
			message:
				"A contract-internal critical finding claims the contract contradicts itself — name the contradicting intents.",
		});
	}
	if (
		finding.affectedIntentIds.length === 0 &&
		finding.evidenceRefs.length === 0
	) {
		ctx.addIssue({
			code: "custom",
			path: ["evidenceRefs"],
			message:
				"A finding that names no affected intent is flagging something MISSING — tie it to the evidence that shows what is missing.",
		});
	}
}

/** The reviewer's structured output: findings plus a short overall reading.
 *  No contract rewrite, no dispositions — those are the reviser's. */
export const designReviewSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: designIdSchema,
		summary: z.string().min(1),
		findings: z.array(designFindingSchema),
	})
	.strict();
export type DesignReview = z.infer<typeof designReviewSchema>;

/**
 * The parse-time reviewer schema, bound to the exact reviewed inputs:
 * a finding cannot cite an intent absent from the reviewed revision, and its
 * source evidence must belong to the reviewed source package (platform
 * references are catalog-owned and always citable).
 */
export function designReviewSchemaFor(
	contract: AppDesignContract,
	sourcePackage: DesignSourcePackage,
) {
	const knownIds = collectContractIds(contract);
	const allowed = allowedSourceRefKeys(sourcePackage);
	return designReviewSchema.superRefine((review, ctx) => {
		review.findings.forEach((finding, i) => {
			finding.affectedIntentIds.forEach((id, j) => {
				if (!knownIds.has(id)) {
					ctx.addIssue({
						code: "custom",
						path: ["findings", i, "affectedIntentIds", j],
						message:
							"This finding cites an intent id that does not exist in the reviewed contract revision. Cite ids from the revision under review, or leave the list empty for a missing-intent finding.",
					});
				}
			});
			finding.evidenceRefs.forEach((ref, j) => {
				if (ref.kind === "platform-constraint") return;
				if (!allowed.has(sourceRefKey(ref))) {
					ctx.addIssue({
						code: "custom",
						path: ["findings", i, "evidenceRefs", j],
						message:
							"This evidence reference does not belong to the reviewed source package. Cite only the sources that were actually provided for review.",
					});
				}
			});
		});
	});
}

/* ------------------------------------------------------------------ */
/* Dispositions                                                        */
/* ------------------------------------------------------------------ */

export const findingDispositionSchema = z
	.object({
		findingId: designIdSchema,
		status: z.enum([
			"accepted",
			"rejected-with-rationale",
			"deferred-with-user-visible-consequence",
		]),
		rationale: z.string().min(1),
		resultingIntentIds: z.array(designIdSchema),
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
				message: "A deferred finding must state its user-visible consequence.",
			});
		}
		if (value.status === "accepted" && value.resultingIntentIds.length === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["resultingIntentIds"],
				message:
					"An accepted finding must name the changed or newly linked intents that resolve it — acceptance with no resulting change resolves nothing.",
			});
		}
	});
export type FindingDisposition = z.infer<typeof findingDispositionSchema>;

/** The reviser's structural output: the revised contract plus one
 *  disposition per required finding. Cross-review closure lives in the
 *  factory (`designRevisionResultSchemaFor`). */
export const designRevisionResultSchema = z
	.object({
		contract: appDesignContractSchema,
		dispositions: z.array(findingDispositionSchema),
	})
	.strict();
export type DesignRevisionResult = z.infer<typeof designRevisionResultSchema>;

/** Top-level retry patch for the immediately preceding rejected revision.
 * Dispositions replace as one closed set when supplied; the contract patch
 * replaces only its named top-level slots. */
export const designRevisionRepairSchema = z
	.object({
		contract: appDesignContractRepairSchema.optional(),
		dispositions: z.array(findingDispositionSchema).optional(),
	})
	.strict()
	.refine(
		(repair) =>
			repair.contract !== undefined || repair.dispositions !== undefined,
		{
			message:
				"A revision repair must replace the contract, the dispositions, or both.",
		},
	);

/** First submission after review may patch the persisted parent rather than
 * re-emitting every unchanged contract collection. Dispositions remain a
 * complete closed set; the composed whole revision takes every proof below. */
export const designRevisionPatchSchema = z
	.object({
		contract: appDesignContractRepairSchema.optional(),
		dispositions: z.array(findingDispositionSchema),
	})
	.strict();

/**
 * The parse-time reviser schema, bound to every review pass of the parent
 * draft. `validateDispositionClosure` proves:
 *  - every critical/important finding across those passes has exactly one
 *    disposition;
 *  - no disposition names an unknown finding;
 *  - accepted resolutions point at intents that exist in the REVISED
 *    contract;
 *  - a deferred CRITICAL finding surfaces in the revised contract as a
 *    blocking open question or an explicitly deferred requirement — it can
 *    never be silently hidden from completion policy.
 */
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
	const findingsById = new Map<string, DesignFinding>();
	for (const review of reviews) {
		for (const finding of review.findings) {
			findingsById.set(finding.id, finding);
		}
	}
	const required = new Set(
		[...findingsById.values()]
			.filter((f) => f.severity === "critical" || f.severity === "important")
			.map((f) => f.id),
	);
	const seen = new Set<string>();
	const revisedIds = collectContractIds(result.contract);
	const blockingQuestionIds = new Set(
		result.contract.openQuestions.filter((q) => q.blocking).map((q) => q.id),
	);
	const deferredClaimIds = new Set(
		result.contract.deferredRequirements.map((d) => d.claimId),
	);

	result.dispositions.forEach((disposition, i) => {
		const finding = findingsById.get(disposition.findingId);
		if (finding === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", i, "findingId"],
				message:
					"This disposition names a finding that no review pass raised. Disposition exactly the reviewer's findings.",
			});
			return;
		}
		if (seen.has(disposition.findingId)) {
			ctx.addIssue({
				code: "custom",
				path: ["dispositions", i, "findingId"],
				message:
					"This finding already has a disposition — each finding is dispositioned exactly once.",
			});
			return;
		}
		seen.add(disposition.findingId);
		disposition.resultingIntentIds.forEach((id, j) => {
			if (!revisedIds.has(id)) {
				ctx.addIssue({
					code: "custom",
					path: ["dispositions", i, "resultingIntentIds", j],
					message:
						"A resulting intent must exist in the revised contract — this id resolves to nothing there.",
				});
			}
		});
		if (
			disposition.status === "deferred-with-user-visible-consequence" &&
			finding.severity === "critical"
		) {
			const surfaced = disposition.resultingIntentIds.some(
				(id) => blockingQuestionIds.has(id) || deferredClaimIds.has(id),
			);
			if (!surfaced) {
				ctx.addIssue({
					code: "custom",
					path: ["dispositions", i, "resultingIntentIds"],
					message:
						"Deferring a CRITICAL finding must leave a visible trace: point the disposition at a blocking open question or an explicitly deferred requirement in the revised contract, so completion policy cannot miss it.",
				});
			}
		}
	});
	for (const findingId of required) {
		if (!seen.has(findingId)) {
			const finding = findingsById.get(findingId);
			ctx.addIssue({
				code: "custom",
				path: ["dispositions"],
				message: `The ${finding?.severity ?? "required"} finding "${truncate(
					finding?.claim ?? findingId,
				)}" has no disposition. Every critical and important finding must be accepted, rejected with rationale, or deferred with its user-visible consequence.`,
			});
		}
	}
}

/**
 * The revision-pair sensitivity rule (§ design-graph validation's one
 * cross-revision clause): a reviser may not LOWER a fact's declared
 * sensitivity unless a dispositioned finding drove the change — the
 * disposition (and through it the finding's evidence) is the rationale.
 */
export function validateSensitivityNotSilentlyLowered(
	parent: AppDesignContract,
	result: DesignRevisionResult,
): string[] {
	const rank = { ordinary: 0, sensitive: 1, "highly-sensitive": 2 } as const;
	const changedByDisposition = new Set(
		result.dispositions.flatMap((d) => d.resultingIntentIds),
	);
	const parentFacts = new Map(parent.facts.map((fact) => [fact.id, fact]));
	const violations: string[] = [];
	for (const fact of result.contract.facts) {
		const before = parentFacts.get(fact.id);
		if (!before) continue;
		if (
			rank[fact.sensitivity] < rank[before.sensitivity] &&
			!changedByDisposition.has(fact.id)
		) {
			violations.push(
				`The fact "${fact.name}" was quietly downgraded from ${before.sensitivity} to ${fact.sensitivity}. Lowering sensitivity needs a dispositioned finding naming this fact — otherwise the revision keeps the parent's grade.`,
			);
		}
	}
	return violations;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Every design id the contract carries, nested ids included — the "does
 *  this id exist in this revision" oracle the factories share. */
export function collectContractIds(
	contract: AppDesignContract,
): ReadonlySet<string> {
	const ids = new Set<string>([contract.id]);
	for (const claim of contract.sourceClaims) ids.add(claim.id);
	for (const actor of contract.actors) ids.add(actor.id);
	for (const record of contract.records) ids.add(record.id);
	for (const fact of contract.facts) ids.add(fact.id);
	for (const rule of contract.rules) ids.add(rule.id);
	for (const task of contract.tasks) {
		ids.add(task.id);
		for (const input of task.inputs) ids.add(input.id);
		for (const write of task.writes) ids.add(write.id);
	}
	for (const transition of contract.transitions) {
		ids.add(transition.id);
		for (const write of transition.writes) ids.add(write.id);
	}
	for (const model of contract.readModels) ids.add(model.id);
	for (const table of contract.lookupIntents) {
		ids.add(table.id);
		for (const column of table.columns) ids.add(column.id);
	}
	for (const policy of contract.accessPolicies) ids.add(policy.id);
	for (const nav of contract.navigation) ids.add(nav.id);
	for (const decision of contract.decisions) {
		ids.add(decision.id);
		for (const option of decision.options) ids.add(option.id);
	}
	for (const assumption of contract.assumptions) ids.add(assumption.id);
	for (const question of contract.openQuestions) ids.add(question.id);
	for (const scenario of contract.acceptanceScenarios) ids.add(scenario.id);
	return ids;
}

/** Canonical comparison key for a source reference. */
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

function truncate(text: string): string {
	return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
