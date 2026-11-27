import { authoredBoundedFlatSelection } from "@/lib/domain/boundedFlatClose";
import { BOUNDED_FLAT_CLOSE_MAXIMUM } from "@/lib/domain/caseSelectionLimits";
import { bindCalculationText } from "./calculationText";
import { mappingIdentityAt } from "./mappingIdentity";
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
	type CaseListDeviceLookup,
	type CaseProperty,
	type Column,
	type ColumnSort,
	type ColumnVia,
	caseListDeviceLookupSchema,
	caseListWordingUnitId,
	casePropertyOptionTranslationUnitId,
	columnFieldText,
	columnPropertyCaseType,
	orderedColumns,
	plainColumn,
	type TranslationUnitId,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { moduleCaseTypeForActions } from "@/lib/domain/basicCaseSlots";
import { caseListOrderPlan } from "@/lib/domain/caseListOrder";
import {
	caseMappingComparison,
	caseMappingRowUuid,
	caseMappingTextUnit,
} from "@/lib/domain/caseMappingRows";
import {
	type CaseRelation,
	CaseRelationCatalog,
} from "@/lib/domain/caseRelations";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	CASE_LIST_LOOKUP_WORKER_FIELDS,
	caseListColumnTextShows,
	caseListLookupResultPropertySchema,
	columnSortLabelShows,
	type DeviceLookupExtra,
} from "@/lib/domain/modules";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { recordFromEntries } from "@/lib/domain/records";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { sharedSources } from "../../hq/suiteDetailSources";
import { emptyShortListColumns } from "../../hqJson/caseList";
import { hqXPath, hqXPathText } from "../../hqJson/xpath";
import {
	isLookupEvaluateExtrasControl,
	lookupCaseKeyWire,
} from "../../suite/case-list/deviceLookup";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import type { FormSyntax } from "../../xpath/formSyntax";
import { scannedInstances } from "../../xpath/instanceSources";
import { sessionContextPath } from "../../xpath/wire/fromExpression";
import { applicationReading } from "../appShell";
import { withCandidate } from "../candidate";
import { indexTarget } from "../caseManagement/basicActions";
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
import { detailSourceSpans } from "../fixtureRows";
import {
	hqDeviceText,
	keyDefinedAfterLineEnd,
	LINE_END_DEFINES_KEY,
	pythonBlank,
	recordTextRewrite,
} from "../heldText";
import { type ExternalKey, externalKey, externalKeyText } from "../identity";
import { reReadUuidOf } from "../identityMap";
import {
	isJsonObject,
	type JsonCursor,
	objectMembers,
	sameJson,
} from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { listFilterWithoutOwnerClause } from "../search/settings";
import { sourceFactories } from "../sourceFactories";
import { recordSyntaxKey, sameXPathText } from "../syntaxCompare";
import { sharedFormSyntax } from "../syntaxRead";
import type { SameStateRegister } from "../types";
import { readMediaMap } from "../xform/media";
import { storedColumnKind } from "./columnIdentity";
import {
	appCodes,
	type ColumnOptions,
	type ColumnProposal,
	type ColumnReading,
	type HeldTexts,
	heldTextsIn,
	noteRespelled,
	readDetailColumn,
	refuseUnheldKey,
	type SelectProperty,
	shownTexts,
	sourceCode,
	sourceText,
	translatedTexts,
} from "./columns";
import { literalText } from "./literalText";
import { CALCULATED_FIELD, readSortElements, type SortReading } from "./order";
import { claimRestUnderFinding } from "./refusedWhole";
import {
	readTile,
	type TileReading,
	widthZeroTileValueShowsInWebApps,
} from "./tile";

const A = "menus-and-case-lists/";

