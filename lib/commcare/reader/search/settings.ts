/**
 * A search's own settings (`search_config`: its title, subtitle, button,
 * owner exclusion, supporting cases and the keys Nova holds nothing for),
 * and the acceptance of the whole menu's search: one call of
 * `hqJson/caseList.ts::projectCaseListForHq` per menu, whose
 * `search_config` must equal the stored one key by key after the inert
 * claims and the same-state rows.
 */
import type { BlueprintDoc, Expression, Module, Uuid } from "@/lib/domain";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { caseTypeNameSchema } from "@/lib/domain/expression/types";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	type CaseListConfig,
	DEFAULT_CASE_SEARCH_TITLE,
	emptyCaseListConfig,
	NO_SEARCH_SCREEN_TITLE,
	type OrdinaryCaseSearchConfig,
	type SearchInputDef,
	searchResultsNameSchema,
} from "@/lib/domain/modules";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import {
	SEARCH_RUNTIME_VALIDATION_MESSAGES,
	type SearchRuntimeValidationMessage,
} from "@/lib/domain/searchRuntimeValidationMessages";
import { isDeviceOnlyCaseProperty } from "@/lib/domain/standardCaseProperties";
import type { TranslationUnitRole } from "@/lib/domain/translationUnits";
import type { Finding, HqPlace } from "@/lib/publish/hqFindings";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { moduleExpressionContexts } from "../../expressionContext";
import {
	projectCaseListForHq,
	type SearchConfigRewrites,
} from "../../hqJson/caseList";
import { HqXPath, hqXPathText } from "../../hqJson/xpath";
import { emitExcludedOwnerFilterExpression } from "../../suite/case-list/nodesetFilter";
import { searchGuardedFieldNames } from "../../suite/case-search/moduleXPathQuery";
import { includeSearchHierarchy } from "../../suite/case-search/relatedCaseProjection";
import {
	dedicatedOrderRefusal,
	readDedicatedOrder,
} from "../../suite/case-search/requestOrder";
import { normalizeSpace } from "../../suite/wire";
import { rethrowWorkStop } from "../../workMeter";
import { type FormSyntax, formSyntaxKey } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import { withCandidate } from "../candidate";
import {
	appCodes,
	type HeldTexts,
	heldTextsIn,
	languageMap,
	sameHeldTexts,
	sourceCode,
	sourceText,
	translatedTexts,
	unheldTextsIn,
} from "../caseList/columns";
import { caseListReadings, sameState } from "../caseList/details";
import { withReadTexts } from "../caseList/readTexts";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { clauses, core } from "../expressions/folds";
import { levelControl, type PrintLevel } from "../expressions/printLevel";
import {
	heldText,
	holdText,
	hqDeviceText,
	keyDefinedAfterLineEnd,
	LINE_END_DEFINES_KEY,
	recordTextRewrite,
	showsInEveryLanguage,
	storedKeyDefinedAfterLineEnd,
	unheldRefusal,
	unheldText,
} from "../heldText";
import {
	isJsonObject,
	type JsonCursor,
	objectMembers,
	registerUndeclaredKeys,
	sameJson,
} from "../jsonCursor";
import {
	type PendingExpression,
	pendingPlaceholder,
} from "../pendingExpressions";
import { whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { sameSyntax, sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { itemsetSource } from "./itemsetSource";
import type { PromptReading } from "./prompts";
import { requiredCaseChildAsBlank } from "./requiredCaseChild";
import { searchPlace } from "./workflow";

const S = "case-search/";

/** The entry a blank `""` is dropped under in a key CommCare HQ reads only where it holds text. */
export const BLANK_IS_ABSENT = `${S}a-blank-text-in-a-search-key-hq-reads-only-where-it-holds-text`;

/** The entry the registry's workflow and its extra cases are dropped under where no registry is
 *  named. */
const NO_REGISTRY = `${S}the-registry-workflow-and-cases-where-no-registry-is-named`;

export const SETTING_CLAIMS = defineClaims("search.settings", {
	/** A Search button condition reading an instance its case list does not load
	 *  (`index.ts::settleSearchButtonConditions`). */
	buttonNotOnTheList: refuse(
		`${S}search-button-display-condition-reading-what-the-case-list-does-not-load`,
		"schema:CaseSearch.search_button_display_condition",
	),
	/** A check whose native test cannot keep the guard and its runtime message together. */
	nameCheckAllowsBothQuotes: refuse(
		`${S}name-check-allows-both-quote-delimiters`,
		"schema:Assertion.test",
	),
	checkWithoutMessageGuarded: refuse(
		`${S}a-check-with-no-message-on-a-field-nova-s-search-guards`,
		"schema:Assertion.text",
	),
	title: take(
		`${S}title-label-lang-non-empty`,
		"schema:CaseSearch.title_label",
	),
	titleBlank: take(
		`${S}title-label-or-blank-hq-s-default`,
		"schema:CaseSearch.title_label",
	),
	titleSome: take(
		`${S}title-label-blank-in-some-languages`,
		"schema:CaseSearch.title_label",
	),
	description: take(
		`${S}description-lang-markdown`,
		"schema:CaseSearch.description",
	),
	buttonDefault: take(
		`${S}search-button-label-hq-default-en-search-all-cases`,
		"schema:CaseSearch.search_button_label",
	),
	buttonOther: refuse(
		`${S}search-button-label-any-other-value`,
		"schema:CaseSearch.search_button_label",
	),
	dormantOwners: drop(
		`${S}owner-exclusion-in-a-dormant-search-setting`,
		"schema:CaseSearch.blacklisted_owner_ids_expression",
	),
	includeDerived: derived(
		`${S}include-all-related-cases-implied-by-nova-relation-reads`,
		"schema:CaseSearch.include_all_related_cases",
	),
	includeFalse: take(
		`${S}include-all-related-cases-false-where-nova-s-relation-reads`,
		"schema:CaseSearch.include_all_related_cases",
	),
	includeAuthored: take(
		`${S}include-all-related-cases-authored-without-relation-reads`,
		"schema:CaseSearch.include_all_related_cases",
	),
	instanceUnreserved: take(
		`${S}instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`,
		"schema:CaseSearch.instance_name",
	),
	instanceUneditable: refuse(
		`${S}results-name-outside-the-search-editor`,
		"schema:CaseSearch.instance_name",
	),
	instanceReserved: refuse(
		`${S}instance-name-containing-casedb-ledgerdb-fixture-or-session`,
		"schema:CaseSearch.instance_name",
	),
	instanceClash: refuse(
		`${S}a-module-whose-effective-results-instance-results-instance-name`,
		"schema:CaseSearch.instance_name",
	),
	instanceClashOutsideInline: take(
		`${S}an-effective-results-instance-equal-to-a-module-s-that-does-not`,
		"schema:CaseSearch.instance_name",
	),
	additionalTypeWithoutMenu: refuse(
		`${S}additional-record-type-without-menu`,
		"schema:CaseSearch.additional_case_types",
	),
	additionalTypes: take(
		`${S}additional-case-types`,
		"schema:CaseSearch.additional_case_types",
	),
	additionalOwnType: drop(
		`${S}additional-case-types-naming-only-the-menu-s-own-type`,
		"schema:CaseSearch.additional_case_types",
	),
	relatedPropertyDeviceOnly: refuse(
		`${S}a-related-record-property-only-devices-hold`,
		"schema:CaseSearch.custom_related_case_property",
	),
	relatedProperty: take(
		`${S}custom-related-case-property`,
		"schema:CaseSearch.custom_related_case_property",
	),
	sortTerm: take(
		`${S}custom-sort-properties-property-name-sort-type-exact-date`,
		"schema:CaseSearchCustomSortProperty",
	),
	sortProperty: take(
		`${S}custom-sort-properties-property-name-sort-type-exact-date`,
		"schema:CaseSearchCustomSortProperty.property_name",
	),
	sortComparison: take(
		`${S}custom-sort-properties-property-name-sort-type-exact-date`,
		"schema:CaseSearchCustomSortProperty.sort_type",
	),
	sortDirection: take(
		`${S}custom-sort-properties-property-name-sort-type-exact-date`,
		"schema:CaseSearchCustomSortProperty.direction",
	),
	customSort: take(
		`${S}custom-sort-properties-property-name-sort-type-exact-date`,
		"schema:CaseSearch.custom_sort_properties",
	),
	customSortReserved: refuse(
		`${S}a-server-order-naming-a-property-nova-reserves`,
		"schema:CaseSearch.custom_sort_properties",
	),
	customSortDeviceOnly: refuse(
		`${S}a-server-order-naming-a-property-only-devices-hold`,
		"schema:CaseSearch.custom_sort_properties",
	),
	searchOnClear: take(
		`${S}search-on-clear`,
		"schema:CaseSearch.search_on_clear",
	),
	searchOnClearAuto: refuse(
		`${S}search-on-clear-with-the-case-list-s-auto-select-checked-whether`,
		"schema:CaseSearch.search_on_clear",
	),
	endpoint: take(
		`${S}case-search-endpoint-id`,
		"schema:CaseSearch.case_search_endpoint_id",
	),
	registry: refuse(
		`${S}data-registry-data-registry-workflow-additional-registry-cases`,
		"schema:CaseSearch.data_registry",
	),
	registryWorkflow: refuse(
		`${S}data-registry-data-registry-workflow-additional-registry-cases`,
		"schema:CaseSearch.data_registry_workflow",
	),
	registryCases: refuse(
		`${S}data-registry-data-registry-workflow-additional-registry-cases`,
		"schema:CaseSearch.additional_registry_cases",
	),
	blankButtonCondition: drop(
		BLANK_IS_ABSENT,
		"schema:CaseSearch.search_button_display_condition",
	),
	blankOwners: drop(
		BLANK_IS_ABSENT,
		"schema:CaseSearch.blacklisted_owner_ids_expression",
	),
	blankRegistry: drop(BLANK_IS_ABSENT, "schema:CaseSearch.data_registry"),
	noRegistryWorkflow: drop(
		NO_REGISTRY,
		"schema:CaseSearch.data_registry_workflow",
	),
	noRegistryCases: drop(
		NO_REGISTRY,
		"schema:CaseSearch.additional_registry_cases",
	),
	blankRelated: drop(
		BLANK_IS_ABSENT,
		"schema:CaseSearch.custom_related_case_property",
	),
	blankInstance: drop(BLANK_IS_ABSENT, "schema:CaseSearch.instance_name"),
	removed: drop(
		`${S}removed-keys-dynamic-search-additional-relevant-search-filter`,
		"schema:CaseSearch.<undeclared>",
	),
	unknown: drop(
		`${S}any-other-unknown-casesearch-key`,
		"schema:CaseSearch.<undeclared>",
	),
});

const T = SETTING_CLAIMS;

/**
 * The text keys of `search_config` that CommCare HQ reads only where they hold text, each with
 * the claim its blank is dropped under. HQ's Case List page writes `""` into each of them on
 * every save (`views/modules.py::_gather_and_update_search_properties`, which builds
 * `CaseSearch` with `search_button_display_condition`, `blacklisted_owner_ids_expression`,
 * `data_registry`, `custom_related_case_property` and `instance_name` defaulting to `""`), and
 * every reader tests them by truth: `details.py` (the button condition), `remote_requests.py`
 * (the owner list, the related-case property), `util.py::module_offers_registry_search` (the
 * registry) and `CaseSearch.get_instance_name`. A blank is the key absent. The registry's
 * workflow is read only behind a named registry, whatever it holds (`readRegistry`).
 */
const BLANK_KEYS = [
	["search_button_display_condition", T.blankButtonCondition],
	["blacklisted_owner_ids_expression", T.blankOwners],
	["data_registry", T.blankRegistry],
	["custom_related_case_property", T.blankRelated],
	["instance_name", T.blankInstance],
] as const;

/** Whether `key` holds a value other than HQ's default and other than a blank `""`, the one use
 *  of a key HQ reads only where it holds text. */
export function holdsText(cursor: JsonCursor, key: string): boolean {
	return cursor.used(key) && cursor.peek(key) !== "";
}

/**
 * Reads a searching menu's data registry keys, and answers whether the search can still be held.
 * A named registry (`data_registry` holding text) is refused with whatever workflow and extra
 * cases stand beside it. Where none is named, HQ reads neither of those: each reader stands behind
 * `util.py::module_offers_registry_search` (`module_loads_registry_case`, `module_uses_smart_links`,
 * `entries.py::EntriesHelper.get_data_registry_case_datums`). HQ's Case List page on a project
 * space with the data registry binds the workflow's `<select>` even while its row is hidden, and
 * Knockout's `value` binding sets the model to the first option, `load_case`, so every save there
 * stores `data_registry: ""` beside `data_registry_workflow: "load_case"`
 * (`case_search_properties.html`, `case_claim.js::searchConfigModel`,
 * `views/modules.py::_gather_and_update_search_properties`). Without a registry both are dropped.
 */
function readRegistry(
	ctx: ReadContext,
	cursor: JsonCursor,
	claimed: ReadonlySet<string>,
): boolean {
	const others = [
		["data_registry_workflow", T.registryWorkflow, T.noRegistryWorkflow],
		["additional_registry_cases", T.registryCases, T.noRegistryCases],
	] as const;
	if (!claimed.has("data_registry") && cursor.used("data_registry")) {
		cursor.refuse("data_registry", T.registry);
		for (const [key, named] of others)
			if (cursor.used(key)) cursor.refuse(key, named);
		return false;
	}
	for (const [key, , unnamed] of others)
		if (cursor.used(key)) {
			cursor.drop(key, unnamed);
			sameState(
				ctx,
				unnamed.entry,
				`${cursor.pointer}/${key}`,
				"list-settings-respelled",
			);
		}
	return true;
}

/**
 * Whether a stored `additional_case_types` widens the menu's list: every reader of it takes
 * `set(additional_case_types) - {case_type}` (`suite_xml/utils.py::get_ordered_case_types`,
 * `remote_requests.py::RemoteRequestFactory._build_datum_nodeset`), so a list naming only the
 * menu's own type, once or more, widens nothing. A value that is no list of texts is read as
 * widening, and refused.
 */
function widensTheList(stored: unknown, module: DraftModule): boolean {
	const own = module.json.peek("case_type");
	return (
		!Array.isArray(stored) ||
		typeof own !== "string" ||
		stored.some((type) => type !== own)
	);
}

/** The keys HQ's model removed, each its docstring's "Removed fields"
 *  (`models/case_search.py::CaseSearch`). */
const REMOVED_KEYS = new Set([
	"again_label",
	"search_again_label",
	"dynamic_search",
	"command_label",
	"search_label",
	"additional_relevant",
	"search_filter",
]);

/** A key `CaseSearch` does not declare, whether or not the menu offers its search: a key HQ's
 *  model removed, or any other, which no build reads. */
function undeclaredSearchKey(key: string): Claim<"drop"> {
	return REMOVED_KEYS.has(key) ? T.removed : T.unknown;
}
registerUndeclaredKeys("CaseSearch", undeclaredSearchKey);

/** Claims each key of a `search_config` its class does not declare. */
export function claimUndeclaredSearchKeys(cursor: JsonCursor): void {
	for (const key of cursor.undeclared())
		cursor.drop(key, undeclaredSearchKey(key));
}

/** The words Core routes an instance source by before the search's own prefixes
 *  (`CommCareInstanceInitializer.generateRoot`). */
const RESERVED_INSTANCE_WORDS = ["casedb", "ledgerdb", "fixture", "session"];

/** The results instance a menu's search loads into (`models/case_search.py::CaseSearch.get_instance_name`). */
function resultsInstance(config: unknown): string {
	const name = isJsonObject(config) ? config.instance_name : undefined;
	return typeof name === "string" && name !== ""
		? `results:${name}`
		: "results:inline";
}

/** Whether a menu's search is inline (`util.py::module_uses_inline_search`). */
function usesInlineSearch(config: unknown): boolean {
	if (!isJsonObject(config)) return false;
	const offers =
		(Array.isArray(config.properties) && config.properties.length > 0) ||
		(Array.isArray(config.default_properties) &&
			config.default_properties.length > 0);
	return offers && config.inline_search === true && config.auto_launch === true;
}

/**
 * Whether the menu's results instance is the one of the menu HQ compares it with, its root menu or
 * the menu its parent selection names (`helpers/validators.py`, `validate_search_config` and
 * `validate_parent_select`, which compare whether or not the menu searches): `"inline"` where that
 * menu's search is inline, which HQ's build refuses, `"other"` where it is not, which no runtime
 * reads. `withParent` false compares with the root menu alone.
 */
function instanceClash(
	ctx: ReadContext,
	module: DraftModule,
	withParent = true,
): "inline" | "other" | undefined {
	const own = resultsInstance(module.json.peek("search_config"));
	const root = module.json.peek("root_module_id");
	const parent = module.json.peek("parent_select");
	const ids = [
		...(typeof root === "string" && root !== "" ? [root] : []),
		...(withParent &&
		isJsonObject(parent) &&
		parent.active === true &&
		typeof parent.module_id === "string"
			? [parent.module_id]
			: []),
	];
	let clash: "inline" | "other" | undefined;
	for (const id of ids) {
		const other = ctx.draft.modules.find((one) => one.uniqueId === id);
		if (other === undefined || other === module) continue;
		const config = other.json.peek("search_config");
		if (resultsInstance(config) !== own) continue;
		if (usesInlineSearch(config)) return "inline";
		clash = "other";
	}
	return clash;
}

/**
 * The menus' refusal of the menu's parent selection, where the menu it names searches inline
 * under this menu's results instance and the root menu gives no such clash: that entry
 * (`menus/modules.ts`, `parent-select-naming-a-module-that-searches-inline-under-the`) names the
 * one cause, and the menu's instance name belongs to it.
 */
function parentSelectionClash(
	ctx: ReadContext,
	module: DraftModule,
): Finding | undefined {
	if (instanceClash(ctx, module, false) === "inline") return undefined;
	const where = whereText(module.place);
	return ctx.accounting
		.findings()
		.find(
			(finding) =>
				finding.code === PARENT_SELECTION_CLASH &&
				whereText(finding.place) === where,
		);
}

const PARENT_SELECTION_CLASH =
	"menus-and-case-lists/parent-select-naming-a-module-that-searches-inline-under-the";

/** HQ's model default for the search button's text. */
const BUTTON_DEFAULT = "Search All Cases";

/** A candidate whose projection threw, which no difference names. */
const EMITTER_THREW = "emitter-threw";

function parse(text: string): FormSyntax | undefined {
	const read = readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

function unwrap(node: FormSyntax | undefined): FormSyntax | undefined {
	return node?.kind === "group" ? unwrap(node.value) : node;
}

/** Whether `node` is the owner clause `emitExcludedOwnerFilterExpression` writes:
 *  `X = '' or not(selected(X, @owner_id))`, the two `X` one tree. */
function isOwnerClause(node: FormSyntax | undefined): boolean {
	const clause = unwrap(node);
	if (clause?.kind !== "binary" || clause.op !== "or") return false;
	const blank = unwrap(clause.left);
	const not = unwrap(clause.right);
	if (
		blank?.kind !== "binary" ||
		blank.op !== "=" ||
		unwrap(blank.right)?.kind !== "string"
	)
		return false;
	if (not?.kind !== "call" || not.name !== "not" || not.args.length !== 1)
		return false;
	const selected = unwrap(not.args[0]);
	if (
		selected?.kind !== "call" ||
		selected.name !== "selected" ||
		selected.args.length !== 2
	)
		return false;
	const [list, owner] = selected.args;
	const ownerAttr = unwrap(owner);
	return (
		list !== undefined &&
		formSyntaxKey(list) === formSyntaxKey(blank.left) &&
		ownerAttr?.kind === "axis" &&
		ownerAttr.axis === "attribute" &&
		ownerAttr.value.kind === "name" &&
		ownerAttr.value.name === "owner_id"
	);
}

/** Whether the menu's stored search names excluded owners. */
function storesOwners(config: unknown): boolean {
	const owners = isJsonObject(config)
		? config.blacklisted_owner_ids_expression
		: undefined;
	return typeof owners === "string" && owners.trim() !== "";
}

/** Whether the menu's stored search offers a search (`workflow.ts::offersSearch` over the raw
 *  config): a field or a filter row. */
function offersOverRaw(config: unknown): boolean {
	if (!isJsonObject(config)) return false;
	const { properties, default_properties: defaults } = config;
	return (
		(Array.isArray(properties) && properties.length > 0) ||
		(Array.isArray(defaults) && defaults.length > 0)
	);
}

/**
 * Where the menu's owner exclusion is written: `config`, where its search stores the list
 * (`blacklisted_owner_ids_expression`) beside the list filter's clause; `filter`, where the menu
 * offers no search and stores no list, so the clause is the exclusion's only spelling
 * (`hqJson/caseList.ts` writes the search's settings only for a search the menu offers, and the
 * filter's clause from the menu's own exclusion whether or not it does); none otherwise.
 */
function ownerSource(module: DraftModule): "config" | "filter" | undefined {
	const config = module.json.peek("search_config");
	if (storesOwners(config)) return "config";
	if (
		isJsonObject(config) &&
		objectMembers(config.default_properties)?.some(
			(row) => row.property === "commcare_blacklisted_owner_ids",
		)
	)
		return "filter";
	return offersOverRaw(config) ? undefined : "filter";
}

/** The owner clause of a list filter: the whole filter, or its last top-level conjunct. */
function ownerClauseOf(
	node: FormSyntax | undefined,
): { readonly clause: FormSyntax; readonly rest?: FormSyntax } | undefined {
	if (node === undefined) return undefined;
	if (isOwnerClause(node)) return { clause: node };
	if (node.kind === "binary" && node.op === "and" && isOwnerClause(node.right))
		return { clause: node.right, rest: node.left };
	return undefined;
}

/**
 * Whether CommCare HQ reads a menu's case list as choosing its case by itself
 * (`models/modules.py::Module.is_auto_select`): the short detail's `auto_select`, whether or not
 * the list is multi-select, since the method tests `is_multi_select` itself, a bound method and so
 * always true; never in an advanced menu (`AdvancedModule.is_auto_select`). HQ refuses
 * `search_on_clear` beside it whether or not the menu offers search
 * (`helpers/validators.py::validate_search_config`).
 */
export function hqAutoSelects(module: DraftModule): boolean {
	if (module.docType === "AdvancedModule") return false;
	const details = module.json.peek("case_details");
	const short = isJsonObject(details) ? details.short : undefined;
	return isJsonObject(short) && short.auto_select === true;
}

/**
 * The case list filter's text less the owner clause, where the menu holds an owner exclusion
 * (`ownerSource`) and the filter's last top-level conjunct is the clause Nova writes for it. The
 * rest is the authored filter, registered on its own; the projection of the whole menu then holds
 * the two together.
 */
export function listFilterWithoutOwnerClause(
	module: DraftModule,
	text: string,
): string {
	if (ownerSource(module) === undefined) return text;
	const found = ownerClauseOf(parse(text));
	if (found === undefined) return text;
	return found.rest === undefined
		? ""
		: text.slice(found.rest.from, found.rest.to);
}

/** The excluded owners' list inside the list filter's owner clause, less the `normalize-space`
 *  wrapper, as text of the filter. */
function ownerListInFilter(text: string): string | undefined {
	const found = ownerClauseOf(parse(text));
	const clause = unwrap(found?.clause);
	if (clause?.kind !== "binary") return undefined;
	const blank = unwrap(clause.left);
	if (blank?.kind !== "binary") return undefined;
	return withoutNormalizeSpace(text.slice(blank.left.from, blank.left.to));
}

/** The two `replace` calls `suite/wire.ts::normalizeSpace` writes, re-emitted around a blank list. */
const NORMALIZE_SPACE_WRAPPER = unwrap(
	parse(hqXPathText(new HqXPath(normalizeSpace(w.str("")), "none"))),
);

/** Whether `node` is `replace(<list>, …)` with the wrapper call `wrapper`'s other two arguments. */
function wrapperCall(
	node: FormSyntax | undefined,
	wrapper: FormSyntax | undefined,
): FormSyntax | undefined {
	const call = unwrap(node);
	if (
		call?.kind !== "call" ||
		wrapper?.kind !== "call" ||
		call.name !== wrapper.name
	)
		return undefined;
	if (call.args.length !== 3 || wrapper.args.length !== 3) return undefined;
	const same = (at: number) =>
		formSyntaxKey(call.args[at] as FormSyntax) ===
		formSyntaxKey(wrapper.args[at] as FormSyntax);
	return same(1) && same(2) ? (call.args[0] as FormSyntax) : undefined;
}

/** The list inside the wrapper `suite/wire.ts::normalizeSpace` writes (found by re-emitting the
 *  wrapper and comparing syntax), or inside a whole-text `normalize-space(...)`; else the text. */
export function withoutNormalizeSpace(text: string): string {
	const node = unwrap(parse(text));
	const innerWrapper =
		NORMALIZE_SPACE_WRAPPER?.kind === "call"
			? NORMALIZE_SPACE_WRAPPER.args[0]
			: undefined;
	const lowered = wrapperCall(
		wrapperCall(node, NORMALIZE_SPACE_WRAPPER),
		innerWrapper,
	);
	if (lowered !== undefined) return text.slice(lowered.from, lowered.to);
	if (
		node?.kind !== "call" ||
		node.name !== "normalize-space" ||
		node.args.length !== 1
	)
		return text;
	const inner = node.args[0] as FormSyntax;
	return text.slice(inner.from, inner.to);
}

/** Register the availability clause on the assigned list independently from the search. */
export function registerListOwner(
	ctx: ReadContext,
	module: DraftModule,
): number | undefined {
	const filter = filterWithOwnerClause(module);
	if (!filter) return;
	const short = caseListReadings(ctx).get(module.uuid)?.short;
	const text = ownerListInFilter(filter);
	const whole = listFilterWithoutOwnerClause(module, filter) === "";
	const site = whole
		? { json: short, key: "filter" }
		: { json: module.json, key: "case_details" };
	if (!site.json || text === undefined) return;
	return ctx.pending.register(
		{
			ref: { entity: "module", uuid: module.uuid, slot: "excluded_owner_ids" },
			text,
			mode: { target: "hq-json", interpolation: "case" },
			place: searchPlace(module),
			key: "schema:CaseSearch.blacklisted_owner_ids_expression",
			slotText: whole ? filter : null,
		},
		{ json: site.json, key: site.key },
	);
}

/** Compare the actual list clause with the clause this shared expression prints when all Search answers are blank. */
export function sharedOwnerRuleFits(
	ctx: ReadContext,
	module: DraftModule,
	doc: BlueprintDoc,
	candidate: Expression,
): boolean {
	const naming = readProjectionInputs(ctx).lookupNaming;
	const expected = emitExcludedOwnerFilterExpression(
		candidate,
		moduleExpressionContexts(
			doc,
			module.uuid,
			naming,
		)({ slot: "excluded_owner_ids" }),
		naming,
	);
	const filter = filterWithOwnerClause(module);
	if (!filter || !expected) return !filter && !expected;
	const clause = ownerClauseOf(parse(filter))?.clause;
	return (
		clause !== undefined &&
		sameXPathValue(
			filter.slice(clause.from, clause.to),
			hqXPathText(new HqXPath(expected, "case")),
		)
	);
}

/** The stored list filter, where it holds the owner clause. */
function filterWithOwnerClause(module: DraftModule): string | undefined {
	const details = module.json.peek("case_details");
	const short = isJsonObject(details) ? details.short : undefined;
	const filter = isJsonObject(short) ? short.filter : undefined;
	if (typeof filter !== "string" || filter.trim() === "") return undefined;
	return ownerClauseOf(parse(filter)) === undefined ? undefined : filter;
}

/** Each results instance name a reading refused, with its refusal and the place it stands at. */
const REFUSED_INSTANCE_NAMES = new WeakMap<
	ReadContext,
	Map<string, { readonly claim: Claim<"refuse">; readonly place: HqPlace }>
>();

/** HQ compares names even on a submenu with Search turned off. Its stored name is independent of activation. */
export function readSearchResultsName(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
	place: HqPlace,
): { ok: boolean; claimed: boolean } {
	const raw = cursor.peek("instance_name");
	const named = typeof raw === "string" && raw !== "";
	if (named && RESERVED_INSTANCE_WORDS.some((word) => raw.includes(word))) {
		refuseInstanceName(ctx, cursor, T.instanceReserved, place);
		return { ok: false, claimed: true };
	}
	const clash = instanceClash(ctx, module);
	if (clash === "inline") {
		const existing = parentSelectionClash(ctx, module);
		if (existing !== undefined) {
			if (named)
				ctx.accounting.cover({ json: cursor, key: "instance_name" }, existing);
		} else if (named) refuseInstanceName(ctx, cursor, T.instanceClash, place);
		else ctx.accounting.finding(T.instanceClash, place);
		return { ok: false, claimed: named };
	}
	if (!named) return { ok: true, claimed: false };
	if (!searchResultsNameSchema.safeParse(raw).success) {
		refuseInstanceName(ctx, cursor, T.instanceUneditable, place);
		return { ok: false, claimed: true };
	}
	const name = cursor.take(
		"instance_name",
		clash === "other" ? T.instanceClashOutsideInline : T.instanceUnreserved,
		String,
	);
	ctx.writeDraft(() => {
		module.module.searchResultsName = name.value;
	});
	return { ok: true, claimed: true };
}

function refuseInstanceName(
	ctx: ReadContext,
	cursor: JsonCursor,
	claim: Claim<"refuse">,
	place: HqPlace,
): void {
	cursor.refuse("instance_name", claim);
	const name = cursor.peek("instance_name");
	if (typeof name !== "string" || name === "") return;
	let refused = REFUSED_INSTANCE_NAMES.get(ctx);
	if (refused === undefined) {
		refused = new Map();
		REFUSED_INSTANCE_NAMES.set(ctx, refused);
	}
	if (!refused.has(name)) refused.set(name, { claim, place });
}

/**
 * The refusal of the results instance name an instance id reads, where the reading refused that
 * name: CommCare HQ's build declares a search's results under it as `results:<name>`, and the
 * search's answers as `search-input:results:<name>` (`suite_xml/post_process/instances.py`), so a
 * form's read of either stands under the name's one finding. Undefined for any other id.
 */
export function refusedInstanceNameOf(
	ctx: ReadContext,
	id: string,
): { readonly claim: Claim<"refuse">; readonly place: HqPlace } | undefined {
	const refused = REFUSED_INSTANCE_NAMES.get(ctx);
	if (refused === undefined) return undefined;
	for (const prefix of ["search-input:results:", "results:"])
		if (id.startsWith(prefix)) return refused.get(id.slice(prefix.length));
	return undefined;
}

/** What the settings pass keeps for the settle. */
export interface SettingsReading {
	readonly ok: boolean;
	readonly owners?: number;
	readonly button?: number;
	/** The keys this pass claimed: on a menu that offers no search, every other key is its
	 *  caller's to claim as inactive. */
	readonly claimed: ReadonlySet<string>;
	/** The search stores an owner exclusion and the list filter holds no clause for it: the
	 *  caller decides it once the menu's fields are drafted (`holdsOwnersWithoutClause`). */
	readonly ownersWithoutClause?: true;
}

/**
 * Reads the search's settings into `config`, the menu's search config being built. On a menu
 * that offers no search only the owner exclusion is read.
 */
export function readSearchSettings(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
	offers: boolean,
	config: Partial<OrdinaryCaseSearchConfig>,
	coveredSettings: ReadonlySet<string> = new Set(),
): SettingsReading {
	const place = searchPlace(module);
	let ok = true;
	const claimed = new Set(coveredSettings);
	for (const [key, claim] of BLANK_KEYS)
		if (cursor.peek(key) === "") {
			cursor.drop(key, claim);
			claimed.add(key);
			if (offers)
				sameState(
					ctx,
					claim.entry,
					`${cursor.pointer}/${key}`,
					"list-settings-respelled",
				);
		}
	// The menu's own list shows the additional types whether or not it searches
	// (`entries.py::EntriesHelper.get_datum_meta_module`, `additional_types`).
	if (cursor.used("additional_case_types")) {
		claimed.add("additional_case_types");
		if (widensTheList(cursor.peek("additional_case_types"), module)) {
			const values = cursor.peek("additional_case_types");
			if (
				Array.isArray(values) &&
				values.every((value) => caseTypeNameSchema.safeParse(value).success)
			) {
				const additional = [...new Set(values as string[])]
					.filter((type) => type !== module.module.caseType)
					.sort();
				const choices = new Set(
					ctx.draft.modules.map((menu) => menu.module.caseType),
				);
				const missing = additional.find((type) => !choices.has(type));
				if (missing !== undefined) {
					cursor.refuse("additional_case_types", T.additionalTypeWithoutMenu, {
						name: missing,
					});
					ok = false;
				} else {
					cursor.take(
						"additional_case_types",
						T.additionalTypes,
						() => additional,
					).value;
					ctx.writeDraft(() => {
						const target = module.module as { caseListConfig?: CaseListConfig };
						target.caseListConfig ??= emptyCaseListConfig();
						target.caseListConfig.additionalCaseTypes = additional;
					});
				}
			} else {
				ctx.accounting.circumstance("unrecognized", place, {
					name: "schema:CaseSearch.additional_case_types",
				});
				ok = false;
			}
		} else {
			cursor.drop("additional_case_types", T.additionalOwnType);
			if (offers)
				sameState(
					ctx,
					T.additionalOwnType.entry,
					`${cursor.pointer}/additional_case_types`,
					"list-settings-respelled",
				);
		}
	}
	const registerButtonCondition = () => {
		const key = "search_button_display_condition";
		const text = cursor.peek(key);
		if (typeof text !== "string" || text.trim() === "") return;
		return ctx.pending.register(
			{
				ref: {
					entity: "module",
					uuid: module.uuid,
					slot: "search_button_display_condition",
				},
				text,
				mode: { target: "hq-json", interpolation: "none" },
				place,
				key: "schema:CaseSearch.search_button_display_condition",
			},
			{ json: cursor, key },
		);
	};
	const name = readSearchResultsName(ctx, module, cursor, place);
	if (name.claimed) claimed.add("instance_name");
	if (!name.ok) ok = false;
	let owners: number | undefined;
	const filter = filterWithOwnerClause(module);
	let ownersWithoutClause = false;
	if (holdsText(cursor, "blacklisted_owner_ids_expression")) {
		claimed.add("blacklisted_owner_ids_expression");
		if (offers)
			// Nova's list writes no clause for an exclusion that reads a Search answer alone, which
			// only the bound tree tells: `readOwnersWithoutClause`, once the menu's fields are drafted.
			ownersWithoutClause = true;
		else {
			// HQ creates no remote request for this menu. The stored Search
			// setting says nothing about the cases on its assigned list.
			cursor.drop("blacklisted_owner_ids_expression", T.dormantOwners);
			sameState(
				ctx,
				T.dormantOwners.entry,
				`${cursor.pointer}/blacklisted_owner_ids_expression`,
				"list-settings-respelled",
			);
		}
	}
	if (filter !== undefined && (!offers || ownerSource(module) === "filter")) {
		owners = registerListOwner(ctx, module);
		if (owners !== undefined)
			config.excludedOwnerIds = pendingPlaceholder("value");
	}
	if (!offers) {
		return { ok, claimed, ...(owners !== undefined && { owners }) };
	}

	const codes = appCodes(ctx);
	const source = sourceCode(ctx);
	const storedTitle = cursor.peek("title_label");
	const title = shownTitles(storedTitle, codes);
	// A language whose title a device shows blank (`titleShownBlank`), not one JavaScript's trim
	// empties: U+FEFF is a title a device keeps.
	const blank = codes.filter((code) => titleShownBlank(title?.[code] ?? ""));
	// The first title Nova's gate admits no spelling of, the source language's first: one whose
	// line defines no string (nothing before a carriage return, or only a character Core's trim
	// drops) is no blank title, since a device then shows the default table's text or fails.
	const unheld =
		title === undefined
			? undefined
			: unheldText(
					title,
					codes,
					source ?? codes[0] ?? "",
					"search-screen-title",
				);
	// Each language's file holds its own title (`shownTitles`), so a rest after a carriage return
	// that defines an app string is read there, a title a device shows blank included.
	const titleLineEnd =
		title === undefined
			? undefined
			: Object.values(title)
					.map(keyDefinedAfterLineEnd)
					.find((one) => one !== undefined);
	if (title === undefined) {
		ctx.accounting.circumstance("unrecognized", place, {
			name: "schema:CaseSearch.title_label",
		});
		ok = false;
	} else if (titleLineEnd !== undefined) {
		cursor.refuse("title_label", LINE_END_DEFINES_KEY, { name: titleLineEnd });
		ok = false;
	} else if (unheld !== undefined) {
		// One finding: refused at the key where the manifest names why Nova's gate admits no
		// spelling of the text, else `unrecognized`, which the close gives.
		const refusal = unheldRefusal(unheld);
		if (refusal === undefined)
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:CaseSearch.title_label",
			});
		else
			cursor.refuse(
				"title_label",
				refusal.claim,
				{ name: refusal.name },
				place,
			);
		ok = false;
	} else if (blank.length === codes.length) {
		cursor.take("title_label", T.titleBlank, languageMap).value;
		config.searchScreenTitle = NO_SEARCH_SCREEN_TITLE;
		const shell = recordFromEntries(codes.map((code) => [code, ""]));
		if (!spelledAsShown(storedTitle, shell, codes))
			sameState(
				ctx,
				T.titleBlank.entry,
				`${cursor.pointer}/title_label`,
				"list-settings-respelled",
			);
	} else {
		// Each language shows its own title, else the first language's (`shownTitles`), so a
		// language shows none where the first language shows none too, which Nova's gate holds
		// (`searchTitleLanguages.ts`): the source language's title is the slot's, text or `none`,
		// and each other language's text a translation of it. A source title a device shows blank
		// beside the first language's text holds only spaces there (`titleShownBlank`), and Nova
		// writes no such title: it is held as the first language's text, which the reading
		// records under `text-spaces-dropped`. Otherwise held as every app string is
		// (`heldText.ts::heldText`): no space at either end, and a language that shows a blank
		// title beside the source's text shows the source's, which the reading records under
		// `text-spaces-dropped` too. Every title is one Nova's gate admits a spelling of
		// (`unheld` above).
		// The codes are not all blank here, so there is a first language and a source.
		const first = codes[0] ?? "";
		const src = source ?? first;
		const sourceShownBlank = blank.includes(src);
		const firstShownBlank = blank.includes(first);
		const held = heldTitles(title, codes, src);
		if (
			held === undefined ||
			// A source title a device shows (U+FEFF alone) that Nova's content policy reads as
			// blank has no document that prints it either.
			(!sourceShownBlank && (held.texts[src] ?? "").trim() === "")
		) {
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:CaseSearch.title_label",
			});
			ok = false;
		} else {
			const blankInSource = sourceShownBlank && firstShownBlank;
			cursor.take(
				"title_label",
				blankInSource ? T.titleSome : T.title,
				languageMap,
			).value;
			// "Search" in the source language is the absent title, whose text is that word, and a
			// blank source title the `none` title: a document holds its other languages as the
			// title unit's translations either way.
			const text = sourceText(ctx, held.texts);
			if (text === "") config.searchScreenTitle = NO_SEARCH_SCREEN_TITLE;
			else if (text !== DEFAULT_CASE_SEARCH_TITLE)
				config.searchScreenTitle = text;
			ctx.translations.set(
				makeTranslationUnitId("module", module.uuid, "search-title"),
				"text",
				translatedTexts(ctx, held.texts),
			);
			if (
				held.workersSeeAnother ||
				!spelledAsShown(storedTitle, held.texts, codes)
			)
				recordTextRewrite(
					ctx,
					{
						entry: (blankInSource ? T.titleSome : T.title).entry,
						path: `${cursor.pointer}/title_label`,
					},
					"list-settings-respelled",
					held.workersSeeAnother,
				);
		}
	}
	const storedDescription = cursor.peek("description");
	// The subtitle as HQ's build shows it in each language (`app_strings.py`, `clean_trans` of the
	// map): a language the map lacks, or holds blank, shows another's text. It is held as every
	// app string is (`caseList/columns.ts::heldTextsIn`): no space at either end, and a language
	// blank-looking beside the source's text takes the source's text there.
	const heldDescription = heldTextsIn(
		storedDescription ?? NO_ENTRIES,
		codes,
		sourceCode(ctx),
		"search-screen-subtitle",
	);
	const description = heldDescription?.texts;
	if (description === undefined) {
		// One finding: refused at the key where the manifest names why Nova's gate admits no
		// spelling of a text, else `unrecognized`.
		const refusal = unheldRefusal(
			unheldTextsIn(
				storedDescription ?? NO_ENTRIES,
				codes,
				sourceCode(ctx),
				"search-screen-subtitle",
			),
		);
		if (refusal === undefined)
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:CaseSearch.description",
			});
		else
			cursor.refuse(
				"description",
				refusal.claim,
				{ name: refusal.name },
				place,
			);
		ok = false;
	} else if (codes.some((code) => (description[code] ?? "") !== "")) {
		cursor.take("description", T.description, languageMap).value;
		config.searchScreenSubtitle = sourceText(ctx, description);
		ctx.translations.set(
			makeTranslationUnitId("module", module.uuid, "search-subtitle"),
			"text",
			translatedTexts(ctx, description),
		);
		if (
			heldDescription?.workersSeeAnother === true ||
			!spelledAsShown(storedDescription, description, codes)
		)
			recordTextRewrite(
				ctx,
				{ entry: T.description.entry, path: `${cursor.pointer}/description` },
				"list-settings-respelled",
				heldDescription?.workersSeeAnother === true,
			);
	} else if (cursor.used("description")) {
		// Blank in every language is no subtitle, as an absent map is.
		cursor.take("description", T.description, languageMap).value;
		if (!spelledAsShown(storedDescription, description, codes))
			sameState(
				ctx,
				T.description.entry,
				`${cursor.pointer}/description`,
				"list-settings-respelled",
			);
	}
	// The button's label is an app string (`app_strings.py`, `clean_trans` of the map), compared
	// with HQ's default as a device shows it in each language (`heldText.ts::showsInEveryLanguage`):
	// spaces at its end, a second language holding the default, or a language the map lacks show
	// the default, which Nova writes as `{en: "Search All Cases"}`, so the first publish only
	// respells the map. A rest after a carriage return that defines an app string is refused.
	const storedButton = cursor.peek("search_button_label");
	const buttonLineEnd = storedKeyDefinedAfterLineEnd(storedButton, codes);
	if (buttonLineEnd !== undefined) {
		cursor.refuse("search_button_label", LINE_END_DEFINES_KEY, {
			name: buttonLineEnd,
		});
		ok = false;
	} else if (
		showsInEveryLanguage(storedButton, codes, BUTTON_DEFAULT) === true
	) {
		cursor.take("search_button_label", T.buttonDefault, languageMap).value;
		if (!sameJson(storedButton, { en: BUTTON_DEFAULT }))
			recordTextRewrite(
				ctx,
				{
					entry: T.buttonDefault.entry,
					path: `${cursor.pointer}/search_button_label`,
				},
				"list-settings-respelled",
				false,
			);
	} else if (cursor.used("search_button_label")) {
		cursor.refuse("search_button_label", T.buttonOther);
		ok = false;
	}
	const buttonIndex = registerButtonCondition();
	if (buttonIndex !== undefined)
		config.searchButtonDisplayCondition = pendingPlaceholder("condition");

	if (cursor.used("custom_sort_properties")) {
		const stored = cursor.peek("custom_sort_properties");
		const order = readDedicatedOrder(stored);
		const refusal = dedicatedOrderRefusal(stored);
		if (order === undefined && refusal !== undefined) {
			cursor.refuse(
				"custom_sort_properties",
				refusal === "reserved" ? T.customSortReserved : T.customSortDeviceOnly,
			);
			ok = false;
		} else if (order === undefined) {
			const detail = { name: "schema:CaseSearch.custom_sort_properties" };
			ctx.accounting.circumstance("unrecognized", place, detail);
			ctx.accounting.cover(
				{ json: cursor, key: "custom_sort_properties" },
				circumstanceFinding("unrecognized", place, detail),
			);
			ok = false;
		} else {
			const members = cursor.list(
				"custom_sort_properties",
				"CaseSearchCustomSortProperty",
				T.customSort,
			);
			for (const row of members) {
				row.takeClass(T.sortTerm).value;
				row.take("property_name", T.sortProperty, String).value;
				row.take("sort_type", T.sortComparison, String).value;
				row.take("direction", T.sortDirection, String).value;
			}
			config.requestOrder = order;
		}
		claimed.add("custom_sort_properties");
	}
	if (
		!claimed.has("custom_related_case_property") &&
		cursor.used("custom_related_case_property")
	) {
		const property = authoredCasePropertyNameSchema.safeParse(
			cursor.peek("custom_related_case_property"),
		);
		if (!property.success) {
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:CaseSearch.custom_related_case_property",
			});
			ok = false;
		} else if (isDeviceOnlyCaseProperty(property.data)) {
			cursor.refuse(
				"custom_related_case_property",
				T.relatedPropertyDeviceOnly,
				{
					name: property.data,
				},
			);
			ok = false;
		} else {
			cursor.take(
				"custom_related_case_property",
				T.relatedProperty,
				() => property.data,
			).value;
			config.relatedRecordIdProperty = property.data;
		}
	}
	if (!readRegistry(ctx, cursor, claimed)) ok = false;
	if (cursor.used("search_on_clear")) {
		if (hqAutoSelects(module)) {
			cursor.refuse("search_on_clear", T.searchOnClearAuto);
			ok = false;
		} else if (cursor.take("search_on_clear", T.searchOnClear, Boolean).value) {
			config.searchOnClear = true;
		}
	}

	claimUndeclaredSearchKeys(cursor);
	return {
		ok,
		claimed,
		...(owners !== undefined && { owners }),
		...(buttonIndex !== undefined && { button: buttonIndex }),
		...(ownersWithoutClause && { ownersWithoutClause: true as const }),
	};
}

