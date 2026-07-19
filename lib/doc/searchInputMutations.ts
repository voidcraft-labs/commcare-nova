/** Rolling-deploy-safe planners for Search-input row edits. */

import type { Mutation } from "@/lib/doc/types";
import type {
	CaseListConfig,
	CaseSearchConfig,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import {
	type PredicateAstPath,
	renameSearchInputInExpression,
	renameSearchInputInPredicate,
	walkExpressionInputRefsWithPaths,
	walkInputRefsWithPaths,
} from "@/lib/domain/predicate";

type SearchInputOccurrencePaths = readonly [
	PredicateAstPath,
	...PredicateAstPath[],
];

function nonEmptyPaths(
	paths: readonly PredicateAstPath[],
): SearchInputOccurrencePaths | undefined {
	const first = paths[0];
	return first === undefined ? undefined : [first, ...paths.slice(1)];
}

type UpdateSearchInputMutation = Extract<
	Mutation,
	{ kind: "updateSearchInput" }
>;

export type SearchInputRemovalDependency =
	| {
			readonly kind: "cases-available";
			readonly label: "Cases available";
			readonly paths: SearchInputOccurrencePaths;
	  }
	| {
			readonly kind: "search-field-condition";
			readonly label: string;
			readonly inputUuid: SearchInputDef["uuid"];
			readonly paths: SearchInputOccurrencePaths;
	  }
	| {
			readonly kind: "search-field-default";
			readonly label: string;
			readonly inputUuid: SearchInputDef["uuid"];
			readonly paths: SearchInputOccurrencePaths;
	  }
	| {
			readonly kind: "assigned-cases";
			readonly label: "Assigned cases";
			readonly paths: SearchInputOccurrencePaths;
	  }
	| {
			readonly kind: "search-button-visibility";
			readonly label: "Search button visibility";
			readonly paths: SearchInputOccurrencePaths;
	  }
	| {
			readonly kind: "calculated-column";
			readonly label: string;
			readonly columnUuid: Uuid;
			readonly paths: SearchInputOccurrencePaths;
	  };

function predicateInputPaths(
	predicate: NonNullable<CaseListConfig["filter"]>,
	name: string,
): PredicateAstPath[] {
	const paths: PredicateAstPath[] = [];
	walkInputRefsWithPaths(predicate, (ref, path) => {
		if (ref.name === name) paths.push(path);
	});
	return paths;
}

function expressionInputPaths(
	expression: NonNullable<CaseSearchConfig["excludedOwnerIds"]>,
	name: string,
): PredicateAstPath[] {
	const paths: PredicateAstPath[] = [];
	walkExpressionInputRefsWithPaths(expression, (ref, path) => {
		if (ref.name === name) paths.push(path);
	});
	return paths;
}

/** Gate-valid rules that still consume the answer of a field being removed. */
export function searchInputRemovalDependencies(
	config: CaseListConfig,
	searchConfig: CaseSearchConfig | undefined,
	inputUuid: Uuid,
): readonly SearchInputRemovalDependency[] {
	const target = config.searchInputs.find((input) => input.uuid === inputUuid);
	if (target === undefined || target.name.length === 0) return [];
	const dependencies: SearchInputRemovalDependency[] = [];
	if (config.filter !== undefined) {
		const paths = nonEmptyPaths(
			predicateInputPaths(config.filter, target.name),
		);
		if (paths !== undefined) {
			dependencies.push({
				kind: "cases-available",
				label: "Cases available",
				paths,
			});
		}
	}
	for (const input of config.searchInputs) {
		if (input.uuid === target.uuid || input.kind !== "advanced") {
			continue;
		}
		const paths = nonEmptyPaths(
			predicateInputPaths(input.predicate, target.name),
		);
		if (paths === undefined) continue;
		dependencies.push({
			kind: "search-field-condition",
			label: `“${input.label.trim() || input.name.trim() || "Another search field"}” search condition`,
			inputUuid: input.uuid,
			paths,
		});
	}
	// Sibling starting values consume answers too (the validator's
	// `searchInputDefaultTypeCheck` rejects an orphan ref there just like
	// the condition slots do). The target's own default leaves with the
	// row, so only siblings count.
	for (const input of config.searchInputs) {
		if (input.uuid === target.uuid || input.default === undefined) {
			continue;
		}
		const paths = nonEmptyPaths(
			expressionInputPaths(input.default, target.name),
		);
		if (paths === undefined) continue;
		dependencies.push({
			kind: "search-field-default",
			label: `“${input.label.trim() || input.name.trim() || "Another search field"}” starting value`,
			inputUuid: input.uuid,
			paths,
		});
	}
	// Calculated-column formulas are a reference-bearing surface too — the
	// rename path (`rewriteModuleSearchInputRefs`) keeps `input(...)` refs
	// there coherent, and a stored pre-gate doc can carry one while its
	// repair is owner-tier pending. Without this walk the review dialog
	// reports "zero uses" for a doc where a use exists, and the removal
	// strands the formula against a field that no longer exists.
	for (const column of config.columns) {
		if (column.kind !== "calculated") continue;
		const paths = nonEmptyPaths(
			expressionInputPaths(column.expression, target.name),
		);
		if (paths === undefined) continue;
		dependencies.push({
			kind: "calculated-column",
			label: `“${column.header.trim() || "Calculated column"}” column formula`,
			columnUuid: column.uuid,
			paths,
		});
	}
	if (searchConfig?.excludedOwnerIds !== undefined) {
		const paths = nonEmptyPaths(
			expressionInputPaths(searchConfig.excludedOwnerIds, target.name),
		);
		if (paths !== undefined) {
			dependencies.push({
				kind: "assigned-cases",
				label: "Assigned cases",
				paths,
			});
		}
	}
	// The Search action's display condition is validator-checked against
	// declared inputs (`searchButtonDisplayConditionTypeCheck`), so a
	// removal that orphans a ref here would bounce off the commit gate
	// without this entry.
	if (searchConfig?.searchButtonDisplayCondition !== undefined) {
		const paths = nonEmptyPaths(
			predicateInputPaths(
				searchConfig.searchButtonDisplayCondition,
				target.name,
			),
		);
		if (paths !== undefined) {
			dependencies.push({
				kind: "search-button-visibility",
				label: "Search button visibility",
				paths,
			});
		}
	}
	return dependencies;
}

/**
 * Replace one Search field without making its runtime name a rolling-deploy
 * hazard. Origin/main's reducer does not know how to rewrite `input(name)` AST
 * leaves, so the nested fallback retains the old declaration name and rewrites
 * the replacement row's own AST back to that name. Current reducers take the
 * desired name from the optional top-level extension and rewrite every module
 * reference against fresh replay-time state.
 */
export function searchInputUpdateMutation(
	moduleUuid: Uuid,
	current: SearchInputDef,
	replacement: SearchInputDef,
): UpdateSearchInputMutation {
	const desired = {
		...structuredClone(replacement),
		uuid: current.uuid,
	};
	if (desired.name === current.name) {
		return {
			kind: "updateSearchInput",
			moduleUuid,
			uuid: current.uuid,
			searchInput: desired,
		};
	}

	const fallback = structuredClone(desired);
	if (fallback.default !== undefined) {
		renameSearchInputInExpression(fallback.default, desired.name, current.name);
	}
	if (fallback.kind === "advanced") {
		renameSearchInputInPredicate(
			fallback.predicate,
			desired.name,
			current.name,
		);
	}
	fallback.name = current.name;

	return {
		kind: "updateSearchInput",
		moduleUuid,
		uuid: current.uuid,
		searchInput: fallback,
		renamedTo: desired.name,
	};
}