export const DETAIL_CLAIMS = defineClaims("caseList.details", {
	pairShared: take(
		`${A}detail-columns-short`,
		"schema:ShadowModule.case_details",
	),
	pairModule: take(`${A}detail-columns-short`, "schema:Module.case_details"),
	pairAdvanced: take(
		`${A}detail-columns-short`,
		"schema:AdvancedModule.case_details",
	),
	short: take(`${A}detail-columns-short`, "schema:DetailPair.short"),
	long: take(`${A}detail-columns-long`, "schema:DetailPair.long"),
	shortColumns: take(`${A}detail-columns-short`, "schema:Detail.columns"),
	longColumns: take(`${A}detail-columns-long`, "schema:Detail.columns"),
	/** A long detail holding no column, HQ's own default: no case detail screen of its own. */
	longColumnsEmpty: take(`${A}long-columns-empty`, "schema:Detail.columns"),
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
	maxSelectFlatClose: take(
		`${A}detail-max-select-value-for-flat-close`,
		"schema:Detail.max_select_value",
	),
	maxSelectFlatFollowup: take(
		`${A}detail-max-select-value-for-flat-followup`,
		"schema:Detail.max_select_value",
	),
	maxSelect101Elsewhere: refuse(
		`${A}detail-max-select-value-101-outside-flat-close`,
		"schema:Detail.max_select_value",
	),
	maxSelectAbove: refuse(
		`${A}detail-max-select-value-above-100`,
		"schema:Detail.max_select_value",
	),
	maxSelectOutsideRuntime: refuse(
		`${A}detail-max-select-value-above-2147483647`,
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
	autoSelectMulti: take(
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
	persistentFromModule: take(
		`${A}detail-persistent-case-tile-from-module`,
		"schema:Detail.persistent_case_tile_from_module",
	),
	pullDown: take(`${A}detail-pull-down-tile`, "schema:Detail.pull_down_tile"),
	persistForPullDown: take(
		`${A}detail-persistent-case-tile-from-module`,
		"schema:Detail.persist_tile_on_forms",
	),
	persistContext: take(
		`${A}detail-persist-case-context-persistent-case-context-xml`,
		"schema:Detail.persist_case_context",
	),
	persistContextXml: take(
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
	contextUnavailable: refuse(
		`${A}form-context-without-a-compatible-case-tile`,
		"schema:Detail.persistent_case_tile_from_module",
	),
	inlineUnavailable: refuse(
		`${A}form-context-without-a-compatible-case-tile`,
		"schema:Detail.pull_down_tile",
	),
	competingContext: refuse(
		`${A}two-different-values-for-the-same-form-context`,
		"schema:Detail.persist_case_context",
	),
	competingContextValue: refuse(
		`${A}two-different-values-for-the-same-form-context`,
		"schema:Detail.persistent_case_context_xml",
	),
	dormantMenu: drop(
		`${A}existing-form-context-source-with-no-tile`,
		"schema:Detail.persistent_case_tile_from_module",
	),
	contextUnused: drop(
		`${A}form-context-setting-outside-a-case-selection`,
		"schema:Detail.persist_case_context",
	),
	contextXmlUnused: drop(
		`${A}form-context-setting-outside-a-case-selection`,
		"schema:Detail.persistent_case_context_xml",
	),
	contextMenuUnused: drop(
		`${A}form-context-setting-outside-a-case-selection`,
		"schema:Detail.persistent_case_tile_from_module",
	),
	contextInlineUnused: drop(
		`${A}form-context-setting-outside-a-case-selection`,
		"schema:Detail.pull_down_tile",
	),
	persistContextFalse: drop(
		`${A}detail-persistence-switches-false`,
		"schema:Detail.persist_case_context",
	),
	persistTileFalse: drop(
		`${A}detail-persistence-switches-false`,
		"schema:Detail.persist_tile_on_forms",
	),
	pullDownFalse: drop(
		`${A}detail-persistence-switches-false`,
		"schema:Detail.pull_down_tile",
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
	noItemsOther: take(
		`${A}detail-no-items-text-other-than-hq-s-default-en-list-is-empty`,
		"schema:Detail.no_items_text",
	),
	selectDefault: drop(
		`${A}detail-select-text-default-en-continue`,
		"schema:Detail.select_text",
	),
	selectOther: take(
		`${A}detail-select-text-non-default`,
		"schema:Detail.select_text",
	),
	textsUnread: drop(
		`${A}detail-texts-no-worker-reads`,
		"schema:Detail.no_items_text",
	),
	selectTextUnread: drop(
		`${A}detail-texts-no-worker-reads`,
		"schema:Detail.select_text",
	),
	ownerClauseFilter: derived(
		`${A}detail-filter-value-lifts-into-predicate`,
		"schema:Detail.filter",
	),
	tabs: take(`${A}plain-tab-header-starting-index`, "schema:Detail.tabs"),
	tabTitle: take(
		`${A}plain-tab-header-starting-index`,
		"schema:DetailTab.header",
	),
	tabPosition: take(
		`${A}plain-tab-header-starting-index`,
		"schema:DetailTab.starting_index",
	),
	// `isTab` is the Case Detail page's state, no field of HQ's schema, so the
	// claim stands on the tab itself.
	tabEditorFlag: derived(`${A}a-stored-tab-without-istab`, "schema:DetailTab"),
	tabChildEnabled: take(
		`${A}data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`,
		"schema:DetailTab.has_nodeset",
	),
	tabChildType: take(
		`${A}data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`,
		"schema:DetailTab.nodeset_case_type",
	),
	tabRecordsEnabled: take(
		`${A}data-tab-over-a-custom-nodeset-xpath`,
		"schema:DetailTab.has_nodeset",
	),
	tabRowsMissing: refuse(
		`${A}detail-tab-without-a-resolvable-row-source`,
		"schema:DetailTab.has_nodeset",
	),
	tabRowsInert: drop(
		`${A}inactive-detail-tab-row-settings`,
		"schema:DetailTab.nodeset",
	),
	tabSearchChildren: take(
		`${A}related-child-type-beside-an-explicit-tab-collection`,
		"schema:DetailTab.nodeset_case_type",
	),
	tabChildTypeNotAdded: refuse(
		`${A}detail-tab-child-type-no-form-of-its-menu-s-case-type-adds`,
		"schema:DetailTab.nodeset_case_type",
	),
	tabTypeInvalid: refuse(
		`${A}detail-tab-without-a-resolvable-row-source`,
		"schema:DetailTab.nodeset_case_type",
	),
	tabTypeInert: drop(
		`${A}inactive-detail-tab-row-settings`,
		"schema:DetailTab.nodeset_case_type",
	),
	tabFilterInert: drop(
		`${A}inactive-detail-tab-row-settings`,
		"schema:DetailTab.nodeset_filter",
	),
	tabsColumnsAbove: refuse(
		`${A}columns-above-the-first-tab-when-tabs-exist`,
		"schema:Detail.tabs",
	),
	tabsTileRowMixed: refuse(
		`${A}a-custom-long-tile-row-mixing-fields-of-two-tabs-in-a-basic-or`,
		"schema:DetailTab.starting_index",
	),
	tabsTileRowMixedTabs: refuse(
		`${A}a-custom-long-tile-row-mixing-fields-of-two-tabs-in-a-basic-or`,
		"schema:Detail.tabs",
	),
	tabsTileRowMixedAdvanced: take(
		`${A}a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced`,
		"schema:DetailTab.starting_index",
	),
	lookupRelativeExtra: refuse(
		`${A}lookup-extra-relative-without-case-context`,
		"schema:Detail.lookup_extras",
	),
	lookupMissingResultHeader: refuse(
		`${A}lookup-case-id-result-without-a-header-map`,
		"schema:Detail.lookup_display_results",
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
	tabUndeclared: refuse(
		`${A}any-other-undeclared-key`,
		"schema:DetailTab.<undeclared>",
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
	recordFromEntries(
		LOOKUP_KEYS.map((key) => [
			key,
			drop(`${A}lookup-enabled-false-with-stale-keys`, `schema:Detail.${key}`),
		]),
	) as Record<string, Claim<"drop">>,
);

/** The switch and every key of a callout. */
const CALLOUT_KEYS = ["lookup_enabled", ...LOOKUP_KEYS];

/** A callout on the case list, refused as one: its switch and its action, the two keys the
 *  callout's own entry names. */
const LOOKUP_ON_KEYS = defineClaims("caseList.details.lookupOn", {
	lookup_enabled: refuse(
		`${A}lookup-enabled-lookup-action`,
		"schema:Detail.lookup_enabled",
	),
	lookup_action: refuse(
		`${A}lookup-enabled-lookup-action`,
		"schema:Detail.lookup_action",
	),
});

const LOOKUP_EVALUATED_EXTRAS = defineClaims(
	"caseList.details.evaluatedLookup",
	{
		extras: take(
			`${A}lookup-extras-explicit-evaluation`,
			"schema:Detail.lookup_extras",
		),
	},
);

const LOOKUP_WITH_INTEGER_SUM = defineClaims(
	"caseList.details.integerSumLookup",
	{
		extras: take(
			`${A}lookup-extra-with-a-fixed-integer-sum`,
			"schema:Detail.lookup_extras",
		),
	},
);

const TEXT_LOOKUP_FIELD_ENTRIES = new Map<string, string>([
	["lookup_name", "lookup-name"],
	["lookup_autolaunch", "lookup-autolaunch"],
	["lookup_responses", "lookup-responses-key"],
	["lookup_extras", "lookup-extras-fixed-text"],
	["lookup_image", "lookup-image-jr"],
]);

const TEXT_LOOKUP_KEYS = defineClaims(
	"caseList.details.textLookup",
	recordFromEntries(
		CALLOUT_KEYS.map((key) => [
			key,
			take(
				`${A}${TEXT_LOOKUP_FIELD_ENTRIES.get(key) ?? "lookup-with-text-extras"}`,
				`schema:Detail.${key}`,
			),
		]),
	) as Record<string, Claim<"take">>,
);

const LOOKUP_WITH_WORKER_EXTRA = defineClaims("caseList.details.workerLookup", {
	extras: take(
		`${A}lookup-extras-worker-context`,
		"schema:Detail.lookup_extras",
	),
});

/** Android evaluates the extra when it creates the list's click listener.
 * A relative child path needs a main instance, which the list session
 * has not got. Keep more complex expressions under the general refusal. */
function lookupHasPlainRelativeExtra(extras: unknown[]): boolean {
	return (
		!extras.some(
			(extra) => isJsonObject(extra) && extra.key === "force_xpath_parsing",
		) &&
		extras.some((extra) => {
			if (
				!isJsonObject(extra) ||
				typeof extra.key !== "string" ||
				typeof extra.value !== "string"
			)
				return false;
			const parsed = sharedFormSyntax(extra.value);
			if (!parsed.ok || parsed.node === undefined) return false;
			const node = parsed.node;
			if (node.kind === "name") return !node.wildcard;
			return (
				node.kind === "child" &&
				!node.descendant &&
				node.left?.kind === "name" &&
				!node.left.wildcard &&
				node.step.kind === "name" &&
				!node.step.wildcard &&
				extra.value.trim() === `${node.left.name}/${node.step.name}`
			);
		})
	);
}

const workerExtraText = CASE_LIST_LOOKUP_WORKER_FIELDS.map((field) => ({
	field,
	text: hqXPathText(hqXPath(sessionContextPath(field))),
}));

const LOOKUP_CONFIDENCE_KEYS = defineClaims(
	"caseList.details.lookupConfidence",
	{
		lookup_display_results: take(
			`${A}lookup-case-id-confidence`,
			"schema:Detail.lookup_display_results",
		),
		lookup_field_header: take(
			`${A}lookup-case-id-confidence`,
			"schema:Detail.lookup_field_header",
		),
		lookup_field_template: take(
			`${A}lookup-case-id-confidence`,
			"schema:Detail.lookup_field_template",
		),
	},
);
const LOOKUP_PROPERTY_CONFIDENCE_KEYS = defineClaims(
	"caseList.details.lookupPropertyConfidence",
	{
		lookup_display_results: take(
			`${A}lookup-case-property-confidence`,
			"schema:Detail.lookup_display_results",
		),
		lookup_field_header: take(
			`${A}lookup-case-property-confidence`,
			"schema:Detail.lookup_field_header",
		),
		lookup_field_template: take(
			`${A}lookup-case-property-confidence`,
			"schema:Detail.lookup_field_template",
		),
	},
);
const lookupCaseKey = hqXPathText(hqXPath(lookupCaseKeyWire()));

/** The installed case list can send this calculation as a number's text or
 * as the exact saved spelling. Count only the canonical two-literal sum. */
function nativeLookupIntegerSum(
	source: string,
	node: FormSyntax | undefined,
): [number, number] | undefined {
	if (
		node?.kind === "binary" &&
		node.op === "+" &&
		node.left.kind === "number" &&
		node.right.kind === "number" &&
		Number.isInteger(node.left.value) &&
		Number.isInteger(node.right.value) &&
		node.left.value >= 0 &&
		node.right.value >= 0 &&
		node.left.value + node.right.value <= 2_147_483_647 &&
		source === `${node.left.value} + ${node.right.value}`
	)
		return [node.left.value, node.right.value];
	return undefined;
}

type LookupRead = { lookup: CaseListDeviceLookup; heading?: HeldTexts };

function textDeviceLookup(
	ctx: ReadContext,
	module: DraftModule,
	detail: JsonCursor,
): LookupRead | undefined {
	const image = detail.peek("lookup_image");
	const results = detail.peek("lookup_display_results");
	const automatic = detail.peek("lookup_autolaunch");
	const action = detail.peek("lookup_action");
	const label = detail.peek("lookup_name");
	const rawExtras = detail.peek("lookup_extras");
	const rawResponses = detail.peek("lookup_responses");
	if (
		(image !== undefined && image !== null && typeof image !== "string") ||
		(results !== undefined &&
			results !== null &&
			typeof results !== "boolean") ||
		(automatic !== undefined &&
			automatic !== null &&
			typeof automatic !== "boolean") ||
		typeof action !== "string" ||
		action.trim() !== action ||
		typeof label !== "string" ||
		label.trim() !== label ||
		!Array.isArray(rawExtras) ||
		!Array.isArray(rawResponses)
	)
		return undefined;
	const evaluateExtras = isLookupEvaluateExtrasControl(rawExtras.at(-1));
	const argumentRows = evaluateExtras ? rawExtras.slice(0, -1) : rawExtras;
	const extras: DeviceLookupExtra[] = [];
	for (const entry of argumentRows) {
		if (
			!isJsonObject(entry) ||
			Object.keys(entry).length !== 2 ||
			typeof entry.key !== "string" ||
			entry.key.trim() !== entry.key ||
			entry.key === "force_xpath_parsing" ||
			typeof entry.value !== "string"
		)
			return undefined;
		const source = entry.value;
		const parsed = sharedFormSyntax(source);
		const value = parsed.ok ? literalText(parsed.node) : undefined;
		if (value !== undefined) {
			extras.push({ name: entry.key, value });
			continue;
		}
		const sum = parsed.ok
			? nativeLookupIntegerSum(source, parsed.node)
			: undefined;
		if (sum !== undefined) {
			const [left, right] = sum;
			extras.push({
				name: entry.key,
				expression: {
					kind: "arith",
					op: "+",
					left: { kind: "term", term: { kind: "literal", value: left } },
					right: { kind: "term", term: { kind: "literal", value: right } },
				},
			});
			continue;
		}
		const field = workerExtraText.find(({ text }) =>
			sameXPathText(source, text),
		)?.field;
		if (field === undefined) return undefined;
		extras.push({
			name: entry.key,
			expression: { kind: "term", term: { kind: "session-context", field } },
		});
	}
	const responses = [];
	for (const entry of rawResponses) {
		if (
			!isJsonObject(entry) ||
			Object.keys(entry).length !== 1 ||
			typeof entry.key !== "string" ||
			entry.key.trim() !== entry.key
		)
			return undefined;
		responses.push(entry.key);
	}
	let heading: HeldTexts | undefined;
	let resultProperty: string | undefined;
	if (results === true) {
		const template = detail.peek("lookup_field_template");
		if (detail.peek("case_tile_template") || typeof template !== "string")
			return undefined;
		if (!sameXPathText(template, lookupCaseKey)) {
			const parsed = sharedFormSyntax(template);
			let node = parsed.ok ? parsed.node : undefined;
			while (node?.kind === "group") node = node.value;
			if (node?.kind === "axis" && node.axis === "child") node = node.value;
			const property = caseListLookupResultPropertySchema.safeParse(
				node?.kind === "name" && !node.wildcard ? node.name : undefined,
			);
			const search = module.json.peek("search_config");
			const additional = isJsonObject(search)
				? search.additional_case_types
				: undefined;
			if (
				!property.success ||
				module.module.caseType === undefined ||
				(Array.isArray(additional) &&
					additional.some((type) => type !== module.module.caseType))
			)
				return undefined;
			resultProperty = property.data;
		}
		heading = heldTextsIn(
			detail.peek("lookup_field_header"),
			appCodes(ctx),
			sourceCode(ctx),
			"case-list-lookup-result-heading",
		);
		if (heading === undefined) return undefined;
	}
	const value = caseListDeviceLookupSchema.safeParse({
		action,
		label,
		extras,
		responses,
		...(automatic === true && { automatic: true }),
		...(evaluateExtras && { evaluateExtras: true }),
		...(heading !== undefined && {
			resultHeading: sourceText(ctx, heading.texts),
		}),
		...(resultProperty !== undefined && { resultProperty }),
	});
	if (!value.success) return undefined;
	return { lookup: value.data, heading };
}

/** HQ writes an empty width-zero header for an empty map. Core requires a text child there. */
function lookupHasEmptyCaseIdResultHeader(detail: JsonCursor): boolean {
	const header = detail.peek("lookup_field_header");
	const template = detail.peek("lookup_field_template");
	return (
		!detail.peek("case_tile_template") &&
		detail.peek("lookup_display_results") === true &&
		isJsonObject(header) &&
		Object.keys(header).length === 0 &&
		typeof template === "string" &&
		sameXPathText(template, lookupCaseKey)
	);
}

const LOOKUP_LONG_KEYS = defineClaims(
	"caseList.details.lookupLong",
	recordFromEntries(
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
	recordFromEntries(
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
	/** A column only the long detail holds that a sort element puts on the list, as a field
	 *  of the short detail Nova writes (`order.ts::readSortElements`). */
	sortField?: true;
	/** The text HQ's build shows for the column in each language of Sort by, where its sort
	 *  element names it there: the `invisible` short column's header, or a sort-only element's
	 *  display (`order.ts::readSortElements`). */
	sortName?: Readonly<Record<string, string>>;
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
		recordFromEntries(
			Object.entries(proposal.column).filter(
				([key]) => key !== "header" && key !== "entryPointUuid",
			),
		);
	const restA = slots(a);
	const restB = slots(b);
	if (a.column.kind === "calculated" || b.column.kind === "calculated") {
		if (
			!sameJson(restA, restB) ||
			!sameJson(a.textKeys ?? [], b.textKeys ?? [])
		)
			return false;
		const ta = a.expression?.text;
		const tb = b.expression?.text;
		if (ta === undefined || tb === undefined || !sameXPathText(ta, tb))
			return false;
	} else if (!sameJson(restA, restB)) return false;
	if ((a.conditions?.size ?? 0) !== (b.conditions?.size ?? 0)) return false;
	for (const [index, source] of a.conditions ?? []) {
		const twin = b.conditions?.get(index);
		if (!twin || !sameXPathText(source.text, twin.text)) return false;
	}
	return sameHeader(a, b) && sameJson(a.texts, b.texts);
}

/** Whether two proposals hold the same header text in every language. */
function sameHeader(a: ColumnProposal, b: ColumnProposal): boolean {
	const languages = new Set([
		...Object.keys(a.header),
		...Object.keys(b.header),
	]);
	for (const language of languages)
		if ((a.header[language] ?? "") !== (b.header[language] ?? "")) return false;
	return true;
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
		fieldTextOf(candidate) !== undefined &&
		fieldTextOf(candidate) === fieldTextOf(hidden)
	);
}

/** A proposal's field as HQ stores it: its walk's indices and its property, joined by `/`. */
function fieldTextOf(proposal: ColumnProposal): string | undefined {
	const body = proposal.column;
	return body.kind === "calculated" ? undefined : columnFieldText(body);
}

/** The detail field carries only index names. Preserve the native path, even
 * when several known target types or a historical row outside the app may
 * supply the value. A uniquely known custom destination keeps its existing
 * Nova type hint for callers that inspect that catalog identity. */
export function readColumnVia(
	ctx: ReadContext,
	caseType: string | undefined,
	steps: readonly string[],
): { readonly via: ColumnVia; readonly caseType?: string } | undefined {
	if (caseType === undefined || !steps.length) return undefined;
	const graph = new CaseRelationCatalog(ctx.draft.caseTypes ?? []);
	const via: ColumnVia[number][] = [];
	let current: string | undefined = caseType;
	for (const identifier of steps) {
		const edges: readonly CaseRelation[] =
			current === undefined ? [] : graph.edges(current, identifier);
		const names = new Set(edges.map((edge) => edge.targetType));
		const next: string | undefined =
			names.size === 1
				? [...names][0]
				: names.size === 0 && current !== undefined
					? indexTarget(ctx, current, identifier)
					: undefined;
		via.push(
			next !== undefined && identifier !== "parent"
				? { identifier, throughCaseType: next }
				: { identifier },
		);
		current = next;
	}
	const scope = graph.reached(caseType, via);
	const only =
		!scope.open && scope.types.length === 1 ? scope.types[0] : current;
	return {
		via: via as ColumnVia,
		...(only !== undefined && { caseType: only }),
	};
}

/**
 * The short and the long detail's columns as one set of columns. Each short column joins the
 * first long column not yet joined whose proposal is equal; an `invisible` short column joins the
 * first unjoined long column over its field that holds its header in every language, and takes
 * that column's proposal. A short column with no partner is hidden from the detail; a long column
 * with no partner is not on the list. An `invisible` column joins no column over its field with
 * another header: Nova writes a column hidden from Results and shown on Details with one header
 * on both screens (`hqJson/caseList.ts::projectColumnForShortDetail`), so one whose header no
 * such column holds is hidden from Details too, and a join would print its partner's header in
 * its place. An `invisible` column its sort element names in Sort by (`named`, by short index,
 * `sortNamedInvisibleColumns`) shows its header there and nowhere else, which Nova writes from
 * the rule's name and not the column's header, so it joins the first unjoined long column over
 * its field whatever that column's header, and its header is its name in Sort by (`sortName`).
 */
/**
 * The index of each stored short column HQ's build lists in Sort by under its own header: an
 * `invisible` column that the sort element landing on it gives display text. HQ keeps the last
 * element of each `field` (a positional `_cc_calculated_<n>` standing for column `n`'s field) and
 * lands it on the first column with that field (`util.py::get_sort_and_sort_only_columns`,
 * `suite_xml/sections/details.py::get_detail_column_infos`), and an `invisible` column's header is
 * written only where that element's display holds text Python does not read as blank
 * (`detail_screen.py::Invisible.header`, `models/case_list.py::SortElement.has_display_values`).
 */
export function sortNamedInvisibleColumns(
	columns: unknown,
	elements: unknown,
): ReadonlySet<number> {
	const stored = Array.isArray(columns) ? columns : [];
	const fieldOfColumn = (index: number): string | undefined => {
		const column = stored[index];
		return isJsonObject(column) && typeof column.field === "string"
			? column.field
			: undefined;
	};
	const lastByText = new Map<string, unknown>();
	for (const element of Array.isArray(elements) ? elements : []) {
		if (!isJsonObject(element) || typeof element.field !== "string") continue;
		const calculated = CALCULATED_FIELD.exec(element.field);
		const text =
			calculated === null
				? element.field
				: fieldOfColumn(Number(calculated[1]));
		if (text !== undefined) lastByText.set(text, element.display);
	}
	const named = new Set<number>();
	for (const [text, display] of lastByText) {
		if (!displayNames(display)) continue;
		const landing = stored.findIndex(
			(column) => isJsonObject(column) && column.field === text,
		);
		const column = stored[landing];
		if (isJsonObject(column) && column.format === "invisible")
			named.add(landing);
	}
	return named;
}

/** Whether a sort element's stored `display` names it in Sort by: some value is text Python does
 *  not read as blank (`models/case_list.py::SortElement.has_display_values`). */
export function displayNames(display: unknown): boolean {
	return (
		isJsonObject(display) &&
		Object.values(display).some(
			(text) => typeof text === "string" && !pythonBlank(text),
		)
	);
}

export function joinDetailColumns(
	short: readonly (ColumnProposal | undefined)[],
	long: readonly (ColumnProposal | undefined)[],
	named: ReadonlySet<number> = new Set(),
): JoinedDetails {
	const columns: JoinedColumn[] = [];
	const joinedLong = new Map<number, number>();
	const listOrder: number[] = [];
	short.forEach((proposal, s) => {
		if (proposal === undefined) return;
		const first = (match: (candidate: ColumnProposal) => boolean) =>
			long.findIndex(
				(candidate, l) =>
					candidate !== undefined && !joinedLong.has(l) && match(candidate),
			);
		// An `invisible` column carries its property and its header alone, so it joins the column
		// over its property that holds its header, the column it is, and no other.
		const sortNamed = proposal.invisible && named.has(s);
		const partner = proposal.invisible
			? first(
					(candidate) =>
						sameHiddenField(proposal, candidate) &&
						(sortNamed || sameHeader(proposal, candidate)),
				)
			: first((candidate) => sameProposal(proposal, candidate));
		const index = columns.length;
		if (partner === -1) {
			columns.push({
				proposal,
				...(proposal.invisible && { visibleInList: false as const }),
				visibleInDetail: false,
				short: s,
				...(sortNamed && { sortName: proposal.header }),
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
				...(sortNamed && { sortName: proposal.header }),
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

/** A calculated column's `field`, or a mapping condition's `key`, in the detail its expression was not registered from: the same
 *  tree, so the expression stage's claim of the registration holds it too. */
export interface ColumnFieldTwin {
	readonly registration: number;
	readonly site: { readonly json: JsonCursor; readonly key: string };
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

/** Whether a short detail's `persistent_case_tile_from_module` names a menu whose list holds no
 *  tile: Core's `EntriesHelper` finds that menu, then uses the selecting menu's own tile or line,
 *  so the setting changes no build (`existing-form-context-source-with-no-tile`, INERT). A menu
 *  that is missing is no such source: HQ raises on it. */
/**
 * Whether a short detail shows another menu's tile above its forms, expanded into that menu's
 * case detail, with the `persist_tile_on_forms` HQ's Case List page keeps beside it: the page
 * offers the source menu and the pull-down only with this menu's own persistence switched on,
 * and its save writes the pull-down off where that switch is off
 * (`details/bootstrap5/screen.js`, `enableTilePullDown`). HQ's build reads the source menu
 * first (`entries.py::get_detail_persistent_attr`, `get_detail_inline_attr`), so the switch is
 * the source's setting there, never this menu's own tile persisting.
 */
export function persistHeldByExternalPullDown(
	ctx: ReadContext,
	module: DraftModule,
	short: JsonCursor,
): boolean {
	const sourceId = short.peek("persistent_case_tile_from_module");
	if (
		short.peek("persist_tile_on_forms") !== true ||
		short.peek("pull_down_tile") !== true ||
		typeof sourceId !== "string" ||
		!sourceId ||
		dormantFormContextSource(ctx, sourceId)
	)
		return false;
	const source = ctx.draft.modules.find((menu) => menu.uniqueId === sourceId);
	const details = source?.json.peek("case_details");
	const sourceShort =
		isJsonObject(details) && isJsonObject(details.short)
			? details.short
			: undefined;
	return (
		source !== undefined &&
		!!sourceShort?.case_tile_template &&
		source.module.caseType === module.module.caseType
	);
}

export function dormantFormContextSource(
	ctx: ReadContext,
	sourceId: unknown,
): boolean {
	if (typeof sourceId !== "string" || !sourceId) return false;
	const source = ctx.draft.modules.find((menu) => menu.uniqueId === sourceId);
	const details = source?.json.peek("case_details");
	const sourceShort =
		isJsonObject(details) && isJsonObject(details.short)
			? details.short
			: undefined;
	return (
		source !== undefined &&
		!sourceShort?.case_tile_template &&
		!sourceShort?.custom_xml
	);
}

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

/** The number type each calculated column's stored order element compares it by, by the column's
 *  uuid, over every list the reading's first pass read whole. */
export function numericSortColumns(
	ctx: ReadContext,
): ReadonlyMap<Uuid, "int" | "double"> {
	const out = new Map<Uuid, "int" | "double">();
	for (const reading of caseListReadings(ctx).values())
		for (const [target, type] of reading.sort.numericColumns) {
			const uuid = reading.uuids[target];
			if (uuid !== undefined) out.set(uuid, type);
		}
	return out;
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
	// HQ delegates requires_case_details to the complete source, including excluded forms.
	const source = module.module.formsFromMenu;
	const owner = source
		? ctx.draft.modules.find((menu) => menu.uuid === source.menuUuid)
		: module;
	for (const form of owner?.forms ?? []) {
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
	return parentsChosen(ctx).has(module.uniqueId) ? "parent" : "unread";
}

/** The ids of the menus another menu chooses a parent from, worked out once a reading's menus
 *  rather than once a menu. */
const parentsChosenOf = new WeakMap<object, ReadonlySet<unknown>>();

function parentsChosen(ctx: ReadContext): ReadonlySet<unknown> {
	const known = parentsChosenOf.get(ctx.draft.modules);
	if (known !== undefined) return known;
	const chosen = new Set<unknown>();
	for (const other of ctx.draft.modules) {
		const parent = other.json.peek("parent_select");
		if (isJsonObject(parent) && parent.active === true)
			chosen.add(parent.module_id);
	}
	parentsChosenOf.set(ctx.draft.modules, chosen);
	return chosen;
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
	const sorts = sortFacts(short);
	if (index === 0 && sorts.count === 0) return true;
	const field = column.field;
	if (
		typeof field === "string" &&
		sorts.fields.has(field) &&
		sorts.firstColumnOf.get(field) === index
	)
		return true;
	if (sorts.lastCalculated > index) return true;
	const template = short.peek("case_tile_template");
	return (
		typeof template === "string" &&
		template !== "" &&
		template !== "custom" &&
		typeof column.case_tile_field === "string" &&
		column.case_tile_field !== ""
	);
}

/** What `filterChangesBuild` reads of a detail's sort elements and columns, worked out once a
 *  detail rather than once a column: how many sort elements it holds, the fields they sort by,
 *  the greatest `_cc_calculated_<n>` they name, and each field's first column. */
interface SortFacts {
	readonly count: number;
	readonly fields: ReadonlySet<string>;
	readonly lastCalculated: number;
	readonly firstColumnOf: ReadonlyMap<string, number>;
}

const sortFactsOf = new WeakMap<JsonCursor, SortFacts>();

function sortFacts(short: JsonCursor): SortFacts {
	const known = sortFactsOf.get(short);
	if (known !== undefined) return known;
	const elements = objectMembers(short.peek("sort_elements")) ?? [];
	const fields = new Set<string>();
	let lastCalculated = Number.NEGATIVE_INFINITY;
	for (const element of elements) {
		if (typeof element.field !== "string") continue;
		fields.add(element.field);
		const named = CALCULATED_FIELD.exec(element.field);
		if (named !== null)
			lastCalculated = Math.max(lastCalculated, Number(named[1]));
	}
	const stored = short.peek("columns");
	const firstColumnOf = new Map<string, number>();
	for (const [at, column] of (Array.isArray(stored) ? stored : []).entries())
		if (
			isJsonObject(column) &&
			typeof column.field === "string" &&
			!firstColumnOf.has(column.field)
		)
			firstColumnOf.set(column.field, at);
	const facts = {
		count: elements.length,
		fields,
		lastCalculated,
		firstColumnOf,
	};
	sortFactsOf.set(short, facts);
	return facts;
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
 * button: inert where every language shows HQ's own default on a device, a finding otherwise.
 * Each is an app string, compared as a device shows it (`heldText.ts::hqDeviceText`: spaces at
 * its end no device shows, nor the text after a carriage return), and one whose rest after a
 * carriage return defines another app string is refused under that entry
 * (`heldText.ts::keyDefinedAfterLineEnd`). Nova writes the empty list's default in every app
 * language on every menu's case list, a menu with no case type included, and leaves the case
 * detail's and both continue texts to HQ's model default (`{en: …}`), so a default map spelled
 * another way is respelled by the first publish, which the reading records under
 * `list-settings-respelled`. Whether the detail is still whole.
 */
function readDetailTexts(
	ctx: ReadContext,
	detail: JsonCursor,
	codes: readonly string[],
	screen: "short" | "long",
	wording?: CaseListShortReading,
): boolean {
	let ok = true;
	const texts = (
		key: "no_items_text" | "select_text",
		fallback: string,
		inert: Claim<"drop">,
		other: Claim<"take">,
		printed: unknown,
	) => {
		// Each language as HQ's build shows it (`app_strings.py`, `clean_trans`): a language the
		// map lacks or holds blank shows another's text. A text the reader cannot know (a number,
		// an object) is left unclaimed, for the close to name at its key.
		const stored = detail.peek(key);
		const shown = shownTexts(stored, codes);
		if (shown === undefined) {
			ok = false;
			return;
		}
		const shownTextsList = Object.values(shown);
		const lineEnd = shownTextsList
			.map(keyDefinedAfterLineEnd)
			.find((one) => one !== undefined);
		if (lineEnd !== undefined) {
			detail.refuse(key, LINE_END_DEFINES_KEY, { name: lineEnd });
			ok = false;
		} else if (
			shownTextsList.every((text) => hqDeviceText(text) === fallback)
		) {
			detail.drop(key, inert);
			if (!sameJson(stored, printed))
				recordTextRewrite(
					ctx,
					{ entry: inert.entry, path: `${detail.pointer}/${key}` },
					"list-settings-respelled",
					false,
				);
		} else if (wording === undefined) {
			// HQ's build writes a detail's texts only from a case list's own short detail
			// (`details.py::add_no_items_text_to_detail`, `add_select_text_to_detail`, under
			// `detail_type.endswith('short')`), so no worker reads this one; the first publish
			// writes HQ's default in its place.
			const unread =
				key === "no_items_text" ? D.textsUnread : D.selectTextUnread;
			detail.drop(key, unread);
			recordTextRewrite(
				ctx,
				{ entry: unread.entry, path: `${detail.pointer}/${key}` },
				"list-settings-respelled",
				false,
			);
		} else {
			const role =
				key === "no_items_text"
					? "case-list-empty-text"
					: "case-list-select-text";
			const held = heldTextsIn(stored, codes, sourceCode(ctx), role);
			if (held === undefined) {
				refuseUnheldKey(detail, key, codes, sourceCode(ctx), role);
				ok = false;
				return;
			}
			const texts = detail.take(key, other, () => held).value;
			noteRespelled(
				ctx,
				other.entry,
				`${detail.pointer}/${key}`,
				stored,
				texts,
			);
			if (key === "no_items_text") wording.empty = texts;
			else wording.select = texts;
		}
	};
	texts(
		"no_items_text",
		NO_ITEMS_DEFAULT,
		D.noItemsDefault,
		D.noItemsOther,
		screen === "short"
			? recordFromEntries(codes.map((code) => [code, NO_ITEMS_DEFAULT]))
			: { en: NO_ITEMS_DEFAULT },
	);
	texts("select_text", SELECT_DEFAULT, D.selectDefault, D.selectOther, {
		en: SELECT_DEFAULT,
	});
	return ok;
}

/** A case list's own texts as the reading of its short detail holds them, each language's. */
interface CaseListShortReading {
	empty?: HeldTexts;
	select?: HeldTexts;
	deviceLookup?: CaseListDeviceLookup;
	lookup?: HeldTexts;
}

/**
 * A refused tab's filter where HQ's build writes it into the suite, the predicate of the tab's
 * rows over a case type's children (`details.py::_get_detail_tab_nodeset`: `has_nodeset`, no
 * `nodeset` of its own, a `nodeset_case_type`), read through its shorthand
 * (`xpath.py::interpolate_xpath`): registered for the uses its text makes alone, at the filter.
 */
function registerTabFilter(
	ctx: ReadContext,
	module: DraftModule,
	tab: JsonCursor,
): void {
	const text = tab.peek("nodeset_filter");
	if (
		typeof text !== "string" ||
		text.trim() === "" ||
		!tab.peek("has_nodeset") ||
		tab.peek("nodeset") ||
		!tab.peek("nodeset_case_type")
	)
		return;
	ctx.pending.register(
		{
			ref: { entity: "module", uuid: module.uuid, slot: "case_list_filter" },
			text,
			mode: { target: "hq-json", interpolation: "no-case" },
			place: tab.place,
			key: "schema:DetailTab.nodeset_filter",
			usesOnly: true,
		},
		{ json: tab, key: "nodeset_filter" },
	);
}

/** Claims the keys of a detail that hold no setting Nova reads: the inert ones and each finding. */
function readDetailKeys(
	ctx: ReadContext,
	module: DraftModule,
	detail: JsonCursor,
	screen: "short" | "long",
	competingLine = false,
	wording?: CaseListShortReading,
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
	} else if (
		detail.peek("auto_select") === true &&
		(screen !== "short" || !multi)
	) {
		detail.refuse("auto_select", D.autoSelectSingle);
		ok = false;
	}
	for (const [key, claim] of [
		["persist_case_context", D.persistContextFalse],
		["persist_tile_on_forms", D.persistTileFalse],
		["pull_down_tile", D.pullDownFalse],
	] as const)
		if (detail.peek(key) === false) detail.drop(key, claim);
	if (screen === "long") {
		if (detail.used("persistent_case_tile_from_module"))
			detail.drop("persistent_case_tile_from_module", D.contextMenuUnused);
		if (detail.peek("pull_down_tile") === true)
			detail.drop("pull_down_tile", D.contextInlineUnused);
		if (competingLine) {
			detail.refuse("persist_case_context", D.competingContext);
			if (detail.used("persistent_case_context_xml"))
				detail.refuse("persistent_case_context_xml", D.competingContextValue);
			ok = false;
		} else {
			if (detail.peek("persist_case_context") === true)
				detail.drop("persist_case_context", D.contextUnused);
			if (detail.used("persistent_case_context_xml"))
				detail.drop("persistent_case_context_xml", D.contextXmlUnused);
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
	ok = readDetailTexts(ctx, detail, appCodes(ctx), screen, wording) && ok;
	const stored = detail.peek("tabs");
	const tabs = objectMembers(stored) ?? [];
	if (tabs.length > 0) {
		// Every kind the tabs hold is a finding; the first kind of the tabs themselves claims the key.
		const start = tabs[0]?.starting_index;
		// A basic or shadow menu's tile row holding fields of two tabs, which HQ's build refuses.
		const mixed =
			screen === "long" &&
			detail.peek("case_tile_template") === "custom" &&
			tileRowMixesTabs(detail, tabs) &&
			module.docType !== "AdvancedModule";
		const kinds = [
			...(typeof start === "number" && start > 0 ? [D.tabsColumnsAbove] : []),
			...(mixed ? [D.tabsTileRowMixedTabs] : []),
		];
		// Each other kind, and a tab's display condition, is a class of the tabs too, so it stands
		// at each key of them its entry names (`Accounting.findingAt`).
		const tabsAt = `${detail.pointer}/tabs`;
		const [primary, ...rest] = kinds;
		if (primary !== undefined) detail.refuse("tabs", primary);
		for (const kind of rest)
			ctx.accounting.findingAt(kind, detail.place, tabsAt);
		if (primary !== undefined)
			for (const tab of detail.coveredList("tabs", "DetailTab"))
				registerTabFilter(ctx, module, tab);
		if (mixed)
			ctx.accounting.findingAt(D.tabsTileRowMixed, detail.place, tabsAt);
		if (primary !== undefined || screen !== "long") ok = false;
	}
	if (detail.peek("lookup_enabled") === true) {
		const parsedLookup =
			screen === "short" && wording
				? textDeviceLookup(ctx, module, detail)
				: undefined;
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
		} else if (wording && parsedLookup !== undefined) {
			const { lookup, heading } = parsedLookup;
			wording.lookup = heading;
			const confidenceKeys =
				lookup.resultProperty === undefined
					? LOOKUP_CONFIDENCE_KEYS
					: LOOKUP_PROPERTY_CONFIDENCE_KEYS;
			noteRespelled(
				ctx,
				confidenceKeys.lookup_field_header.entry,
				`${detail.pointer}/lookup_field_header`,
				detail.peek("lookup_field_header"),
				heading,
			);
			const image = detail.peek("lookup_image");
			if (typeof image === "string" && image !== "") {
				const ref = readMediaMap(
					ctx,
					recordFromEntries(appCodes(ctx).map((language) => [language, image])),
					{
						site: { json: detail, key: "lookup_image" },
						place: detail.place,
						slot: "case_list_lookup_icon",
						mediaKind: "image",
					},
				);
				if (ref.kind === "asset") {
					const assetId = mediaAssetIdSchema.safeParse(ref.assetId);
					if (assetId.success) lookup.icon = assetId.data;
				}
			}
			for (const key of CALLOUT_KEYS) {
				const resultClaim =
					heading !== undefined &&
					(key === "lookup_display_results" ||
						key === "lookup_field_header" ||
						key === "lookup_field_template")
						? confidenceKeys[key]
						: undefined;
				const extrasClaim =
					lookup.evaluateExtras === true
						? LOOKUP_EVALUATED_EXTRAS.extras
						: lookup.extras.some(
									(extra) =>
										"expression" in extra && extra.expression.kind === "arith",
								)
							? LOOKUP_WITH_INTEGER_SUM.extras
							: lookup.extras.some((extra) => "expression" in extra)
								? LOOKUP_WITH_WORKER_EXTRA.extras
								: TEXT_LOOKUP_KEYS.lookup_extras;
				const claim =
					resultClaim ??
					(key === "lookup_extras" ? extrasClaim : TEXT_LOOKUP_KEYS[key]);
				if (
					claim !== undefined &&
					detail.used(key) &&
					(key !== "lookup_image" || lookup.icon !== undefined || !image)
				)
					wording.deviceLookup = detail.take(key, claim, () => lookup).value;
			}
		} else {
			// Report the decisive failure once and claim the remaining lookup keys under it.
			const extras = detail.peek("lookup_extras");
			const responses = detail.peek("lookup_responses");
			const unready =
				!Array.isArray(extras) ||
				extras.length === 0 ||
				!Array.isArray(responses) ||
				responses.length === 0;
			const relativeExtra =
				!unready &&
				typeof detail.peek("lookup_action") === "string" &&
				typeof detail.peek("lookup_name") === "string" &&
				lookupHasPlainRelativeExtra(extras);
			let cause: Claim<"refuse">;
			if (unready) {
				cause = D.lookupNoExtras;
				detail.refuse("lookup_extras", cause);
				detail.refuse("lookup_responses", D.lookupNoResponses);
				ctx.accounting.finding(D.lookupNoExtras, detail.place);
			} else if (relativeExtra) {
				cause = D.lookupRelativeExtra;
				detail.refuse("lookup_extras", cause);
			} else if (lookupHasEmptyCaseIdResultHeader(detail)) {
				cause = D.lookupMissingResultHeader;
				detail.refuse("lookup_display_results", cause);
			} else {
				cause = LOOKUP_ON_KEYS.lookup_enabled;
				detail.refuse("lookup_enabled", cause);
				detail.refuse("lookup_action", LOOKUP_ON_KEYS.lookup_action);
			}
			claimRestUnderFinding(
				ctx,
				detail,
				{ code: cause.entry, place: detail.place },
				(key) => CALLOUT_KEYS.includes(key),
			);
			ok = false;
		}
	} else if (LOOKUP_KEYS.some((key) => detail.used(key))) {
		// The switch off beside a callout key left behind; a switch off with every key at HQ's
		// default is of no class the stale keys' entry names, so it and its keys are left unclaimed.
		detail.drop("lookup_enabled", D.lookupOff);
		for (const key of LOOKUP_KEYS) {
			const claim = LOOKUP_OFF_KEYS[key];
			if (claim !== undefined && detail.used(key)) detail.drop(key, claim);
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

// The form's own close action, expressions and outgoing route all settle
// after this list has to declare its datum for binding.
const deferredFlatCloseLimits = new WeakMap<
	ReadContext,
	{ module: DraftModule; short: JsonCursor }[]
>();

export function settleFlatCloseSelectionLimits(
	ctx: ReadContext,
	doc: BlueprintDoc,
	webAppsOnly: boolean,
): void {
	const awaiting = deferredFlatCloseLimits.get(ctx);
	if (!awaiting) return;
	for (const { module, short } of awaiting) {
		const candidate = {
			...doc,
			appSettings: { ...doc.appSettings, runsOnlyOn: "web-apps" as const },
		};
		const formUuid = doc.formOrder[module.uuid]?.[0];
		if (
			formUuid &&
			webAppsOnly &&
			authoredBoundedFlatSelection(candidate, module.uuid, formUuid)
		) {
			const claim =
				doc.forms[formUuid].type === "close"
					? D.maxSelectFlatClose
					: D.maxSelectFlatFollowup;
			short.take("max_select_value", claim, Number).value;
		} else short.refuse("max_select_value", D.maxSelect101Elsewhere);
	}
	deferredFlatCloseLimits.delete(ctx);
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
	const automatic =
		short.peek("auto_select") === true
			? {
					autoSelect: short.take(
						"auto_select",
						D.autoSelectMulti,
						() => true as const,
					).value,
				}
			: {};
	// A null is HQ's model's `None`, for which HQ's build writes no `max-select-value`
	// (`suite_xml/xml_models.py`, an `IntegerField`, which leaves out `None`), and Core then
	// takes 100 (`SessionDatumParser.DEFAULT_MAX_SELECT_VAL`), Nova's own maximum.
	if (max === null) {
		short.take("max_select_value", D.maxSelect, () => 100).value;
		sameState(
			ctx,
			D.maxSelect.entry,
			`${short.pointer}/max_select_value`,
			"list-settings-respelled",
		);
		return {
			ok: true,
			selection: { kind: "multiple", maximum: 100, ...automatic },
		};
	}
	// Any other value that is no number is one HQ's model refuses as it wraps the app
	// (`IntegerProperty`, an `AssertTypeProperty`), so no source HQ serves holds it: no entry
	// names it, and it is left for the close.
	if (typeof max !== "number") return { ok: false };
	if (max === 0 || max < -1) {
		short.refuse("max_select_value", D.maxSelectZero);
		return { ok: false };
	}
	// Core's SessionDatumParser parses the suite attribute as a signed Java integer.
	if (max > 2_147_483_647) {
		short.refuse("max_select_value", D.maxSelectOutsideRuntime);
		return { ok: false };
	}
	if (
		max === BOUNDED_FLAT_CLOSE_MAXIMUM &&
		module.docType === "Module" &&
		ctx.facts.webAppsOnInHq
	) {
		const awaiting = deferredFlatCloseLimits.get(ctx) ?? [];
		awaiting.push({ module, short });
		deferredFlatCloseLimits.set(ctx, awaiting);
		return {
			ok: true,
			selection: { kind: "multiple", maximum: max, ...automatic },
		};
	}
	if (max === BOUNDED_FLAT_CLOSE_MAXIMUM) {
		short.refuse("max_select_value", D.maxSelect101Elsewhere);
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
		selection: {
			kind: "multiple",
			maximum: maximum === -1 ? 100 : maximum,
			...automatic,
		},
	};
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
	typesOf: (column: JoinedColumn) => readonly string[],
	joined: JoinedDetails,
): void {
	const catalog = ctx.draft.caseTypes;
	if (catalog == null) return;
	// Each column states the choices of the type whose property it shows: a column read through a
	// relation, the related type's.
	const shown = joined.columns.flatMap((column) => {
		const body = column.proposal.column;
		const choices = column.proposal.choices;
		if (body.kind !== "plain" || choices === undefined) return [];
		return typesOf(column).flatMap((type) => {
			const owner = columnPropertyCaseType(body, type, catalog);
			return owner ? [{ owner, property: body.field, choices }] : [];
		});
	});
	if (shown.length === 0) return;
	const stated = SHOWN_STATED.get(ctx) ?? new Set<string>();
	SHOWN_STATED.set(ctx, stated);
	const declared: typeof shown = [];
	const next = produce(catalog, (draft) => {
		for (const { owner, property, choices } of shown) {
			const type = draft.find((one) => one.name === owner);
			const key = `${owner}\u0000${property}`;
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
			declared.push({ owner, property, choices });
		}
	});
	if (declared.length === 0) return;
	ctx.writeDraft(() => {
		ctx.draft.caseTypes = next;
	});
	for (const { owner, property, choices } of declared)
		for (const option of choices.options)
			ctx.translations.set(
				casePropertyOptionTranslationUnitId(owner, property, option.value),
				"prose",
				translatedTexts(
					ctx,
					recordFromEntries(
						Object.entries(option.labels).map(([code, text]) => [
							code,
							proseText(text),
						]),
					),
				),
			);
}

/**
 * Reads one menu's two details into its case list: every key claimed, the columns joined, the
 * order and the tile read, each column minted, every expression registered and every text handed
 * to the translation sink. The config is written into the menu's draft.
 */
export function readCaseDetails(
	ctx: ReadContext,
	module: DraftModule,
	selectProperty: SelectProperty,
): void {
	const pair = module.json.object(
		"case_details",
		"DetailPair",
		module.docType === "ShadowModule"
			? D.pairShared
			: module.docType === "AdvancedModule"
				? D.pairAdvanced
				: D.pairModule,
	);
	const listPlace = caseListPlace(module, "case-list");
	const detailPlace = caseListPlace(module, "case-detail");
	const short = pair.object("short", "Detail", D.short, listPlace);
	const long = pair.object("long", "Detail", D.long, detailPlace);
	if (module.module.caseType === undefined) {
		// A menu with no case type shows neither screen: each detail's columns, its screen word
		// and its two texts, which read by the rule of a menu with a case type.
		for (const [detail, screen] of [
			[short, "short"],
			[long, "long"],
		] as const) {
			detail.drop("columns", D.surveyColumns);
			detail.drop("display", D.display);
			readDetailTexts(ctx, detail, appCodes(ctx), screen);
		}
		return;
	}
	// Both details are read whatever the first holds, so every finding is raised in one pass.
	const wording: CaseListShortReading = {};
	const shortKeys = readDetailKeys(ctx, module, short, "short", false, wording);
	// HQ generates a single shared detail ID for every enabled line on this
	// menu. Core keeps the last definition. A long-only line is unreferenced,
	// but a second, different definition shadows what the Case List editor
	// says the worker sees. Do not import the earlier value.
	const definesLine = (screen: JsonCursor) =>
		screen.peek("persist_case_context") === true &&
		!(
			screen.peek("case_tile_template") &&
			screen.peek("persist_tile_on_forms") === true
		);
	const lineText = (screen: JsonCursor) =>
		screen.peek("persistent_case_context_xml") ?? "case_name";
	const competingLine =
		definesLine(short) &&
		definesLine(long) &&
		lineText(short) !== lineText(long);
	const longKeys = readDetailKeys(ctx, module, long, "long", competingLine);
	let whole = shortKeys && longKeys;
	const selection = readSelection(ctx, module, short);
	whole &&= selection.ok;
	const tileTemplate = short.peek("case_tile_template");
	const inTile = tileTemplate === "custom";

	const storedShort = short.peek("columns");
	if (!Array.isArray(storedShort) || storedShort.length === 0) {
		// The class is a fact about the menu's pair of details, so the refusal stands at each
		// of its columns that holds a value (`Accounting.findingAt`).
		const need = listNeeded(ctx, module);
		if (need === "needed")
			ctx.accounting.findingAt(D.shortEmptyNeeded, listPlace, pair.pointer);
		else if (need === "parent")
			ctx.accounting.findingAt(D.shortEmptyParent, listPlace, pair.pointer);
		whole &&= need === "unread";
	}
	const shortCursors = short.list("columns", "DetailColumn", D.shortColumns);
	const storedLong = long.peek("columns");
	if (Array.isArray(storedLong) && storedLong.length === 0)
		long.takeDefault("columns", D.longColumnsEmpty);
	const longCursors = long.list("columns", "DetailColumn", D.longColumns);
	const shared = {
		selectProperty,
		optimizationsOn:
			module.json.peek("show_case_list_optimization_options") === true,
		advanced: module.docType === "AdvancedModule",
		offersSearch: menuOffersSearch(module),
		relationVia: (steps: readonly string[]) =>
			readColumnVia(ctx, module.module.caseType, steps),
	};
	// HQ's build admits a read of the search's instances in a detail of its results, or in a menu
	// whose search launches by itself (`helpers/validators.py::validate_detail_columns`).
	const search = module.json.peek("search_config");
	const autoLaunch = isJsonObject(search) && search.auto_launch === true;
	const inlineResultProperty =
		autoLaunch &&
		search.inline_search === true &&
		(search.instance_name == null || search.instance_name === "inline");
	const standaloneResultDetailText =
		ctx.facts.webAppsOnInHq &&
		isJsonObject(search) &&
		search.auto_launch === true &&
		search.inline_search !== true &&
		search.default_search !== true;
	const shortOptions: Omit<ColumnOptions, "filterChangesBuild"> = {
		...shared,
		inTile,
		namedTile: tileTemplate === "icon_text_grid",
		formats: formatCounts(short),
		searchInstancesRead:
			autoLaunch || short.peek("instance_name") === "results",
		inlineResultProperty,
		standaloneResultDetailText,
	};
	const longOptions: ColumnOptions = {
		...shared,
		inTile: false,
		formats: formatCounts(long),
		filterChangesBuild: false,
		searchInstancesRead: autoLaunch || long.peek("instance_name") === "results",
		standaloneResultDetailText,
	};
	const shortReadings = shortCursors.map((column, index) =>
		readDetailColumn(ctx, module, column, "short", {
			...shortOptions,
			widthZeroValueShowsInWebApps:
				ctx.facts.webAppsOnInHq &&
				widthZeroTileValueShowsInWebApps(short, column),
			filterChangesBuild: filterChangesBuild(short, index),
		}),
	);
	const sourceTabs = objectMembers(long.peek("tabs")) ?? [];
	const sourceAt = detailSourceSpans(sourceTabs, longCursors.length);
	const rowTabAt = (index: number) => sourceAt[index]?.tab;
	const childTypeAt = (index: number) => sourceAt[index]?.caseType;
	const longReadings = longCursors.map((column, i) => {
		const child = childTypeAt(i);
		const source = sourceAt[i];
		return readDetailColumn(ctx, module, column, "long", {
			...longOptions,
			dataRows: rowTabAt(i)?.has_nodeset === true,
			fixtureRow: source?.fixture === true,
			...(child && {
				relationVia: (steps) => readColumnVia(ctx, child, steps),
				selectProperty: (name, owner) => selectProperty(name, owner ?? child),
			}),
		});
	});
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
	// HQ emits a plain or invisible calculated field's expression in its
	// physical detail template. Sort-only nodes are outside get_all_xpaths.
	const factories = sourceFactories(ctx.input);
	const screens = [shortProposals, longProposals].map((proposals, screen) => {
		const kind = screen === 0 ? "short" : "long";
		// Module.get_details can clone these same columns onto search_short/long.
		const ids = ["case", "search"].map(
			(family) => `m${module.index}_${family}_${kind}`,
		);
		const sources = new Map<string, string>();
		for (const proposal of proposals)
			if (
				proposal?.expression &&
				["plain", "invisible"].includes(
					String(proposal.json.peek("format") ?? "plain"),
				)
			) {
				for (const [name, src] of scannedInstances(
					proposal.expression.text,
					factories,
				))
					sources.set(name, src);
			}
		const scopes: ReadonlyMap<string, string>[] = [];
		for (const id of ids) {
			const observed = ctx.input.suiteDetails?.get(id);
			if (observed === null) continue;
			if (!observed) {
				// The ordinary screen always has this template. A search clone
				// exists only if a served suite or module configuration provides one.
				if (id === ids[0] || shared.offersSearch) scopes.push(sources);
				continue;
			}
			const resolved = new Map(sources);
			for (const [name, src] of observed) {
				if (src === null) resolved.delete(name);
				else resolved.set(name, src);
			}
			scopes.push(resolved);
		}
		return { ids, sources: sharedSources(scopes), reached: scopes.length > 0 };
	});
	const both = sharedSources(
		screens.filter((screen) => screen.reached).map((screen) => screen.sources),
	);

	const joined = joinDetailColumns(
		shortProposals,
		longProposals,
		sortNamedInvisibleColumns(
			short.peek("columns"),
			short.peek("sort_elements"),
		),
	);
	const sort = readSortElements(ctx, module, short, joined, shortCursors, {
		offersSearch: shared.offersSearch,
		relationVia: shared.relationVia,
	});
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

	// Each property a column or a sort element reads is a property of the catalog: of the case
	// type its walk reaches, for a column read through a relation.
	const caseType = module.module.caseType;
	// The case types whose properties a column shows: the list's own on
	// Results, and a Details tab's child type on Details. A column on neither
	// detail (a sort's carrier) reads the list's own type.
	const typesOf = (column: JoinedColumn) => {
		const types = new Set([
			...(column.short !== undefined ? [caseType] : []),
			...(column.long !== undefined
				? [childTypeAt(column.long) ?? caseType]
				: []),
		]);
		return [...(types.size > 0 ? types : [caseType])];
	};
	const properties = joined.columns.flatMap((column) => {
		const body = column.proposal.column;
		if (body.kind === "calculated" || typeof body.field !== "string") return [];
		// The worker's own record is no case type of the catalog.
		if (body.readFrom === "worker-record") return [];
		const graph = new CaseRelationCatalog(ctx.draft.caseTypes ?? []);
		return typesOf(column).flatMap((type) =>
			type === undefined
				? []
				: graph
						.reached(type, body.via ?? [])
						.types.map((owner) => [owner, body.field] as const),
		);
	});
	if (
		caseType !== undefined &&
		wording.deviceLookup?.resultProperty !== undefined
	)
		properties.push([caseType, wording.deviceLookup.resultProperty]);
	if (
		caseType !== undefined &&
		properties.length > 0 &&
		ctx.draft.caseTypes != null
	)
		ctx.writeDraft(() => {
			ctx.draft.caseTypes = produce(ctx.draft.caseTypes ?? [], (draft) => {
				for (const [owner, property] of properties) {
					if (!draft.some((type) => type.name === owner))
						draft.push({ name: owner, properties: [] });
					noteProperty(draft, owner, property, ctx.input.knownCaseTypes);
				}
			});
		});
	if (caseType !== undefined) declareShownChoices(ctx, typesOf, joined);

	// Each column's identity: by (kind, field, n), n its ordinal among equal pairs in list order.
	const seen = new Map<string, number>();
	const uuids: Uuid[] = new Array(joined.columns.length);
	const startKeys = new Map<number, { uuid: Uuid; key: ExternalKey }>();
	for (const index of joined.listOrder) {
		const column = joined.columns[index] as JoinedColumn;
		const field = fieldOf(column.proposal) ?? "";
		const kind =
			column.proposal.choices !== undefined
				? "choice-label"
				: column.proposal.column.kind === "calculated" &&
						column.proposal.column.showAs === "formatted-text"
					? "calculated-formatted-text"
					: column.proposal.column.kind === "id-mapping" &&
							column.proposal.column.behavior === "first-match"
						? "conditional-label"
						: column.proposal.column.kind;
		const pairKey = JSON.stringify([kind, field]);
		const n = seen.get(pairKey) ?? 0;
		seen.set(pairKey, n + 1);
		const key = externalKey.caseListColumn(module.uniqueId, kind, field, n);
		const minted = ctx.accounting.identity(
			ctx.identities.claim(key, `${module.uniqueId}/case-list/${index}`),
			listPlace,
			"schema:DetailColumn",
		);
		if (minted === undefined) whole = false;
		else {
			ctx.facts.detailColumnOwners.push({
				uuid: minted,
				short:
					column.short === undefined
						? undefined
						: shortCursors[column.short]?.pointer,
				long:
					column.long === undefined
						? undefined
						: longCursors[column.long]?.pointer,
			});
			if (column.long !== undefined)
				startKeys.set(column.long, { uuid: minted, key });
		}
		uuids[index] = minted ?? (`${module.uuid}-column-${index}` as Uuid);
	}

	const config: CaseListConfig = {
		columns: [],
		...(sort.calculations.length > 0 && {
			calculatedSorts: [...sort.calculations],
		}),
		listColumnOrder: joined.listOrder.map((index) => uuids[index] as Uuid),
		detailColumnOrder: joined.detailOrder.map((index) => uuids[index] as Uuid),
		searchInputs: [],
		...(selection.selection !== undefined && {
			selection: selection.selection,
		}),
		...(wording.empty !== undefined && {
			emptyText: sourceText(ctx, wording.empty.texts),
		}),
		...(wording.select !== undefined && {
			selectButtonText: sourceText(ctx, wording.select.texts),
		}),
		...(wording.deviceLookup !== undefined && {
			deviceLookup: wording.deviceLookup,
		}),
		// Claimed by the menu's reading (`menus/modules.ts`), held here with the list it serves.
		...(module.json.peek("show_case_list_optimization_options") === true && {
			optimizations: true as const,
		}),
		...(tile.config !== undefined && {
			tile: {
				...tile.config,
				...(tile.slots && {
					namedSlots: recordFromEntries(
						[...tile.slots].map(
							([slot, index]) => [slot, uuids[index] as Uuid] as const,
						),
					) as NonNullable<NonNullable<CaseListConfig["tile"]>["namedSlots"]>,
				}),
			},
		}),
		...(tile.detailCells && {
			detailTile: {
				cells: recordFromEntries(
					[...tile.detailCells].map(
						([i, cell]) => [uuids[i] as Uuid, cell] as const,
					),
				),
			},
		}),
	};
	const ownPersistent = tile.config?.persistOnForms === true;
	const sourceId = short.peek("persistent_case_tile_from_module");
	const usesLine = short.peek("persist_case_context") === true;
	const inline = short.peek("pull_down_tile") === true;
	let external: DraftModule | undefined;
	if (typeof sourceId === "string" && sourceId) {
		const source = ctx.draft.modules.find((menu) => menu.uniqueId === sourceId);
		const details = source?.json.peek("case_details");
		const sourceShort =
			isJsonObject(details) && isJsonObject(details.short)
				? details.short
				: undefined;
		if (dormantFormContextSource(ctx, sourceId)) {
			// EntriesHelper finds the named menu, then uses this menu's own
			// tile or line. A missing menu is a different outcome: HQ raises.
			short.drop("persistent_case_tile_from_module", D.dormantMenu);
		} else if (
			!source ||
			!sourceShort?.case_tile_template ||
			source.module.caseType !== module.module.caseType
		) {
			short.refuse("persistent_case_tile_from_module", D.contextUnavailable);
			whole = false;
		} else {
			short.take(
				"persistent_case_tile_from_module",
				D.persistentFromModule,
				String,
			).value;
			external = source;
			config.contextAboveForm = {
				kind: "menu-tile",
				moduleUuid: source.uuid,
				...(inline && { expandDetails: true }),
			};
		}
	}
	if (inline) {
		if (external || ownPersistent) {
			short.take("pull_down_tile", D.pullDown, Boolean).value;
			if (external && persistHeldByExternalPullDown(ctx, module, short))
				short.take("persist_tile_on_forms", D.persistForPullDown, Boolean)
					.value;
			else if (external)
				// HQ's build expands the source menu's tile with this menu's persistence off too;
				// Nova writes it on, as HQ's Case List page keeps the pull-down.
				sameState(
					ctx,
					D.persistForPullDown.entry,
					`${short.pointer}/persist_tile_on_forms`,
					"list-settings-respelled",
				);
			if (!external)
				config.contextAboveForm = { kind: "own-tile", expandDetails: true };
		} else {
			short.refuse("pull_down_tile", D.inlineUnavailable);
			whole = false;
		}
	}
	if (usesLine) {
		if (ownPersistent) {
			short.drop("persist_case_context", D.persistContextBeside);
			short.drop("persistent_case_context_xml", D.persistContextXmlBeside);
		} else {
			short.take("persist_case_context", D.persistContext, Boolean).value;
			const value = short.peek("persistent_case_context_xml") ?? "case_name";
			if (typeof value !== "string") {
				ctx.accounting.circumstance("unrecognized", short.place, {
					name: "schema:Detail.persistent_case_context_xml",
				});
				whole = false;
			} else {
				ctx.pending.register(
					{
						ref: {
							entity: "module",
							uuid: module.uuid,
							slot: "case_form_context_line",
						},
						text: value,
						mode: { target: "hq-json", interpolation: "none" },
						place: short.place,
						key: "schema:Detail.persistent_case_context_xml",
					},
					{ json: short, key: "persistent_case_context_xml" },
				);
				const expression = pendingPlaceholder("value");
				config.contextAboveForm = external
					? {
							kind: "menu-tile",
							moduleUuid: external.uuid,
							expression,
							...(inline && { expandDetails: true }),
						}
					: { kind: "line", expression };
			}
		}
	} else if (short.used("persistent_case_context_xml"))
		short.drop("persistent_case_context_xml", D.contextXmlUnused);
	if (longKeys && long.used("tabs")) {
		const tabs = long.list("tabs", "DetailTab", D.tabs);
		const detailed: NonNullable<CaseListConfig["detailTabs"]> = [];
		let previous = -1;
		const mixed =
			module.docType === "AdvancedModule" &&
			long.peek("case_tile_template") === "custom" &&
			tileRowMixesTabs(long, objectMembers(long.peek("tabs")) ?? []);
		for (const [tabIndex, tab] of tabs.entries()) {
			// `isTab` is the Case Detail page's own (`tabEditorFlag`); any other key a tab
			// does not declare is no word a person knows from HQ's pages.
			for (const key of tab.undeclared())
				if (key !== "isTab") {
					tab.refuse(key, D.tabUndeclared);
					whole = false;
				}
			const start = tab.take(
				"starting_index",
				mixed ? D.tabsTileRowMixedAdvanced : D.tabPosition,
				(value) => value,
			).value;
			const anchor =
				typeof start === "number" ? startKeys.get(start) : undefined;
			if (
				anchor === undefined ||
				typeof start !== "number" ||
				start <= previous ||
				(previous < 0 && start !== 0)
			) {
				ctx.accounting.circumstance("unrecognized", tab.place, {
					name: "schema:DetailTab.starting_index",
				});
				whole = false;
				continue;
			}
			previous = start;
			const held = heldTextsIn(
				tab.peek("header"),
				appCodes(ctx),
				sourceCode(ctx),
				"case-detail-tab-title",
			);
			if (!held) {
				refuseUnheldKey(
					tab,
					"header",
					appCodes(ctx),
					sourceCode(ctx),
					"case-detail-tab-title",
				);
				whole = false;
				continue;
			}
			const titles = tab.take("header", D.tabTitle, () => held.texts).value;
			noteRespelled(
				ctx,
				D.tabTitle.entry,
				`${tab.pointer}/header`,
				tab.peek("header"),
				held,
			);
			tab.derived("isTab", D.tabEditorFlag);
			const nextStart = tabs[tabIndex + 1]?.peek("starting_index");
			const end =
				typeof nextStart === "number"
					? Math.min(nextStart, longCursors.length)
					: longCursors.length;
			const members: ExternalKey[] = [];
			for (let i = start + 1; i < end; i++) {
				const member = startKeys.get(i);
				if (member) members.push(member.key);
			}
			const uuid = ctx.accounting.identity(
				ctx.identities.claim(
					externalKey.caseDetailTab(anchor.key, members),
					`${module.uniqueId}/detail-tab/${start}`,
				),
				detailPlace,
				"schema:DetailTab",
			);
			if (uuid === undefined) {
				whole = false;
				continue;
			}
			const tabBody: NonNullable<CaseListConfig["detailTabs"]>[number] = {
				uuid,
				title: sourceText(ctx, titles),
				startColumnUuid: anchor.uuid,
			};
			const condition = tab.peek("relevant");
			if (typeof condition === "string" && condition !== "") {
				ctx.pending.register(
					{
						ref: {
							entity: "module",
							uuid: module.uuid,
							slot: "case_detail_tab_condition",
							member: { tabUuid: uuid },
						},
						text: condition,
						mode: { target: "hq-json", interpolation: "none" },
						place: tab.place,
						key: "schema:DetailTab.relevant",
					},
					{ json: tab, key: "relevant" },
				);
				tabBody.displayCondition = pendingPlaceholder("condition");
			}
			const nodes = tab.peek("nodeset"),
				child = tab.peek("nodeset_case_type"),
				filter = tab.peek("nodeset_filter");
			const active = tab.peek("has_nodeset") === true;
			const custom = active && typeof nodes === "string" && nodes !== "";
			const children =
				active &&
				!custom &&
				typeof child === "string" &&
				CASE_TYPE_PATTERN.test(child);
			if (custom || children) {
				tab.take(
					"has_nodeset",
					custom ? D.tabRecordsEnabled : D.tabChildEnabled,
					Boolean,
				).value;
				if (children) tabBody.rowSource = { kind: "children", caseType: child };
				const relatedType =
					typeof child === "string" && CASE_TYPE_PATTERN.test(child)
						? child
						: undefined;
				if (relatedType) {
					tab.take(
						"nodeset_case_type",
						children ? D.tabChildType : D.tabSearchChildren,
						String,
					).value;
					// The type a tab names, its rows' or a search's related
					// children, is a type of the catalog.
					if (
						ctx.draft.caseTypes &&
						!ctx.draft.caseTypes.some((type) => type.name === relatedType)
					)
						ctx.writeDraft(() => {
							ctx.draft.caseTypes = [
								...(ctx.draft.caseTypes ?? []),
								{ name: relatedType, properties: [] },
							];
						});
				} else if (custom && child && shared.offersSearch) {
					tab.refuse("nodeset_case_type", D.tabTypeInvalid);
					whole = false;
				}
				if (custom || (typeof filter === "string" && filter !== "")) {
					const key = custom ? "nodeset" : "nodeset_filter";
					ctx.pending.register(
						{
							ref: {
								entity: "module",
								uuid: module.uuid,
								slot: custom
									? "case_detail_tab_rows"
									: "case_detail_tab_filter",
								member: { tabUuid: uuid },
							},
							text: custom ? nodes : (filter as string),
							mode: {
								target: "hq-json",
								interpolation: custom ? "none" : "no-case",
							},
							place: tab.place,
							key: `schema:DetailTab.${key}`,
						},
						{ json: tab, key },
					);
					if (custom)
						tabBody.rowSource = {
							kind: "records",
							rows: pendingPlaceholder("value"),
							...(relatedType && { includeChildrenOfType: relatedType }),
						};
					else if (tabBody.rowSource?.kind === "children")
						tabBody.rowSource.condition = pendingPlaceholder("condition");
				}
				const orderFields = joined.columns
					.flatMap((c, i) =>
						c.long !== undefined &&
						rowTabAt(c.long)?.starting_index === start &&
						longCursors[c.long]?.peek("format") === "invisible"
							? [{ uuid: uuids[i], place: c.long }]
							: [],
					)
					.sort((a, b) => a.place - b.place)
					.map((c) => c.uuid);
				if (orderFields.length) tabBody.orderFields = orderFields;
			} else if (active) {
				tab.refuse("has_nodeset", D.tabRowsMissing);
				if (tab.used("nodeset_case_type"))
					tab.refuse("nodeset_case_type", D.tabTypeInvalid);
				whole = false;
			}
			if (!custom && tab.used("nodeset")) tab.drop("nodeset", D.tabRowsInert);
			if (
				(!active ||
					(custom &&
						(typeof child !== "string" || !CASE_TYPE_PATTERN.test(child)) &&
						!shared.offersSearch)) &&
				tab.used("nodeset_case_type")
			)
				tab.drop("nodeset_case_type", D.tabTypeInert);
			if (!children && tab.used("nodeset_filter"))
				tab.drop("nodeset_filter", D.tabFilterInert);
			detailed.push(tabBody);
			ctx.translations.set(
				makeTranslationUnitId("detail-tab", uuid, "title"),
				"text",
				translatedTexts(ctx, titles),
			);
		}
		if (detailed.length) config.detailTabs = detailed;
	}
	const named = applicationReading(ctx)?.languages.tagOf !== undefined;
	const twins: ColumnFieldTwin[] = [];
	joined.columns.forEach((column, index) => {
		const uuid = uuids[index] as Uuid;
		const built = {
			...column.proposal.column,
			uuid,
			...(column.sort !== undefined && { sort: column.sort }),
			...(column.visibleInList === false &&
				!tile.cells.get(index)?.androidOnly &&
				!tile.config?.rawSlots?.some(
					(slot) => tile.slots?.get(slot) === index,
				) && { visibleInList: false }),
			...(column.visibleInDetail === false && { visibleInDetail: false }),
			...(column.notOnList === true && { notOnList: true }),
			...(tile.cells.get(index) !== undefined && {
				tile: tile.cells.get(index),
			}),
		} as Column;
		if (built.kind === "image-map" || built.kind === "id-mapping") {
			const counts = new Map<string, number>();
			for (const [index, row] of built.mapping.entries()) {
				const source = column.proposal.conditions?.get(index);
				const comparison = source
					? JSON.stringify(["condition", recordSyntaxKey(source.text)])
					: caseMappingComparison(row);
				const key = externalKey.caseMappingRow(
					uuid,
					mappingIdentityAt(comparison, counts),
				);
				const matched = ctx.accounting.identity(
					ctx.identities.claim(
						key,
						`${module.uniqueId}/case-list/${uuid}/mapping/${index}`,
					),
					column.proposal.json.place,
					"schema:MappingItem",
				);
				if (matched === undefined) whole = false;
				else {
					// A saved value's row is known by its column and comparison, as
					// HQ keys its translations (`caseMappingRows.ts::caseMappingRowUuid`);
					// it holds an identity only where the document it was published
					// from gave it one of its own. A condition always holds one.
					const known =
						matched !==
						caseMappingRowUuid(uuid, {
							value: row.value,
							...("match" in row && { match: row.match }),
						});
					if (source !== undefined || row.when !== undefined || known)
						row.uuid = matched;
					if (source) {
						const registration = ctx.pending.register(
							{
								ref: {
									entity: "module",
									uuid: module.uuid,
									slot: "case_list_mapping_condition",
									member: { columnUuid: uuid, rowUuid: matched },
								},
								text: source.text,
								mode: source.mode,
								place: source.place,
								key: source.key,
							},
							source.at,
						);
						const other =
							column.proposal.json === shortProposals[column.short ?? -1]?.json
								? longProposals[column.long ?? -1]
								: shortProposals[column.short ?? -1];
						const twin = other?.conditions?.get(index);
						if (twin && twin.at.json !== source.at.json)
							twins.push({ registration, site: twin.at, place: twin.place });
					}
				}
			}
		}
		const expression = column.proposal.expression;
		if (built.kind === "calculated" && expression !== undefined) {
			const physical = screens.filter((_, i) =>
				i === 0 ? column.short !== undefined : column.long !== undefined,
			);
			let text = expression.text;
			const keys = column.proposal.textKeys;
			if (keys !== undefined) {
				const pieces: NonNullable<typeof built.texts> = [];
				const owners = keys.map((key) =>
					externalKey.caseCalculationText(uuid, key),
				);
				const reserved = new Set(owners.map(externalKeyText));
				for (const [index, key] of keys.entries()) {
					const piece = ctx.accounting.identity(
						ctx.identities.claim(
							owners[index],
							`${module.uniqueId}/case-list/${uuid}/text/${index}`,
							reserved,
						),
						column.proposal.json.place,
						"schema:MappingItem",
					);
					if (piece === undefined) {
						whole = false;
						return;
					}
					pieces.push({
						uuid: piece,
						label: sourceText(ctx, column.proposal.texts[key]),
					});
				}
				built.texts = pieces;
				text = bindCalculationText(expression.text, keys, pieces);
			}
			const registration = ctx.pending.register(
				{
					suiteDetails: physical.flatMap((screen) => screen.ids),
					suiteSources:
						physical.length === 2
							? both
							: physical[0]?.reached
								? physical[0].sources
								: undefined,
					ref: {
						entity: "module",
						uuid: module.uuid,
						slot: "case_list_column_expression",
						member: { columnUuid: uuid },
					},
					text,
					mode: expression.mode,
					place: expression.place,
					key: expression.key,
					...(expression.readerClaimed && { readerClaimed: true }),
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
		const byLanguage = (map: Readonly<Record<string, string>>) =>
			translatedTexts(ctx, map);
		if (named && column.sortName !== undefined && columnSortLabelShows(built))
			ctx.translations.set(
				makeTranslationUnitId("column", uuid, "sort-label"),
				"text",
				byLanguage(column.sortName),
			);
		if (!named || !caseListColumnTextShows(built)) return;
		ctx.translations.set(
			makeTranslationUnitId("column", uuid, "header"),
			"text",
			byLanguage(column.proposal.header),
		);
		if (built.kind === "image-map" || built.kind === "id-mapping") {
			for (const [index, row] of built.mapping.entries()) {
				const key = String(index);
				const map = column.proposal.texts[key];
				if (map !== undefined)
					ctx.translations.set(
						caseMappingTextUnit(
							uuid,
							row,
							built.kind === "image-map" ? "image-description" : "mapping",
						),
						"text",
						byLanguage(map),
					);
			}
		}
		if (built.kind === "calculated")
			for (const [index, piece] of (built.texts ?? []).entries()) {
				const key = column.proposal.textKeys?.[index];
				if (key !== undefined)
					ctx.translations.set(
						makeTranslationUnitId(
							"column",
							uuid,
							"calculation-text",
							piece.uuid,
						),
						"text",
						byLanguage(column.proposal.texts[key]),
					);
			}
		if (built.kind === "interval" && column.proposal.texts[""] !== undefined)
			ctx.translations.set(
				makeTranslationUnitId("column", uuid, "text"),
				"text",
				byLanguage(column.proposal.texts[""]),
			);
	});
	// The array in the list's order, as the reader returns it (`columnsInListOrder`): a column an
	// order rule alone carries stands among the list's fields, ahead of the columns only Details
	// shows (`order.ts`), though the join made it last.
	const rank = new Map(config.listColumnOrder.map((uuid, at) => [uuid, at]));
	config.columns = config.columns
		.map((column, at) => ({ column, at }))
		.sort(
			(a, b) =>
				(rank.get(a.column.uuid) ?? rank.size) -
					(rank.get(b.column.uuid) ?? rank.size) || a.at - b.at,
		)
		.map(({ column }) => column);

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
					// HQ interpolates the filter whole, the owner clause beside the operand too.
					...(text !== storedFilter && { slotText: storedFilter }),
				},
				{ json: short, key: "filter" },
			);
			config.filter = pendingPlaceholder("condition");
		}
	}

	for (const [slot, held] of [
		["empty", wording.empty],
		["select", wording.select],
		["lookup", wording.lookup],
	] as const)
		if (held !== undefined)
			ctx.translations.set(
				caseListWordingUnitId(module.uuid, slot),
				"text",
				translatedTexts(ctx, held.texts),
			);
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
 * not show (`visibleInDetail: false`) has no place in the long detail, and a column the short
 * detail holds no field for has none in the short one, so a document that holds either anywhere in
 * that screen's order prints what one that holds it last prints. A column the short detail holds
 * no field for is one not on the list (`notOnList`) and, in a tile list, one hidden from Results
 * (`caseListOrder.ts`, rule 1, which `caseListOrderPlan`'s fields state). The reader returns the
 * screen's own columns in their order, then the others: on the detail, those off it in the list's
 * order; on the list, those Details shows in the detail's order (the long detail's columns no short
 * column joins, `joinDetailColumns`), then those no screen shows, which only an order rule carries,
 * in the order `tile-columns-shown-nowhere-are-as-read` gives them (`order.ts::readSortElements`
 * appends each as it reads its rule).
 */
export function columnsOffAScreenLast(doc: BlueprintDoc): BlueprintDoc {
	const next = new Map<Uuid, { list: Uuid[]; detail: Uuid[] }>();
	for (const moduleUuid of doc.moduleOrder) {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) continue;
		const columns = new Map(config.columns.map((one) => [one.uuid, one]));
		// Which columns are fields depends on no property, no comparator and no expression's
		// print, so the plan is asked with none of them.
		const fields = new Set(
			caseListOrderPlan(config, [], {
				mediaOn: false,
				calculatedType: () => undefined,
				expressionText: () => "",
			}).fields.map((field) => field.column.uuid),
		);
		const onDetail = (uuid: Uuid) =>
			columns.get(uuid)?.visibleInDetail !== false;
		const list = [
			...config.listColumnOrder.filter((uuid) => fields.has(uuid)),
			...config.detailColumnOrder.filter(
				(uuid) =>
					!fields.has(uuid) &&
					onDetail(uuid) &&
					config.listColumnOrder.includes(uuid),
			),
			...config.listColumnOrder.filter(
				(uuid) => !fields.has(uuid) && !onDetail(uuid),
			),
		];
		const detail = [
			...config.detailColumnOrder.filter(onDetail),
			...list.filter(
				(uuid) => !onDetail(uuid) && config.detailColumnOrder.includes(uuid),
			),
		];
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
			const renamed = identitiesByListOrder(
				config.columns,
				config.listColumnOrder,
				list,
			);
			config.listColumnOrder = list;
			config.detailColumnOrder = detail;
			renameColumns(draft, config, renamed);
		}
	});
}

/** The key a reading claims a column under, less its ordinal: its kind and its property. */
function columnPairKey(column: Column): string {
	return JSON.stringify([
		column.kind,
		column.kind === "calculated" ? "" : column.field,
	]);
}

/**
 * The identity each column takes where a list's order on Results moves from `before` to
 * `after`: a reading names a column by its kind, its property and its ordinal among such columns
 * in that order (`identityMap.ts::externalIdentityMap`, which a re-read's resolver answers), so
 * the n-th such column in the new order takes the identity the n-th held in the old one. Only a
 * column whose identity moves is named.
 */
function identitiesByListOrder(
	columns: readonly Column[],
	before: readonly Uuid[],
	after: readonly Uuid[],
): ReadonlyMap<Uuid, Uuid> {
	const byUuid = new Map(columns.map((column) => [column.uuid, column]));
	const held = new Map<string, Uuid[]>();
	for (const uuid of before) {
		const column = byUuid.get(uuid);
		if (column === undefined) continue;
		const key = columnPairKey(column);
		held.set(key, [...(held.get(key) ?? []), uuid]);
	}
	const seen = new Map<string, number>();
	const renamed = new Map<Uuid, Uuid>();
	for (const uuid of after) {
		const column = byUuid.get(uuid);
		if (column === undefined) continue;
		const key = columnPairKey(column);
		const n = seen.get(key) ?? 0;
		seen.set(key, n + 1);
		const target = held.get(key)?.[n];
		if (target !== undefined && target !== uuid) renamed.set(uuid, target);
	}
	return renamed;
}

/** Named Results assignments follow the short fields. Details cells follow
 * the long fields, which a join can attach to a different short field. */
function remappedCaseTileRefs(
	config: Pick<CaseListConfig, "tile" | "detailTile">,
	short: (uuid: Uuid) => Uuid,
	long: (uuid: Uuid) => Uuid,
): Pick<CaseListConfig, "tile" | "detailTile"> {
	const tile = config.tile;
	const detailTile = config.detailTile;
	return {
		...(tile?.namedSlots !== undefined && {
			tile: {
				...tile,
				namedSlots: recordFromEntries(
					Object.entries(tile.namedSlots).map(([slot, uuid]) => [
						slot,
						short(uuid),
					]),
				) as NonNullable<typeof tile.namedSlots>,
			},
		}),
		...(detailTile !== undefined && {
			detailTile: {
				cells: recordFromEntries(
					Object.entries(detailTile.cells).map(([uuid, cell]) => [
						long(uuid as Uuid),
						cell,
					]),
				),
			},
		}),
	};
}

/** `config`'s columns renamed by `renamed` in the draft, in both orders and with the
 *  translations each one's print holds. */
function renameColumns(
	draft: Draft<BlueprintDoc>,
	config: Draft<CaseListConfig>,
	renamed: ReadonlyMap<Uuid, Uuid>,
): void {
	if (renamed.size === 0) return;
	const rename = (uuid: Uuid) => renamed.get(uuid) ?? uuid;
	Object.assign(config, remappedCaseTileRefs(config, rename, rename));
	for (const column of config.columns) column.uuid = rename(column.uuid);
	config.listColumnOrder = config.listColumnOrder.map(rename);
	config.detailColumnOrder = config.detailColumnOrder.map(rename);
	for (const tab of config.detailTabs ?? [])
		tab.startColumnUuid = rename(tab.startColumnUuid);
	for (const targets of Object.values(draft.localization?.translations ?? {})) {
		if (targets === undefined) continue;
		const moved: [string, unknown][] = [];
		for (const [from, to] of renamed) {
			const prefix = columnUnitPrefix(from);
			for (const unit of Object.keys(targets) as TranslationUnitId[])
				if (unit.startsWith(prefix)) {
					moved.push([
						`${columnUnitPrefix(to)}${unit.slice(prefix.length)}`,
						targets[unit],
					]);
					delete targets[unit];
				}
		}
		for (const [unit, entry] of moved)
			(targets as Record<string, unknown>)[unit] = entry;
	}
}

/** The prefix of every translation unit a column owns (its header, its text, its mappings'
 *  labels), which names the column by its uuid. */
function columnUnitPrefix(uuid: Uuid): string {
	return makeTranslationUnitId("column", uuid);
}

/** A column less what its print on the detail does not read: its identity, its order rule, its
 *  tile cell and its place on each screen. */
function columnContent(column: Column): Record<string, unknown> {
	const {
		uuid: _uuid,
		sort: _sort,
		tile: _tile,
		visibleInList: _visibleInList,
		visibleInDetail: _visibleInDetail,
		notOnList: _notOnList,
		...rest
	} = column as Column & Record<string, unknown>;
	return rest;
}

/** What of a column its print on the detail reads: its content (`columnContent`) and the text
 *  each language holds for each of its translation units. */
function detailPrintKey(column: Column, doc: BlueprintDoc): string {
	const prefix = columnUnitPrefix(column.uuid);
	const texts = Object.entries(doc.localization?.translations ?? {}).map(
		([language, entries]) => [
			language,
			Object.entries(entries ?? {})
				.filter(([unit]) => unit.startsWith(prefix))
				.map(([unit, entry]) => [
					unit.slice(prefix.length),
					(entry as { readonly value?: unknown }).value,
				])
				.sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)),
		],
	);
	return JSON.stringify([columnContent(column), texts]);
}

/** The header a column prints in each app language: on Details its header's text map (a
 *  current translation, else the source), and in a column hidden from Results and from Details,
 *  whose `invisible` field carries it, its stored header in every language
 *  (`hqJson/caseList.ts::projectColumnForShortDetail`). */
function headerTexts(
	column: Column,
	doc: BlueprintDoc,
	onDetail: boolean,
): Record<string, string> {
	const languages = doc.localization?.languageOrder ?? ["source"];
	const unit = makeTranslationUnitId("column", column.uuid, "header");
	return recordFromEntries(
		languages.map((language) => {
			const entry = onDetail
				? (
						doc.localization?.translations?.[language] as
							| Record<string, { readonly value?: unknown }>
							| undefined
					)?.[unit]
				: undefined;
			return [
				language,
				typeof entry?.value === "string" ? entry.value : column.header,
			];
		}),
	);
}

/** Whether a long detail column is over the field a column hidden from Results reads, as the
 *  join asks it (`sameHiddenField`): one property, or for a calculated column one expression. */
function overItsField(hidden: Column, candidate: Column): boolean {
	if (hidden.kind === "calculated" || candidate.kind === "calculated")
		return (
			hidden.kind === "calculated" &&
			candidate.kind === "calculated" &&
			sameJson(hidden.expression, candidate.expression)
		);
	return columnFieldText(hidden) === columnFieldText(candidate);
}

/**
 * The reader's canonical choice `sort-named-hidden-column-header-is-its-name`. A column hidden
 * from Results and from Details whose own order rule names it in Sort by
 * (`caseListOrder.ts`, rule 10) prints that name where its header would stand: HQ JSON's
 * `invisible` field takes the name as its header (`hqJson/caseList.ts::projectColumnForShortDetail`),
 * and the local archive writes the name under the field's locale id; no screen shows the column's
 * own header. So two such columns that differ only in their header print one source, and the
 * reader returns the one whose header is the name, the text the field's header holds.
 */
export function sortNamedHiddenColumnHeader(doc: BlueprintDoc): BlueprintDoc {
	const renamed: { moduleUuid: Uuid; column: Uuid; header: string }[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) continue;
		const plan = caseListOrderPlan(config, [], {
			mediaOn: false,
			calculatedType: () => undefined,
			expressionText: () => "",
		});
		for (const field of plan.fields) {
			const label = field.rule?.label;
			if (
				label === undefined ||
				label.column !== field.column.uuid ||
				field.column.visibleInDetail !== false ||
				field.column.header === label.text
			)
				continue;
			renamed.push({ moduleUuid, column: label.column, header: label.text });
		}
	}
	if (renamed.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const one of renamed) {
			const column = draft.modules[
				one.moduleUuid
			]?.caseListConfig?.columns.find(
				(candidate) => candidate.uuid === one.column,
			);
			if (column !== undefined) column.header = one.header;
		}
	});
}

/**
 * The reader's canonical choice `columns-joined-as-read`. Neither detail prints a column's
 * identity, so the reader pairs the short detail's fields with the long detail's columns by what
 * they print (`joinDetailColumns`): each field, in its order on Results, joins the first long
 * detail column not yet joined that prints the same column, or, for a field hidden from Results,
 * whose `invisible` column carries its property and its header alone, the first over that property
 * with that header in every language (whatever its header where the field's rule names it in
 * Sort by, which prints that name in the header's place), whose print it then takes, and none
 * where no such column is free. A list whose fields join other columns than their own prints what the list that
 * join gives prints, and the reader returns that list: each field holding the print of the column
 * it joined (its own where it is shown on Results) beside its own order rule, tile cell and place
 * on Results, in its order there; off the detail where it joined none; each long detail column
 * no field joined after them, off the list; the rest as they stand. Each column then takes the
 * identity a re-read gives its key there (`identityMap.ts::reReadUuidOf`), its print's
 * translations with it. Two columns print the same column where they differ only in identity,
 * order rule, tile cell and place on each screen, and hold the same text in every language
 * (`detailPrintKey`). It reads the orders `columns-off-a-screen-last-in-its-order` gives.
 */
export function columnsJoinedAsRead(doc: BlueprintDoc): BlueprintDoc {
	const effectiveTypes = effectiveCaseTypes(doc);
	const next = new Map<
		Uuid,
		{
			readonly config: CaseListConfig;
			readonly units: ReadonlyMap<Uuid, Uuid>;
		}
	>();
	const reRead = reReadUuidOf(doc, DERIVED_WIRE_IDENTITY);
	for (const moduleUuid of doc.moduleOrder) {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) continue;
		const columns = new Map(config.columns.map((one) => [one.uuid, one]));
		const column = (uuid: Uuid) => columns.get(uuid) as Column;
		const planned = caseListOrderPlan(config, [], {
			mediaOn: false,
			calculatedType: () => undefined,
			expressionText: () => "",
		}).fields;
		const fieldSet = new Set(planned.map((field) => field.column.uuid));
		// A hidden field whose rule names it in Sort by prints that name in its header's place, so
		// it joins the first column over its property whatever that column's header.
		const sortNamed = new Set(
			planned.flatMap((field) =>
				field.hidden && field.rule?.label !== undefined
					? [field.column.uuid]
					: [],
			),
		);
		const fields = config.listColumnOrder.filter(
			(uuid) => fieldSet.has(uuid) && columns.has(uuid),
		);
		const long = config.detailColumnOrder.filter(
			(uuid) => columns.has(uuid) && column(uuid).visibleInDetail !== false,
		);
		const joinedBy = new Map<Uuid, Uuid>();
		const partnerOf = new Map<Uuid, Uuid>();
		for (const short of fields) {
			const own = column(short);
			const hidden = own.visibleInList === false;
			const key = hidden ? undefined : detailPrintKey(own, doc);
			const free = (uuid: Uuid) => !joinedBy.has(uuid);
			const partner = hidden
				? long.find(
						(uuid) =>
							free(uuid) &&
							overItsField(own, column(uuid)) &&
							(sortNamed.has(short) ||
								sameJson(
									headerTexts(column(uuid), doc, true),
									headerTexts(own, doc, own.visibleInDetail !== false),
								)),
					)
				: long.find(
						(uuid) => free(uuid) && detailPrintKey(column(uuid), doc) === key,
					);
			if (partner === undefined) continue;
			joinedBy.set(partner, short);
			partnerOf.set(short, partner);
		}
		const unchanged = fields.every(
			(uuid) =>
				partnerOf.get(uuid) ===
				(column(uuid).visibleInDetail !== false ? uuid : undefined),
		);
		if (unchanged) continue;

		// The list the join gives, each column with the uuid of the column whose print it holds.
		const built: { column: Column; printOf: Uuid }[] = [];
		for (const short of fields) {
			const own = column(short);
			const partner = partnerOf.get(short);
			const printOf =
				partner !== undefined && own.visibleInList === false ? partner : short;
			built.push({
				column: {
					...columnContent(column(printOf)),
					uuid: short,
					...(own.sort !== undefined && { sort: own.sort }),
					...(own.tile !== undefined && { tile: own.tile }),
					...(own.visibleInList === false && { visibleInList: false }),
					...(partner === undefined && { visibleInDetail: false }),
				} as Column,
				printOf,
			});
		}
		const longOnly = long.filter((uuid) => !joinedBy.has(uuid));
		// A long detail column no field joined is off the list: one the short detail holds a field
		// for, whose field joined another column, is read as its print alone; any other is read as
		// it stands (off the list, or in a tile list a column hidden from Results whose order rule
		// the reader lands on it).
		for (const uuid of longOnly)
			built.push({
				column: fieldSet.has(uuid)
					? ({
							...columnContent(column(uuid)),
							uuid,
							visibleInList: false,
							notOnList: true,
						} as Column)
					: column(uuid),
				printOf: uuid,
			});
		// Every column the join reads (each field, each column on Details, joined or not) is
		// rebuilt above; the rest (columns no screen shows, which an order rule alone carries)
		// stand as they are.
		const placed = new Set([...fields, ...long]);
		const rest = config.listColumnOrder.filter(
			(uuid) => !placed.has(uuid) && columns.has(uuid),
		);

		// Each built column's identity: the one a re-read gives its key, by kind, property and
		// ordinal among equal pairs in its list order, as the reader claims it. A uuid of the
		// document can stand twice among them (a field hidden from Results that joined another
		// column, and its own column on Details that no field joined), so each is named by place.
		const counts = new Map<string, number>();
		const units = new Map<Uuid, Uuid>();
		const module = doc.modules[moduleUuid];
		const named = built.map(({ column: one, printOf }) => {
			const field = (one as { field?: unknown }).field;
			const property = typeof field === "string" ? field : "";
			const kind = storedColumnKind(one, module?.caseType, effectiveTypes);
			const pair = JSON.stringify([kind, property]);
			const n = counts.get(pair) ?? 0;
			counts.set(pair, n + 1);
			const uuid = reRead(
				externalKey.caseListColumn(
					DERIVED_WIRE_IDENTITY.moduleUniqueId(module?.uuid ?? moduleUuid),
					kind,
					property,
					n,
				),
			);
			units.set(uuid, printOf);
			return { ...one, uuid } as Column;
		});
		const shortAt = new Map(fields.map((uuid, index) => [uuid, index]));
		const longAt = new Map(
			longOnly.map((uuid, index) => [uuid, fields.length + index]),
		);
		const at = (index: number) => named[index]?.uuid as Uuid;
		const list = [...named.map((one) => one.uuid), ...rest];
		const onDetail = long.map((uuid) => {
			const joined = joinedBy.get(uuid);
			return joined !== undefined
				? at(shortAt.get(joined) ?? -1)
				: at(longAt.get(uuid) ?? -1);
		});
		const newLong = new Map(long.map((uuid, index) => [uuid, onDetail[index]]));
		const detail = [
			...onDetail,
			...list.filter((uuid) => !onDetail.includes(uuid)),
		];
		next.set(moduleUuid, {
			config: {
				...config,
				...remappedCaseTileRefs(
					config,
					(uuid) => {
						const index = shortAt.get(uuid);
						return index === undefined ? uuid : at(index);
					},
					(uuid) => newLong.get(uuid) ?? uuid,
				),
				columns: [...named, ...rest.map(column)],
				listColumnOrder: list,
				detailColumnOrder: detail,
				...(config.detailTabs && {
					detailTabs: config.detailTabs.map((tab) => ({
						...tab,
						startColumnUuid:
							onDetail[long.indexOf(tab.startColumnUuid)] ??
							tab.startColumnUuid,
					})),
				}),
			},
			units,
		});
	}
	if (next.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const [moduleUuid, { config, units }] of next) {
			const module = draft.modules[moduleUuid];
			if (module === undefined) continue;
			const before =
				module.caseListConfig?.columns.map((one) => one.uuid) ?? [];
			module.caseListConfig = structuredClone(config);
			// Each column's translations follow its print: those of the column whose print it
			// holds, under its own uuid; the units of a column whose print no column holds go.
			for (const targets of Object.values(
				draft.localization?.translations ?? {},
			)) {
				if (targets === undefined) continue;
				const held = new Map<Uuid, [string, unknown][]>();
				for (const uuid of before) {
					const prefix = columnUnitPrefix(uuid);
					const own: [string, unknown][] = [];
					for (const unit of Object.keys(targets) as TranslationUnitId[])
						if (unit.startsWith(prefix)) {
							own.push([unit.slice(prefix.length), targets[unit]]);
							delete targets[unit];
						}
					held.set(uuid, own);
				}
				for (const [uuid, printOf] of units)
					for (const [suffix, entry] of held.get(printOf) ?? [])
						(targets as Record<string, unknown>)[
							`${columnUnitPrefix(uuid)}${suffix}`
						] = structuredClone(entry);
				for (const uuid of before)
					if (
						!units.has(uuid) &&
						config.columns.some((one) => one.uuid === uuid)
					)
						for (const [suffix, entry] of held.get(uuid) ?? [])
							(targets as Record<string, unknown>)[
								`${columnUnitPrefix(uuid)}${suffix}`
							] = structuredClone(entry);
			}
		}
	});
}

/**
 * The reader's canonical choice `columns-in-list-order`: a case list's `columns` array is the set
 * of its columns, and its position reaches no export (every projection reads the columns through
 * `listColumnOrder` and `detailColumnOrder`, `modules.ts::orderedColumns`), so a list whose array
 * holds its columns in any order prints what one holding them in the list's order prints. The
 * reader builds the array in the order it joins the two details (`joinDetailColumns`, then each
 * column an order rule alone carries), which is its list order, so it returns the array in
 * `listColumnOrder`'s order, a column that order does not name after the rest as it stands. It
 * runs after `columns-off-a-screen-last-in-its-order`, whose list order it reads.
 */
export function columnsInListOrder(doc: BlueprintDoc): BlueprintDoc {
	const next = new Map<Uuid, Column[]>();
	for (const moduleUuid of doc.moduleOrder) {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) continue;
		const place = new Map(
			config.listColumnOrder.map((uuid, index) => [uuid, index]),
		);
		const rank = (column: Column) =>
			place.get(column.uuid) ?? config.listColumnOrder.length;
		const ordered = config.columns
			.map((column, index) => ({ column, index }))
			.sort((a, b) => rank(a.column) - rank(b.column) || a.index - b.index)
			.map(({ column }) => column);
		if (ordered.some((column, index) => column !== config.columns[index]))
			next.set(moduleUuid, ordered);
	}
	if (next.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const [moduleUuid, columns] of next) {
			const config = draft.modules[moduleUuid]?.caseListConfig;
			if (config !== undefined) config.columns = structuredClone(columns);
		}
	});
}

/**
 * The reader's canonical choice `columns-of-a-menu-that-lists-no-cases-are-its-one-name-column`: a
 * menu whose forms are all surveys, with no case list entry, lists no cases, and Nova writes it
 * the pair every new menu holds in CommCare HQ, whatever its list and its search hold
 * (`expander.ts`, `hasCases`, `hqJson/caseList.ts::emptyListDetailPair`): one `name` column
 * headed with the same word in every language, on the list and on the detail, and the search's
 * shell defaults. So no export carries the menu's columns, their headers' translations, their
 * order rules, its tile, its filter, its selection, its Search fields or its search settings, and
 * the reader returns the list that pair reads as: that one plain `case_name` column, on both
 * screens, and nothing else. The column keeps
 * the identity of the menu's own first plain `case_name` column where it has one, the identity a
 * re-read gives it, and otherwise the UUID a re-read gives a key the document lacks
 * (`identityMap.ts::reReadUuidOf`), which is not the key's own mint where the document holds
 * that under another column (one whose property was changed in Nova). It runs
 * before `columns-off-a-screen-last-in-its-order`.
 */
export function columnsOfAMenuThatListsNoCases(
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
		const column = plainColumn(
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
		);
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
