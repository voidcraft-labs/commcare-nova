/**
 * The reviewer's MODEL-FACING structured-output schema — symbol vocabulary on
 * the wire, the persisted UUID-only `DesignReview` out of the parse.
 *
 * The strict wire projection emits a Zod pipe's INPUT side (`io: "input"`),
 * so `.transform()` is the one in-band seam where a model-facing vocabulary
 * can resolve into the persisted shape: the provider grammar the model fills
 * is the symbol schema below, and the validation bridge hands back the
 * resolved review. The model emits NO identities Nova already owns — source
 * citations are `S`-numbered tags from the prompt's legend (an exact enum, so
 * an out-of-set citation is grammatically inexpressible), affected elements
 * are the contract's printed `@handle` symbols, platform citations are the
 * catalog's code enum (the catalog supplies `sourceAnchor`; a model-invented
 * anchor was never verifiable), and the server mints the review and finding
 * ids at resolution.
 *
 * Resolution failures surface as `code: "custom"` issues naming the offending
 * symbol — those messages ride `schemaIssueSummary` into operational logs, so
 * a failed review is diagnosable from its log line alone. The final step
 * re-parses the resolved value under the persisted `designReviewSchema`, so
 * every law stated there (citation counts per severity, platform basis,
 * disposition-class coherence) runs with wire paths and the resolved output
 * provably satisfies the artifact store's read-back schema.
 */

import { z } from "zod";
import {
	type AppDesignContract,
	collectContractIds,
} from "@/lib/agent/design/contract";
import type { SourceRef } from "@/lib/agent/design/evidence";
import { DESIGN_HANDLE_PATTERN, designIdSchema } from "@/lib/agent/design/ids";
import {
	PLATFORM_CONSTRAINT_CODES,
	PLATFORM_CONSTRAINTS,
	type PlatformConstraintCode,
} from "@/lib/agent/design/platformConstraints";
import {
	type DesignFinding,
	type DesignReview,
	designFindingBasisSchema,
	designFindingCategorySchema,
	designFindingDispositionClassSchema,
	designFindingSeveritySchema,
	designReviewSchema,
} from "@/lib/agent/design/review";
import {
	type ReviewHandleBinding,
	type TaggedSourceRef,
	taggedCitableSourceRefs,
} from "@/lib/agent/design/reviewVocabulary";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";

function unanchored(pattern: RegExp): string {
	return pattern.source.replace(/^\^/, "").replace(/\$$/, "");
}

/** An affected element is the contract's printed `@handle`, or — only when
 *  the contract printed a raw identity for an unbound element — that exact
 *  identity string. One pattern node, so the strict projection stays a plain
 *  typed string slot. */
const AFFECTED_ELEMENT_PATTERN = new RegExp(
	`^(?:${unanchored(DESIGN_HANDLE_PATTERN)}|${unanchored(CANONICAL_UUID_PATTERN)})$`,
);

const sourceCitationSchema = (tags: [string, ...string[]]) =>
	z
		.object({
			source: z.enum(tags),
			sectionPath: z.array(z.string().min(1)).optional(),
			figureMarker: z.string().min(1).optional(),
		})
		.strict();

const platformCitationSchema = z
	.object({ platform: z.enum(PLATFORM_CONSTRAINT_CODES) })
	.strict();

type WireCitation =
	| { source: string; sectionPath?: string[]; figureMarker?: string }
	| { platform: PlatformConstraintCode };

interface WireFinding {
	category: DesignFinding["category"];
	severity: DesignFinding["severity"];
	basis: DesignFinding["basis"];
	dispositionClass: DesignFinding["dispositionClass"];
	claim: string;
	evidenceRefs: WireCitation[];
	affectedElements: string[];
	proposedResolution?: string;
}

interface ResolutionContext {
	readonly tagByName: ReadonlyMap<string, TaggedSourceRef["ref"]>;
	readonly designIdByHandle: ReadonlyMap<string, string>;
	readonly knownIds: ReadonlySet<string>;
	readonly printedHandleCount: number;
}

function mintDesignId(): DesignFinding["id"] {
	return designIdSchema.parse(crypto.randomUUID());
}

function resolveCitation(
	citation: WireCitation,
	path: (string | number)[],
	ctx: z.RefinementCtx,
	resolution: ResolutionContext,
): SourceRef | null {
	if ("platform" in citation) {
		return {
			kind: "platform-constraint",
			code: citation.platform,
			sourceAnchor: PLATFORM_CONSTRAINTS[citation.platform].sourceAnchor,
		};
	}
	const ref = resolution.tagByName.get(citation.source);
	if (ref === undefined) {
		// The tag enum makes this unreachable from the provider; a direct
		// caller with a stale tag still gets the offender named.
		ctx.addIssue({
			code: "custom",
			path,
			message: `The source tag ${citation.source} is not in this review's legend.`,
		});
		return null;
	}
	if (ref.kind === "attachment-extract") {
		/* Identity fields only — a claim-carried citable entry may itself hold
		 * a sectionPath, and inheriting it would attribute the model's citation
		 * to a location it never named. */
		return {
			kind: "attachment-extract",
			assetId: ref.assetId,
			extractorVersion: ref.extractorVersion,
			sectionPath: citation.sectionPath ?? [],
			...(citation.figureMarker !== undefined && {
				figureMarker: citation.figureMarker,
			}),
		};
	}
	if (
		citation.sectionPath !== undefined ||
		citation.figureMarker !== undefined
	) {
		ctx.addIssue({
			code: "custom",
			path,
			message: `sectionPath and figureMarker say where inside a document extract a citation points; ${citation.source} is a ${ref.kind} source. Drop them, or cite the attachment's tag instead.`,
		});
		return null;
	}
	return ref;
}

