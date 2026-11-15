/**
 * A menu's two details read into one case list (`readCaseDetails`): the
 * detail's own keys, each column of the short and the long detail
 * (`columns.ts`), the two joined into one set of columns
 * (`joinDetailColumns`), the order (`order.ts`) and the tile (`tile.ts`).
 * What the pass decides is written into the menu's draft; what the second
 * pass compares is kept in the reading (`caseListReading`).
 */
import { type Draft, produce } from "immer";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type CaseProperty,
	type Column,
	type ColumnSort,
	casePropertyOptionTranslationUnitId,
	orderedColumns,
	plainColumn,
	type TranslationUnitId,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { moduleCaseTypeForActions } from "@/lib/domain/basicCaseSlots";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { caseListColumnTextShows } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { emptyShortListColumns } from "../../hqJson/caseList";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { applicationReading } from "../appShell";
import { withCandidate } from "../candidate";
import { noteProperty } from "../caseManagement/catalog";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { externalKey } from "../identity";
import { reReadUuidOf } from "../identityMap";
import { isJsonObject, type JsonCursor, sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { listFilterWithoutOwnerClause } from "../search/settings";
import { sameXPathText } from "../syntaxCompare";
import type { SameStateRegister } from "../types";
import {
	appCodes,
	type ColumnOptions,
	type ColumnProposal,
	type ColumnReading,
	readDetailColumn,
	type SelectProperty,
	shownTexts,
	sourceText,
	translatedTexts,
} from "./columns";
import { CALCULATED_FIELD, readSortElements, type SortReading } from "./order";
import { readTile, type TileReading } from "./tile";

const A = "menus-and-case-lists/";

export const DETAIL_CLAIMS = defineClaims("caseList.details", {
	pairModule: take(`${A}detail-columns-short`, "schema:Module.case_details"),
	pairAdvanced: take(
		`${A}detail-columns-short`,
		"schema:AdvancedModule.case_details",
	),
	short: take(`${A}detail-columns-short`, "schema:DetailPair.short"),
	long: take(`${A}detail-columns-long`, "schema:DetailPair.long"),
	shortColumns: take(`${A}detail-columns-short`, "schema:Detail.columns"),
	longColumns: take(`${A}detail-columns-long`, "schema:Detail.columns"),
	surveyColumns: drop(
		`${A}short-columns-empty-on-a-survey-or-registration-only-module-that`,
		"schema:Detail.columns",
	),
	shortEmptyNeeded: refuse(
		`${A}short-columns-empty-on-a-module-that-needs-case-details`,
		"schema:Detail.columns",
	),
	shortEmptyUnread: drop(
		`${A}short-columns-empty-on-a-survey-or-registration-only-module-that`,
		"schema:Detail.columns",
	),
	shortEmptyParent: refuse(
		`${A}short-columns-empty-on-a-module-another-module-s-active-parent`,
		"schema:Detail.columns",
	),
	display: drop(`${A}detail-display`, "schema:Detail.display"),
	instanceCasedb: drop(
		`${A}detail-instance-name-casedb`,
		"schema:Detail.instance_name",
	),
	instanceOther: refuse(
		`${A}detail-instance-name-any-other-stored-value`,
		"schema:Detail.instance_name",
	),
	multiSelect: take(`${A}detail-multi-select`, "schema:Detail.multi_select"),
	multiSelectAdvanced: drop(
		`${A}multi-select-auto-select-or-max-select-value-on-an-advanced-or`,
		"schema:Detail.multi_select",
	),
	maxSelect: take(
		`${A}detail-max-select-value-on-a-multi-select-basic-list`,
		"schema:Detail.max_select_value",
	),
	maxSelectAbove: refuse(
		`${A}detail-max-select-value-above-100`,
		"schema:Detail.max_select_value",
	),
	maxSelectZero: refuse(
		`${A}detail-max-select-value-of-0-or-below-1-on-a-multi-select-basic`,
		"schema:Detail.max_select_value",
	),
	maxSelectSingle: drop(
		`${A}detail-max-select-value-on-a-basic-list-that-is-not-multi-select`,
		"schema:Detail.max_select_value",
	),
	maxSelectAdvanced: drop(
		`${A}multi-select-auto-select-or-max-select-value-on-an-advanced-or`,
		"schema:Detail.max_select_value",
	),
	autoSelectMulti: refuse(
		`${A}detail-auto-select-multi-select`,
		"schema:Detail.auto_select",
	),
	autoSelectSingle: refuse(
		`${A}detail-auto-select-true-on-a-single-select-basic-list`,
		"schema:Detail.auto_select",
	),
	autoSelectAdvanced: drop(
		`${A}multi-select-auto-select-or-max-select-value-on-an-advanced-or`,
		"schema:Detail.auto_select",
	),
	persistentFromModule: refuse(
		`${A}detail-persistent-case-tile-from-module`,
		"schema:Detail.persistent_case_tile_from_module",
	),
	pullDown: refuse(`${A}detail-pull-down-tile`, "schema:Detail.pull_down_tile"),
	persistContext: refuse(
		`${A}detail-persist-case-context-persistent-case-context-xml`,
		"schema:Detail.persist_case_context",
	),
	persistContextXml: refuse(
		`${A}detail-persist-case-context-persistent-case-context-xml`,
		"schema:Detail.persistent_case_context_xml",
	),
	persistContextBeside: drop(
		`${A}persist-case-context-beside-persist-tile-on-forms-on-a-short`,
		"schema:Detail.persist_case_context",
	),
	persistContextXmlBeside: drop(
		`${A}persist-case-context-beside-persist-tile-on-forms-on-a-short`,
		"schema:Detail.persistent_case_context_xml",
	),
	customXml: refuse(
		`${A}detail-custom-xml-non-empty`,
		"schema:Detail.custom_xml",
	),
	customVariables: refuse(
		`${A}detail-custom-variables-dict-non-empty`,
		"schema:Detail.custom_variables_dict",
	),
	legacyVariables: drop(
		`${A}legacy-detail-custom-variables-key`,
		"schema:Detail.<undeclared>",
	),
	printTemplate: drop(
		`${A}detail-print-template`,
		"schema:Detail.<undeclared>",
	),
	noItemsDefault: drop(
		`${A}detail-no-items-text-equal-to-hq-s-default`,
		"schema:Detail.no_items_text",
	),
	noItemsOther: refuse(
		`${A}detail-no-items-text-other-than-hq-s-default-en-list-is-empty`,
		"schema:Detail.no_items_text",
	),
	selectDefault: drop(
		`${A}detail-select-text-default-en-continue`,
		"schema:Detail.select_text",
	),
	selectOther: refuse(
		`${A}detail-select-text-non-default`,
		"schema:Detail.select_text",
	),
	ownerClauseFilter: derived(
		`${A}detail-filter-value-lifts-into-predicate`,
		"schema:Detail.filter",
	),
	tabs: refuse(`${A}plain-tab-header-starting-index`, "schema:Detail.tabs"),
	tabsDataChild: refuse(
		`${A}data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`,
		"schema:Detail.tabs",
	),
	tabsDataCustom: refuse(
		`${A}data-tab-over-a-custom-nodeset-xpath`,
		"schema:Detail.tabs",
	),
	tabsColumnsAbove: refuse(
		`${A}columns-above-the-first-tab-when-tabs-exist`,
		"schema:Detail.tabs",
	),
	tabRelevant: refuse(
		`${A}tab-relevant-lifts-into-predicate-not`,
		"schema:DetailTab.relevant",
	),
	tabsTileRowMixed: refuse(
		`${A}a-custom-long-tile-row-mixing-fields-of-two-tabs-in-a-basic-or`,
		"schema:DetailTab.starting_index",
	),
	tabsTileRowMixedAdvanced: refuse(
		`${A}a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced`,
		"schema:DetailTab.starting_index",
	),
	lookupNoExtras: refuse(
		`${A}callout-with-no-extras-or-no-responses`,
		"schema:Detail.lookup_extras",
	),
	lookupNoResponses: refuse(
		`${A}callout-with-no-extras-or-no-responses`,
		"schema:Detail.lookup_responses",
	),
	lookupOff: drop(
		`${A}lookup-enabled-false-with-stale-keys`,
		"schema:Detail.lookup_enabled",
	),
	undeclared: refuse(
		`${A}any-other-undeclared-key`,
		"schema:Detail.<undeclared>",
	),
});

const D = DETAIL_CLAIMS;

/** HQ's model default for a detail's two texts (`models/case_list.py::Detail`). */
const NO_ITEMS_DEFAULT = "List is empty.";
const SELECT_DEFAULT = "Continue";

/** The keys a disabled callout leaves behind, each claimed with the off switch. */
const LOOKUP_KEYS = [
	"lookup_autolaunch",
	"lookup_action",
	"lookup_name",
	"lookup_image",
	"lookup_extras",
	"lookup_responses",
	"lookup_display_results",
	"lookup_field_header",
	"lookup_field_template",
];

const LOOKUP_OFF_KEYS = defineClaims(
	"caseList.details.lookupOff",
	Object.fromEntries(
		LOOKUP_KEYS.map((key) => [
			key,
			drop(`${A}lookup-enabled-false-with-stale-keys`, `schema:Detail.${key}`),
		]),
	) as Record<string, Claim<"drop">>,
);

/** The switch and every key of a callout. */
const CALLOUT_KEYS = ["lookup_enabled", ...LOOKUP_KEYS];

/** Each key of a callout on the case list, by the entry that names it. */
const LOOKUP_ENTRY_OF_KEY: Readonly<Record<string, string>> = {
	lookup_enabled: "lookup-enabled-lookup-action",
	lookup_action: "lookup-enabled-lookup-action",
	lookup_name: "lookup-name",
	lookup_image: "lookup-image-jr",
	lookup_autolaunch: "lookup-autolaunch",
	lookup_extras: "lookup-extras-key-value",
	lookup_responses: "lookup-responses-key",
	lookup_display_results:
		"lookup-display-results-lookup-field-header-lookup-field-template",
	lookup_field_header:
		"lookup-display-results-lookup-field-header-lookup-field-template",
	lookup_field_template:
		"lookup-display-results-lookup-field-header-lookup-field-template",
};

const LOOKUP_ON_KEYS = defineClaims(
	"caseList.details.lookupOn",
	Object.fromEntries(
		CALLOUT_KEYS.map((key) => [
			key,
			refuse(`${A}${LOOKUP_ENTRY_OF_KEY[key]}`, `schema:Detail.${key}`),
		]),
	) as Record<string, Claim<"refuse">>,
);

const LOOKUP_LONG_KEYS = defineClaims(
	"caseList.details.lookupLong",
	Object.fromEntries(
		CALLOUT_KEYS.map((key) => [
			key,
			refuse(
				`${A}lookup-on-the-long-detail-tabbed-or-not`,
				`schema:Detail.${key}`,
			),
		]),
	) as Record<string, Claim<"refuse">>,
);

/** HQ builds no callout on an `icon_text_grid` list (`case_tiles.py::build_case_tile_detail`). */
const LOOKUP_GRID_KEYS = defineClaims(
	"caseList.details.lookupGrid",
	Object.fromEntries(
		CALLOUT_KEYS.map((key) => [
			key,
			drop(
				`${A}lookup-enabled-on-an-icon-text-grid-case-list`,
				`schema:Detail.${key}`,
			),
		]),
	) as Record<string, Claim<"drop">>,
);

/** Whether a row of a custom tile holds columns of two tabs: each column stands in the last tab
 *  that starts at or before it (`Detail.get_tab_spans`). */
function tileRowMixesTabs(
	detail: JsonCursor,
	tabs: readonly Readonly<Record<string, unknown>>[],
): boolean {
	const columns = detail.peek("columns");
	if (!Array.isArray(columns)) return false;
	const starts = tabs.map((tab) =>
		typeof tab.starting_index === "number" ? tab.starting_index : 0,
	);
	const tabsOfRow = new Map<number, Set<number>>();
	columns.forEach((column, index) => {
		if (!isJsonObject(column) || typeof column.grid_y !== "number") return;
		let tab = -1;
		starts.forEach((start, at) => {
			if (start <= index) tab = at;
		});
		const set = tabsOfRow.get(column.grid_y) ?? new Set<number>();
		set.add(tab);
		tabsOfRow.set(column.grid_y, set);
	});
	return [...tabsOfRow.values()].some((set) => set.size > 1);
}

/** One Nova column the join made, before its identity is minted. */
export interface JoinedColumn {
	proposal: ColumnProposal;
	visibleInList?: false;
	visibleInDetail?: false;
	notOnList?: true;
	sort?: ColumnSort;
	/** The column's index in the short detail, where it stands there. */
	readonly short?: number;
	/** The column's index in the long detail, where it stands there. */
	readonly long?: number;
	/** A column a sort element added: no column of either detail holds it. */
	readonly carrier?: true;
}

export interface JoinedDetails {
	readonly columns: JoinedColumn[];
	/** Indexes into `columns`, in the list's order and the detail's. */
	readonly listOrder: number[];
	readonly detailOrder: number[];
}

/** Two proposals of one Nova column: kind, field or expression tree, header in every language,
 *  and the kind's own slots. */
function sameProposal(a: ColumnProposal, b: ColumnProposal): boolean {
	const slots = (proposal: ColumnProposal) =>
		Object.fromEntries(
			Object.entries(proposal.column).filter(([key]) => key !== "header"),
		);
	const restA = slots(a);
	const restB = slots(b);
	if (a.column.kind === "calculated" || b.column.kind === "calculated") {
		if (a.column.kind !== b.column.kind) return false;
		const ta = a.expression?.text;
		const tb = b.expression?.text;
		if (ta === undefined || tb === undefined || !sameXPathText(ta, tb))
			return false;
	} else if (!sameJson(restA, restB)) return false;
	const languages = new Set([
		...Object.keys(a.header),
		...Object.keys(b.header),
	]);
	for (const language of languages)
		if ((a.header[language] ?? "") !== (b.header[language] ?? "")) return false;
	return sameJson(a.texts, b.texts);
}

function fieldOf(proposal: ColumnProposal): string | undefined {
	return "field" in proposal.column
		? (proposal.column.field as string)
		: undefined;
}

/** Whether a long column is over the field an `invisible` short column reads: one property, or,
 *  for a calculated field, one expression tree. */
function sameHiddenField(
	hidden: ColumnProposal,
	candidate: ColumnProposal,
): boolean {
	if (
		hidden.column.kind === "calculated" ||
		candidate.column.kind === "calculated"
	) {
		const a = hidden.expression?.text;
		const b = candidate.expression?.text;
		return (
			hidden.column.kind === candidate.column.kind &&
			a !== undefined &&
			b !== undefined &&
			sameXPathText(a, b)
		);
	}
	return (
		fieldOf(candidate) !== undefined && fieldOf(candidate) === fieldOf(hidden)
	);
}

/**
 * The short and the long detail's columns as one set of columns. Each short column joins the
 * first long column not yet joined whose proposal is equal; an `invisible` short column joins the
 * first unjoined long column over its field and takes that column's proposal. A short column
 * with no partner is hidden from the detail; a long column with no partner is not on the list.
 */
export function joinDetailColumns(
	short: readonly (ColumnProposal | undefined)[],
	long: readonly (ColumnProposal | undefined)[],
): JoinedDetails {
	const columns: JoinedColumn[] = [];
	const joinedLong = new Map<number, number>();
	const listOrder: number[] = [];
	short.forEach((proposal, s) => {
		if (proposal === undefined) return;
		let partner = -1;
		for (let l = 0; l < long.length; l++) {
			const candidate = long[l];
			if (candidate === undefined || joinedLong.has(l)) continue;
			const match = proposal.invisible
				? sameHiddenField(proposal, candidate)
				: sameProposal(proposal, candidate);
			if (match) {
				partner = l;
				break;
			}
		}
		const index = columns.length;
		if (partner === -1) {
			columns.push({
				proposal,
				...(proposal.invisible && { visibleInList: false as const }),
				visibleInDetail: false,
				short: s,
			});
		} else {
			joinedLong.set(partner, index);
			const taken = proposal.invisible
				? (long[partner] as ColumnProposal)
				: proposal;
			columns.push({
				proposal: taken,
				...(proposal.invisible && { visibleInList: false as const }),
				short: s,
				long: partner,
			});
		}
		listOrder.push(index);
	});
	const detailOrder: number[] = [];
	long.forEach((proposal, l) => {
		if (proposal === undefined) return;
		const joined = joinedLong.get(l);
		if (joined !== undefined) {
			detailOrder.push(joined);
			return;
		}
		const index = columns.length;
		columns.push({ proposal, visibleInList: false, notOnList: true, long: l });
		detailOrder.push(index);
	});
	for (const [index, column] of columns.entries())
		if (column.notOnList === true) listOrder.push(index);
	for (const [index, column] of columns.entries())
		if (column.long === undefined) detailOrder.push(index);
	return { columns, listOrder, detailOrder };
}

/** A calculated column's `field` in the detail its expression was not registered from: the same
 *  tree, so the expression stage's claim of the registration holds it too. */
export interface ColumnFieldTwin {
	readonly registration: number;
	readonly site: { readonly json: JsonCursor; readonly key: "field" };
	readonly place: HqPlace;
}

/** What the second pass compares for one menu's case list. */
export interface CaseListReading {
	readonly module: DraftModule;
	readonly short: JsonCursor;
	readonly long: JsonCursor;
	readonly sort: SortReading;
	readonly tile: TileReading;
	/** Each minted column's uuid, by its index in the join. */
	readonly uuids: readonly Uuid[];
	readonly joined: JoinedDetails;
	/** The registration of the list filter, where the short detail holds one. */
	readonly filter?: number;
	/** The `field` of each calculated column's other detail, held by its registration's claim. */
	readonly twins: readonly ColumnFieldTwin[];
	/** Whether every column and key was read: false where a finding stands on the list. */
	readonly whole: boolean;
	/** The stored columns of each detail an inert row dropped, by index: no build writes them. */
	readonly dropped: {
		readonly short: ReadonlySet<number>;
		readonly long: ReadonlySet<number>;
	};
}

const READINGS = new WeakMap<ReadContext, Map<Uuid, CaseListReading>>();

/** The case list each menu's first pass read, by the menu's uuid. */
export function caseListReadings(
	ctx: ReadContext,
): ReadonlyMap<Uuid, CaseListReading> {
	return READINGS.get(ctx) ?? new Map();
}

function caseListPlace(
	module: DraftModule,
	kind: "case-list" | "case-detail",
): HqPlace {
	const name = module.place.kind === "menu" ? module.place.name : "";
	return { kind, menu: module.index, name };
}

/** Records a same-state rewrite a comparison allows: the entry, the JSON Pointer, the register row. */
export function sameState(
	ctx: ReadContext,
	entry: string,
	path: string,
	register: SameStateRegister,
): void {
	ctx.facts.sameStateRewrites.push({ entry, path, register });
}

/** Whether a menu needs its case list: a form of it loads a case, its list is its own menu
 *  item, or another menu chooses a parent from it. */
function listNeeded(
	ctx: ReadContext,
	module: DraftModule,
): "needed" | "parent" | "unread" {
	if (module.json.peek("case_list") !== undefined) {
		const caseList = module.json.peek("case_list");
		if (isJsonObject(caseList) && caseList.show === true) return "needed";
	}
	for (const form of module.forms) {
		const requires = form.json.peek("requires");
		if (requires === "case") return "needed";
		const actions = form.json.peek("actions");
		if (
			isJsonObject(actions) &&
			Array.isArray(actions.load_update_cases) &&
			actions.load_update_cases.length > 0
		)
			return "needed";
	}
	const search = module.json.peek("search_config");
	if (
		isJsonObject(search) &&
		Array.isArray(search.properties) &&
		search.properties.length > 0
	)
		return "needed";
	for (const other of ctx.draft.modules) {
		const parent = other.json.peek("parent_select");
		if (
			isJsonObject(parent) &&
			parent.active === true &&
			parent.module_id === module.uniqueId
		)
			return "parent";
	}
	return "unread";
}

/**
 * Whether the `filter` column at `index` of the short detail changes HQ's build of it. It writes
 * no field (`detail_screen.py::Filter`), so it changes the build where it is the column HQ's
 * default sort reads (the first column of a list with no sort element,
 * `details.py::get_default_sort_elements`), where it is the first column whose `field` a sort
 * element names (`util.py::get_sort_and_sort_only_columns` attaches the sort to it), where a
 * `_cc_calculated_<n>` element names a column after it, or where a template tile maps it to a slot
 * (`case_tiles.py::_get_matched_detail_column`).
 */
function filterChangesBuild(short: JsonCursor, index: number): boolean {
	const stored = short.peek("columns");
	const columns = Array.isArray(stored) ? stored : [];
	const column = columns[index];
	if (!isJsonObject(column)) return false;
	const sorts = short.peek("sort_elements");
	const elements = Array.isArray(sorts) ? sorts.filter(isJsonObject) : [];
	if (index === 0 && elements.length === 0) return true;
	const field = column.field;
	if (
		typeof field === "string" &&
		elements.some((element) => element.field === field) &&
		!columns
			.slice(0, index)
			.some((earlier) => isJsonObject(earlier) && earlier.field === field)
	)
		return true;
	if (
		elements.some((element) => {
			const named =
				typeof element.field === "string"
					? CALCULATED_FIELD.exec(element.field)
					: null;
			return named !== null && Number(named[1]) > index;
		})
	)
		return true;
	const template = short.peek("case_tile_template");
	return (
		typeof template === "string" &&
		template !== "" &&
		template !== "custom" &&
		typeof column.case_tile_field === "string" &&
		column.case_tile_field !== ""
	);
}

/** How many columns of each format a detail holds. */
function formatCounts(detail: JsonCursor): Map<string, number> {
	const stored = detail.peek("columns");
	const counts = new Map<string, number>();
	if (!Array.isArray(stored)) return counts;
	for (const column of stored) {
		if (!isJsonObject(column)) continue;
		const format = typeof column.format === "string" ? column.format : "plain";
		counts.set(format, (counts.get(format) ?? 0) + 1);
	}
	return counts;
}

/** Whether the menu offers search (`util.py::module_offers_search`). */
function menuOffersSearch(module: DraftModule): boolean {
	const config = module.json.peek("search_config");
	if (!isJsonObject(config)) return false;
	return (
		(Array.isArray(config.properties) && config.properties.length > 0) ||
		(Array.isArray(config.default_properties) &&
			config.default_properties.length > 0)
	);
}

/**
 * Claims a detail's two texts, the words an empty list shows and the words of its continue
 * button: inert where every language holds HQ's own default, a finding otherwise. Nova writes
 * the default in every language of every menu, a menu with no case type included. Whether the
 * detail is still whole.
 */
function readDetailTexts(
	detail: JsonCursor,
	codes: readonly string[],
): boolean {
	let ok = true;
	const texts = (
		key: string,
		fallback: string,
		inert: Claim<"drop">,
		other: Claim<"refuse">,
	) => {
		// Each language as HQ's build shows it (`app_strings.py`, `clean_trans`): a language the
		// map lacks or holds blank shows another's text. A text the reader cannot know (a number,
		// an object) is left unclaimed, for the close to name at its key.
		const shown = shownTexts(detail.peek(key), codes);
		if (shown === undefined) ok = false;
		else if (Object.values(shown).every((text) => text === fallback))
			detail.drop(key, inert);
		else {
			detail.refuse(key, other);
			ok = false;
		}
	};
	texts("no_items_text", NO_ITEMS_DEFAULT, D.noItemsDefault, D.noItemsOther);
	texts("select_text", SELECT_DEFAULT, D.selectDefault, D.selectOther);
	return ok;
}

/** Claims the keys of a detail that hold no setting Nova reads: the inert ones and each finding. */
function readDetailKeys(
	ctx: ReadContext,
	module: DraftModule,
	detail: JsonCursor,
	screen: "short" | "long",
): boolean {
	let ok = true;
	detail.drop("display", D.display);
	const instance = detail.peek("instance_name");
	if (instance === "casedb" || instance === null || instance === undefined)
		detail.drop("instance_name", D.instanceCasedb);
	else {
		detail.refuse("instance_name", D.instanceOther);
		ok = false;
	}
	const advanced = module.docType === "AdvancedModule";
	const multi = detail.peek("multi_select") === true;
	if (screen === "short" && advanced) {
		detail.drop("multi_select", D.multiSelectAdvanced);
		detail.drop("max_select_value", D.maxSelectAdvanced);
		detail.drop("auto_select", D.autoSelectAdvanced);
	} else if (detail.peek("auto_select") === true) {
		detail.refuse(
			"auto_select",
			multi ? D.autoSelectMulti : D.autoSelectSingle,
		);
		ok = false;
	}
	if (detail.used("persistent_case_tile_from_module")) {
		detail.refuse("persistent_case_tile_from_module", D.persistentFromModule);
		ok = false;
	}
	if (detail.used("pull_down_tile")) {
		detail.refuse("pull_down_tile", D.pullDown);
		ok = false;
	}
	if (
		detail.used("persist_case_context") ||
		detail.used("persistent_case_context_xml")
	) {
		if (detail.peek("persist_tile_on_forms") === true) {
			detail.drop("persist_case_context", D.persistContextBeside);
			detail.drop("persistent_case_context_xml", D.persistContextXmlBeside);
		} else {
			detail.refuse("persist_case_context", D.persistContext);
			detail.refuse("persistent_case_context_xml", D.persistContextXml);
			ok = false;
		}
	}
	if (detail.used("custom_xml")) {
		detail.refuse("custom_xml", D.customXml);
		ok = false;
	}
	const variables = detail.peek("custom_variables_dict");
	if (isJsonObject(variables) && Object.keys(variables).length > 0) {
		detail.refuse("custom_variables_dict", D.customVariables);
		ok = false;
	}
	ok = readDetailTexts(detail, appCodes(ctx)) && ok;
	const stored = detail.peek("tabs");
	const tabs = Array.isArray(stored) ? stored.filter(isJsonObject) : [];
	if (tabs.length > 0) {
		// Every kind the tabs hold is a finding; the first kind of the tabs themselves claims the key.
		const start = tabs[0]?.starting_index;
		const data = tabs.filter((tab) => tab.has_nodeset === true);
		const overChildren = (tab: Readonly<Record<string, unknown>>) =>
			typeof tab.nodeset_case_type === "string" && tab.nodeset_case_type !== "";
		const child = data.some(overChildren);
		const custom = data.some((tab) => !overChildren(tab));
		const kinds = [
			...(typeof start === "number" && start > 0 ? [D.tabsColumnsAbove] : []),
			...(data.length < tabs.length ? [D.tabs] : []),
			...(child ? [D.tabsDataChild] : []),
			...(custom ? [D.tabsDataCustom] : []),
		];
		const [primary, ...rest] = kinds;
		if (primary !== undefined) detail.refuse("tabs", primary);
		for (const kind of rest) ctx.accounting.finding(kind, detail.place);
		if (
			screen === "long" &&
			detail.peek("case_tile_template") === "custom" &&
			tileRowMixesTabs(detail, tabs)
		)
			ctx.accounting.finding(
				module.docType === "AdvancedModule"
					? D.tabsTileRowMixedAdvanced
					: D.tabsTileRowMixed,
				detail.place,
			);
		if (
			tabs.some(
				(tab) => typeof tab.relevant === "string" && tab.relevant.trim() !== "",
			)
		)
			ctx.accounting.finding(D.tabRelevant, detail.place);
		ok = false;
	}
	if (detail.peek("lookup_enabled") === true) {
		if (
			screen === "short" &&
			detail.peek("case_tile_template") === "icon_text_grid"
		) {
			for (const key of CALLOUT_KEYS) {
				const claim = LOOKUP_GRID_KEYS[key];
				if (claim !== undefined) detail.drop(key, claim);
			}
		} else if (screen === "long") {
			for (const key of CALLOUT_KEYS) {
				const claim = LOOKUP_LONG_KEYS[key];
				if (claim !== undefined) detail.refuse(key, claim);
			}
			ok = false;
		} else {
			// The refused row is tested before the rows of its keys: a callout with no extras or no
			// responses claims those two, and every other key takes its own row.
			const extras = detail.peek("lookup_extras");
			const responses = detail.peek("lookup_responses");
			const unready =
				!Array.isArray(extras) ||
				extras.length === 0 ||
				!Array.isArray(responses) ||
				responses.length === 0;
			if (unready) {
				detail.refuse("lookup_extras", D.lookupNoExtras);
				detail.refuse("lookup_responses", D.lookupNoResponses);
				ctx.accounting.finding(D.lookupNoExtras, detail.place);
			}
			for (const key of CALLOUT_KEYS) {
				if (unready && (key === "lookup_extras" || key === "lookup_responses"))
					continue;
				const claim = LOOKUP_ON_KEYS[key];
				if (claim !== undefined) detail.refuse(key, claim);
			}
			ok = false;
		}
	} else {
		detail.drop("lookup_enabled", D.lookupOff);
		for (const key of LOOKUP_KEYS) {
			const claim = LOOKUP_OFF_KEYS[key];
			if (claim !== undefined) detail.drop(key, claim);
		}
	}
	for (const key of detail.undeclared()) {
		if (key === "custom_variables") detail.drop(key, D.legacyVariables);
		else if (key === "print_template") detail.drop(key, D.printTemplate);
		else {
			// A stored key is no word a person knows from HQ's pages, so the finding names nothing.
			detail.refuse(key, D.undeclared);
			ok = false;
		}
	}
	return ok;
}

/** The menu's selection: one case, or several up to a maximum. */
function readSelection(
	ctx: ReadContext,
	module: DraftModule,
	short: JsonCursor,
): { ok: boolean; selection?: CaseListConfig["selection"] } {
	if (module.docType === "AdvancedModule") return { ok: true };
	const multi = short.peek("multi_select") === true;
	const max = short.peek("max_select_value");
	if (!multi) {
		short.drop("max_select_value", D.maxSelectSingle);
		return { ok: true };
	}
	short.take("multi_select", D.multiSelect, Boolean).value;
	if (typeof max !== "number" || max === 0 || max < -1) {
		short.refuse("max_select_value", D.maxSelectZero);
		return { ok: false };
	}
	if (max > 100) {
		short.refuse("max_select_value", D.maxSelectAbove);
		return { ok: false };
	}
	const maximum = short.take("max_select_value", D.maxSelect, Number).value;
	if (maximum === -1)
		sameState(
			ctx,
			D.maxSelect.entry,
			`${short.pointer}/max_select_value`,
			"list-settings-respelled",
		);
	return {
		ok: true,
		selection: { kind: "multiple", maximum: maximum === -1 ? 100 : maximum },
	};
}

/**
 * The choices the catalog drops from each property a raw plain column shows, where no column of
 * the app shows that property by its choices' labels: Nova writes a plain column over a property
 * with no choices as its values, so the property the select questions writing it would give
 * choices keeps none, and the column reads as written. Its select type stays.
 */
function withholdRawShownChoices(
	ctx: ReadContext,
	caseType: string,
	joined: JoinedDetails,
	labelShown: (property: string) => boolean,
): void {
	const raw = new Set(
		joined.columns.flatMap((column) => {
			const body = column.proposal.column;
			return body.kind === "plain" &&
				column.proposal.choices === undefined &&
				column.proposal.json.peek("useXpathExpression") !== true &&
				!labelShown(body.field)
				? [body.field]
				: [];
		}),
	);
	const catalog = ctx.draft.caseTypes;
	if (raw.size === 0 || catalog == null) return;
	const withChoices = catalog
		.find((one) => one.name === caseType)
		?.properties.some(
			(one) => raw.has(one.name) && (one.options ?? []).length > 0,
		);
	if (withChoices !== true) return;
	const next = produce(catalog, (draft) => {
		for (const property of draft.find((one) => one.name === caseType)
			?.properties ?? [])
			if (raw.has(property.name)) delete property.options;
	});
	ctx.writeDraft(() => {
		ctx.draft.caseTypes = next;
	});
}

/** A catalog entry for a standard property, named by its name and kept in name order, as
 *  `caseManagement/catalog.ts::noteProperty` keeps every other. */
function declaredStandard(
	properties: Draft<CaseProperty>[],
	name: string,
): Draft<CaseProperty> | undefined {
	if (!isStandardCaseListProperty(name)) return undefined;
	const declared = { name, label: proseText(name) };
	const at = properties.findIndex((one) => one.name > name);
	if (at === -1) properties.push(declared);
	else properties.splice(at, 0, declared);
	return properties.find((one) => one.name === name);
}

/** The properties each reading's label-showing columns have stated choices for, by case type and
 *  property. */
const SHOWN_STATED = new WeakMap<ReadContext, Set<string>>();

/**
 * The kind and choices of each property a plain column shows by its choices' labels, from the
 * column's label projection, which is the export's only evidence of them: Nova prints the
 * catalog's choices there, in its order, whatever choices the select questions writing the
 * property hold. Each choice's label is its text in the source language, and its other languages
 * go to the translation sink under the role `case-property-option-label`. The first column over a
 * property states them; a property of another type keeps its own, and the comparison of each
 * whole menu holds every other column against what was stated.
 */
function declareShownChoices(
	ctx: ReadContext,
	caseType: string,
	joined: JoinedDetails,
): void {
	const shown = joined.columns.flatMap((column) => {
		const body = column.proposal.column;
		const choices = column.proposal.choices;
		return body.kind === "plain" && choices !== undefined
			? [{ property: body.field, choices }]
			: [];
	});
	const catalog = ctx.draft.caseTypes;
	if (shown.length === 0 || catalog == null) return;
	const stated = SHOWN_STATED.get(ctx) ?? new Set<string>();
	SHOWN_STATED.set(ctx, stated);
	const declared: typeof shown = [];
	const next = produce(catalog, (draft) => {
		const type = draft.find((one) => one.name === caseType);
		for (const { property, choices } of shown) {
			const key = `${caseType}\u0000${property}`;
			// A standard property the catalog does not list (`noteProperty` lists none) is
			// declared here: its choices are the label projection's, which Nova prints only
			// from a catalog entry (`hqJson/caseList.ts::projectColumnToDetail`).
			const entry =
				type?.properties.find((one) => one.name === property) ??
				(type === undefined || stated.has(key)
					? undefined
					: declaredStandard(type.properties, property));
			if (
				stated.has(key) ||
				entry === undefined ||
				(entry.data_type !== undefined && entry.data_type !== choices.dataType)
			)
				continue;
			stated.add(key);
			entry.data_type = choices.dataType;
			entry.options = choices.options.map((option) => ({
				value: option.value,
				label: proseText(sourceText(ctx, option.labels)),
			}));
			declared.push({ property, choices });
		}
	});
	if (declared.length === 0) return;
	ctx.writeDraft(() => {
		ctx.draft.caseTypes = next;
	});
	for (const { property, choices } of declared)
		for (const option of choices.options)
			ctx.translations.set(
				casePropertyOptionTranslationUnitId(caseType, property, option.value),
				"prose",
				translatedTexts(
					ctx,
					Object.fromEntries(
						Object.entries(option.labels).map(([code, text]) => [
							code,
							proseText(text),
						]),
					),
				),
			);
}

/** What a menu's columns read of the properties of its case type: whose choices the catalog keeps,
 *  and which a column of the app shows by its choices' labels. */
export interface ShownChoices {
	readonly selectProperty: SelectProperty;
	readonly labelShown: (property: string) => boolean;
}

/**
 * Reads one menu's two details into its case list: every key claimed, the columns joined, the
 * order and the tile read, each column minted, every expression registered and every text handed
 * to the translation sink. The config is written into the menu's draft.
 */
export function readCaseDetails(
	ctx: ReadContext,
	module: DraftModule,
	choices: ShownChoices,
): void {
	const { selectProperty } = choices;
	const pair = module.json.object(
		"case_details",
		"DetailPair",
		module.docType === "AdvancedModule" ? D.pairAdvanced : D.pairModule,
	);
	const listPlace = caseListPlace(module, "case-list");
	const detailPlace = caseListPlace(module, "case-detail");
	const short = pair.object("short", "Detail", D.short, listPlace);
	const long = pair.object("long", "Detail", D.long, detailPlace);
	if (module.module.caseType === undefined) {
		// A menu with no case type shows neither screen: each detail's columns, its screen word
		// and its two texts, which read by the rule of a menu with a case type.
		for (const detail of [short, long]) {
			detail.drop("columns", D.surveyColumns);
			detail.drop("display", D.display);
			readDetailTexts(detail, appCodes(ctx));
		}
		return;
	}
	// Both details are read whatever the first holds, so every finding is raised in one pass.
	const shortKeys = readDetailKeys(ctx, module, short, "short");
	const longKeys = readDetailKeys(ctx, module, long, "long");
	let whole = shortKeys && longKeys;
	const selection = readSelection(ctx, module, short);
	whole &&= selection.ok;
	const tileTemplate = short.peek("case_tile_template");
	const inTile = tileTemplate === "custom";

	const storedShort = short.peek("columns");
	if (!Array.isArray(storedShort) || storedShort.length === 0) {
		const need = listNeeded(ctx, module);
		if (need === "needed")
			ctx.accounting.finding(D.shortEmptyNeeded, listPlace);
		else if (need === "parent")
			ctx.accounting.finding(D.shortEmptyParent, listPlace);
		whole &&= need === "unread";
	}
	const shortCursors = short.list("columns", "DetailColumn", D.shortColumns);
	const longCursors = long.list("columns", "DetailColumn", D.longColumns);
	const shared = {
		selectProperty,
		advanced: module.docType === "AdvancedModule",
		offersSearch: menuOffersSearch(module),
	};
	const shortOptions: Omit<ColumnOptions, "filterChangesBuild"> = {
		...shared,
		inTile,
		formats: formatCounts(short),
	};
	const longOptions: ColumnOptions = {
		...shared,
		inTile: false,
		formats: formatCounts(long),
		filterChangesBuild: false,
	};
	const shortReadings = shortCursors.map((column, index) =>
		readDetailColumn(ctx, module, column, "short", {
			...shortOptions,
			filterChangesBuild: filterChangesBuild(short, index),
		}),
	);
	const longReadings = longCursors.map((column) =>
		readDetailColumn(ctx, module, column, "long", longOptions),
	);
	whole &&=
		shortReadings.every((one) => one !== undefined) &&
		longReadings.every((one) => one !== undefined);
	const droppedOf = (readings: readonly ColumnReading[]) =>
		new Set(
			readings.flatMap((one, index) => (one === "dropped" ? [index] : [])),
		);
	const dropped = {
		short: droppedOf(shortReadings),
		long: droppedOf(longReadings),
	};
	const proposalsOf = (readings: readonly ColumnReading[]) =>
		readings.map((one) => (one === "dropped" ? undefined : one));
	const shortProposals = proposalsOf(shortReadings);
	const longProposals = proposalsOf(longReadings);

	const joined = joinDetailColumns(shortProposals, longProposals);
	const sort = readSortElements(ctx, module, short, joined, shortCursors);
	whole &&= sort.ok;
	const tile = readTile(
		ctx,
		module,
		short,
		long,
		joined,
		shortCursors,
		longCursors,
		dropped.short,
	);
	whole &&= tile.ok;

	// Each property a column or a sort element reads is a property of the catalog.
	const caseType = module.module.caseType;
	const properties = joined.columns.flatMap((column) =>
		column.proposal.column.kind !== "calculated" &&
		"field" in column.proposal.column &&
		typeof column.proposal.column.field === "string"
			? [column.proposal.column.field]
			: [],
	);
	if (
		caseType !== undefined &&
		properties.length > 0 &&
		ctx.draft.caseTypes != null
	)
		ctx.writeDraft(() => {
			ctx.draft.caseTypes = produce(ctx.draft.caseTypes ?? [], (draft) => {
				for (const property of properties)
					noteProperty(draft, caseType, property);
			});
		});
	if (caseType !== undefined) {
		withholdRawShownChoices(ctx, caseType, joined, choices.labelShown);
		declareShownChoices(ctx, caseType, joined);
	}

	// Each column's identity: by (kind, field, n), n its ordinal among equal pairs in list order.
	const seen = new Map<string, number>();
	const uuids: Uuid[] = new Array(joined.columns.length);
	for (const index of joined.listOrder) {
		const column = joined.columns[index] as JoinedColumn;
		const field = fieldOf(column.proposal) ?? "";
		const pairKey = JSON.stringify([column.proposal.column.kind, field]);
		const n = seen.get(pairKey) ?? 0;
		seen.set(pairKey, n + 1);
		const minted = ctx.accounting.identity(
			ctx.resolver.claim(
				externalKey.caseListColumn(
					module.uniqueId,
					column.proposal.column.kind,
					field,
					n,
				),
				`${module.uniqueId}/case-list/${index}`,
			),
			listPlace,
			"schema:DetailColumn",
		);
		if (minted === undefined) whole = false;
		uuids[index] = minted ?? (`${module.uuid}-column-${index}` as Uuid);
	}

	const config: CaseListConfig = {
		columns: [],
		listColumnOrder: joined.listOrder.map((index) => uuids[index] as Uuid),
		detailColumnOrder: joined.detailOrder.map((index) => uuids[index] as Uuid),
		searchInputs: [],
		...(selection.selection !== undefined && {
			selection: selection.selection,
		}),
		...(tile.config !== undefined && { tile: tile.config }),
	};
	const named = applicationReading(ctx)?.languages.tagOf !== undefined;
	const twins: ColumnFieldTwin[] = [];
	joined.columns.forEach((column, index) => {
		const uuid = uuids[index] as Uuid;
		const built = {
			...column.proposal.column,
			uuid,
			...(column.sort !== undefined && { sort: column.sort }),
			...(column.visibleInList === false && { visibleInList: false }),
			...(column.visibleInDetail === false && { visibleInDetail: false }),
			...(column.notOnList === true && { notOnList: true }),
			...(tile.cells.get(index) !== undefined && {
				tile: tile.cells.get(index),
			}),
		} as Column;
		const expression = column.proposal.expression;
		if (built.kind === "calculated" && expression !== undefined) {
			const registration = ctx.pending.register(
				{
					ref: {
						entity: "module",
						uuid: module.uuid,
						slot: "case_list_column_expression",
						member: { columnUuid: uuid },
					},
					text: expression.text,
					mode: expression.mode,
					place: expression.place,
					key: expression.key,
				},
				expression.at,
			);
			// The column's other detail holds the same expression tree (the join's equality), so
			// its `field` is held as the registered one is.
			const twin =
				column.proposal.json === shortProposals[column.short ?? -1]?.json
					? longProposals[column.long ?? -1]
					: shortProposals[column.short ?? -1];
			if (twin !== undefined && twin.json !== column.proposal.json)
				twins.push({
					registration,
					site: { json: twin.json, key: "field" },
					place: twin.json.place,
				});
			(built as { expression: unknown }).expression =
				pendingPlaceholder("value");
		}
		config.columns.push(built);
		if (!named || !caseListColumnTextShows(built)) return;
		const byLanguage = (map: Readonly<Record<string, string>>) =>
			translatedTexts(ctx, map);
		ctx.translations.set(
			makeTranslationUnitId("column", uuid, "header"),
			"text",
			byLanguage(column.proposal.header),
		);
		for (const [value, map] of Object.entries(column.proposal.texts))
			ctx.translations.set(
				value === ""
					? makeTranslationUnitId("column", uuid, "text")
					: makeTranslationUnitId("column", uuid, "mapping", value),
				"text",
				byLanguage(map),
			);
	});

	let filter: number | undefined;
	const storedFilter = short.peek("filter");
	if (typeof storedFilter === "string" && storedFilter.trim() !== "") {
		const text = listFilterWithoutOwnerClause(module, storedFilter);
		// A filter that is the owner clause alone is the search's owner exclusion, which the settle
		// holds by the projection's filter.
		if (text === "") short.derived("filter", D.ownerClauseFilter);
		else {
			filter = ctx.pending.register(
				{
					ref: {
						entity: "module",
						uuid: module.uuid,
						slot: "case_list_filter",
					},
					text,
					mode: { target: "hq-json", interpolation: "case" },
					place: listPlace,
					key: "schema:Detail.filter",
				},
				{ json: short, key: "filter" },
			);
			config.filter = pendingPlaceholder("condition");
		}
	}

	ctx.writeDraft(() => {
		(module.module as { caseListConfig?: CaseListConfig }).caseListConfig =
			config;
	});
	const readings = READINGS.get(ctx) ?? new Map<Uuid, CaseListReading>();
	READINGS.set(ctx, readings);
	readings.set(module.uuid, {
		module,
		short,
		long,
		sort,
		tile,
		uuids,
		joined,
		...(filter !== undefined && { filter }),
		twins,
		whole,
		dropped,
	});
}

/**
 * The reader's canonical choice `columns-off-a-screen-last-in-its-order`: a column the detail does
 * not show (`visibleInDetail: false`) has no place in the long detail, and a column that is not on
 * the list (`notOnList`) none in the short one, so a document that holds either anywhere in that
 * screen's order prints what one that holds it last prints. The reader returns the screen's own
 * columns in their order, then the others: those off the detail in the list's order, those off the
 * list in the detail's (`joinDetailColumns`, rules 3 to 5).
 */
export function columnsOffAScreenLast(doc: BlueprintDoc): BlueprintDoc {
	const next = new Map<Uuid, { list: Uuid[]; detail: Uuid[] }>();
	for (const moduleUuid of doc.moduleOrder) {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) continue;
		const columns = new Map(config.columns.map((one) => [one.uuid, one]));
		const last = (
			order: readonly Uuid[],
			other: readonly Uuid[],
			off: (column: Column) => boolean,
		): Uuid[] => {
			const isOff = (uuid: Uuid) => {
				const column = columns.get(uuid);
				return column !== undefined && off(column);
			};
			return [
				...order.filter((uuid) => !isOff(uuid)),
				...other.filter((uuid) => isOff(uuid) && order.includes(uuid)),
			];
		};
		const detail = last(
			config.detailColumnOrder,
			config.listColumnOrder,
			(column) => column.visibleInDetail === false,
		);
		const list = last(
			config.listColumnOrder,
			config.detailColumnOrder,
			(column) => column.notOnList === true,
		);
		if (
			detail.join() !== config.detailColumnOrder.join() ||
			list.join() !== config.listColumnOrder.join()
		)
			next.set(moduleUuid, { list, detail });
	}
	if (next.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const [moduleUuid, { list, detail }] of next) {
			const config = draft.modules[moduleUuid]?.caseListConfig;
			if (config === undefined) continue;
			config.listColumnOrder = list;
			config.detailColumnOrder = detail;
		}
	});
}