/**
 * The owner exclusion a search stores with no clause for it in the list filter, as a registration
 * of the menu's `excluded_owner_ids` slot: the list beside its `normalize-space` wrapper, which
 * the projection writes again.
 */
export function ownersWithoutClauseRegistration(
	module: DraftModule,
	cursor: JsonCursor,
): PendingExpression | undefined {
	const stored = cursor.peek("blacklisted_owner_ids_expression");
	if (typeof stored !== "string" || stored.trim() === "") return undefined;
	return {
		ref: { entity: "module", uuid: module.uuid, slot: "excluded_owner_ids" },
		text: stored,
		mode: { target: "hq-json", interpolation: "none" },
		place: searchPlace(module),
		key: "schema:CaseSearch.blacklisted_owner_ids_expression",
	};
}

/**
 * The search title each app language shows, or `undefined` where a value's printed text cannot be
 * known. The title is no `clean_trans` text: a language's file holds `title_label.get(lang) or ''`
 * (`app_strings.py::_create_case_search_app_strings`, `CaseSearch.get_search_title_label`) and drops it
 * where blank (`AppStringsBase.create_custom_app_strings`, `non_empty_only`), and the `default`
 * table every such language falls back to holds the first language's
 * (`create_default_app_strings`, `for_default`, which reads `app.default_language`, `langs[0]`).
 * So a language whose own title is blank or absent shows the first language's.
 */
