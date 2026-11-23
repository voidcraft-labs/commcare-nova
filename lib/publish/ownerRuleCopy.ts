/**
 * What a review says of an owner rule the places CommCare HQ holds cannot
 * satisfy: the question, why the rule names no one place, the one explicit
 * rule Nova offers, and the other way through. The bring-in review, the
 * HQ-changes panel and MCP's two projections all say it in these words.
 *
 * Client-safe, and it imports nothing: the review's schema
 * (`lib/deployment/reading/projectData/reviewTypes.ts`) holds these types.
 */

/** Why one level's owner rule names no one place, as the places CommCare HQ holds say. */
export type OwnerRuleConflict =
	/** Two places at the level stand below one place that owns cases. */
	| {
			readonly kind: "two-places";
			readonly source: string;
			readonly places: readonly [string, string];
	  }
	/** No place at the level stands below one place that owns cases. */
	| { readonly kind: "no-place"; readonly source: string }
	/** The level's places do not own cases. */
	| { readonly kind: "level-owns-no-cases" }
	/** No level above the level owns cases. */
	| { readonly kind: "no-owning-level-above" }
	/** The place the rule finds is outside what a worker type carries. */
	| {
			readonly kind: "outside-address-book";
			readonly place: string;
			readonly persona: string;
	  };

/** One level whose owner rule the places cannot satisfy: the question its answer settles. */
export interface ReviewOwnerRule {
	/** The level's code in CommCare HQ: what an answer is keyed by. */
	readonly level: string;
	/** The level's name, as CommCare HQ holds it. */
	readonly levelName: string;
	readonly conflict: OwnerRuleConflict;
	/** The forms whose case changes give a case by the rule, by name, in the app's order. */
	readonly forms: readonly string[];
}

/** `“a”`, `“a” and “b”`, `“a”, “b” and “c”`. */
function quotedList(names: readonly string[]): string {
	const quoted = names.map((name) => `“${name}”`);
	if (quoted.length <= 1) return quoted.join("");
	return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** The question's title. */
export function ownerRuleTitle(rule: ReviewOwnerRule): string {
	return `Who owns the cases for ${rule.levelName}`;
}

/** What the rule does and why the places in `domain` give it no one place. */
export function ownerRuleBody(rule: ReviewOwnerRule, domain: string): string {
	const forms =
		rule.forms.length === 1
			? `The form ${quotedList(rule.forms)} gives`
			: `The forms ${quotedList(rule.forms)} give`;
	const lead = `${forms} each case to the ${rule.levelName} below the place that owns it.`;
	const { conflict } = rule;
	switch (conflict.kind) {
		case "two-places":
			return `${lead} In ${domain}, both ${conflict.places[0]} and ${conflict.places[1]} are below ${conflict.source}, so the rule can't tell which one to use.`;
		case "no-place":
			return `${lead} In ${domain}, no ${rule.levelName} is below ${conflict.source}, so the rule finds no place.`;
		case "level-owns-no-cases":
			return `${lead} In ${domain}, places at the ${rule.levelName} level don't own cases.`;
		case "no-owning-level-above":
			return `${lead} In ${domain}, no level above ${rule.levelName} owns cases.`;
		case "outside-address-book":
			return `${lead} In ${domain}, the rule can find ${conflict.place}, which workers of the type ${conflict.persona} don't carry on their phones.`;
	}
}

/** The one answer's label. */
export const OWNER_RULE_WORKER_LABEL =
	"Give these cases to the worker who fills in the form";

/** What the answer does, in Nova and at the next publish. */
export const OWNER_RULE_WORKER_DETAIL =
	"The worker who fills in the form owns each case these forms save. Publishing to CommCare HQ makes the same change there.";

/** The row for choosing one place, which only CommCare HQ's places can give. */
export const OWNER_RULE_ONE_PLACE_LABEL = "Use one place from CommCare HQ";

/** Why that row cannot be chosen here. */
export const OWNER_RULE_ONE_PLACE_REASON =
	"Nova never picks a place for you. You can change the places in CommCare HQ so the rule finds one, then check again.";

/** What the question says once Bring it in found it unanswered. */
export const OWNER_RULE_NEEDS_ANSWER =
	"Choose who owns these cases before Nova brings this in.";

/** The other way through. */
export const OWNER_RULE_OTHERWISE =
	"Or you can change the places in CommCare HQ so the rule finds one place, then check again.";
