/**
 * Rule: every authored predicate whose CSQL emission funnels through
 * CCHQ's tokenized `match`-query path carries whitespace-free
 * literal values.
 *
 * Three operator-mode combinations share the same wire fate:
 *
 *   - `match` with `mode: "fuzzy"` — `fuzzy-match` dispatches
 *     `case_property_query(name, value, fuzzy=True)`, which forwards
 *     to ElasticSearch's `match` query on the tokenized field.
 *   - `match` with `mode: "phonetic"` — `phonetic-match` dispatches
 *     `sounds_like_text_query`, ditto.
 *   - `multi-select-contains` — both `selected` and `selected-any`
 *     dispatch the same `_selected_query` (verified at
 *     `commcare-hq/.../case_search/xpath_functions/__init__.py`:
 *     `'selected': selected_any` — they are the same function), which
 *     routes through `case_property_query(name, value,
 *     multivalue_mode='or'|'and')` and forwards to ES's `match`
 *     query.
 *
 * Every path tokenizes its value argument on whitespace and matches
 * as an OR across the tokens, regardless of the function name Nova
 * emits. So an authored `match(prop, "Alice Smith", "fuzzy")` or
 * `multiSelectAny(prop, literal("Alice Smith"), ...)` ends up
 * matching cases whose property tokens include any of
 * `["Alice", "Smith"]` — silently broader than the author's
 * single-string intent. The on-device dialect tokenizes differently
 * (JavaRosa `multiSelected` uses token-bounded substring matching);
 * the CSQL dispatch through ES's analyzer is the silent divergence.
 *
 * `starts-with` is unaffected — `case_property_starts_with` routes
 * through `filters.prefix` against the exact (non-analyzed) value
 * field, so whitespace-bearing prefix queries work as authored.
 * `fuzzy-date` admits only validated `YYYY-MM-DD` shapes;
 * whitespace is structurally impossible inside a valid date literal.
 *
 * The rule walks every authored `Predicate` slot wire-emitted to
 * CSQL: `caseListConfig.filter`, every advanced-arm
 * `caseListConfig.searchInputs[i].predicate`, and
 * `caseSearchConfig.searchButtonDisplayCondition`. The simple-arm
 * `(property, mode)` shape is derived at wire-emit time from the
 * user's typed input — the value is user-supplied at runtime, not
 * author-supplied, so the validator has nothing to gate.
 *
 * Short-circuits cleanly when the module has no in-scope slots.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

interface WhitespaceMatch {
	readonly operator: "match" | "multi-select-contains";
	readonly mode: "fuzzy" | "phonetic" | "any" | "all";
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
	const operatorLabel =
		match.operator === "match"
			? `\`${match.mode}\` match`
			: `\`multi-select-contains\` quantifier=\`${match.mode}\``;
	const adviceTail =
		match.operator === "match"
			? "either replace the match with a `starts-with` mode (which prefix-matches the whole string) or compose multiple single-word matches via `and(...)` if the author wants every word to match."
			: "either split the multi-word value into separate single-token values, or move the membership check to a `match` predicate with `mode: starts-with` if the author wants prefix matching on the whole literal.";
	return validationError(
		"CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE",
		"module",
		`Module "${mod.name}" has a ${operatorLabel} in ${slot} testing case property "${match.property}" against "${match.value}" — a value that contains whitespace. CCHQ's runtime tokenizes the value on whitespace through ElasticSearch's \`match\` query and matches as an OR across the tokens, so the wire would match cases whose "${match.property}" tokens contain any of "${match.value.split(/\s+/).join('", "')}" — broader than the authored single-string intent. Open ${adviceSlotName} and ${adviceTail}`,
		{ moduleUuid, moduleName: mod.name },
		{
			operator: match.operator,
			mode: match.mode,
			property: match.property,
			value: match.value,
			slot,
		},
	);
}

function collectMatches(predicate: Predicate): WhitespaceMatch[] {
	const matches: WhitespaceMatch[] = [];
	walkPredicateNodes(predicate, {
		visitMatch: (node) => {
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
				operator: "match",
				mode: node.mode,
				property: node.property.property,
				value: literal,
			});
		},
		visitMultiSelect: (node) => {
			// `multi-select-contains.values` is `[Literal, ...Literal[]]` —
			// every value is statically inspectable. CCHQ's `selected` and
			// `selected-any` are the SAME runtime function; both tokenize
			// their value argument. Flag every whitespace-bearing value.
			for (const literal of node.values) {
				if (typeof literal.value !== "string") continue;
				if (!/\s/.test(literal.value)) continue;
				matches.push({
					operator: "multi-select-contains",
					mode: node.quantifier,
					property: node.property.property,
					value: literal.value,
				});
			}
		},
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
type MultiSelectPredicate = Extract<
	Predicate,
	{ kind: "multi-select-contains" }
>;

interface PredicateVisitor {
	readonly visitMatch: (node: MatchPredicate) => void;
	readonly visitMultiSelect: (node: MultiSelectPredicate) => void;
}

function walkPredicateNodes(
	predicate: Predicate,
	visitor: PredicateVisitor,
): void {
	switch (predicate.kind) {
		case "match":
			visitor.visitMatch(predicate);
			return;
		case "multi-select-contains":
			visitor.visitMultiSelect(predicate);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses)
				walkPredicateNodes(clause, visitor);
			return;
		case "not":
			walkPredicateNodes(predicate.clause, visitor);
			return;
		case "when-input-present":
			walkPredicateNodes(predicate.clause, visitor);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				walkPredicateNodes(predicate.where, visitor);
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
