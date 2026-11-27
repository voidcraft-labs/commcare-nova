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
	isVisibleSearchInput,
	searchInputDefault,
	searchInputScreenExpressions,
} from "@/lib/domain";
import { type CheckPath, walkInputRefs } from "@/lib/domain/expression";
import { searchAnswerFieldDependents } from "./searchReadDependents";

type SearchInputOccurrencePaths = readonly [CheckPath, ...CheckPath[]];

function nonEmptyPaths(
	paths: readonly CheckPath[],
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
			readonly kind: "search-address-receiver";
			readonly label: string;
			readonly inputUuid: Uuid;
	  }
	| {
			readonly kind: "cases-available";
			readonly label: "Cases available" | "Online search";
			readonly surface?: "search";
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
	/** A search filter whose value reads the answer, on the Online search
	 * surface of Results' Cases available. */
	| {
			readonly kind: "search-filter";
			readonly label: string;
			readonly filterUuid: Uuid;
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
	/** A form field reading the answer as `#search/<name>` (a case list
	 * registration form's carried answers, or a field of a form whose menu's
	 * forms read the search). */
	| {
			readonly kind: "form-field";
			readonly label: string;
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly fieldUuid: Uuid;
			/** How many of the field's expression slots read the answer. */
			readonly uses: number;
	  };

/** How many places one dependency uses the Search field in. */
export function searchInputDependencyUses(
	dependency: SearchInputRemovalDependency,
): number {
	if (dependency.kind === "search-address-receiver") return 1;
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

function expressionInputPaths(
	expression: NonNullable<CaseSearchConfig["excludedOwnerIds"]>,
	searchInputUuid: Uuid,
): CheckPath[] {
	const paths: CheckPath[] = [];
	walkInputRefs(expression, (ref, path) => {
		if (ref.searchInputUuid === searchInputUuid) paths.push(path);
	});
	return paths;
}

/** Gate-valid uses of a Search field being removed. */
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
			expressionInputPaths(config.filter, target.uuid),
		);
		if (paths !== undefined) {
			dependencies.push({
				kind: "cases-available",
				label: "Cases available",
				paths,
			});
		}
	}
	if (config.searchCondition !== undefined) {
		const paths = nonEmptyPaths(
			expressionInputPaths(config.searchCondition, target.uuid),
		);
		if (paths)
			dependencies.push({
				kind: "cases-available",
				surface: "search",
				label: "Online search",
				paths,
			});
	}
	// A sibling's custom match, required condition, and check rule all read
	// answers; each is its own dependency so the review can open the exact
	// condition. The target's own conditions leave with the row.
	for (const input of config.searchInputs) {
		if (input.uuid === target.uuid) continue;
		const siblingLabel =
			input.label.trim() || input.name.trim() || "Another search field";
		if (
			target.kind === "address" &&
			isVisibleSearchInput(input) &&
			(input.addressReceiver?.kind === "address" ||
				input.addressReceiver?.kind === "address-clear") &&
			input.addressReceiver.source === target.uuid
		) {
			dependencies.push({
				kind: "search-address-receiver",
				label: siblingLabel,
				inputUuid: input.uuid,
			});
		}
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
			...searchInputScreenExpressions(input).map((screen) => ({
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
				expressionInputPaths(condition.predicate, target.uuid),
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
	// A search filter's value is checked against the declared inputs
	// (`nativeSearchFilters.ts`), so a removal that orphans a ref there would
	// bounce off the commit gate without this entry.
	for (const [index, filter] of (config.searchFilters ?? []).entries()) {
		if (!("value" in filter)) continue;
		const paths = nonEmptyPaths(
			expressionInputPaths(filter.value, target.uuid),
		);
		if (paths === undefined) continue;
		dependencies.push({
			kind: "search-filter",
			label: `Search filter ${index + 1}`,
			filterUuid: filter.uuid,
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
			expressionInputPaths(
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
	source: "editor" | "document-diff" = "editor",
): UpdateSearchInputMutation {
	const retainedDefault =
		source === "editor" &&
		current.kind === "address" &&
		replacement.kind === "address"
			? current.savedDefault
			: undefined;
	const { uuid: _uuid, ...searchInput } = {
		...structuredClone(replacement),
		...(retainedDefault !== undefined && { savedDefault: retainedDefault }),
		uuid: current.uuid,
	};
	return {
		kind: "updateSearchInput",
		moduleUuid,
		uuid: current.uuid,
		searchInput,
	};
}