function shownTitles(
	stored: unknown,
	codes: readonly string[],
): Record<string, string> | undefined {
	const map = stored === undefined ? NO_ENTRIES : stored;
	if (!isJsonObject(map)) return undefined;
	const files = recordFromEntries<string>([]);
	for (const code of codes) {
		const value = map[code];
		// Python's `or ''`: every falsy value is the blank.
		if (pythonFalsy(value)) files[code] = "";
		else if (typeof value === "string") files[code] = value;
		else return undefined;
	}
	const first = codes.length === 0 ? "" : files[codes[0]];
	return recordFromEntries(
		codes.map((code) => [code, files[code] !== "" ? files[code] : first]),
	);
}

function pythonFalsy(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === false ||
		value === 0 ||
		value === "" ||
		(Array.isArray(value) && value.length === 0) ||
		(isJsonObject(value) && Object.keys(value).length === 0)
	);
}

/** Whether a stored `{lang: text}` map is spelled exactly as HQ's build shows it, `shown`: a key
 *  for each app language and none other, each holding the text shown. Another spelling prints
 *  the same text and is written as shown by the first publish. */
export function spelledAsShown(
	stored: unknown,
	shown: Readonly<Record<string, string>>,
	codes: readonly string[],
): boolean {
	if (!isJsonObject(stored)) return codes.length === 0;
	const keys = Object.keys(stored);
	return (
		keys.length === codes.length &&
		codes.every((code) => stored[code] === shown[code])
	);
}

