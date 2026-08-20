// components/builder/form-links/seeds.ts
//
// Born-valid after-submit links.
//
// The app is valid by construction, so "add a link" cannot land a
// half-configured link and let the author discover the rejection later.
// Each seed here is a complete link the validator accepts on its own,
// which is why the add affordance asks WHAT KIND of link it is before it
// commits anything: a conditional link and the otherwise link differ in
// exactly one slot, and that slot decides where the link may sit.
//
// Seeds carry placeholder CONTENT, never placeholder STRUCTURE:
//
//   - a conditional link starts from `false()`, a condition that never
//     fires, so adding it changes nothing about the running app until the
//     author writes the real condition (the detail opens with the editor
//     ready for that);
//   - a destination that needs values this form cannot supply
//     automatically (`formLinkCarryVerdict` says `manual-required`) starts
//     with one `''` per required selection datum, so the gate's
//     `FORM_LINK_DATUMS_INCOMPLETE` never meets a fresh link, and the
//     author fills each one in where the hint says to.
//
// `__tests__/formLinkValidByConstruction.test.ts` pins every seed against
// the commit gate.

import { newUuid } from "@/components/builder/case-list-config/uuid";
import type {
	FormLinkCarryVerdict,
	FormLinkRequiredDatum,
} from "@/lib/doc/formLinkReview";
import type {
	FormLink,
	FormLinkDatum,
	FormLinkTarget,
	XPathExpression,
} from "@/lib/domain";

/** The condition a fresh conditional link carries until the author replaces it. */
export const SEED_CONDITION_TEXT = "false()";

/** The expression a fresh carried value carries until the author replaces it. */
export const SEED_CARRIED_VALUE_TEXT = "''";

/** Text → stored AST, resolved against the current document. */
export type XPathParser = (text: string) => XPathExpression;

/** One `''` per required selection datum, named as the destination names it. */
export function seedCarriedValues(
	required: readonly FormLinkRequiredDatum[],
	parse: XPathParser,
): FormLinkDatum[] {
	return required.map((datum) => ({
		name: datum.id,
		xpath: parse(SEED_CARRIED_VALUE_TEXT),
	}));
}

/**
 * The `datums` slot a link to `target` has to carry: seeded values when the
 * destination cannot be matched automatically from this form, absent
 * otherwise (absent means "match automatically"; `[]` is not a state).
 */
export function carriedValuesFor(
	carry: FormLinkCarryVerdict,
	required: readonly FormLinkRequiredDatum[],
	parse: XPathParser,
): FormLinkDatum[] | undefined {
	return carry.kind === "manual-required"
		? seedCarriedValues(required, parse)
		: undefined;
}

interface SeedTarget {
	readonly target: FormLinkTarget;
	readonly carry: FormLinkCarryVerdict;
	readonly required: readonly FormLinkRequiredDatum[];
}

/** A complete conditional link to `target`, never firing until edited. */
export function seedConditionalLink(
	seed: SeedTarget,
	parse: XPathParser,
	uuid = newUuid(),
): FormLink {
	const datums = carriedValuesFor(seed.carry, seed.required, parse);
	return {
		uuid,
		condition: parse(SEED_CONDITION_TEXT),
		target: seed.target,
		...(datums !== undefined && { datums }),
	};
}

/** A complete otherwise link to `target`. */
export function seedOtherwiseLink(
	seed: SeedTarget,
	parse: XPathParser,
	uuid = newUuid(),
): FormLink {
	const datums = carriedValuesFor(seed.carry, seed.required, parse);
	return {
		uuid,
		target: seed.target,
		...(datums !== undefined && { datums }),
	};
}

/**
 * The link, pointed at a new destination. Carried values are the
 * destination's, not the link's: a value worked out for one form's
 * selection is meaningless to another's, so they are reseeded for the new
 * target (or dropped when it needs none).
 */
export function retargetLink(
	link: FormLink,
	seed: SeedTarget,
	parse: XPathParser,
): FormLink {
	const datums = carriedValuesFor(seed.carry, seed.required, parse);
	const { datums: _previous, ...rest } = link;
	return {
		...rest,
		target: seed.target,
		...(datums !== undefined && { datums }),
	};
}

/** Whether retargeting would discard values the author worked out. */
export function retargetDropsCarriedValues(
	link: FormLink,
	next: FormLink,
): boolean {
	return (link.datums?.length ?? 0) > 0 && next.datums === undefined;
}
