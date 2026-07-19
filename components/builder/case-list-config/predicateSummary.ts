// components/builder/case-list-config/predicateSummary.ts
//
// Human-language one-liner for a filter `Predicate` — "Status isn't
// closed and Age is more than 5", never `status ≠ closed`. Search stamps
// this on its Cases available summary so the always-on rule reads as a
// sentence; the full structural editor stays in the inspector.
//
// Best-effort by design: the AST is richer than any one-line sentence
// (nested groups, relational quantifiers, calculated operands), so
// exotic shapes degrade to honest generic phrases ("a calculated
// value", "a related case exists") rather than leaking AST jargon.
// The summary is display-only — nothing parses it back.

import {
	authorableCaseProperties,
	type CaseProperty,
	type CaseType,
	canonicalCasePropertyName,
} from "@/lib/domain";
import type {
	Literal,
	Predicate,
	PropertyRef,
	ValueExpression,
} from "@/lib/domain/predicate";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabelForName,
	propertyFallbackSentenceLabel,
} from "../shared/primitives/propertyDisplay";
import { resolveRelationDestination } from "../shared/relationDestination";
import {
	type EditorSearchInputDecl,
	searchInputDisplayLabel,
} from "../shared/searchInputPresentation";

/** Cap on rendered `and` / `or` clauses before "+N more" kicks in —
 *  past two clauses the sentence stops being scannable. */
const MAX_CLAUSES = 2;

export interface PredicateSummaryContext {
	readonly caseTypes?: readonly CaseType[];
	readonly currentCaseType?: string;
	readonly knownInputs?: readonly EditorSearchInputDecl[];
}

/**
 * Summarize an always-on predicate for the Search summary. Returns
 * `undefined` for predicates that don't narrow anything (`match-all`,
 * the conjunction identity) so the caller can render its "Filter"
 * all-cases state instead of a vacuous sentence.
 */
export function summarizeFilter(
	predicate: Predicate | undefined,
	context: PredicateSummaryContext = {},
): string | undefined {
	if (predicate === undefined) return undefined;
	if (predicate.kind === "match-all") return undefined;
	if (predicate.kind === "not") {
		if (predicate.clause.kind === "match-all") return "Exclude every case";
		if (predicate.clause.kind === "match-none") return "No cases are excluded";
		return `Exclude cases when ${summarizeExclusionCondition(
			predicate.clause,
			context,
			context.currentCaseType,
		)}`;
	}
	return summarizePredicate(predicate, context, context.currentCaseType);
}

function summarizeExclusionCondition(
	predicate: Predicate,
	context: PredicateSummaryContext,
	currentCaseType: string | undefined,
): string {
	if (predicate.kind === "when-input-present") {
		return `${searchInputDisplayLabel(predicate.input.name, context.knownInputs ?? [])} has an answer and ${embeddedSummary(summarizePredicate(predicate.clause, context, currentCaseType))}`;
	}
	return embeddedSummary(
		summarizePredicate(predicate, context, currentCaseType),
	);
}

