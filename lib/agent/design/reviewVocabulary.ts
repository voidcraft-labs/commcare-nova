/**
 * The reviewer's model-facing symbol vocabulary — source tags and identity
 * handles — derived, never persisted.
 *
 * A structured generation reproduces short semantic symbols far more reliably
 * than 32-hex-digit UUIDs or compound source coordinates: both observed live
 * failure classes (minted citations, a spliced element UUID) were the model
 * failing to copy an arbitrary string it could not mean. So the reviewer
 * reads and writes symbols — `S1`-numbered source tags and the session's
 * `@handle` element symbols — and the server resolves them back to the
 * UUID-only persisted vocabulary inside the review schema.
 *
 * Everything here is a render-time projection. Tags are positional over
 * `citableSourceRefs(pkg)`, so they are stable within one package version and
 * MUST never be persisted (an extended package renumbers); the package digest
 * and every stored artifact stay tag-free. Dependency-free of `loop/` and the
 * database on purpose: `prompts.ts` renders from here, and the reviewer
 * schema resolves from here, so what the model is shown and what the schema
 * admits share one derivation.
 */

import type { SourceRef } from "@/lib/agent/design/evidence";
import { sourceRefKey } from "@/lib/agent/design/evidence";
import {
	citableSourceRefs,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";

/** One durable handle ↔ design-ID pair, as the identity ledger stores it. */
export interface ReviewHandleBinding {
	readonly handle: string;
	readonly designId: string;
}

export interface TaggedSourceRef {
	readonly tag: string;
	readonly ref: SourceRef;
}

/**
 * `S1..SN` over the package's citable set, in `citableSourceRefs` order, with
 * platform-constraint refs filtered out — those are cited by their catalog
 * code, which is already a short closed symbol. THE one derivation behind the
 * prompt's tag legend, the source-block labels, and the reviewer schema's tag
 * enum; deriving any of the three separately is how the shown set and the
 * admitted set start disagreeing.
 */
export function taggedCitableSourceRefs(
	pkg: DesignSourcePackage,
): readonly TaggedSourceRef[] {
	return citableSourceRefs(pkg)
		.filter((ref) => ref.kind !== "platform-constraint")
		.map((ref, index) => ({ tag: `S${index + 1}`, ref }));
}

/** Identity-key → tag lookup over the same derivation. */
export function sourceTagByRefKey(
	pkg: DesignSourcePackage,
): ReadonlyMap<string, string> {
	return new Map(
		taggedCitableSourceRefs(pkg).map(({ tag, ref }) => [
			sourceRefKey(ref),
			tag,
		]),
	);
}

/**
 * Review findings never enter the identity ledger — their handles are this
 * positional projection, recomputable from persisted state anywhere it is
 * needed. `@f1..@fN` runs continuously across the given reviews in their
 * persisted `review_ordinal` order (callers pass them that way), findings in
 * array order. The state packet and disposition resolver use this same
 * projection.
 */
export function deriveFindingHandleBindings(
	reviews: ReadonlyArray<{
		readonly findings: ReadonlyArray<{ readonly id: string }>;
	}>,
): ReadonlyArray<{
	readonly handle: string;
	readonly designId: string;
	readonly entityKind: "finding";
}> {
	return reviews
		.flatMap((review) => review.findings)
		.map((finding, index) => ({
			handle: `@f${index + 1}`,
			designId: finding.id,
			entityKind: "finding" as const,
		}));
}

/**
 * `@f<N>` is reserved for the server's finding projection above. A contract
 * element declared under it would print the same symbol as a finding, making
 * the projection ambiguous — the stage tools refuse the declaration.
 */
export const RESERVED_FINDING_HANDLE_PATTERN = /^@f[1-9][0-9]*$/;