/**
 * The reader's canonical choice `columns-of-a-menu-that-lists-no-cases-are-off-the-detail`: a menu
 * whose forms are all surveys, with no case list entry, lists no cases, and Nova writes it the
 * pair every new menu holds in CommCare HQ, whatever its list and its search hold
 * (`expander.ts`, `hasCases`): one `name` column headed with the same word in every language,
 * on the list and off the detail, and the search's shell defaults. So no export carries the
 * menu's columns, their headers' translations, their order rules, its tile, its filter, its
 * selection, its Search fields or its search settings, and the reader returns the list that pair
 * reads as: that one plain `case_name` column off the detail and nothing else. The column keeps
 * the identity of the menu's own first plain `case_name` column where it has one, the identity a
 * re-read gives it, and otherwise the UUID a re-read gives a key the document lacks
 * (`identityMap.ts::reReadUuidOf`), which is not the key's own mint where the document holds
 * that under another column (one whose property was changed in Nova). It runs
 * before `columns-off-a-screen-last-in-its-order`.
 */
export function columnsOfAMenuThatListsNoCasesOffTheDetail(
	doc: BlueprintDoc,
): BlueprintDoc {
	const lists = new Map<Uuid, CaseListConfig>();
	const reRead = reReadUuidOf(doc, DERIVED_WIRE_IDENTITY);
	for (const uuid of doc.moduleOrder) {
		const module = doc.modules[uuid];
		if (
			module?.caseType === undefined ||
			moduleCaseTypeForActions(doc, uuid) !== ""
		)
			continue;
		const config = module.caseListConfig;
		const own =
			config === undefined
				? undefined
				: orderedColumns(config, "list").find(
						(column) => column.kind === "plain" && column.field === "case_name",
					);
		const column = {
			...plainColumn(
				own?.uuid ??
					reRead(
						externalKey.caseListColumn(
							DERIVED_WIRE_IDENTITY.moduleUniqueId(uuid),
							"plain",
							"case_name",
							0,
						),
					),
				"case_name",
				SHELL_COLUMN_HEADER,
			),
			visibleInDetail: false,
		};
		const list: CaseListConfig = {
			columns: [column],
			listColumnOrder: [column.uuid],
			detailColumnOrder: [column.uuid],
			searchInputs: [],
		};
		if (!sameJson(config, list) || module.caseSearchConfig !== undefined)
			lists.set(uuid, list);
	}
	if (lists.size === 0) return doc;
	const before = translationUnitsById(doc);
	const shellHeaders = new Set(
		[...lists.values()].map((list) =>
			makeTranslationUnitId("column", list.listColumnOrder[0] ?? "", "header"),
		),
	);
	return withCandidate(doc, (draft) => {
		for (const [uuid, list] of lists) {
			const module = draft.modules[uuid];
			if (module === undefined) continue;
			module.caseListConfig = structuredClone(list);
			delete module.caseSearchConfig;
		}
		// The units the pair carries no text for: those of what the menus no longer hold, and the
		// shell column's header, the same word in every language.
		const after = translationUnitsById(draft as BlueprintDoc);
		for (const targets of Object.values(draft.localization?.translations ?? {}))
			for (const unit of Object.keys(targets ?? {}) as TranslationUnitId[])
				if (shellHeaders.has(unit) || (before.has(unit) && !after.has(unit)))
					delete targets?.[unit];
	});
}

/** The header of the one column a menu that lists no cases is written, which is the same word in
 *  every language. */
const SHELL_COLUMN_HEADER = (() => {
	const header = emptyShortListColumns(["en"])[0]?.header.en;
	if (header === undefined)
		throw new Error(
			"Nova's empty list holds no column with a header, but every new menu in CommCare HQ holds one; look at hqJson/caseList.ts::emptyShortListColumns.",
		);
	return header;
})();
