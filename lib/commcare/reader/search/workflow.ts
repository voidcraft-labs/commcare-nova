/**
 * Whether a menu searches, and what a worker sees first: the three booleans
 * of `search_config`, read by the inverse of
 * `suite/case-search/searchWireShape.ts::searchWireShape` and accepted
 * where it gives them back.
 */
import type { OrdinaryCaseSearchConfig } from "@/lib/domain/modules";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { searchWireShape } from "../../suite/case-search/searchWireShape";
import { type Claim, defineClaims, drop, refuse, take } from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { isJsonObject, type JsonCursor } from "../jsonCursor";

const S = "case-search/";

const triple = (entry: string) =>
	({
		autoLaunch: take(`${S}${entry}`, "schema:CaseSearch.auto_launch"),
		defaultSearch: take(`${S}${entry}`, "schema:CaseSearch.default_search"),
		inlineSearch: take(`${S}${entry}`, "schema:CaseSearch.inline_search"),
	}) as const;

export const WORKFLOW_CLAIMS = {
	searchFirst: defineClaims(
		"search.workflow.searchFirst",
		triple("workflow-search-first-auto-launch-true-default-search-false"),
	),
	skipToResults: defineClaims(
		"search.workflow.skipToResults",
		triple("workflow-skip-to-default-results-auto-launch-true-default-search"),
	),
	inlineVisible: defineClaims(
		"search.workflow.inlineVisible",
		triple("inline-search-true-auto-launch-true-on-a-module-with-visible"),
	),
	inlineHidden: defineClaims(
		"search.workflow.inlineHidden",
		triple("inline-search-true-auto-launch-true-on-a-module-without-visible"),
	),
	inlineSkipVisible: defineClaims(
		"search.workflow.inlineSkipVisible",
		triple("inline-search-default-search-on-a-module-with-visible-inputs"),
	),
	inlineSkipHidden: defineClaims(
		"search.workflow.inlineSkipHidden",
		triple("inline-search-default-search-on-a-module-without-visible-inputs"),
	),
	listFirst: defineClaims("search.workflow.listFirst", {
		autoLaunch: take(
			`${S}auto-launch-false-in-an-app-with-cloudcare-enabled-false`,
			"schema:CaseSearch.auto_launch",
		),
		defaultSearch: take(
			`${S}auto-launch-false-in-an-app-with-cloudcare-enabled-false`,
			"schema:CaseSearch.default_search",
		),
	}),
	listFirstWithDefaultResults: defineClaims(
		"search.workflow.listFirstWithDefaultResults",
		{
			autoLaunch: take(
				`${S}list-first-with-a-search-that-skips-to-results`,
				"schema:CaseSearch.auto_launch",
			),
			defaultSearch: take(
				`${S}list-first-with-a-search-that-skips-to-results`,
				"schema:CaseSearch.default_search",
			),
		},
	),
	other: defineClaims("search.workflow.other", {
		classic: refuse(
			`${S}workflow-legacy-classic-auto-launch-false-in-an-app-with`,
			"schema:CaseSearch.auto_launch",
		),
		inlineWithoutLaunch: drop(
			`${S}inline-search-true-with-auto-launch-false`,
			"schema:CaseSearch.inline_search",
		),
		putInRoot: take(
			`${S}search-on-a-put-in-root-module`,
			"schema:CaseSearch.auto_launch",
		),
	}),
};

/** A menu's search: the place every finding about its `search_config` stands at. */
export function searchPlace(module: DraftModule): HqPlace {
	return {
		kind: "search",
		menu: module.index,
		name: module.place.kind === "menu" ? module.place.name : "",
	};
}

/** The workflow slots one menu's booleans read into. */
export type SearchWorkflow = Pick<
	OrdinaryCaseSearchConfig,
	"workflow" | "formsReadSearch"
>;

/** Whether a menu offers search: `properties` or `default_properties` not empty
 *  (`util.py::module_offers_search`). */
export function offersSearch(config: JsonCursor): boolean {
	const properties = config.peek("properties");
	const defaults = config.peek("default_properties");
	return (
		(Array.isArray(properties) && properties.length > 0) ||
		(Array.isArray(defaults) && defaults.length > 0)
	);
}

/** Whether some prompt of the search is visible. */
function hasVisiblePrompt(config: JsonCursor): boolean {
	const properties = config.peek("properties");
	return (
		Array.isArray(properties) &&
		properties.some((one) => isJsonObject(one) && one.hidden !== true)
	);
}

function claimTriple(
	config: JsonCursor,
	claims: Readonly<
		Record<"autoLaunch" | "defaultSearch" | "inlineSearch", Claim<"take">>
	>,
): void {
	config.take("auto_launch", claims.autoLaunch, Boolean).value;
	config.take("default_search", claims.defaultSearch, Boolean).value;
	config.take("inline_search", claims.inlineSearch, Boolean).value;
}

/**
 * Reads the menu's three booleans into its search's `workflow` and `formsReadSearch`, or raises
 * the finding a row names. `undefined` where a finding stands.
 */
export function readSearchWorkflow(
	ctx: ReadContext,
	module: DraftModule,
	config: JsonCursor,
): SearchWorkflow | undefined {
	const W = WORKFLOW_CLAIMS;
	const autoLaunch = config.peek("auto_launch") === true;
	const defaultSearch = config.peek("default_search") === true;
	const inline = config.peek("inline_search") === true;
	// An inline search on such a menu is the menu's refusal
	// (`menus/modules.ts::readFormsInMenuAbove`, HQ's `inline search to display
	// only forms`), which stands before any search is read.
	const formsAbove = module.json.peek("put_in_root") === true;
	let workflow: SearchWorkflow;
	if (autoLaunch) {
		const visible = hasVisiblePrompt(config);
		const claims = !inline
			? defaultSearch
				? W.skipToResults
				: W.searchFirst
			: defaultSearch
				? visible
					? W.inlineSkipVisible
					: W.inlineSkipHidden
				: visible
					? W.inlineVisible
					: W.inlineHidden;
		claimTriple(config, claims);
		workflow = {
			...(defaultSearch && { workflow: "skipToResults" as const }),
			...(inline && { formsReadSearch: true as const }),
		};
	} else {
		if (inline) config.drop("inline_search", W.other.inlineWithoutLaunch);
		if (ctx.input.source.cloudcareEnabled) {
			// `auto_launch: false` is the model's default, which no claim records.
			ctx.accounting.finding(W.other.classic, config.place);
			return undefined;
		}
		const claims = defaultSearch ? W.listFirstWithDefaultResults : W.listFirst;
		config.take("auto_launch", claims.autoLaunch, Boolean).value;
		config.take("default_search", claims.defaultSearch, Boolean).value;
		workflow = {
			workflow: defaultSearch ? "listFirstWithDefaultResults" : "listFirst",
		};
	}
	// The booleans the projection writes for the reading are the stored ones.
	const shape = searchWireShape(workflow as OrdinaryCaseSearchConfig);
	if (
		shape.autoLaunch !== autoLaunch ||
		shape.defaultSearch !== defaultSearch ||
		shape.inlineSearch !== (autoLaunch && inline)
	) {
		ctx.accounting.circumstance("unrecognized", config.place, {
			name: "schema:CaseSearch.auto_launch",
		});
		return undefined;
	}
	if (formsAbove) {
		if (config.used("auto_launch"))
			config.takePart("auto_launch", "forms-in-menu-above", W.other.putInRoot);
		else config.takeDefault("auto_launch", W.other.putInRoot);
	}
	return workflow;
}