// ── The whole menu, as Nova's emission writes it back ───────────────────

type JsonObject = Readonly<Record<string, unknown>>;

function printed(value: unknown): unknown {
	if (value instanceof HqXPath) return hqXPathText(value);
	if (Array.isArray(value)) return value.map(printed);
	if (isJsonObject(value))
		return recordFromEntries(
			Object.entries(value).map(([key, one]) => [key, printed(one)]),
		);
	return value;
}

const BLANK = (value: unknown) =>
	value === undefined || value === null || value === "" || value === false;

function sameXPathValue(a: unknown, b: unknown): boolean {
	if (BLANK(a) || BLANK(b)) return BLANK(a) && BLANK(b);
	return typeof a === "string" && typeof b === "string" && sameXPathText(a, b);
}

/** Whether a reading holds two stored text maps of role `role` alike in each app language
 *  (`caseList/columns.ts::sameHeldTexts`, over `hqText.ts::shownText`): a language a map lacks
 *  shows another language's text. A map that is absent is no text. */
function sameTexts(
	codes: readonly string[],
	source: string | undefined,
	role: TranslationUnitRole,
	a: unknown,
	b: unknown,
): boolean {
	return sameHeldTexts(codes, source, role, a ?? NO_ENTRIES, b ?? NO_ENTRIES);
}

