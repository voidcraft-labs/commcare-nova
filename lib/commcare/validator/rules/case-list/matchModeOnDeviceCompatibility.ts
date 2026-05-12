/**
 * Rule: `match` predicate modes `fuzzy`, `phonetic`, and `fuzzy-date`
 * only land on slots that lower to CSQL (server-side ES). On
 * slots that lower to JavaRosa on-device XPath, only `starts-with`
 * is admissible.
 *
 * JavaRosa registers `starts-with` at
 * `commcare-core/.../org/javarosa/xpath/expr/XPathStartsWithFunc.java::NAME`
 * (and dispatched at
 * `commcare-core/.../xpath/parser/ast/ASTNodeFunctionCall.java::buildFunction`).
 * It has no entries for `fuzzy-match`, `phonetic-match`, or
 * `fuzzy-date` — those are CCHQ-server-only functions registered
 * on
 * `commcare-hq/.../case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
 * JavaRosa raises `XPathUnhandledException` at the first
 * unrecognized function call, so a case-list nodeset filter or
 * search-button display condition carrying a CSQL-only mode
 * throws on every case-list load — fail-closed, no silent
 * regression but no working module either.
 *
 * On-device-lowering authoring slots:
 *
 *   - `caseListConfig.filter` — wraps the entry nodeset for
 *     case-list display via
 *     `lib/commcare/suite/case-list/nodesetFilter.ts::emitNodesetFilter`.
 *     ALSO AND-composes into `_xpath_query` (CSQL) when the module
 *     carries a `caseSearchConfig`, but the on-device requirement
 *     is the limiting factor — the case-list display has to render
 *     before search starts.
 *   - `caseSearchConfig.searchButtonDisplayCondition` — feeds the
 *     `relevant` attribute on the `<action>` block (case-search
 *     button) AND on the `<remote-request>`'s `<command>` (via
 *     `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument`'s
 *     `search_button_display_condition` slot).
 *
 * The advanced-arm `searchInputs[i].predicate` slot is exempt —
 * that one routes only through CSQL (`composeXPathQueryEmission`'s
 * `_xpath_query` AND-composition), so the three CSQL-only modes are
 * wire-correct there.
 *
 * Short-circuits cleanly when the module has no in-scope slots.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

type MatchPredicate = Extract<Predicate, { kind: "match" }>;
type DisallowedMode = "fuzzy" | "phonetic" | "fuzzy-date";

const CSQL_ONLY_MODES: readonly DisallowedMode[] = [
	"fuzzy",
	"phonetic",
	"fuzzy-date",
];

function isCsqlOnlyMode(mode: string): mode is DisallowedMode {
	return (CSQL_ONLY_MODES as readonly string[]).includes(mode);
}

export function matchModeOnDeviceCompatibility(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const filter = mod.caseListConfig?.filter;
	if (filter !== undefined) {
		for (const offender of collectCsqlOnlyMatches(filter)) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					match: offender,
					slot: "caseListConfig.filter",
					adviceSlotName: "the case list's always-on filter",
				}),
			);
		}
	}

	const buttonCondition = mod.caseSearchConfig?.searchButtonDisplayCondition;
	if (buttonCondition !== undefined) {
		for (const offender of collectCsqlOnlyMatches(buttonCondition)) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					match: offender,
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
	match: MatchPredicate;
	slot: string;
	adviceSlotName: string;
}): ValidationError {
	const { mod, moduleUuid, match, slot, adviceSlotName } = args;
	const mode = match.mode;
	return validationError(
		"CASE_LIST_MATCH_MODE_NOT_ON_DEVICE",
		"module",
		`Module "${mod.name}" has a \`${mode}\` match on case property "${match.property.property}" in ${slot}, but that slot lowers to on-device XPath where only \`starts-with\` is available — JavaRosa's runtime has no \`fuzzy-match\` / \`phonetic-match\` / \`fuzzy-date\` function, so the case list would fail to load. Move the predicate to an advanced-arm search input (\`caseListConfig.searchInputs[i].predicate\`) — that path routes only through CSQL on the server, where the three modes are supported — or switch the match mode to \`starts-with\` in ${adviceSlotName} if a prefix match satisfies the author's intent.`,
		{ moduleUuid, moduleName: mod.name },
		{
			mode,
			property: match.property.property,
			slot,
		},
	);
}

function collectCsqlOnlyMatches(predicate: Predicate): MatchPredicate[] {
	const offenders: MatchPredicate[] = [];
	walkMatchPredicates(predicate, (node) => {
		if (isCsqlOnlyMode(node.mode)) offenders.push(node);
	});
	return offenders;
}

function walkMatchPredicates(
	predicate: Predicate,
	visit: (node: MatchPredicate) => void,
): void {
	switch (predicate.kind) {
		case "match":
			visit(predicate);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				walkMatchPredicates(clause, visit);
			}
			return;
		case "not":
		case "when-input-present":
			walkMatchPredicates(predicate.clause, visit);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				walkMatchPredicates(predicate.where, visit);
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
		case "multi-select-contains":
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`matchModeOnDeviceCompatibility: hit an unhandled predicate kind '${String(_exhaustive)}' while walking the AST. The walker covers every variant on the Predicate discriminated union; extending the union surfaces here as a TypeScript never error. Add a branch matching the new kind so the rule walks it correctly.`,
			);
		}
	}
}
