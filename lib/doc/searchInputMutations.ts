/** Planners for Search-input row edits. */

import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type {
	CaseListConfig,
	CaseSearchConfig,
	SearchInputConditionSlot,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import {
	isOwnerOnlyCaseSearchConfig,
	searchInputDefault,
	searchInputScreenPredicates,
} from "@/lib/domain";
import {
	type PredicateAstPath,
	walkExpressionInputRefsWithPaths,
	walkInputRefsWithPaths,
} from "@/lib/domain/predicate";
import { searchAnswerFieldDependents } from "./searchNoMatchesDependents";

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
			/** Which of the sibling's conditions reads the answer. */
			readonly slot: SearchInputConditionSlot;
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
	  }
	/** A form field reading the answer as `#search/<name>` (the no-matches
	 * registration form's carried answers). */
	| {
			readonly kind: "form-field";
			readonly label: string;
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly fieldUuid: Uuid;
			/** How many of the field's expression slots read the answer. */
			readonly uses: number;
	  };

/** How many places one dependency reads the answer in. */
export function searchInputDependencyUses(
	dependency: SearchInputRemovalDependency,
): number {
	return dependency.kind === "form-field"
		? dependency.uses
		: dependency.paths.length;
}

/**
 * The form fields of `moduleUuid` reading the prompt's answer as
 * `#search/<name>`: they live outside the case-list config, so a surface
 * holding the config still needs the document for them.
 */
export function searchInputFormFieldDependencies(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	inputUuid: Uuid,
): readonly SearchInputRemovalDependency[] {
	return searchAnswerFieldDependents(doc, inputUuid).map((dependent) => ({
		kind: "form-field" as const,
		label: `“${dependent.fieldId}” in “${dependent.formName}”`,
		moduleUuid,
		formUuid: dependent.formUuid,
		fieldUuid: dependent.fieldUuid,
		uses: dependent.slots.length,
	}));
}

/**
 * {@link searchInputRemovalDependencies} over the document's own copy of the
 * module's config, plus {@link searchInputFormFieldDependencies}.
 */
export function searchInputRemovalDependenciesInDoc(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	inputUuid: Uuid,
): readonly SearchInputRemovalDependency[] {
	const mod = doc.modules[moduleUuid];
	if (mod?.caseListConfig === undefined) return [];
	return [
		...searchInputRemovalDependencies(
			mod.caseListConfig,
			mod.caseSearchConfig,
			inputUuid,
		),
		...searchInputFormFieldDependencies(doc, moduleUuid, inputUuid),
	];
}

function predicateInputPaths(
	predicate: NonNullable<CaseListConfig["filter"]>,
	searchInputUuid: Uuid,
): PredicateAstPath[] {
	const paths: PredicateAstPath[] = [];
	walkInputRefsWithPaths(predicate, (ref, path) => {
		if (ref.searchInputUuid === searchInputUuid) paths.push(path);
	});
	return paths;
}

function expressionInputPaths(
	expression: NonNullable<CaseSearchConfig["excludedOwnerIds"]>,
	searchInputUuid: Uuid,
): PredicateAstPath[] {
	const paths: PredicateAstPath[] = [];
	walkExpressionInputRefsWithPaths(expression, (ref, path) => {
		if (ref.searchInputUuid === searchInputUuid) paths.push(path);
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
	if (target === undefined) return [];
	const dependencies: SearchInputRemovalDependency[] = [];
	if (config.filter !== undefined) {
		const paths = nonEmptyPaths(
			predicateInputPaths(config.filter, target.uuid),
		);
		if (paths !== undefined) {
			dependencies.push({
				kind: "cases-available",
				label: "Cases available",
				paths,
			});
		}
	}
	// A sibling's custom match, required condition, and check rule all read
	// answers; each is its own dependency so the review can open the exact
	// condition. The target's own conditions leave with the row.
	for (const input of config.searchInputs) {
		if (input.uuid === target.uuid) continue;
		const siblingLabel =
			input.label.trim() || input.name.trim() || "Another search field";
		const conditions: readonly {
			readonly slot: SearchInputConditionSlot;
			readonly predicate: NonNullable<CaseListConfig["filter"]>;
			readonly label: string;
		}[] = [
			...(input.kind === "advanced"
				? [
						{
							slot: "match" as const,
							predicate: input.predicate,
							label: `“${siblingLabel}” search condition`,
						},
					]
				: []),
			...searchInputScreenPredicates(input).map((screen) => ({
				slot: screen.slot,
				predicate: screen.predicate,
				label:
					screen.slot === "required"
						? `“${siblingLabel}” required condition`
						: `“${siblingLabel}” check`,
			})),
		];
		for (const condition of conditions) {
			const paths = nonEmptyPaths(
				predicateInputPaths(condition.predicate, target.uuid),
			);
			if (paths === undefined) continue;
			dependencies.push({
				kind: "search-field-condition",
				label: condition.label,
				inputUuid: input.uuid,
				slot: condition.slot,
				paths,
			});
		}
	}
	// Sibling starting values consume answers too (the validator's
	// `searchInputDefaultTypeCheck` rejects an orphan ref there just like
	// the condition slots do). The target's own default leaves with the
	// row, so only siblings count.
	for (const input of config.searchInputs) {
		const defaultValue = searchInputDefault(input);
		if (input.uuid === target.uuid || defaultValue === undefined) {
			continue;
		}
		const paths = nonEmptyPaths(
			expressionInputPaths(defaultValue, target.uuid),
		);
		if (paths === undefined) continue;
		dependencies.push({
			kind: "search-field-default",
			label: `“${input.label.trim() || input.name.trim() || "Another search field"}” starting value`,
			inputUuid: input.uuid,
			paths,
		});
	}
	// Calculated-column formulas are a reference-bearing surface too.
	// Without this walk the review dialog
	// reports "zero uses" for a doc where a use exists, and the removal
	// strands the formula against a field that no longer exists.
	for (const column of config.columns) {
		if (column.kind !== "calculated") continue;
		const paths = nonEmptyPaths(
			expressionInputPaths(column.expression, target.uuid),
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
			expressionInputPaths(searchConfig.excludedOwnerIds, target.uuid),
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
	if (
		searchConfig !== undefined &&
		!isOwnerOnlyCaseSearchConfig(searchConfig) &&
		searchConfig.searchButtonDisplayCondition !== undefined
	) {
		const paths = nonEmptyPaths(
			predicateInputPaths(
				searchConfig.searchButtonDisplayCondition,
				target.uuid,
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

/** Replace one Search field; UUID-backed references need no rename rewrite. */
export function searchInputUpdateMutation(
	moduleUuid: Uuid,
	current: SearchInputDef,
	replacement: SearchInputDef,
): UpdateSearchInputMutation {
	const { uuid: _uuid, ...searchInput } = {
		...structuredClone(replacement),
		uuid: current.uuid,
	};
	return {
		kind: "updateSearchInput",
		moduleUuid,
		uuid: current.uuid,
		searchInput,
	};
}
