/**
 * Rule: every authored `match` predicate whose `mode` is `fuzzy` or
 * `phonetic` carries a whitespace-free `value`.
 *
 * CCHQ's CSQL evaluator dispatches `fuzzy-match` through
 * `case_property_query(name, value, fuzzy=True)` and `phonetic-match`
 * through `sounds_like_text_query`. Both consult ElasticSearch's
 * tokenized `match` query against the analyzed value field: a value
 * containing whitespace is split into tokens and matched as an OR
 * across them. So an authored `match(prop, "Alice Smith", "fuzzy")`
 * emits a wire that CCHQ evaluates as
 * `fuzzy-match(prop, "Alice") OR fuzzy-match(prop, "Smith")` — silently
 * broader than the authored intent ("the name is fuzzy-equal to
 * 'Alice Smith'").
 *
 * `starts-with` is unaffected — CCHQ's `case_property_starts_with`
 * routes through `filters.prefix` against the exact (non-analyzed)
 * value field, so whitespace-bearing prefix queries work as
 * authored. `fuzzy-date` admits only validated `YYYY-MM-DD` shapes;
 * whitespace is structurally impossible inside a valid date literal.
 *
 * The rule walks every authored `Predicate` slot wire-emitted to
 * CSQL: `caseListConfig.filter`, every advanced-arm
 * `caseListConfig.searchInputs[i].predicate`, and
 * `caseSearchConfig.searchButtonDisplayCondition`. The simple-arm
 * `(property, mode)` shape is derived at wire-emit time from the
 * user's typed input — the value is user-supplied at runtime, not
 * author-supplied, so the validator has nothing to gate; users typing
 * multi-word values into a fuzzy input are CCHQ's runtime semantic,
 * unchanged.
 *
 * Short-circuits cleanly when the module has no in-scope slots.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

interface WhitespaceMatch {
	readonly mode: "fuzzy" | "phonetic";
	readonly property: string;
	readonly value: string;
}

export function matchModeWhitespaceInValue(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const filter = mod.caseListConfig?.filter;
	if (filter !== undefined) {
		for (const match of collectMatches(filter)) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					match,
					slot: "caseListConfig.filter",
					adviceSlotName: "the case list's always-on filter card",
				}),
			);
		}
	}

	const inputs = mod.caseListConfig?.searchInputs ?? [];
	for (let i = 0; i < inputs.length; i++) {
		const input = inputs[i];
		if (input.kind !== "advanced") continue;
		for (const match of collectMatches(input.predicate)) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					match,
					slot: `caseListConfig.searchInputs[${i}].predicate`,
					adviceSlotName: `search input "${input.label || input.name}" (input #${i + 1})`,
				}),
			);
		}
	}

	const buttonCondition = mod.caseSearchConfig?.searchButtonDisplayCondition;
	if (buttonCondition !== undefined) {
		for (const match of collectMatches(buttonCondition)) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					match,
					slot: "caseSearchConfig.searchButtonDisplayCondition",
					adviceSlotName: "the search-button display condition",
				}),
			);
		}
	}

	return errors;
}

function buildError(args: {
	mod: Module;
	moduleUuid: Uuid;
	match: WhitespaceMatch;
	slot: string;
	adviceSlotName: string;
}): ValidationError {
	const { mod, moduleUuid, match, slot, adviceSlotName } = args;
	return validationError(
		"CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE",
		"module",
		`Module "${mod.name}" has a \`${match.mode}\` match in ${slot} testing case property "${match.property}" against "${match.value}" — a value that contains whitespace. CCHQ's runtime tokenizes the value on whitespace for both \`fuzzy\` and \`phonetic\` matches and OR-composes the tokens, so the wire would match cases whose "${match.property}" approximately matches "${match.value.split(/\s+/)[0]}" OR matches the rest of the words — broader than the authored single-string intent. Open ${adviceSlotName} and either replace the match with a \`starts-with\` mode (which prefix-matches the whole string), or compose multiple single-word matches via \`and(...)\` if the author wants every word to match.`,
		{ moduleUuid, moduleName: mod.name },
		{
			mode: match.mode,
			property: match.property,
			value: match.value,
			slot,
		},
	);
}

function collectMatches(predicate: Predicate): WhitespaceMatch[] {
	const matches: WhitespaceMatch[] = [];
	walkMatchNodes(predicate, (node) => {
		if (node.mode !== "fuzzy" && node.mode !== "phonetic") return;
		// Only literal-string values are statically inspectable. Other
		// `ValueExpression` shapes (search-input refs, arithmetic, etc.)
		// resolve at runtime; the validator has no static value to
		// check. The bare-input-ref rule covers the input-ref shape
		// elsewhere.
		const literal = extractLiteralStringValue(node.value);
		if (literal === undefined) return;
		if (!/\s/.test(literal)) return;
		matches.push({
			mode: node.mode,
			property: node.property.property,
			value: literal,
		});
	});
	return matches;
}

/**
 * Extract the bare string-literal from a `match.value` expression
 * when the expression is the canonical `{ kind: "term", term:
 * { kind: "literal", type: "text", value: <string> } }` shape the
 * `match(prop, "value", mode)` builder produces. Returns `undefined`
 * for every other shape — the validator only catches statically-
 * inspectable literal values.
 */
function extractLiteralStringValue(
	expression: MatchPredicate["value"],
): string | undefined {
	if (expression.kind !== "term") return undefined;
	if (expression.term.kind !== "literal") return undefined;
	if (typeof expression.term.value !== "string") return undefined;
	return expression.term.value;
}

type MatchPredicate = Extract<Predicate, { kind: "match" }>;

function walkMatchNodes(
	predicate: Predicate,
	visit: (node: MatchPredicate) => void,
): void {
	switch (predicate.kind) {
		case "match":
			visit(predicate);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) walkMatchNodes(clause, visit);
			return;
		case "not":
			walkMatchNodes(predicate.clause, visit);
			return;
		case "when-input-present":
			walkMatchNodes(predicate.clause, visit);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				walkMatchNodes(predicate.where, visit);
			}
			return;
		case "match-all":
		case "match-none":
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "in":
		case "within-distance":
		case "multi-select-contains":
		case "is-null":
		case "is-blank":
		case "between":
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`matchModeWhitespaceInValue: unhandled predicate kind ${String(
					_exhaustive,
				)}`,
			);
		}
	}
}
