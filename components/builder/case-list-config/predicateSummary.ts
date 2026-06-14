// components/builder/case-list-config/predicateSummary.ts
//
// Human-language one-liner for a filter `Predicate` — "Status isn't
// closed and Age is more than 5", never `status ≠ closed`. The case
// list canvas stamps this on its filter affordance so config state
// reads as a sentence on the artifact; the full structural editor
// stays in the inspector.
//
// Best-effort by design: the AST is richer than any one-line sentence
// (nested groups, relational quantifiers, calculated operands), so
// exotic shapes degrade to honest generic phrases ("a calculated
// value", "a related case exists") rather than leaking AST jargon.
// The summary is display-only — nothing parses it back.

import type { Predicate, ValueExpression } from "@/lib/domain/predicate";

/** Cap on rendered `and` / `or` clauses before "+N more" kicks in —
 *  past two clauses the sentence stops being scannable. */
const MAX_CLAUSES = 2;

/**
 * Summarize a filter predicate for the canvas affordance. Returns
 * `undefined` for predicates that don't narrow anything (`match-all`,
 * the conjunction identity) so the caller can render its "Filter"
 * resting label instead of a vacuous sentence.
 */
export function summarizeFilter(
	predicate: Predicate | undefined,
): string | undefined {
	if (predicate === undefined) return undefined;
	if (predicate.kind === "match-all") return undefined;
	return summarizePredicate(predicate);
}

function summarizePredicate(p: Predicate): string {
	switch (p.kind) {
		case "eq":
			return `${operand(p.left)} is ${operand(p.right)}`;
		case "neq":
			return `${operand(p.left)} isn't ${operand(p.right)}`;
		case "gt":
			return `${operand(p.left)} is more than ${operand(p.right)}`;
		case "gte":
			return `${operand(p.left)} is at least ${operand(p.right)}`;
		case "lt":
			return `${operand(p.left)} is less than ${operand(p.right)}`;
		case "lte":
			return `${operand(p.left)} is at most ${operand(p.right)}`;
		case "in":
			return `${operand(p.left)} is one of ${p.values
				.map((v) => literalText(v.value))
				.join(", ")}`;
		case "between": {
			const subject = operand(p.left);
			const lower = p.lower !== undefined ? operand(p.lower) : undefined;
			const upper = p.upper !== undefined ? operand(p.upper) : undefined;
			if (lower !== undefined && upper !== undefined) {
				return `${subject} is between ${lower} and ${upper}`;
			}
			if (lower !== undefined) return `${subject} is at least ${lower}`;
			if (upper !== undefined) return `${subject} is at most ${upper}`;
			return subject;
		}
		case "is-null":
			return `${operand(p.left)} is not set`;
		case "is-blank":
			return `${operand(p.left)} is blank`;
		case "match": {
			const subject = humanizeName(p.property.property);
			const value = operand(p.value);
			switch (p.mode) {
				case "fuzzy":
					return `${subject} roughly matches ${value}`;
				case "phonetic":
					return `${subject} sounds like ${value}`;
				case "starts-with":
					return `${subject} starts with ${value}`;
				case "fuzzy-date":
					return `${subject} is about ${value}`;
				default:
					return `${subject} matches ${value}`;
			}
		}
		case "multi-select-contains": {
			const values = p.values.map((v) => literalText(v.value)).join(", ");
			const quantifier = p.quantifier === "all" ? "all of" : "any of";
			return `${humanizeName(p.property.property)} includes ${quantifier} ${values}`;
		}
		case "within-distance":
			return `${humanizeName(p.property.property)} is within ${p.distance} ${p.unit}`;
		case "and":
		case "or":
			return joinClauses(p.clauses, p.kind === "and" ? "and" : "or");
		case "not":
			return `not (${summarizePredicate(p.clause)})`;
		case "when-input-present":
			return `${summarizePredicate(p.clause)} (when ${humanizeName(p.input.name)} is filled in)`;
		case "exists":
			return p.where !== undefined
				? `a related case has ${summarizePredicate(p.where)}`
				: "a related case exists";
		case "missing":
			return p.where !== undefined
				? `no related case has ${summarizePredicate(p.where)}`
				: "no related case exists";
		case "match-all":
			return "all cases";
		case "match-none":
			return "no cases";
	}
}

function joinClauses(
	clauses: readonly Predicate[],
	word: "and" | "or",
): string {
	const rendered = clauses
		.slice(0, MAX_CLAUSES)
		.map((c) => summarizePredicate(c));
	const overflow = clauses.length - MAX_CLAUSES;
	const tail = overflow > 0 ? ` ${word} ${overflow} more` : "";
	return rendered.join(` ${word} `) + tail;
}

/** Render a value operand. Terms read as their referent; computed
 *  expressions stay honest-generic — the inspector shows structure. */
function operand(expr: ValueExpression): string {
	switch (expr.kind) {
		case "term": {
			const t = expr.term;
			switch (t.kind) {
				case "prop":
					return humanizeName(t.property);
				case "input":
					return humanizeName(t.name);
				case "literal":
					return literalText(t.value);
				case "session-user":
					return humanizeName(t.field);
				case "session-context":
					return humanizeName(t.field);
			}
			break;
		}
		case "today":
			return "today";
		case "now":
			return "now";
	}
	return "a calculated value";
}

function literalText(value: string | number | boolean | null): string {
	if (value === null) return "empty";
	if (value === "") return "blank";
	return String(value);
}

/** Identifier → words: `rash_onset_date` reads "rash onset date".
 *  Property/input names are author-controlled identifiers; spacing the
 *  separators is as far as the summary goes (no casing games — the
 *  author's vocabulary stays recognizable). */
export function humanizeName(name: string): string {
	return name.replace(/[_-]+/g, " ").trim() || name;
}
