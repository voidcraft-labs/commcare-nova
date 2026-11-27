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
type ResolvedResultText = { readonly localText: string } & (
	| { readonly text: string }
	| {
			readonly inputName: string;
			readonly inputUuid: import("./uuid").Uuid;
			readonly prefix: string;
			readonly suffix: string;
			readonly onList?: true;
	  }
);

function literalText(column: CalculatedColumn): string | undefined {
	const expr = column.expression;
	return expr.kind === "term" &&
		expr.term.kind === "literal" &&
		typeof expr.term.value === "string"
		? expr.term.value
		: undefined;
}

/** Read a submitted answer only on the Web Apps route that supplied it. */
export function resolveSearchResultDetailText(
	doc: Pick<BlueprintDoc, "appSettings">,
	module: Module,
	column: CalculatedColumn,
	branch: SearchResultDetailText,
): ResolvedResultText | undefined {
	return doc.appSettings.runsOnlyOn === "web-apps"
		? resolveSearchResultDetailRoute(module, column, branch)
		: undefined;
}

/** Check the route and column shape before the reader offers platform choices. */
export function resolveSearchResultDetailRoute(
	module: Module,
	column: CalculatedColumn,
	branch: SearchResultDetailText,
): ResolvedResultText | undefined {
	const config = module.caseListConfig;
	const onList = "onList" in branch && branch.onList === true;
	if (
		config === undefined ||
		moduleSearchWorkflow(module) !== "searchFirst" ||
		moduleFormsReadSearch(module) ||
		projectSearchOf(module) !== undefined ||
		config.selection !== undefined ||
		config.detailTabs !== undefined ||
		config.detailTile !== undefined ||
		(onList
			? column.notOnList === true ||
				column.visibleInList === false ||
				column.visibleInDetail !== false ||
				module.caseListMenuItem !== undefined ||
				config.tile !== undefined ||
				branch.prefix !== "" ||
				branch.suffix !== ""
			: column.notOnList !== true || column.visibleInDetail === false) ||
		column.sort !== undefined ||
		column.texts !== undefined ||
		column.showAs !== undefined ||
		column.loadBehavior !== undefined ||
		column.rowField !== undefined
	)
		return;
	const localText = literalText(column);
	if (
		localText === undefined ||
		!canPrint(localText) ||
		(onList && localText !== "")
	)
		return;
	if ("text" in branch) {
		return canPrint(branch.text) ? { text: branch.text, localText } : undefined;
	}
	const prompt = config.searchInputs.find(
		(input) => input.uuid === branch.inputUuid,
	);
	if (
		(prompt?.kind !== "simple" && prompt?.kind !== "advanced") ||
		prompt.type !== "text" ||
		prompt.hidden ||
		searchInputRequestKey(prompt) !== prompt.name ||
		!canPrint(branch.prefix) ||
		!canPrint(branch.suffix)
	)
		return;
	return {
		inputName: prompt.name,
		inputUuid: prompt.uuid,
		prefix: branch.prefix,
		suffix: branch.suffix,
		localText,
		...(onList && { onList }),
	};
}

function canPrint(text: string): boolean {
	return !(text.includes("'") && text.includes('"'));
}

/** Columns and their resolved text prompts in the standalone Results route. */
export function searchResultDetailColumns(
	doc: Pick<BlueprintDoc, "appSettings">,
	module: Module,
) {
	return (module.caseListConfig?.columns ?? []).flatMap<
		ResolvedResultText & { columnUuid: Column["uuid"] }
	>((column) => {
		if (column.kind !== "calculated" || !column.searchResultDetail) return [];
		const resolved = resolveSearchResultDetailText(
			doc,
			module,
			column,
			column.searchResultDetail,
		);
		return resolved ? [{ columnUuid: column.uuid, ...resolved }] : [];
	});
}