function summarizePredicate(
	p: Predicate,
	context: PredicateSummaryContext,
	currentCaseType: string | undefined,
): string {
	switch (p.kind) {
		case "eq": {
			const [left, right] = equalityOperands(p.left, p.right, context);
			return `${left} is ${right}`;
		}
		case "neq": {
			const [left, right] = equalityOperands(p.left, p.right, context);
			return `${left} isn't ${right}`;
		}
		case "gt":
			return `${operand(p.left, context)} is more than ${operand(p.right, context)}`;
		case "gte":
			return `${operand(p.left, context)} is at least ${operand(p.right, context)}`;
		case "lt":
			return `${operand(p.left, context)} is less than ${operand(p.right, context)}`;
		case "lte":
			return `${operand(p.left, context)} is at most ${operand(p.right, context)}`;
		case "in": {
			const property = directPropertyRef(p.left);
			return `${operand(p.left, context)} is one of ${choiceValues(
				p.values,
				property,
				context,
			)}`;
		}
		case "between": {
			const subject = operand(p.left, context);
			const lower =
				p.lower !== undefined ? operand(p.lower, context) : undefined;
			const upper =
				p.upper !== undefined ? operand(p.upper, context) : undefined;
			if (lower !== undefined && upper !== undefined) {
				return `${subject} is between ${lower} and ${upper}`;
			}
			if (lower !== undefined) return `${subject} is at least ${lower}`;
			if (upper !== undefined) return `${subject} is at most ${upper}`;
			return subject;
		}
		case "is-null":
			return `${operand(p.left, context)} isn’t set`;
		case "is-blank":
			return `${operand(p.left, context)} is blank`;
		case "match": {
			const subject = propertySentenceLabel(p.property, context);
			const value = operand(p.value, context);
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
			const values = choiceValues(p.values, p.property, context);
			const quantifier = p.quantifier === "all" ? "all of" : "any of";
			return `${propertySentenceLabel(p.property, context)} includes ${quantifier} ${values}`;
		}
		case "within-distance":
			return `${propertySentenceLabel(p.property, context)} is within ${p.distance} ${p.unit} of ${operand(p.center, context)}`;
		case "and":
		case "or":
			return joinClauses(
				p.clauses,
				p.kind === "and" ? "and" : "or",
				context,
				currentCaseType,
			);
		case "not":
			return summarizeNegatedPredicate(p.clause, context, currentCaseType);
		case "when-input-present":
			return `When ${searchInputDisplayLabel(p.input.name, context.knownInputs ?? [])} has an answer, ${embeddedSummary(summarizePredicate(p.clause, context, currentCaseType))}`;
		case "exists": {
			const destination = relationDestination(p.via, context, currentCaseType);
			return p.where !== undefined
				? `A related case matches ${embeddedSummary(summarizePredicate(p.where, context, destination))}`
				: "A related case exists";
		}
		case "missing": {
			const destination = relationDestination(p.via, context, currentCaseType);
			return p.where !== undefined
				? `No related case matches ${embeddedSummary(summarizePredicate(p.where, context, destination))}`
				: "No related case exists";
		}
		case "match-all":
			return "all cases";
		case "match-none":
			return "no cases";
	}
}

/**
 * Render a nested negation as an ordinary sentence fragment. Top-level
 * negation is phrased as an author-facing action ("Exclude cases when …");
 * inside a larger rule, inverting the predicate keeps conjunctions and
 * related-case summaries grammatical without exposing `not (…)` syntax.
 */
function summarizeNegatedPredicate(
	p: Predicate,
	context: PredicateSummaryContext,
	currentCaseType: string | undefined,
): string {
	switch (p.kind) {
		case "eq": {
			const [left, right] = equalityOperands(p.left, p.right, context);
			return `${left} isn't ${right}`;
		}
		case "neq": {
			const [left, right] = equalityOperands(p.left, p.right, context);
			return `${left} is ${right}`;
		}
		case "gt":
			return `${operand(p.left, context)} is at most ${operand(p.right, context)}`;
		case "gte":
			return `${operand(p.left, context)} is less than ${operand(p.right, context)}`;
		case "lt":
			return `${operand(p.left, context)} is at least ${operand(p.right, context)}`;
		case "lte":
			return `${operand(p.left, context)} is more than ${operand(p.right, context)}`;
		case "in": {
			const property = directPropertyRef(p.left);
			return `${operand(p.left, context)} isn't one of ${choiceValues(
				p.values,
				property,
				context,
			)}`;
		}
		case "between": {
			const subject = operand(p.left, context);
			const lower =
				p.lower !== undefined ? operand(p.lower, context) : undefined;
			const upper =
				p.upper !== undefined ? operand(p.upper, context) : undefined;
			if (lower !== undefined && upper !== undefined) {
				return `${subject} is outside ${lower} to ${upper}`;
			}
			if (lower !== undefined) return `${subject} is less than ${lower}`;
			if (upper !== undefined) return `${subject} is more than ${upper}`;
			return `${subject} doesn't match the range`;
		}
		case "is-null":
			return `${operand(p.left, context)} is set`;
		case "is-blank":
			return `${operand(p.left, context)} isn't blank`;
		case "match":
			return `${propertySentenceLabel(p.property, context)} doesn't ${matchVerb(
				p.mode,
			)} ${operand(p.value, context)}`;
		case "multi-select-contains": {
			const values = choiceValues(p.values, p.property, context);
			return p.quantifier === "all"
				? `${propertySentenceLabel(p.property, context)} doesn't include all of ${values}`
				: `${propertySentenceLabel(p.property, context)} includes none of ${values}`;
		}
		case "within-distance":
			return `${propertySentenceLabel(p.property, context)} is farther than ${p.distance} ${p.unit} from ${operand(p.center, context)}`;
		case "and":
			return joinNegatedClauses(p.clauses, "or", context, currentCaseType);
		case "or":
			return joinNegatedClauses(p.clauses, "and", context, currentCaseType);
		case "not":
			return summarizePredicate(p.clause, context, currentCaseType);
		case "when-input-present":
			return `${searchInputDisplayLabel(p.input.name, context.knownInputs ?? [])} has an answer and ${embeddedSummary(summarizeNegatedPredicate(p.clause, context, currentCaseType))}`;
		case "exists": {
			const destination = relationDestination(p.via, context, currentCaseType);
			return p.where === undefined
				? "No related case exists"
				: `No related case matches ${embeddedSummary(summarizePredicate(p.where, context, destination))}`;
		}
		case "missing": {
			const destination = relationDestination(p.via, context, currentCaseType);
			return p.where === undefined
				? "A related case exists"
				: `A related case matches ${embeddedSummary(summarizePredicate(p.where, context, destination))}`;
		}
		case "match-all":
			return "nothing matches";
		case "match-none":
			return "everything matches";
	}
}