/** A title each app language shows (`shownTitles`) as a reading holds it
 *  (`heldText.ts::heldText`), or undefined where Nova's gate admits no spelling of a text. */
function heldTitles(
	shown: Readonly<Record<string, string>>,
	codes: readonly string[],
	source: string | undefined,
): HeldTexts | undefined {
	if (source === undefined) return { texts: shown, workersSeeAnother: false };
	// A source title a device shows blank beside the first language's text holds only spaces,
	// which Nova writes no title for: the source takes the first language's text, which a worker
	// there then reads.
	const first = codes[0] ?? source;
	const spacesOnly =
		titleShownBlank(shown[source] ?? "") &&
		!titleShownBlank(shown[first] ?? "");
	const held = heldText(
		spacesOnly
			? recordFromEntries(
					codes.map((code) => [
						code,
						code === source ? (shown[first] ?? "") : (shown[code] ?? ""),
					]),
				)
			: shown,
		codes,
		source,
		"search-screen-title",
	);
	return held === undefined
		? undefined
		: {
				texts: held.printed,
				workersSeeAnother: held.workersSeeAnother || spacesOnly,
			};
}

/**
 * Whether a device shows a search title blank in a language whose file holds `text`, as Nova
 * holds it: a text Python reads as blank (`heldText.ts::hqDeviceText`, which HQ's build writes as
 * a non-breaking space) or one Core's trim leaves only spaces of, and one Nova's gate admits a
 * spelling of (`heldText.ts::holdText`). A line that defines no string (nothing before a carriage
 * return, or only a character Core's trim drops) is no blank title: a device shows the default
 * table's text there, or fails where that table defines none.
 */
function titleShownBlank(text: string): boolean {
	return holdText(text) !== undefined && hqDeviceText(text) === "";
}

/** Whether a reading holds two stored titles alike in each app language (`shownTitles`,
 *  `heldTitles`). */
function sameTitles(
	codes: readonly string[],
	source: string | undefined,
	a: unknown,
	b: unknown,
): boolean {
	const shownA = shownTitles(a, codes);
	const shownB = shownTitles(b, codes);
	// A title a device shows blank in every language is no title, as the reading reads it.
	const none = (shown: Record<string, string> | undefined) =>
		shown !== undefined &&
		codes.every((code) => titleShownBlank(shown[code] ?? ""));
	if (none(shownA) || none(shownB)) return none(shownA) && none(shownB);
	const left =
		shownA === undefined ? undefined : heldTitles(shownA, codes, source);
	const right =
		shownB === undefined ? undefined : heldTitles(shownB, codes, source);
	return (
		left !== undefined &&
		right !== undefined &&
		codes.every((code) => left.texts[code] === right.texts[code])
	);
}

const PROMPT_TEXT_KEYS = [
	["label", "search-input-label"],
	["hint", "search-input-hint"],
] as const;
const PROMPT_PLAIN_KEYS = ["name", "input_", "hidden", "exclude"] as const;