function resolveElement(
	element: string,
	path: (string | number)[],
	ctx: z.RefinementCtx,
	resolution: ResolutionContext,
): string | null {
	if (element.startsWith("@")) {
		const designId = resolution.designIdByHandle.get(element);
		if (designId === undefined) {
			ctx.addIssue({
				code: "custom",
				path,
				message: `The element handle ${element} is not bound in this design session. The reviewed contract prints each element's exact @handle — copy one of the ${resolution.printedHandleCount} printed handles.`,
			});
			return null;
		}
		if (!resolution.knownIds.has(designId)) {
			ctx.addIssue({
				code: "custom",
				path,
				message: `${element} names an element that is not part of the reviewed contract.`,
			});
			return null;
		}
		return designId;
	}
	if (!resolution.knownIds.has(element)) {
		ctx.addIssue({
			code: "custom",
			path,
			message: `The element id ${element} is not part of the reviewed contract. Name elements by the exact @handle the contract prints.`,
		});
		return null;
	}
	return element;
}

function resolveReview(
	wire: { summary: string; findings: WireFinding[] },
	ctx: z.RefinementCtx,
	resolution: ResolutionContext,
): DesignReview {
	let failed = false;
	const findings = wire.findings.map((finding, index) => {
		const affectedElementIds = finding.affectedElements.map(
			(element, elementIndex) => {
				const resolved = resolveElement(
					element,
					["findings", index, "affectedElements", elementIndex],
					ctx,
					resolution,
				);
				if (resolved === null) failed = true;
				return resolved ?? element;
			},
		);
		const evidenceRefs = finding.evidenceRefs.map((citation, citationIndex) => {
			const resolved = resolveCitation(
				citation,
				["findings", index, "evidenceRefs", citationIndex],
				ctx,
				resolution,
			);
			if (resolved === null) failed = true;
			return resolved;
		});
		return {
			id: mintDesignId(),
			category: finding.category,
			severity: finding.severity,
			basis: finding.basis,
			dispositionClass: finding.dispositionClass,
			claim: finding.claim,
			evidenceRefs: evidenceRefs.filter(
				(citation): citation is SourceRef => citation !== null,
			),
			affectedElementIds,
			...(finding.proposedResolution !== undefined && {
				proposedResolution: finding.proposedResolution,
			}),
		};
	});
	if (failed) return z.NEVER;
	const parsed = designReviewSchema.safeParse({
		schemaVersion: 1,
		id: mintDesignId(),
		summary: wire.summary,
		findings,
	});
	if (!parsed.success) {
		/* The persisted schema's own laws (citation counts per severity,
		 * platform basis, disposition-class coherence) speak here with wire
		 * paths; anything else would be a resolution defect this backstop
		 * refuses to let through. */
		for (const issue of parsed.error.issues) {
			ctx.addIssue({
				code: "custom",
				path: issue.path,
				message: issue.message,
			});
		}
		return z.NEVER;
	}
	return parsed.data;
}

/**
 * Build the reviewer's structured-output schema for one exact contract,
 * source package, and identity-binding set. The ONE `bindings` value a caller
 * loads must feed both this factory and the review prompt's rendering, so the
 * symbols the model reads and the symbols this schema resolves cannot drift.
 */
export function designReviewSchemaFor(args: {
	contract: AppDesignContract;
	pkg: DesignSourcePackage;
	bindings: readonly ReviewHandleBinding[];
}): z.ZodType<DesignReview> {
	const tagged = taggedCitableSourceRefs(args.pkg);
	const knownIds = collectContractIds(args.contract);
	const resolution: ResolutionContext = {
		tagByName: new Map(tagged.map(({ tag, ref }) => [tag, ref])),
		designIdByHandle: new Map(
			args.bindings.map((binding) => [binding.handle, binding.designId]),
		),
		knownIds,
		printedHandleCount: args.bindings.filter((binding) =>
			knownIds.has(binding.designId),
		).length,
	};
	const tags = tagged.map(({ tag }) => tag);
	/* Every real package carries at least one request block, so the tag list
	 * is nonempty in production; the platform-only arm keeps a synthetic empty
	 * package from crashing schema construction. */
	const citationSchema: z.ZodType<WireCitation> =
		tags.length === 0
			? platformCitationSchema
			: z.union([
					sourceCitationSchema(tags as [string, ...string[]]),
					platformCitationSchema,
				]);
	const findingSchema = z
		.object({
			category: designFindingCategorySchema,
			severity: designFindingSeveritySchema,
			basis: designFindingBasisSchema,
			dispositionClass: designFindingDispositionClassSchema,
			claim: z.string().min(1),
			evidenceRefs: z.array(citationSchema),
			affectedElements: z.array(
				z
					.string()
					.regex(
						AFFECTED_ELEMENT_PATTERN,
						"Expected a printed @handle from the reviewed contract.",
					),
			),
			proposedResolution: z.string().min(1).optional(),
		})
		.strict();
	return z
		.object({
			summary: z.string().min(1),
			findings: z.array(findingSchema),
		})
		.strict()
		.transform((wire, ctx) => resolveReview(wire, ctx, resolution));
}