function matchVerb(
	mode: Extract<Predicate, { kind: "match" }>["mode"],
): string {
	switch (mode) {
		case "fuzzy":
			return "roughly match";
		case "phonetic":
			return "sound like";
		case "starts-with":
			return "start with";
		case "fuzzy-date":
			return "roughly match";
		default:
			return "match";
	}
}

function joinNegatedClauses(
	clauses: readonly Predicate[],
	word: "and" | "or",
	context: PredicateSummaryContext,
	currentCaseType: string | undefined,
): string {
	const rendered = clauses.slice(0, MAX_CLAUSES).map((clause, index) => {
		const summary = summarizeNegatedPredicate(clause, context, currentCaseType);
		return index === 0 ? summary : embeddedSummary(summary);
	});
	const overflow = clauses.length - MAX_CLAUSES;
	const tail = overflow > 0 ? ` ${word} ${overflow} more` : "";
	return rendered.join(` ${word} `) + tail;
}

function joinClauses(
	clauses: readonly Predicate[],
	word: "and" | "or",
	context: PredicateSummaryContext,
	currentCaseType: string | undefined,
): string {
	const rendered = clauses.slice(0, MAX_CLAUSES).map((clause, index) => {
		const summary = summarizePredicate(clause, context, currentCaseType);
		return index === 0 ? summary : embeddedSummary(summary);
	});
	const overflow = clauses.length - MAX_CLAUSES;
	const tail = overflow > 0 ? ` ${word} ${overflow} more` : "";
	return rendered.join(` ${word} `) + tail;
}

/** Lowercase only Nova-authored sentence scaffolding when it is embedded in a
 * larger sentence. Authored property and search-field labels keep the casing
 * chosen by the app builder. */
function embeddedSummary(summary: string): string {
	const novaPhrases: readonly [string, string][] = [
		["A related case", "a related case"],
		["No related case", "no related case"],
		["When ", "when "],
		["Exclude cases when ", "exclude cases when "],
	];
	for (const [leading, embedded] of novaPhrases) {
		if (summary.startsWith(leading)) {
			return embedded + summary.slice(leading.length);
		}
	}
	return summary;
}

/** Render a value operand. Terms read as their referent; computed
 *  expressions stay honest-generic — the inspector shows structure. */