/** The surface key of the first difference between a stored prompt and the projection's. */
function promptDifference(
	codes: readonly string[],
	source: string | undefined,
	stored: JsonObject,
	ours: JsonObject,
	firstValidation: Readonly<Record<string, string>> | undefined,
): string | undefined {
	const storedGroup = stored.is_group === true;
	if (storedGroup !== (ours.is_group === true))
		return "schema:CaseSearchProperty.is_group";
	if (storedGroup)
		return sameTexts(
			codes,
			source,
			"search-input-group-label",
			stored.label,
			ours.label,
		)
			? undefined
			: "schema:CaseSearchProperty.label";
	// Group keys change with row placement in the Case List editor. The
	// first pass already proved every field belongs to its preceding heading.

	for (const key of PROMPT_PLAIN_KEYS)
		if (!(BLANK(stored[key]) && BLANK(ours[key])) && stored[key] !== ours[key])
			return `schema:CaseSearchProperty.${key}`;
	if (
		(stored.appearance === "barcode_scan") !==
		(ours.appearance === "barcode_scan")
	)
		return "schema:CaseSearchProperty.appearance";
	for (const [key, role] of PROMPT_TEXT_KEYS)
		if (
			// A hidden prompt's hint is shown nowhere, and the reading holds none
			// (`prompts.ts::readPrompt`).
			!(key === "hint" && stored.hidden === true && ours.hint === undefined) &&
			!sameTexts(codes, source, role, stored[key], ours[key])
		)
			return `schema:CaseSearchProperty.${key}`;
	if (!sameXPathValue(stored.default_value, ours.default_value))
		return "schema:CaseSearchProperty.default_value";
	const itemA = isJsonObject(stored.itemset) ? stored.itemset : NO_ENTRIES;
	const itemB = isJsonObject(ours.itemset) ? ours.itemset : NO_ENTRIES;
	// The instance only HQ's Case List page reads: beside a nodeset that reads a table's item list,
	// the field's table is that one whatever the stored instance names, and the projection names it
	// (`prompts.ts::readPrompt`).
	const storedTable = itemsetSource(itemA.nodeset)?.tag;
	if (
		!(
			storedTable !== undefined &&
			itemB.instance_id === `item-list:${storedTable}`
		) &&
		(itemA.instance_id ?? null) !== (itemB.instance_id ?? null)
	)
		return "schema:Itemset.instance_id";
	for (const key of ["nodeset", "label", "value", "sort"] as const)
		if (!sameXPathValue(itemA[key], itemB[key])) return `schema:Itemset.${key}`;
	// A blank test is no requirement, whatever its text: HQ's build writes no `<required>` and no
	// text for it (`remote_requests.py`, `app_strings.py`: `if prop.required.test`).
	const requirement = (value: unknown) =>
		isJsonObject(value) && !BLANK(value.test) ? value : undefined;
	const reqA = requirement(stored.required);
	const reqB = requirement(ours.required);
	if ((reqA === undefined) !== (reqB === undefined))
		return "schema:CaseSearchProperty.required";
	if (reqA !== undefined && reqB !== undefined) {
		const normalized =
			typeof reqA.test === "string"
				? requiredCaseChildAsBlank(reqA.test)
				: undefined;
		if (!sameXPathValue(normalized ?? reqA.test, reqB.test))
			return "schema:Assertion.test";
		if (
			!sameTexts(
				codes,
				source,
				"search-input-required-message",
				reqA.text,
				reqB.text,
			)
		)
			return "schema:Assertion.text";
	}
	const valA = objectMembers(stored.validations) ?? [];
	const valB = Array.isArray(ours.validations)
		? ours.validations.filter(isJsonObject)
		: [];
	if (valA.length !== valB.length)
		return "schema:CaseSearchProperty.validations";
	for (const [index, one] of valA.entries()) {
		const other = valB[index] as JsonObject;
		if (!sameXPathValue(one.test, other.test)) return "schema:Assertion.test";
		// The first validation's text as the reading holds it where it read one
		// (`prompts.ts::PromptReading.validationText`: a message held apart from the guard's text
		// joined after it), else each stored text held whole.
		const held = index === 0 ? firstValidation : undefined;
		const ourHeld =
			held === undefined
				? undefined
				: heldTextsIn(
						other.text ?? NO_ENTRIES,
						codes,
						source,
						"search-input-validation-message",
					)?.texts;
		if (
			held === undefined
				? !sameTexts(
						codes,
						source,
						"search-input-validation-message",
						one.text,
						other.text,
					)
				: ourHeld === undefined ||
					codes.some((code) => held[code] !== ourHeld[code])
		)
			return "schema:Assertion.text";
	}
	return undefined;
}

/** One search slot of a menu, as `SearchConfigRewrites` names it. */
type SearchSlotRef = Parameters<SearchConfigRewrites>[0];

/** The key a search slot's level is kept under. */
function searchSlotKey(ref: SearchSlotRef): string {
	if ("parameterUuid" in ref) return `${ref.slot}/${ref.parameterUuid}`;
	return "searchInputUuid" in ref
		? `${ref.slot}/${ref.searchInputUuid}`
		: ref.slot;
}

/** The tree `mod` holds in one of its search slots. */
function searchSlotTree(
	mod: Module,
	ref: SearchSlotRef,
): Expression | undefined {
	if ("parameterUuid" in ref) {
		const config = mod.caseSearchConfig;
		return config && "projectSearch" in config
			? config.projectSearch?.defaults.find((p) => p.uuid === ref.parameterUuid)
					?.value
			: undefined;
	}
	if (!("searchInputUuid" in ref)) {
		const config = mod.caseSearchConfig;
		if (config === undefined) return undefined;
		if (ref.slot === "excluded_owner_ids") return config.excludedOwnerIds;
		return "searchButtonDisplayCondition" in config
			? config.searchButtonDisplayCondition
			: undefined;
	}
	const input = mod.caseListConfig?.searchInputs.find(
		(one) => one.uuid === ref.searchInputUuid,
	);
	if (input === undefined) return undefined;
	switch (ref.slot) {
		case "search_input_hidden_value":
			return input.kind === "hidden" ? input.value : undefined;
		case "search_input_default":
			return input.kind !== "hidden" && "default" in input
				? input.default
				: undefined;
		case "search_input_required_when":
			return input.kind === "hidden" ? undefined : input.required?.when;
		case "search_input_validation_rule":
			return input.kind === "hidden" ? undefined : input.validation?.rule;
		case "search_input_options":
			return input.kind !== "hidden" &&
				"options" in input &&
				input.options?.kind === "lookup"
				? input.options.filter
				: undefined;
		default:
			return undefined;
	}
}

/**
 * The control each of `mod`'s search slots prints under in the settle: the level the expression
 * stage held the slot's tree at (`expressions/printLevel.ts`), so a slot held with a rewrite
 * withheld prints as its source does; none for a slot held exact, and none where `mod` holds
 * another tree there than the one held (a candidate without the runtime guard's conjunct), which
 * prints as an export does.
 */
function heldSearchLevels(ctx: ReadContext, mod: Module): SearchConfigRewrites {
	const held = new Map<string, { tree: Expression; level: PrintLevel }>();
	const registrations = ctx.pending.list();
	for (const index of ctx.pending.of("module", mod.uuid)) {
		const ref = (registrations[index] as PendingExpression).ref;
		const { expression, level } = ctx.pending.outcome(index);
		if (expression === undefined || level === undefined) continue;
		const member = "member" in ref ? ref.member : undefined;
		const uuid =
			member &&
			("searchInputUuid" in member
				? member.searchInputUuid
				: "parameterUuid" in member
					? member.parameterUuid
					: undefined);
		const key = uuid ? `${ref.slot}/${uuid}` : ref.slot;
		held.set(key, { tree: expression, level });
	}
	return (ref) => {
		const one = held.get(searchSlotKey(ref));
		if (one === undefined) return undefined;
		const tree = searchSlotTree(mod, ref);
		return tree !== undefined && sameJson(tree, one.tree)
			? levelControl(one.level)
			: undefined;
	};
}

function callArgs(
	node: FormSyntax,
	name: string,
	count: number,
): readonly FormSyntax[] | undefined {
	const expression = core(node);
	return expression.kind === "call" &&
		expression.name === name &&
		expression.args.length === count
		? expression.args
		: undefined;
}

/** Core checks only a nonempty answer. A lowercase ASCII rule on this same
 * input already rejects an answer containing either quote. Accept only the
 * exact direct-input guard we generate after that rule. A computed value,
 * another field's answer, or any additional requirement needs its own proof.
 */
function redundantQuoteCheck(
	field: SearchInputDef,
	stored: unknown,
	printed: unknown,
): boolean {
	if (field.kind === "hidden" || field.validation?.message !== undefined)
		return false;
	const rule = field.validation?.rule;
	if (
		rule?.kind !== "matches-pattern" ||
		rule.pattern !== "^[a-z]+$" ||
		rule.left.kind !== "term" ||
		rule.left.term.kind !== "input" ||
		rule.left.term.searchInputUuid !== field.uuid ||
		typeof stored !== "string" ||
		typeof printed !== "string"
	)
		return false;
	const before = readFormSyntax(stored);
	const after = readFormSyntax(printed);
	if (!before.ok || !before.node || !after.ok || !after.node) return false;
	const merged = core(after.node);
	if (
		merged.kind !== "binary" ||
		merged.op !== "and" ||
		!sameSyntax(merged.left, before.node)
	)
		return false;
	const [text] = callArgs(merged.left, "regex", 2) ?? [];
	// Core reads the input via its node-set-to-value conversion, as printed
	// by the expression emitter. The typed rule above already binds its UUID.
	const answer = text && (callArgs(text, "if", 3)?.[1] ?? text);
	const [rejection] = callArgs(merged.right, "not", 1) ?? [];
	if (!answer || !rejection) return false;
	const parts = clauses(rejection, "and");
	if (parts.length !== 3) return false;
	const [present] = callArgs(parts[0], "count", 1) ?? [];
	if (!present || !sameSyntax(present, answer)) return false;
	const quotes = parts.slice(1).map((part) => {
		const [value, quote] = callArgs(part, "contains", 2) ?? [];
		const literal = quote && core(quote);
		return value && sameSyntax(value, answer) && literal?.kind === "string"
			? literal.value
			: undefined;
	});
	return quotes.includes("'") && quotes.includes('"');
}

/** The surface key of the first difference between the stored search and the projection's,
 *  `default_properties` aside (the rows are held by `rows.ts`). Each expression slot prints at
 *  the level the reading held it (`heldSearchLevels`), so a slot held with a rewrite withheld is
 *  compared as its source spells it, and the reading records the rewrite. A Search field with no
 *  check of its own, stored with none, is the field the projection prints with Nova's runtime
 *  guard as its check (`searchPrompts.ts::buildValidation`) where the menu's rows were read up to
 *  `search-value-guards` (`rows.ts::classifySearchRows`, at `place`): the guard is that rewrite's,
 *  which the first publish sends and the reading reports. Given `fields`, it compares
 *  every stored Search field once the settings before them agree, and sets each field's
 *  difference (undefined where its property prints as stored) by its pointer. */
