/**
 * The places Nova's emitter spells an expression otherwise than its stored
 * tree reads, which a reader of CommCare HQ's apps must print without (an HQ
 * author never wrote them) or report (a worker meets the change).
 *
 * Every site takes an optional `RewriteControl`. Absent, the emitter prints as
 * it always does. With one, the site calls `reached` wherever its rewrite
 * applies to the print, and where the control withholds the id it prints what
 * it printed before the rewrite existed.
 */
export const EMISSION_REWRITE_IDS = [
	"instant-comparison",
	"empty-rows-guard",
	"absent-session-value-guard",
	"row-predicate-current",
	"default-reads-current",
	"search-value-guards",
	"filter-identities-dropped",
	"validation-counts-moved",
] as const;
export type EmissionRewriteId = (typeof EMISSION_REWRITE_IDS)[number];

export interface EmissionRewrite {
	/** `changes`: a worker meets it, and the first-publish register holds an entry of the same id. */
	readonly behavior: "changes" | "none";
}

export const EMISSION_REWRITES: Readonly<
	Record<EmissionRewriteId, EmissionRewrite>
> = {
	/** `fromExpression.ts::compareSides`, plan `lowered`: two dates and times compare as moments. */
	"instant-comparison": { behavior: "changes" },
	/** `fromExpression.ts::emitExpression`, `::operand` and `::emitCall`, through
	 *  `emptyRows.ts`: a read of rows that may be empty reads blank where there are none. */
	"empty-rows-guard": { behavior: "changes" },
	/** `fromExpression.ts::term` (`session-context`) and `::lowerExpression`
	 *  (`case-list-search-text`): a session value that can be absent reads blank there. */
	"absent-session-value-guard": { behavior: "changes" },
	/** `formReads.ts::formReadToWire`, and a Save to Case block's binding
	 *  (`formReads.ts::placeBindingWithheld`): a row filter inside a repeat
	 *  reads this entry's answer. Also a block's read, inside a row filter, of
	 *  the id of a create in a repeat, which `xform/caseOps.ts::bindOperationPaths`
	 *  prints through `current()` and the reader prints by the create block's
	 *  absolute path where this is withheld (`reader/expressions/readExpression.ts::relocatedOperationIds`):
	 *  the read is of this entry's case. */
	"row-predicate-current": { behavior: "changes" },
	/** `formReads.ts::formReadToWire`, the `default_value` slot, and a Save to
	 *  Case block's binding of its own repeat's answer outside a row filter
	 *  (`formReads.ts::placeBindingWithheld`): Core resolves the absolute and
	 *  the `current()` spelling of the read to one node. Also a block's read of
	 *  an earlier create's id anywhere else, which `xform/caseOps.ts::bindOperationPaths`
	 *  prints through `current()` and the reader prints by the create block's
	 *  absolute path where this is withheld (`reader/expressions/readExpression.ts::relocatedOperationIds`). */
	"default-reads-current": { behavior: "none" },
	/** `csql/print.ts`: a search value picks its quote mark and fails closed. */
	"search-value-guards": { behavior: "changes" },
	/** The filters and conditions printed through `simplifyForEmission`: no boolean identity. */
	"filter-identities-dropped": { behavior: "none" },
	/** `xform/constraintCollections.ts::planConstraintCollections`: a count
	 *  inside a validation moves to a sibling Hidden Value. */
	"validation-counts-moved": { behavior: "changes" },
};

export interface RewriteControl {
	/** Rewrites the print leaves out, so the reader can compare with text that never had them. */
	readonly withhold: ReadonlySet<EmissionRewriteId>;
	/** Called once per site a print reaches, whether it applied the rewrite or withheld it. */
	readonly reached?: (id: EmissionRewriteId) => void;
	/** Where present, answers in place of `withhold` at each site the print reaches, called once
	 *  per site in the order the print reaches them: whether that one site leaves its rewrite out.
	 *  The reader's level for a source that spells a rewrite at some of a slot's sites and not at
	 *  others. */
	readonly withholdSite?: (id: EmissionRewriteId) => boolean;
}

/** A site whose rewrite applies to this print: reports it to the control
 *  and answers whether the print leaves it out. No control, no report, and
 *  the rewrite stands. */
export function rewriteWithheld(
	control: RewriteControl | undefined,
	id: EmissionRewriteId,
): boolean {
	if (control === undefined) return false;
	control.reached?.(id);
	return control.withholdSite === undefined
		? control.withhold.has(id)
		: control.withholdSite(id);
}