function operand(
	expr: ValueExpression,
	context: PredicateSummaryContext,
): string {
	switch (expr.kind) {
		case "term": {
			const t = expr.term;
			switch (t.kind) {
				case "prop":
					return propertySentenceLabel(t, context);
				case "input":
					return searchInputDisplayLabel(t.name, context.knownInputs ?? []);
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

/** Equality is the one binary comparison where a stored select value can be
 * rendered with the vocabulary authored on the property. The property may sit
 * on either side, so preserve the sentence order while lending its choices to
 * the literal opposite it. Calculated expressions and non-literal operands keep
 * their ordinary summaries. */
function equalityOperands(
	left: ValueExpression,
	right: ValueExpression,
	context: PredicateSummaryContext,
): readonly [string, string] {
	const leftLiteral = directLiteral(left);
	const rightLiteral = directLiteral(right);
	const leftProperty = directPropertyRef(left);
	const rightProperty = directPropertyRef(right);

	return [
		leftLiteral !== undefined && rightProperty !== undefined
			? choiceLiteralText(leftLiteral, rightProperty, context)
			: operand(left, context),
		rightLiteral !== undefined && leftProperty !== undefined
			? choiceLiteralText(rightLiteral, leftProperty, context)
			: operand(right, context),
	];
}

function directLiteral(expr: ValueExpression): Literal | undefined {
	return expr.kind === "term" && expr.term.kind === "literal"
		? expr.term
		: undefined;
}

function directPropertyRef(expr: ValueExpression): PropertyRef | undefined {
	return expr.kind === "term" && expr.term.kind === "prop"
		? expr.term
		: undefined;
}

function choiceValues(
	values: readonly Literal[],
	propertyRef: PropertyRef | undefined,
	context: PredicateSummaryContext,
): string {
	return values
		.map((value) =>
			propertyRef === undefined
				? literalText(value.value)
				: choiceLiteralText(value, propertyRef, context),
		)
		.join(", ");
}

/** Map a select property's stored wire value back to its authored label. A
 * stored-value cue only appears when two options share the same label; without
 * it those distinct conditions would become visually indistinguishable. */
function choiceLiteralText(
	literal: Literal,
	propertyRef: PropertyRef,
	context: PredicateSummaryContext,
): string {
	const resolved = resolvePropertyRef(propertyRef, context);
	const property = resolved?.property;
	if (
		property === undefined ||
		(property.data_type !== "single_select" &&
			property.data_type !== "multi_select") ||
		typeof literal.value !== "string"
	) {
		return literalText(literal.value);
	}

	const option = property.options?.find(
		(candidate) => candidate.value === literal.value,
	);
	if (option === undefined || option.label === "") {
		return literalText(literal.value);
	}

	const duplicateLabel =
		property.options?.some(
			(candidate) =>
				candidate.value !== option.value && candidate.label === option.label,
		) ?? false;
	return duplicateLabel
		? `${option.label} (saved as ${option.value})`
		: option.label;
}

interface ResolvedPropertyRef {
	readonly property: CaseProperty;
	readonly properties: readonly CaseProperty[];
}

function resolvePropertyRef(
	propertyRef: PropertyRef,
	context: PredicateSummaryContext,
): ResolvedPropertyRef | undefined {
	const caseTypes = context.caseTypes ?? [];
	const destination =
		propertyRef.via === undefined
			? propertyRef.caseType
			: resolveRelationDestination(
					propertyRef.via,
					propertyRef.caseType,
					caseTypes,
				);
	const rawProperties = caseTypes.find(
		(caseType) => caseType.name === destination,
	)?.properties;
	if (rawProperties === undefined) return undefined;
	// Summaries speak the same one-concept Nova vocabulary as every picker.
	// Project aliases before resolving so CCHQ's legacy `name` / `case_name`
	// pair cannot reappear as duplicate choices or fake disambiguation.
	const properties = authorableCaseProperties(rawProperties);
	const canonicalProperty = canonicalCasePropertyName(propertyRef.property);
	const property = properties.find(
		(candidate) => candidate.name === canonicalProperty,
	);
	return property === undefined ? undefined : { property, properties };
}

function propertySentenceLabel(
	propertyRef: PropertyRef,
	context: PredicateSummaryContext,
): string {
	const resolved = resolvePropertyRef(propertyRef, context);
	if (resolved === undefined) {
		return propertyFallbackSentenceLabel(propertyRef.property);
	}

	const label = propertyDisplayLabelForName(
		propertyRef.property,
		resolved.properties,
	);
	const disambiguator = friendlyPropertyDisambiguator(
		resolved.property,
		resolved.properties,
	);
	return disambiguator === undefined ? label : `${label} (${disambiguator})`;
}

function relationDestination(
	via: Extract<Predicate, { kind: "exists" | "missing" }>["via"],
	context: PredicateSummaryContext,
	currentCaseType: string | undefined,
): string | undefined {
	if (currentCaseType === undefined) return undefined;
	return resolveRelationDestination(
		via,
		currentCaseType,
		context.caseTypes ?? [],
	);
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