function searchDifference(
	ctx: ReadContext,
	doc: BlueprintDoc,
	mod: Module,
	stored: JsonCursor,
	prompts: readonly PromptReading[],
	fields?: Map<string, string | undefined>,
	addedGuards?: Set<string>,
): string | undefined {
	const inputs = readProjectionInputs(ctx);
	const ours = printed(
		projectCaseListForHq(
			mod,
			withReadTexts(doc, ctx.translations),
			inputs.assets,
			inputs.lookupNaming,
			heldSearchLevels(ctx, mod),
		).searchConfig,
	) as JsonObject;
	const codes = appCodes(ctx);
	const source = sourceCode(ctx);
	for (const key of ["auto_launch", "default_search"] as const)
		if ((stored.peek(key) === true) !== (ours[key] === true))
			return `schema:CaseSearch.${key}`;
	// Every reader of `inline_search` in HQ's build reads it beside `auto_launch`
	// (`util.py::module_uses_inline_search`), so a stored `true` beside `auto_launch: false` is
	// the state of the default.
	const inline = (config: { readonly [key: string]: unknown }): boolean =>
		config.inline_search === true && config.auto_launch === true;
	if (
		inline({
			inline_search: stored.peek("inline_search"),
			auto_launch: stored.peek("auto_launch"),
		}) !== inline(ours)
	)
		return "schema:CaseSearch.inline_search";
	if (!sameTitles(codes, source, stored.peek("title_label"), ours.title_label))
		return "schema:CaseSearch.title_label";
	if (
		!sameTexts(
			codes,
			source,
			"search-screen-subtitle",
			stored.peek("description"),
			ours.description,
		)
	)
		return "schema:CaseSearch.description";
	for (const key of [
		"search_button_display_condition",
		"blacklisted_owner_ids_expression",
	] as const)
		if (!sameXPathValue(stored.peek(key), ours[key]))
			return `schema:CaseSearch.${key}`;
	if (
		!sameJson(
			readDedicatedOrder(stored.peek("custom_sort_properties")) ?? [],
			readDedicatedOrder(ours.custom_sort_properties) ?? [],
		)
	)
		return "schema:CaseSearch.custom_sort_properties";
	// Each stored prompt with the pointer its reading's cursor has.
	const promptsA = Array.isArray(stored.peek("properties"))
		? (stored.peek("properties") as unknown[]).flatMap((one, index) =>
				isJsonObject(one)
					? [{ one, pointer: `${stored.pointer}/properties/${index}` }]
					: [],
			)
		: [];
	const promptsB = Array.isArray(ours.properties)
		? ours.properties.filter(isJsonObject)
		: [];
	if (promptsA.length !== promptsB.length)
		return "schema:CaseSearch.properties";
	const validationTexts = new Map(
		prompts.map((prompt) => [prompt.cursor.pointer, prompt.validationText]),
	);
	const uuidAt = new Map(
		prompts.map((prompt) => [prompt.cursor.pointer, prompt.uuid]),
	);
	const savedReceivers = new Map(
		prompts.flatMap(({ cursor, canonicalReceiver }) =>
			canonicalReceiver === undefined
				? []
				: [[cursor.pointer, canonicalReceiver] as const],
		),
	);
	let firstField: string | undefined;
	for (const [index, prompt] of promptsA.entries()) {
		let projected = promptsB[index] as JsonObject;
		const field = mod.caseListConfig?.searchInputs.find(
			(entry) => entry.uuid === uuidAt.get(prompt.pointer),
		);
		const ours = objectMembers(projected.validations) ?? [];
		const stored = objectMembers(prompt.one.validations) ?? [];
		if (
			field &&
			(field.kind === "hidden" || field.validation === undefined) &&
			ours.length === 1
		) {
			const check = ours[0];
			if (stored.length === 0) {
				addedGuards?.add(prompt.pointer);
				projected = { ...projected, validations: [] };
			} else if (
				check &&
				stored.length === 1 &&
				typeof check.test === "string" &&
				typeof stored[0]?.test === "string"
			) {
				const before = readFormSyntax(stored[0].test);
				const after = readFormSyntax(check.test);
				if (before.ok && before.node && after.ok && after.node) {
					const oldClauses = clauses(before.node, "and");
					const newClauses = clauses(after.node, "and");
					if (
						oldClauses.length < newClauses.length &&
						oldClauses.every((old) =>
							newClauses.some((next) => sameSyntax(old, next)),
						)
					) {
						// The field already carries part of the proven runtime guard. A new
						// use of its answer adds the remaining clauses at first publish.
						addedGuards?.add(prompt.pointer);
						projected = {
							...projected,
							validations: [{ ...check, test: stored[0].test }],
						};
					}
				}
			}
		}
		if (
			field &&
			stored.length === 1 &&
			ours.length === 1 &&
			stored[0] &&
			ours[0] &&
			redundantQuoteCheck(field, stored[0].test, ours[0].test)
		) {
			addedGuards?.add(prompt.pointer);
			projected = {
				...projected,
				validations: [{ ...ours[0], test: stored[0].test }],
			};
		}
		const savedReceiver = savedReceivers.get(prompt.pointer);
		const key =
			savedReceiver !== undefined &&
			projected.receiver_expression !== savedReceiver
				? "schema:CaseSearchProperty.receiver_expression"
				: promptDifference(
						codes,
						source,
						prompt.one,
						projected,
						validationTexts.get(prompt.pointer),
					);
		fields?.set(prompt.pointer, key);
		if (key !== undefined && fields === undefined) return key;
		firstField ??= key;
	}
	if (firstField !== undefined) return firstField;
	if (
		(stored.peek("include_all_related_cases") === true) !==
		(ours.include_all_related_cases === true)
	)
		return "schema:CaseSearch.include_all_related_cases";
	return undefined;
}

/**
 * For each of `prompts`, where the stored test of its first validation is Nova's runtime guard, or
 * ends with it as its last top-level conjuncts, the field's own rule before it: the guard is the
 * one the projection joins to the field's check (`searchPrompts.ts::buildValidation`), printed by
 * the production projection of `mod` with the fields holding no check of their own, compared
 * conjunct by conjunct as parsed trees. `rule` is the source's text of the conjuncts before the
 * guard, where one node of the stored test holds them all (`a and b and G`, `(a or b) and G`); it
 * is absent where the guard is the whole test, or where the guard's conjuncts and the rule's share
 * a group (`a and (b and G)`), whose rule no text of the source spells alone. Undefined where the
 * test does not end with the guard. A field's check prints into its own property alone, so the
 * menu is printed once for every field asked, with all of their checks taken off. The guard reads
 * the menu's rows, so it is asked once they are placed.
 */
export function runtimeGuardEndings(
	ctx: ReadContext,
	doc: BlueprintDoc,
	mod: Module,
	prompts: readonly PromptReading[],
): ReadonlyMap<
	PromptReading,
	| {
			readonly rule?: string;
			readonly whole: boolean;
			readonly message: SearchRuntimeValidationMessage;
	  }
	| undefined
> {
	const endings = new Map<
		PromptReading,
		| {
				readonly rule?: string;
				readonly whole: boolean;
				readonly message: SearchRuntimeValidationMessage;
		  }
		| undefined
	>();
	const asked = prompts.flatMap((prompt) => {
		const validations = prompt.cursor.peek("validations");
		const first = Array.isArray(validations) ? validations[0] : undefined;
		const stored = isJsonObject(first) ? first.test : undefined;
		return typeof stored === "string" ? [{ prompt, stored }] : [];
	});
	if (asked.length === 0) return endings;
	const uuids = new Set(asked.map(({ prompt }) => prompt.uuid));
	const unchecked = withCandidate(doc, (draft) => {
		for (const one of draft.modules[mod.uuid]?.caseListConfig?.searchInputs ??
			[])
			if (uuids.has(one.uuid) && one.kind !== "hidden") delete one.validation;
	});
	const without = unchecked.modules[mod.uuid];
	if (without === undefined) return endings;
	const inputs = readProjectionInputs(ctx);
	let properties: readonly unknown[];
	try {
		const ours = printed(
			projectCaseListForHq(
				without,
				{ ...unchecked, localization: undefined },
				inputs.assets,
				inputs.lookupNaming,
			).searchConfig,
		) as JsonObject;
		properties = Array.isArray(ours.properties) ? ours.properties : [];
	} catch (error) {
		rethrowWorkStop(error);
		return endings;
	}
	for (const { prompt, stored } of asked) {
		const property = properties.find(
			(one) => isJsonObject(one) && one.name === prompt.name,
		);
		const printedChecks = isJsonObject(property)
			? property.validations
			: undefined;
		const check = Array.isArray(printedChecks) ? printedChecks[0] : undefined;
		const guard = isJsonObject(check) ? check.test : undefined;
		const texts =
			isJsonObject(check) && isJsonObject(check.text) ? check.text : undefined;
		const message = SEARCH_RUNTIME_VALIDATION_MESSAGES.find(
			(one) => one.message === texts?.en,
		);
		const ending =
			typeof guard === "string" ? guardEnding(stored, guard) : undefined;
		if (ending && message) endings.set(prompt, { ...ending, message });
	}
	return endings;
}

/** Where `stored` ends with `guard` as its last top-level conjuncts, the rule before it (see
 *  `runtimeGuardEndings`); undefined where it does not. */
function guardEnding(
	stored: string,
	guard: string,
): { readonly rule?: string; readonly whole: boolean } | undefined {
	const storedSyntax = readFormSyntax(stored);
	const guardSyntax = readFormSyntax(guard);
	if (
		!storedSyntax.ok ||
		!guardSyntax.ok ||
		storedSyntax.node === undefined ||
		guardSyntax.node === undefined
	)
		return undefined;
	const storedClauses = clauses(storedSyntax.node, "and");
	const guardClauses = clauses(guardSyntax.node, "and");
	const offset = storedClauses.length - guardClauses.length;
	const ends =
		offset >= 0 &&
		guardClauses.every((clause, at) => {
			const one = storedClauses[offset + at];
			return one !== undefined && sameSyntax(one, clause);
		});
	if (!ends) return undefined;
	if (offset === 0) return { whole: true };
	const rule = leadingClauses(storedSyntax.node, guardClauses.length);
	return rule === undefined
		? { whole: false }
		: { whole: false, rule: stored.slice(rule.from, rule.to) };
}

/** The node of `node`'s `and` chain that holds every conjunct but the last `count`, where one
 *  does: the chain is read as written, so a group that holds conjuncts from both sides has none. */
