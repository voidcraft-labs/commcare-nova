import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import {
	type Column,
	type Module,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
	projectSearchOf,
	searchInputRequestKey,
} from "./modules";
import { uuidSchema } from "./uuid";

/** The text branch of a calculated column when it runs on a Search result
 * Detail. An offered prompt's absence reads as empty text. The column's
 * ordinary expression still owns the fallback. */
export const searchResultDetailTextSchema = z.strictObject({
	inputUuid: uuidSchema,
	prefix: z.string(),
	suffix: z.string(),
});

export type SearchResultDetailText = z.infer<
	typeof searchResultDetailTextSchema
>;

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
	const config = module.caseListConfig;
	if (
		doc.appSettings.runsOnlyOn !== "web-apps" ||
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
