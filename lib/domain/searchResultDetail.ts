import type { BlueprintDoc } from "./blueprint";
import {
	type Column,
	type Module,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
	projectSearchOf,
	searchInputRequestKey,
} from "./modules";
import type { SearchResultDetailText } from "./searchResultDetailShape";

type CalculatedColumn = Extract<Column, { kind: "calculated" }>;

function literalText(column: CalculatedColumn): string | undefined {
	const expr = column.expression;
	return expr.kind === "term" &&
		expr.term.kind === "literal" &&
		typeof expr.term.value === "string"
		? expr.term.value
		: undefined;
}

/** Limit the first result branch to the proven complete Web Apps route and
 * plain, long-only column. In particular the result expression must never
 * run while a worker is sorting, choosing, or displaying an ordinary list. */
export function resolveSearchResultDetailText(
	doc: Pick<BlueprintDoc, "appSettings">,
	module: Module,
	column: CalculatedColumn,
	branch: SearchResultDetailText,
) {
	return doc.appSettings.runsOnlyOn === "web-apps"
		? resolveSearchResultDetailRoute(module, column, branch)
		: undefined;
}

/** Check the route and column shape before the reader offers platform choices. */
export function resolveSearchResultDetailRoute(
	module: Module,
	column: CalculatedColumn,
	branch: SearchResultDetailText,
) {
	const config = module.caseListConfig;
	if (
		config === undefined ||
		moduleSearchWorkflow(module) !== "searchFirst" ||
		moduleFormsReadSearch(module) ||
		projectSearchOf(module) !== undefined ||
		config.selection !== undefined ||
		config.detailTabs !== undefined ||
		config.detailTile !== undefined ||
		column.notOnList !== true ||
		column.visibleInDetail === false ||
		column.sort !== undefined ||
		column.texts !== undefined ||
		column.showAs !== undefined ||
		column.loadBehavior !== undefined ||
		column.rowField !== undefined
	)
		return;
	const prompt = config.searchInputs.find(
		(input) => input.uuid === branch.inputUuid,
	);
	if (
		(prompt?.kind !== "simple" && prompt?.kind !== "advanced") ||
		prompt.type !== "text" ||
		prompt.hidden ||
		searchInputRequestKey(prompt) !== prompt.name
	)
		return;
	const localText = literalText(column);
	if (
		localText === undefined ||
		[localText, branch.prefix, branch.suffix].some(
			(text) => text.includes("'") && text.includes('"'),
		)
	)
		return;
	return {
		inputName: prompt.name,
		prefix: branch.prefix,
		suffix: branch.suffix,
		localText,
	};
}

/** Columns and their resolved text prompts in the standalone Results route. */
export function searchResultDetailColumns(
	doc: Pick<BlueprintDoc, "appSettings">,
	module: Module,
) {
	return (module.caseListConfig?.columns ?? []).flatMap((column) => {
		if (column.kind !== "calculated" || !column.searchResultDetail) return [];
		const resolved = resolveSearchResultDetailText(
			doc,
			module,
			column,
			column.searchResultDetail,
		);
		return resolved
			? [
					{
						columnUuid: column.uuid,
						inputUuid: column.searchResultDetail.inputUuid,
						...resolved,
					},
				]
			: [];
	});
}