function leadingClauses(
	node: FormSyntax,
	count: number,
): FormSyntax | undefined {
	if (count === 0) return node;
	const at = core(node);
	if (at.kind !== "binary" || at.op !== "and") return undefined;
	const right = clauses(at.right, "and").length;
	return right > count ? undefined : leadingClauses(at.left, count - right);
}

function topLevel(expression: Expression): Expression[] {
	return expression.kind === "and" ? [...expression.clauses] : [expression];
}

/** The variants of one validation rule, by their place in `RULE_VARIANTS`: as read, without its
 *  last top-level conjunct, without its first (the runtime guard Nova conjoins is one of those
 *  two, where the rule has two or more), and no rule at all, where the stored check is Nova's
 *  guard alone. A variant a rule has none of is undefined. */
function ruleVariants(
	rule: Expression,
): readonly ({ readonly rule: Expression | undefined } | undefined)[] {
	const clauses = topLevel(rule);
	const without = (drop: number): Expression => {
		const rest = clauses.filter((_, index) => index !== drop);
		return rest.length === 1
			? (rest[0] as Expression)
			: { kind: "and", clauses: rest as [Expression, ...Expression[]] };
	};
	return [
		{ rule },
		clauses.length < 2 ? undefined : { rule: without(clauses.length - 1) },
		clauses.length < 2 ? undefined : { rule: without(0) },
		{ rule: undefined },
	];
}

/** The four places of a rule's variants, in the order a field's are tried. */
const RULE_VARIANTS = [0, 1, 2, 3] as const;

/**
 * The whole menu's search accepted: the projection's `search_config` equal to the stored one,
 * each Search field's validation rule chosen on that field's own evidence. A field's rule prints
 * into that field's property alone, so the search is printed once a variant, each variant of
 * `ruleVariants` applied to every field at once, and each field takes the first variant whose
 * property prints as the stored one (the rule as read where none does). The document of those
 * choices is then compared whole, once: where it agrees it is the reading, kept in `ctx.doc`;
 * where it does not, the difference reported is that of the rules as read. So the work is at
 * most five projections of the menu whatever the number of fields, and a reading that held its
 * fields' choices only together would be the comparison's finding, never a wrong reading.
 */
export function settleSearchSettings(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
	prompts: readonly PromptReading[],
): void {
	const place = searchPlace(module);
	const original = ctx.doc;
	if (original === undefined || original.modules[module.uuid] === undefined)
		return;
	const list = original.modules[module.uuid]?.caseListConfig;
	const storedIncludes = cursor.peek("include_all_related_cases") === true;
	const derivedIncludes =
		list !== undefined &&
		includeSearchHierarchy(
			list,
			moduleExpressionContexts(original, module.uuid),
		);
	let start = original;
	if (storedIncludes === derivedIncludes) {
		cursor.derived("include_all_related_cases", T.includeDerived);
	} else {
		const claim = storedIncludes ? T.includeAuthored : T.includeFalse;
		cursor.take("include_all_related_cases", claim, Boolean).value;
		start = withCandidate(original, (draft) => {
			const menu = draft.modules[module.uuid];
			menu.caseSearchConfig ??= {};
			const settings = menu.caseSearchConfig;
			if ("searchActionEnabled" in settings) return;
			settings.relatedRecords = storedIncludes ? "hierarchy" : "details";
		});
	}
	const ruled = prompts.flatMap((prompt) => {
		const entry = start.modules[module.uuid]?.caseListConfig?.searchInputs.find(
			(one) => one.uuid === prompt.uuid,
		);
		return prompt.validationRule === undefined ||
			entry === undefined ||
			entry.kind === "hidden" ||
			entry.validation === undefined
			? []
			: [{ prompt, variants: ruleVariants(entry.validation.rule) }];
	});
	/** `doc` with each field's rule at the variant `variantOf` names, where it names one. */
	const withRules = (
		doc: BlueprintDoc,
		variantOf: (field: (typeof ruled)[number]) => number | undefined,
	): BlueprintDoc => {
		const changes = ruled.flatMap((field) => {
			const at = variantOf(field);
			const variant = at === undefined ? undefined : field.variants[at];
			return at === undefined || at === 0 || variant === undefined
				? []
				: [{ uuid: field.prompt.uuid, rule: variant.rule }];
		});
		if (changes.length === 0) return doc;
		return withCandidate(doc, (draft) => {
			const inputs = draft.modules[module.uuid]?.caseListConfig?.searchInputs;
			for (const change of changes) {
				const one = inputs?.find((input) => input.uuid === change.uuid);
				if (
					one === undefined ||
					one.kind === "hidden" ||
					one.validation === undefined
				)
					continue;
				if (change.rule === undefined) delete one.validation;
				else one.validation.rule = change.rule as never;
			}
		});
	};
	const compared = (
		doc: BlueprintDoc,
		fields?: Map<string, string | undefined>,
		addedGuards?: Set<string>,
	): string | undefined => {
		try {
			return searchDifference(
				ctx,
				doc,
				doc.modules[module.uuid] as Module,
				cursor,
				prompts,
				fields,
				addedGuards,
			);
		} catch (error) {
			rethrowWorkStop(error);
			return EMITTER_THREW;
		}
	};
	const keep = (candidate: BlueprintDoc, addedGuards: ReadonlySet<string>) => {
		ctx.doc = candidate;
		for (const pointer of addedGuards) {
			const path = `${pointer}/validations`;
			if (
				!ctx.facts.rewrites.some(
					(row) => row.id === "search-value-guards" && row.pointer === path,
				)
			)
				ctx.facts.rewrites.push({
					id: "search-value-guards",
					place,
					key: "schema:CaseSearchProperty.validations",
					pointer: path,
				});
		}
	};
	const chosen = new Map<string, number>();
	let asRead: string | undefined;
	for (const variant of RULE_VARIANTS) {
		const open = ruled.filter(
			(field) =>
				!chosen.has(field.prompt.uuid) && field.variants[variant] !== undefined,
		);
		if (variant > 0 && open.length === 0) continue;
		const fields = new Map<string, string | undefined>();
		const addedGuards = new Set<string>();
		const difference = compared(
			withRules(start, () => variant),
			fields,
			addedGuards,
		);
		if (variant === 0) {
			asRead = difference;
			if (difference === undefined) {
				keep(start, addedGuards);
				return;
			}
		}
		for (const field of open)
			if (
				fields.has(field.prompt.cursor.pointer) &&
				fields.get(field.prompt.cursor.pointer) === undefined
			)
				chosen.set(field.prompt.uuid, variant);
	}
	const settled = withRules(start, (field) => chosen.get(field.prompt.uuid));
	const addedGuards = new Set<string>();
	if (
		settled !== start &&
		compared(settled, undefined, addedGuards) === undefined
	) {
		keep(settled, addedGuards);
		return;
	}
	const first = asRead;
	if (first === EMITTER_THREW)
		ctx.accounting.defect(
			place,
			"schema:Module.search_config",
			readerDefect.emissionThrew(place, "projectCaseListForHq"),
		);
	else if (first !== undefined && !ctx.accounting.hasFindingAt(place)) {
		const guarded = checksWithoutMessageTheSearchGuards(
			start,
			module.uuid,
			prompts,
		);
		if (guarded.length === 0)
			ctx.accounting.circumstance("unrecognized", place, { name: first });
		for (const prompt of guarded) {
			const input = list?.searchInputs.find((one) => one.uuid === prompt.uuid);
			const rule =
				input?.kind === "simple" &&
				input.type === "text" &&
				input.property === "case_name"
					? input.validation?.rule
					: undefined;
			const admitsBothQuotes =
				rule?.kind === "matches-pattern" &&
				rule.left.kind === "term" &&
				rule.left.term.kind === "input" &&
				(rule.pattern === "^.+$" ||
					(rule.pattern === "^[a-z]+$" &&
						rule.left.term.searchInputUuid !== prompt.uuid));
			ctx.accounting.findingAt(
				admitsBothQuotes
					? T.nameCheckAllowsBothQuotes
					: T.checkWithoutMessageGuarded,
				place,
				`${prompt.cursor.pointer}/validations`,
				{ name: prompt.name },
			);
		}
	}
}

/**
 * A native check with no message can share the runtime sentence when its
 * authored rule and existing guard project to the same native test. This
 * names the remaining checked shapes whose projected test cannot match.
 */
function checksWithoutMessageTheSearchGuards(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	prompts: readonly PromptReading[],
): readonly PromptReading[] {
	const inputs = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
	const messageless = prompts.filter((prompt) => {
		const input = inputs.find((one) => one.uuid === prompt.uuid);
		return (
			input !== undefined &&
			input.kind !== "hidden" &&
			input.validation !== undefined &&
			input.validation.message === undefined
		);
	});
	if (messageless.length === 0) return [];
	let guarded: ReadonlySet<string>;
	try {
		guarded = searchGuardedFieldNames(doc, moduleUuid);
	} catch (error) {
		rethrowWorkStop(error);
		return [];
	}
	return messageless.filter((prompt) => guarded.has(prompt.name));
}

/**
 * The reader's canonical choice `empty-search-settings-beside-fields-are-absent`: a menu with
 * Search fields searches with Nova's own settings whether it holds a settings object that sets
 * nothing or none at all (`effectiveCaseSearchConfig` gives `{}` for both), so both print one
 * `search_config`, and the reader returns no settings object. It reads what
 * `default-search-title-is-absent` leaves, which may empty a settings object.
 */
export function emptySearchSettingsBesideFieldsAreAbsent(
	doc: BlueprintDoc,
): BlueprintDoc {
	const empty = doc.moduleOrder.filter((uuid) => {
		const mod = doc.modules[uuid];
		const config = mod?.caseSearchConfig;
		return (
			config !== undefined &&
			(mod?.caseListConfig?.searchInputs.length ?? 0) > 0 &&
			Object.values(config).every((value) => value === undefined)
		);
	});
	if (empty.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const uuid of empty) {
			const mod = draft.modules[uuid];
			if (mod !== undefined) delete mod.caseSearchConfig;
		}
	});
}

/**
 * The reader's canonical choice `default-search-title-is-absent`: a search whose title is "Search"
 * (`DEFAULT_CASE_SEARCH_TITLE`) prints what a search with no title of its own prints, its title
 * unit's source and every translation of it alike, and the reader returns no title.
 */
export function defaultSearchTitleIsAbsent(doc: BlueprintDoc): BlueprintDoc {
	const titled = doc.moduleOrder.filter((uuid) => {
		const config = doc.modules[uuid]?.caseSearchConfig;
		return (
			config !== undefined &&
			"searchScreenTitle" in config &&
			config.searchScreenTitle === DEFAULT_CASE_SEARCH_TITLE
		);
	});
	if (titled.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const uuid of titled) {
			const config = draft.modules[uuid]?.caseSearchConfig;
			if (config !== undefined && "searchScreenTitle" in config)
				delete config.searchScreenTitle;
		}
	});
}
