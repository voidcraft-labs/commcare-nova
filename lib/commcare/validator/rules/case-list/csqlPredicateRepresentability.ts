/**
 * Rule: every predicate that reaches CCHQ's server-side case-search query
 * language has a faithful CSQL representation.
 *
 * Nova's predicate AST and Preview/Postgres evaluators intentionally support
 * more value-expression shapes than CCHQ's CSQL parser. In particular, CSQL
 * needs a case-property query anchor on a comparison, cannot compare one case
 * property with another, and supports related-case counts only for child
 * cases in the query-anchor position. Letting one of those wider AST shapes
 * through would make Preview work while the exported app fails when search is
 * executed.
 *
 * This rule is deliberately scoped to modules where case search is effective
 * and to the two authored predicate slots that reach `_xpath_query`:
 *
 *   - `caseListConfig.filter`, which joins the remote query whenever search is
 *     enabled; and
 *   - advanced `caseListConfig.searchInputs[i].predicate` bodies.
 *
 * A filter on an ordinary on-device case list is out of scope because it does
 * not cross the CSQL boundary. Simple inputs are out of scope because their
 * constrained `(property, mode, via)` shape is derived by the wire layer and
 * has its own compatibility rules. Every authored clause is simplified before
 * checking, exactly like `_xpath_query` emission; an effective match-none
 * clause absorbs the AND composition, so dead sibling clauses do not create
 * false-positive authoring errors. Strict-null is intentionally delegated to
 * the module-wide portability rule, which covers every predicate/expression
 * wire slot with one user-facing repair.
 */

import {
	type CsqlRepresentabilityIssue,
	checkCsqlRepresentability,
} from "@/lib/commcare/predicate";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath } from "./shared";

const FILTER_SLOT = "caseListConfig.filter";

export function csqlPredicateRepresentability(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (effectiveCaseSearchConfig(mod) === undefined) return [];

	const slots: EffectivePredicateSlot[] = [];
	const filter = mod.caseListConfig?.filter;
	if (filter !== undefined) {
		const effective = effectiveFilterForEmission(filter);
		if (effective !== undefined) {
			slots.push({
				mod,
				moduleUuid,
				predicate: effective,
				slot: FILTER_SLOT,
				slotLabel: "the Cases available rule",
			});
		}
	}

	const inputs = mod.caseListConfig?.searchInputs ?? [];
	for (let index = 0; index < inputs.length; index += 1) {
		const input = inputs[index];
		if (input.kind !== "advanced") continue;
		const effective = effectiveFilterForEmission(input.predicate);
		if (effective === undefined) continue;
		slots.push({
			mod,
			moduleUuid,
			predicate: effective,
			slot: `caseListConfig.searchInputs[${index}].predicate`,
			slotLabel: `advanced search input "${input.label || input.name}"`,
			input: {
				uuid: input.uuid,
				name: input.name,
				label: input.label || input.name,
			},
		});
	}

	// `_xpath_query` AND-composes these slots. One effective match-none clause
	// absorbs the whole composition, so every sibling is unreachable and the
	// emitted query is the portable constant `match-none()`. Validating a dead
	// sibling would reject more than the wire boundary does.
	if (slots.some((entry) => entry.predicate.kind === "match-none")) return [];

	return slots.flatMap(errorsForPredicate);
}

interface EffectivePredicateSlot {
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly predicate: Predicate;
	readonly slot: string;
	readonly slotLabel: string;
	readonly input?: {
		readonly uuid: Uuid;
		readonly name: string;
		readonly label: string;
	};
}

function errorsForPredicate(args: EffectivePredicateSlot): ValidationError[] {
	return (
		checkCsqlRepresentability(args.predicate)
			// Strict-null portability is a module-wide wire constraint shared by
			// every Predicate/ValueExpression slot. Its dedicated rule owns that
			// single repair; keep the checker issue for direct-emitter defense in
			// depth without duplicating it in the module validator.
			.filter((issue) => issue.reason !== "strict-null-not-portable")
			.map((issue) => buildError(args, issue))
	);
}

function buildError(
	args: EffectivePredicateSlot,
	issue: CsqlRepresentabilityIssue,
): ValidationError {
	const path = formatPath([...issue.path]);
	return validationError(
		"CASE_LIST_CSQL_NOT_REPRESENTABLE",
		"module",
		`Module "${args.mod.name}" needs a change in ${args.slotLabel}: ${issue.message}`,
		{ moduleUuid: args.moduleUuid, moduleName: args.mod.name },
		{
			reason: issue.reason,
			path,
			slot: args.slot,
			surface: args.input === undefined ? "filter" : "advanced-input",
			...(args.input !== undefined
				? {
						inputUuid: args.input.uuid,
						inputName: args.input.name,
						inputLabel: args.input.label,
					}
				: {}),
		},
	);
}
