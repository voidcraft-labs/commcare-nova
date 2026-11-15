/**
 * One column of a CommCare HQ case list or case detail, read as the Nova
 * column it would be (`readDetailColumn`). A column is read by its `format`
 * into one of Nova's eight column kinds, or raises the finding its manifest
 * row names; every other key of the column is claimed by its row. The read is
 * a proposal: the two details are joined into one set of columns
 * (`details.ts`), and the whole menu is accepted only where
 * `projectCaseListForHq` writes the stored details back
 * (`caseList/index.ts::settleCaseLists`).
 */
import type { CaseProperty, Column, LanguageTag } from "@/lib/domain";
import {
	AUTHORED_CASE_PROPERTY_NAME_PATTERN,
	MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH,
} from "@/lib/domain/casePropertyName";
import { COMMCARE_DATE_PATTERN_REGEX } from "@/lib/domain/commCareDatePattern";
import {
	INTERVAL_DISPLAYS,
	TIME_SINCE_UNIT_DAYS,
	TIME_SINCE_UNITS,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import type { TranslationUnitRole } from "@/lib/domain/translationUnits";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { hqXPath, hqXPathText } from "../../hqJson/xpath";
import {
	imageMapEnumKey,
	intervalColumnDisplayXpath,
	linkColumnDisplayXpath,
	plainSelectDisplayXpath,
} from "../../suite/case-list/columns";
import { hqEnumPlaceholder } from "../../suite/case-list/orderPlanOptions";
import { casePropertyPath } from "../../suite/wire";
import type { FormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import type { WireExpr } from "../../xpath/wire/tree";
import { applicationReading } from "../appShell";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { heldText, recordTextRewrite } from "../heldText";
import { dotInterpolate } from "../hqInterpolation";
import { HQ_PAGE_LABELS } from "../hqPageLabels";
import { shownText } from "../hqText";
import { isJsonObject, type JsonCursor, sameJson } from "../jsonCursor";
import { pendingPlaceholder, type ReadMode } from "../pendingExpressions";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { readMediaMap } from "../xform/media";

const A = "menus-and-case-lists/";

export const COLUMN_CLAIMS = defineClaims("caseList.columns", {
	header: take(`${A}header`, "schema:DetailColumn.header"),
	modelProduct: refuse(`${A}model-product`, "schema:DetailColumn.model"),
	modelCase: derived(`${A}model-case`, "schema:DetailColumn.model"),
	field: take(
		`${A}field-property-paths-in-column-field-paths`,
		"schema:DetailColumn.field",
	),
	fieldInvalid: refuse(
		`${A}field-failing-details-utils-js-isvalidpropertyname-non`,
		"schema:DetailColumn.field",
	),
	fieldOutsideGrammar: refuse(
		`${A}column-field-outside-nova-s-property-grammar`,
		"schema:DetailColumn.field",
	),
	fieldCalculated: take(
		`${A}usexpathexpression-field-xpath-lifting-into-valueexpression`,
		"schema:DetailColumn.useXpathExpression",
	),
	fieldAttribute: take(
		`${A}usexpathexpression-field-reading-one-case-attribute`,
		"schema:DetailColumn.useXpathExpression",
	),
	fieldAttributeField: take(
		`${A}usexpathexpression-field-reading-one-case-attribute`,
		"schema:DetailColumn.field",
	),
	relationPath: refuse(
		`${A}idx-prop-parent-host-any-index-names-other-than-a-first-step`,
		"detail-field-type:property",
	),
	userProp: refuse(`${A}user-prop-usercase`, "detail-field-type:property"),
	userSteps: refuse(`${A}user-steps-prop`, "detail-field-type:property"),
	ownerName: refuse(`${A}owner-name`, "detail-field-type:property"),
	prefixed: refuse(
		`${A}property-x-or-prefix-x-with-a-prefix-hq-registers-no-generator`,
		"detail-field-type:property",
	),
	attachment: refuse(
		`${A}attachment-name-with-any-other-format`,
		"detail-field-type:attachment",
	),
	ledger: refuse(`${A}ledger-section`, "detail-field-type:ledger"),
	location: refuse(`${A}location-type`, "detail-field-type:location"),
	schedule: refuse(`${A}schedule-var`, "detail-field-type:schedule"),
	callCenter: refuse(
		`${A}indicator-call-center-name`,
		"detail-field-type:indicator",
	),
	indicator: refuse(
		`${A}indicator-any-other-set-name`,
		"detail-field-type:indicator",
	),
	plain: take(
		`${A}1-plain-over-a-property-that-is-not-a-select-with-options`,
		"schema:DetailColumn.format",
	),
	plainSelect: refuse(
		`${A}1p-plain-over-a-property-select-questions-write`,
		"schema:DetailColumn.format",
	),
	date: take(
		`${A}2-date-date-format-d-m-y-d-m-y-m-d-y-m-d-y-b-d-y`,
		"schema:DetailColumn.format",
	),
	datePattern: take(
		`${A}2-date-date-format-d-m-y-d-m-y-m-d-y-m-d-y-b-d-y`,
		"schema:DetailColumn.date_format",
	),
	dateOther: refuse(
		`${A}2p-date-any-other-date-format`,
		"schema:DetailColumn.date_format",
	),
	timeAgo: refuse(
		`${A}3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
		"schema:DetailColumn.format",
	),
	timeAgoOther: refuse(
		`${A}3p-time-ago-other-interval`,
		"schema:DetailColumn.format",
	),
	timeAgoInterval: refuse(
		`${A}3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
		"schema:DetailColumn.time_ago_interval",
	),
	timeAgoOtherInterval: refuse(
		`${A}3p-time-ago-other-interval`,
		"schema:DetailColumn.time_ago_interval",
	),
	phone: take(`${A}4-phone`, "schema:DetailColumn.format"),
	enumFormat: take(`${A}5-enum-id-mapping`, "schema:DetailColumn.format"),
	enumMapping: take(`${A}5-enum-id-mapping`, "schema:DetailColumn.enum"),
	enumBlankKey: refuse(
		`${A}5pp-enum-key-that-is-empty-or-holds-whitespace`,
		"schema:DetailColumn.enum",
	),
	enumSpecialKey: refuse(
		`${A}5p-enum-key-containing`,
		"schema:DetailColumn.enum",
	),
	enumDuplicateKey: refuse(
		`${A}an-enum-enum-image-conditional-enum-or-translatable-enum-column`,
		"schema:DetailColumn.enum",
	),
	lateFlag: refuse(`${A}6-late-flag-late-flag-1`, "schema:DetailColumn.format"),
	lateFlagZero: refuse(
		`${A}6p-late-flag-late-flag-0`,
		"schema:DetailColumn.format",
	),
	lateFlagValue: refuse(
		`${A}6-late-flag-late-flag-1`,
		"schema:DetailColumn.late_flag",
	),
	lateFlagZeroValue: refuse(
		`${A}6p-late-flag-late-flag-0`,
		"schema:DetailColumn.late_flag",
	),
	invisible: take(
		`${A}7-invisible-search-only-on-the-case-list-outside-a-custom-tile`,
		"schema:DetailColumn.format",
	),
	invisibleLong: take(
		`${A}7p-invisible-on-the-case-detail-outside-a-data-tab-over-a`,
		"schema:DetailColumn.format",
	),
	invisibleInTile: refuse(
		`${A}invisible-or-address-column-in-a-custom-tile`,
		"schema:DetailColumn.format",
	),
	address: refuse(`${A}8-address`, "schema:DetailColumn.format"),
	distance: refuse(`${A}9-distance`, "schema:DetailColumn.format"),
	markdownLink: take(
		`${A}10-markdown-any-property-or-expression`,
		"schema:DetailColumn.format",
	),
	markdownOther: refuse(
		`${A}10-markdown-outside-the-link-shape`,
		"schema:DetailColumn.format",
	),
	geoBoundary: refuse(`${A}11-geo-boundary`, "schema:DetailColumn.format"),
	geoBoundaryColor: refuse(
		`${A}12-geo-boundary-color-on-the-case-list-only-needs-an-address`,
		"schema:DetailColumn.format",
	),
	geoPoints: refuse(
		`${A}13-geo-points-on-the-case-list-only`,
		"schema:DetailColumn.format",
	),
	geoPointsColors: refuse(
		`${A}14-geo-points-colors-on-the-case-list-only-needs-an-address`,
		"schema:DetailColumn.format",
	),
	geoOnDetail: take(
		`${A}a-geo-column-on-the-case-detail-beside-the-column-it-depends-on`,
		"schema:DetailColumn.format",
	),
	geoWithout: refuse(
		`${A}a-geo-column-without-the-column-it-depends-on`,
		"schema:DetailColumn.format",
	),
	severalOfOneFormat: refuse(
		`${A}more-than-one-address-column-or-more-than-one-image-or-geo`,
		"schema:DetailColumn.format",
	),
	severalAddressAdvanced: refuse(
		`${A}more-than-one-address-column-in-a-detail-of-an-advanced-module`,
		"schema:DetailColumn.format",
	),
	severalImageGeoAdvanced: refuse(
		`${A}more-than-one-image-or-geo-column-of-the-same-format-in-a-detail`,
		"schema:DetailColumn.format",
	),
	addressPopup: refuse(`${A}15-address-popup`, "schema:DetailColumn.format"),
	clickableIcon: refuse(
		`${A}16-clickable-icon-endpoint-action-id-on-the-case-list`,
		"schema:DetailColumn.format",
	),
	clickableIconEmpty: refuse(
		`${A}16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case`,
		"schema:DetailColumn.format",
	),
	clickableIconLong: refuse(
		`${A}16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint`,
		"schema:DetailColumn.format",
	),
	picture: refuse(`${A}17-picture`, "schema:DetailColumn.format"),
	audio: refuse(`${A}18-audio`, "schema:DetailColumn.format"),
	enumImage: take(
		`${A}19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a`,
		"schema:DetailColumn.format",
	),
	enumImageMapping: take(
		`${A}19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a`,
		"schema:DetailColumn.enum",
	),
	enumImageValue: take(
		`${A}19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a`,
		"schema:MappingItem.value",
	),
	projectionXpath: take(
		`${A}usexpathexpression-field-xpath-lifting-into-valueexpression`,
		"schema:DetailColumn.useXpathExpression",
	),
	projectionField: take(
		`${A}usexpathexpression-field-xpath-lifting-into-valueexpression`,
		"schema:DetailColumn.field",
	),
	enumImagePlain: refuse(
		`${A}19-enum-image-whose-keys-are-plain-values`,
		"schema:DetailColumn.format",
	),
	enumImageOther: refuse(
		`${A}19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot`,
		"schema:DetailColumn.format",
	),
	conditionalEnum: refuse(
		`${A}20-conditional-enum`,
		"schema:DetailColumn.format",
	),
	translatableEnum: take(
		`${A}21-translatable-enum-authored`,
		"schema:DetailColumn.format",
	),
	translatableEnumMapping: take(
		`${A}21-translatable-enum-authored`,
		"schema:DetailColumn.enum",
	),
	translatableEnumOther: refuse(
		`${A}21-translatable-enum-outside-nova-s-two-projections`,
		"schema:DetailColumn.format",
	),
	translatableEnumKey: refuse(
		`${A}21p-translatable-enum-key-outside-a-za-z0-9`,
		"schema:DetailColumn.enum",
	),
	translatableEnumOwn: refuse(
		`${A}translatable-enum-on-a-column-that-is-not-a-calculated-property-over-a-property`,
		"schema:DetailColumn.format",
	),
	translatableEnumRelationOffers: refuse(
		`${A}translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-offers`,
		"schema:DetailColumn.format",
	),
	translatableEnumRelationDoes: refuse(
		`${A}translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-does`,
		"schema:DetailColumn.format",
	),
	graph: refuse(`${A}22-graph`, "schema:DetailColumn.format"),
	image: refuse(`${A}23-image-cc-case-image`, "schema:DetailColumn.format"),
	filterInert: drop(
		`${A}24-filter-other-than-the-first-column-of-a-short-detail-with-no`,
		"schema:DetailColumn.format",
	),
	filterRefused: refuse(
		`${A}24p-filter-otherwise`,
		"schema:DetailColumn.format",
	),
	unregistered: take(
		`${A}unregistered-format-slug-incl-nova-s-own-calculate`,
		"schema:DetailColumn.format",
	),
	altTextBlank: derived(
		`${A}enum-mappingitem-alt-text-lang`,
		"schema:MappingItem.alt_text",
	),
	altText: refuse(
		`${A}enum-mappingitem-alt-text-non-blank`,
		"schema:MappingItem.alt_text",
	),
	altTextNoImage: drop(
		`${A}mappingitem-alt-text-on-a-format-that-builds-no-image`,
		"schema:MappingItem.alt_text",
	),
	tileFieldInert: drop(
		`${A}case-tile-field-blank-or-off-a-template-tile`,
		"schema:DetailColumn.case_tile_field",
	),
	graphNull: drop(
		`${A}graph-configuration-null`,
		"schema:DetailColumn.graph_configuration",
	),
	graphOther: drop(
		`${A}graph-configuration-non-empty-on-any-other-column`,
		"schema:DetailColumn.graph_configuration",
	),
	filterXpath: drop(`${A}filter-xpath`, "schema:DetailColumn.filter_xpath"),
	advanced: drop(`${A}advanced`, "schema:DetailColumn.advanced"),
	bookkeeping: drop(
		`${A}ui-bookkeeping-keys-hasautocomplete-calc-xpath-istab-hasnodeset`,
		"schema:DetailColumn.<undeclared>",
	),
	dateFormatElsewhere: drop(
		`${A}format-extras-the-column-editor-saves-on-every-column`,
		"schema:DetailColumn.date_format",
	),
	lateFlagElsewhere: drop(
		`${A}format-extras-the-column-editor-saves-on-every-column`,
		"schema:DetailColumn.late_flag",
	),
	timeAgoElsewhere: drop(
		`${A}format-extras-the-column-editor-saves-on-every-column`,
		"schema:DetailColumn.time_ago_interval",
	),
	enumElsewhere: drop(
		`${A}format-extras-the-column-editor-saves-on-every-column`,
		"schema:DetailColumn.enum",
	),
	caseIdElement: refuse(
		`${A}case-id-as-a-property-column-s-field`,
		"detail-field-type:property",
	),
	optimization: refuse(
		`${A}optimization-cache-lazy-load-cache-and-lazy-load`,
		"schema:DetailColumn.optimization",
	),
	endpointOnImage: drop(
		`${A}enum-image-column-carrying-an-endpoint-action-id-on-the-case`,
		"schema:DetailColumn.endpoint_action_id",
	),
	endpointOther: drop(
		`${A}a-column-of-a-format-other-than-clickable-icon-or-enum-image`,
		"schema:DetailColumn.endpoint_action_id",
	),
	endpointOnList: refuse(
		`${A}a-case-list-column-of-any-format-carrying-an-endpoint-action-id`,
		"schema:DetailColumn.endpoint_action_id",
	),
	undeclared: refuse(
		`${A}any-other-undeclared-key`,
		"schema:DetailColumn.<undeclared>",
	),
});

const C = COLUMN_CLAIMS;

/** HQ's build reads these column fields as other properties
 *  (`detail_screen.py::CASE_PROPERTY_MAP`); Nova names each by its own name. */
export const HQ_PROPERTY_RENAMES: Readonly<Record<string, string>> = {
	"external-id": "external_id",
	"date-opened": "date_opened",
	status: "status",
	name: "case_name",
	owner_id: "owner_id",
};

/** The three case attributes a Nova column reads as `@<name>`. */
const ATTRIBUTE_PROPERTIES = new Set(["case_id", "owner_id", "status"]);

/** The bookkeeping keys of HQ's column editor, which no build reads. */
const BOOKKEEPING_KEYS = [
	"hasAutocomplete",
	"calc_xpath",
	"isTab",
	"hasNodeset",
	"nodeset",
	"relevant",
];

/** The intervals HQ's Time Since or Until Date menu offers, in days
 *  (`static/app_manager/js/details/utils.js::TIME_AGO`, the menu in
 *  `details/bootstrap5/column.js`): years, months, weeks and days since; days, weeks and months
 *  until. */
const TIME_AGO_MENU: readonly number[] = [
	365.25,
	365.25 / 12,
	7,
	1,
	-1,
	-7,
	-365.25 / 12,
];

/** The formats a geo format needs beside it in its detail
 *  (`static/app_manager/js/details/utils.js::COLUMN_FORMAT_DEPENDENCIES`). */
const GEO_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
	"geo-boundary": ["address"],
	"geo-points": ["address"],
	"geo-boundary-color": ["address", "geo-boundary"],
	"geo-points-colors": ["address", "geo-points"],
};

/** The formats whose column HQ's build reads `enum` for (`detail_screen.py::Enum` and its
 *  subclasses; `app_strings.py::_create_module_details_app_strings`). */
const MAPPING_FORMATS: ReadonlySet<string> = new Set([
	"enum",
	"conditional-enum",
	"enum-image",
	"clickable-icon",
	"translatable-enum",
]);

/** Whether HQ's build reads a column's `enum` under `format`. */
export function formatReadsMapping(format: string): boolean {
	return MAPPING_FORMATS.has(format);
}

/**
 * The format HQ's build reads a stored column under, as the reading reads it on `screen`: a slug
 * HQ registers no class for is `plain` (`detail_screen.py::get_class_for_format`), and on the
 * case detail `invisible` and a geo format hide nothing (`HideShortColumn` hides only a list
 * column), so each is `plain` there too. Every other format is its own.
 */
export function columnFormatAsRead(
	stored: unknown,
	screen: "short" | "long",
): string {
	const format = typeof stored === "string" ? stored : "plain";
	if (!REGISTERED_FORMATS.has(format)) return "plain";
	if (
		screen === "long" &&
		(format === "invisible" || GEO_DEPENDENCIES[format] !== undefined)
	)
		return "plain";
	return format;
}

/** The formats HQ's Case List and Case Detail saves admit once per detail (`screen.js::save`). */
const ONCE_PER_DETAIL = new Set(["image", ...Object.keys(GEO_DEPENDENCIES)]);

/** Keys every column's reading takes or drops by its own row. */
const CELL_KEYS = [
	"grid_x",
	"grid_y",
	"width",
	"height",
	"horizontal_align",
	"vertical_align",
	"font_size",
	"show_border",
	"show_shading",
];

/** A calculated column's text, registered once the column's identity is minted. */
export interface ColumnExpressionSource {
	readonly text: string;
	readonly at: { readonly json: JsonCursor; readonly key: string };
	readonly mode: ReadMode;
	readonly place: HqPlace;
	readonly key: string;
}

/** `Omit` over each arm of a union. */
type ArmOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A column's body: its kind and the kind's own slots, less what the join, the order and the
 *  tile set. */
export type ColumnBody = ArmOmit<
	Column,
	"uuid" | "sort" | "tile" | "visibleInList" | "visibleInDetail" | "notOnList"
>;

/** One detail column as the Nova column it would be, before the two details are joined. */
export interface ColumnProposal {
	/** The column less the slots the join, the order and the tile set: its kind, its `field` or
	 *  expression (a calculated column at `pendingPlaceholder`), its header's source text, its
	 *  kind's own slots. */
	readonly column: ColumnBody;
	/** The header in every app language, for the join's equality and the translation sink. */
	readonly header: Readonly<Record<string, string>>;
	/** Each mapping label of an ID mapping, and an interval's text, in every app language, by
	 *  the mapping's value (`""` for the interval's text). */
	readonly texts: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** A calculated column's expression, registered by the join once the column is minted. */
	readonly expression?: ColumnExpressionSource;
	/** True for an `invisible` short column, which joins by `field` alone. */
	readonly invisible: boolean;
	/** The cursor the column was read from, for the tile and the comparison. */
	readonly json: JsonCursor;
	/** For a plain column read from Nova's label projection of a select property, the property's
	 *  kind and choices the projection holds: each value with its label in every app language. */
	readonly choices?: SelectChoices;
}

/** A select property's kind and choices, as a column's label projection holds them. */
export interface SelectChoices {
	readonly dataType: "single_select" | "multi_select";
	readonly options: readonly {
		readonly value: string;
		readonly labels: Readonly<Record<string, string>>;
	}[];
}

/** A `{lang: text}` map, every value a string. */
export function languageMap(value: unknown): Record<string, string> {
	if (!isJsonObject(value)) return {};
	const out: Record<string, string> = {};
	for (const [lang, text] of Object.entries(value))
		if (typeof text === "string") out[lang] = text;
	return out;
}

/**
 * A stored `{lang: text}` app string (a column's header, a mapping entry's label or image path,
 * a sort element's label) as HQ's build shows it in each of the app's languages, `codes`
 * (`hqText.ts::shownText`): a language the map lacks, or holds blank, shows another language's
 * text, so the map is read as built and never taken literally. `undefined` where the build
 * prints a value whose text the reader cannot know (a number, an object), or the stored value is
 * no map.
 */
export function shownTexts(
	stored: unknown,
	codes: readonly string[],
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const code of codes) {
		const shown = shownText(stored, code, codes);
		if (!shown.ok) return undefined;
		out[code] = shown.text;
	}
	return out;
}

/** A stored app string as a reading holds it in each app language (`heldTextsIn`). */
export interface HeldTexts {
	/** By language code, the text Nova prints there: the language's own held text where it
	 *  differs from the source's, else the source's (`heldText.ts::heldText`). */
	readonly texts: Readonly<Record<string, string>>;
	/** Whether a worker reads another text in some language after the first publish. */
	readonly workersSeeAnother: boolean;
}

/**
 * A stored `{lang: text}` app string of role `role` as a reading holds it in each of the app's
 * languages `codes`, with `source` the source language's code: the text HQ's build shows there
 * (`shownTexts`), held as every app string is (`heldText.ts::heldText`: no space at either end,
 * and no blank-looking translation beside a source that holds text where the role requires
 * text). `undefined` where the build prints a value whose text the reader cannot know, or Nova's
 * gate admits no spelling of a text.
 */
export function heldTextsIn(
	stored: unknown,
	codes: readonly string[],
	source: string | undefined,
	role: TranslationUnitRole,
): HeldTexts | undefined {
	const shown = shownTexts(stored, codes);
	if (shown === undefined) return undefined;
	if (source === undefined) return { texts: shown, workersSeeAnother: false };
	const held = heldText(shown, codes, source, role);
	return held === undefined
		? undefined
		: { texts: held.printed, workersSeeAnother: held.workersSeeAnother };
}

/** Whether a reading holds two stored app strings of role `role` alike in every app language
 *  (`heldTextsIn`). */
export function sameHeldTexts(
	codes: readonly string[],
	source: string | undefined,
	role: TranslationUnitRole,
	a: unknown,
	b: unknown,
): boolean {
	const left = heldTextsIn(a, codes, source, role);
	const right = heldTextsIn(b, codes, source, role);
	return (
		left !== undefined &&
		right !== undefined &&
		codes.every((code) => left.texts[code] === right.texts[code])
	);
}

/**
 * Records the first publish's rewrite of a stored app string the reading read as `read`: Nova
 * writes each language's held text under its own code, so a map that lacks a language, holds one
 * blank, holds a code the app does not list, or holds a text with a space at either end, is
 * written another way, under `list-settings-respelled` where every language shows what it
 * showed and `text-spaces-dropped` where a worker reads another text
 * (`heldText.ts::recordTextRewrite`).
 */
export function noteRespelled(
	ctx: ReadContext,
	entry: string,
	path: string,
	stored: unknown,
	read: HeldTexts | undefined,
): void {
	if (
		read !== undefined &&
		(read.workersSeeAnother || !sameJson(stored, read.texts))
	)
		recordTextRewrite(
			ctx,
			{ entry, path },
			"list-settings-respelled",
			read.workersSeeAnother,
		);
}

/** Whether HQ's build shows two stored `{lang: text}` app strings alike in every app language. */
export function sameShownTexts(
	codes: readonly string[],
	a: unknown,
	b: unknown,
): boolean {
	const left = shownTexts(a, codes);
	const right = shownTexts(b, codes);
	return (
		left !== undefined &&
		right !== undefined &&
		codes.every((code) => left[code] === right[code])
	);
}

/** The app's language codes in HQ's order. */
export function appCodes(ctx: ReadContext): readonly string[] {
	return applicationReading(ctx)?.languages.codes ?? [];
}

/**
 * The code of the reading's source language: the language whose text the document's own slots
 * hold, as the languages stage wrote it into the draft's localization. That is the app's first
 * language unless the first language translates one of Nova's own sentences
 * (`search/systemSentences.ts`); a draft with no localization holds English alone, its first.
 */
export function sourceCode(ctx: ReadContext): string | undefined {
	const codes = appCodes(ctx);
	const source = ctx.draft.localization?.sourceLanguage;
	const tags = applicationReading(ctx)?.languages.tagOf;
	if (source !== undefined && tags !== undefined)
		for (const code of codes) if (tags.get(code) === source) return code;
	return codes[0];
}

/** The text of `map` in the reading's source language. */
export function sourceText(
	ctx: ReadContext,
	map: Readonly<Record<string, string>>,
): string {
	const source = sourceCode(ctx);
	return source === undefined ? "" : (map[source] ?? "");
}

/** `map`'s text in each language of the app other than the source, by the language's tag: what a
 *  stage hands the translation sink. A code the reading named no language for holds none. */
export function translatedTexts<T>(
	ctx: ReadContext,
	map: Readonly<Record<string, T>>,
): Map<LanguageTag, T> {
	const tags = applicationReading(ctx)?.languages.tagOf;
	const source = sourceCode(ctx);
	return new Map(
		Object.entries(map).flatMap(([code, text]) => {
			const tag = tags?.get(code);
			return tag === undefined || code === source ? [] : [[tag, text] as const];
		}),
	);
}

function parse(text: string): FormSyntax | undefined {
	const read = readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

/** The one attribute a parsed field reads, `@case_id`, where it is exactly that. */
function oneAttribute(node: FormSyntax | undefined): string | undefined {
	if (node?.kind !== "axis" || node.axis !== "attribute") return undefined;
	const value = node.value;
	return value.kind === "name" && !value.wildcard ? value.name : undefined;
}

/** The one case attribute an expression column's text reads, `@case_id`, where that is all it reads. */
export function attributeOf(text: string): string | undefined {
	return oneAttribute(parse(text));
}

export type FieldClass =
	| { readonly kind: "property"; readonly name: string }
	| { readonly kind: "finding"; readonly claim: Claim<"refuse"> };

/** HQ's `details/utils.js::isValidPropertyName`, one word or a path of words. */
const HQ_WORD = "[a-zA-Z][\\w_-]*";
const HQ_PROPERTY_NAME = new RegExp(
	`^(${HQ_WORD}:)*(${HQ_WORD}\\/)*#?${HQ_WORD}$`,
);

/** The column field a property-backed column reads, classified by the rows of the field: also
 *  the field of the hidden column HQ's build appends for a sort element no column joins
 *  (`util.py::create_temp_sort_column`). */
export function classifyField(field: string): FieldClass {
	if (field === "#owner_name") return { kind: "finding", claim: C.ownerName };
	const colon = field.indexOf(":");
	if (colon > 0) {
		const prefix = field.slice(0, colon);
		const claim =
			prefix === "attachment"
				? C.attachment
				: prefix === "ledger"
					? C.ledger
					: prefix === "location"
						? C.location
						: prefix === "schedule"
							? C.schedule
							: prefix === "indicator"
								? field.startsWith("indicator:call_center")
									? C.callCenter
									: C.indicator
								: prefix === "property"
									? C.prefixed
									: C.prefixed;
		return { kind: "finding", claim };
	}
	if (field.startsWith("user/"))
		return {
			kind: "finding",
			claim: field.split("/").length > 2 ? C.userSteps : C.userProp,
		};
	if (field.includes("/")) return { kind: "finding", claim: C.relationPath };
	if (!HQ_PROPERTY_NAME.test(field))
		return { kind: "finding", claim: C.fieldInvalid };
	// HQ's page accepts a `#` before the last word and a name of any length;
	// Nova's property grammar takes neither.
	const renamed = HQ_PROPERTY_RENAMES[field] ?? field;
	// HQ's build reads a property field through `CASE_PROPERTY_MAP`, which maps `status` and
	// `owner_id` to their attributes and has no entry for `case_id`, so it reads the child element
	// `case_id`, which no case holds (Core holds the id as the attribute alone,
	// `CaseChildElement`): the column is blank for every case.
	if (renamed === "case_id") return { kind: "finding", claim: C.caseIdElement };
	if (
		!AUTHORED_CASE_PROPERTY_NAME_PATTERN.test(renamed) ||
		renamed.length > MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH
	)
		return { kind: "finding", claim: C.fieldOutsideGrammar };
	return { kind: "property", name: renamed };
}

/** Whether a property is one whose choices the reading's catalog keeps, so Nova's plain column
 *  over it shows the choice's label: a select question of the app's forms writes it, and a column
 *  of the app shows it by its choices' labels (`labelShownProperty`). */
export type SelectProperty = (property: string) => boolean;

/** The format words HQ registers a column class for (`detail_screen.py::register_format_type`). */
const REGISTERED_FORMATS = new Set([
	"plain",
	"date",
	"time-ago",
	"phone",
	"enum",
	"late-flag",
	"invisible",
	"address",
	"distance",
	"markdown",
	"geo-boundary",
	"geo-boundary-color",
	"geo-points",
	"geo-points-colors",
	"address-popup",
	"clickable-icon",
	"picture",
	"audio",
	"enum-image",
	"conditional-enum",
	"translatable-enum",
	"graph",
	"image",
	"filter",
]);

const FORMAT_FINDING: Readonly<Record<string, Claim<"refuse">>> = {
	address: C.address,
	distance: C.distance,
	"address-popup": C.addressPopup,
	picture: C.picture,
	audio: C.audio,
	"conditional-enum": C.conditionalEnum,
	graph: C.graph,
	image: C.image,
	"geo-boundary": C.geoBoundary,
	"geo-boundary-color": C.geoBoundaryColor,
	"geo-points": C.geoPoints,
	"geo-points-colors": C.geoPointsColors,
};

/** What `HQ_PAGE_LABELS` shows for a column's format, where HQ's page has a label for it. */
function formatName(format: string): { name: string } | undefined {
	const labels: Readonly<Record<string, string>> = HQ_PAGE_LABELS.columnFormat;
	const label = labels[format];
	return label === undefined ? undefined : { name: label };
}

/** One stored `enum` entry: its key, and its value as HQ's build shows it in each app language
 *  (`shownTexts`), `undefined` where the build prints a value the reader cannot know. */
interface EnumEntry {
	readonly key: unknown;
	readonly value: Readonly<Record<string, string>> | undefined;
}

/** The enum entries of a column, each value read in the app's languages `codes` with `source`
 *  the source language's code. */
function enumEntries(
	column: JsonCursor,
	codes: readonly string[],
	source?: string,
): readonly EnumEntry[] {
	return enumEntriesOf(column.peek("enum"), codes, source);
}

/** The entries of a stored `enum`, each value read in the app's languages `codes` as a reading
 *  holds a label (`heldTextsIn`): every text a mapping's value holds is a label or an interval's
 *  text, whose roles allow a blank translation alike. */
function enumEntriesOf(
	stored: unknown,
	codes: readonly string[],
	source?: string,
): readonly EnumEntry[] {
	if (!Array.isArray(stored)) return [];
	return stored.map((entry) => ({
		key: isJsonObject(entry) ? entry.key : undefined,
		value: heldTextsIn(
			isJsonObject(entry) ? entry.value : {},
			codes,
			source,
			"case-list-mapping-label",
		)?.texts,
	}));
}

/**
 * Claims one enum entry's `alt_text` as HQ's build shows it in each app language
 * (`app_strings.py`: `clean_trans(item.alt_text, langs)`, on an image map and a clickable icon
 * alone, the formats `detail_screen.py::EnumImage` builds an `<alt_text>` for): blank in every
 * language by its HELD row; on a format that builds no image, inert whatever it holds; with text
 * in any language by its finding (a `null` HQ prints `None`); and left unclaimed, for the close to
 * name, where the build prints a value the reader cannot know. Whether the entry's alt text is
 * Nova's.
 */
function claimAltText(
	item: JsonCursor,
	codes: readonly string[],
	buildsImage: boolean,
): boolean {
	const alt = shownTexts(item.peek("alt_text"), codes);
	if (
		alt !== undefined &&
		Object.values(alt).every((text) => text.trim() === "")
	)
		item.derived("alt_text", C.altTextBlank);
	else if (!buildsImage) item.drop("alt_text", C.altTextNoImage);
	else if (alt === undefined) return false;
	else {
		item.refuse("alt_text", C.altText);
		return false;
	}
	return true;
}

/**
 * Claims each ID mapping entry's `alt_text`, which HQ's build reads on no `enum` column
 * (`claimAltText`), and its key and value. A value whose shown text the reader cannot know is left unclaimed, for the close
 * to name at its entry.
 */
function claimAltTexts(
	ctx: ReadContext,
	column: JsonCursor,
	codes: readonly string[],
): boolean {
	let ok = true;
	for (const item of column.list("enum", "MappingItem", C.enumMapping)) {
		if (!claimAltText(item, codes, false)) ok = false;
		item.derived("key", derivedEnumKey);
		const value = heldTextsIn(
			item.peek("value"),
			codes,
			sourceCode(ctx),
			"case-list-mapping-label",
		);
		if (value === undefined) ok = false;
		else {
			item.derived("value", derivedEnumValue);
			noteRespelled(
				ctx,
				derivedEnumValue.entry,
				`${item.pointer}/value`,
				item.peek("value"),
				value,
			);
		}
	}
	return ok;
}

const ITEM_CLAIMS = defineClaims("caseList.columns.item", {
	key: derived(`${A}5-enum-id-mapping`, "schema:MappingItem.key"),
	value: derived(`${A}5-enum-id-mapping`, "schema:MappingItem.value"),
	imageKey: derived(
		`${A}19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a`,
		"schema:MappingItem.key",
	),
	labelKey: derived(
		`${A}21-translatable-enum-authored`,
		"schema:MappingItem.key",
	),
	labelValue: derived(
		`${A}21-translatable-enum-authored`,
		"schema:MappingItem.value",
	),
});
const derivedEnumKey = ITEM_CLAIMS.key;
const derivedEnumValue = ITEM_CLAIMS.value;

/** Claims a column's keys that no format reads: the inert ones, the bookkeeping ones, and the
 *  undeclared ones. The tile cell keys are `tile.ts`'s. */
function claimOtherKeys(
	column: JsonCursor,
	format: string,
	screen: "short" | "long",
): boolean {
	let ok = true;
	column.drop("filter_xpath", C.filterXpath);
	column.drop("advanced", C.advanced);
	column.drop("case_tile_field", C.tileFieldInert);
	column.drop(
		"graph_configuration",
		column.peek("graph_configuration") === null ? C.graphNull : C.graphOther,
	);
	for (const key of BOOKKEEPING_KEYS) column.drop(key, C.bookkeeping);
	// HQ's column editor saves every format's extra on every column (`column.js::serialize`); a
	// format that does not read one leaves it behind.
	if (format !== "date") column.drop("date_format", C.dateFormatElsewhere);
	if (format !== "late-flag") column.drop("late_flag", C.lateFlagElsewhere);
	if (format !== "time-ago")
		column.drop("time_ago_interval", C.timeAgoElsewhere);
	// The save writes the ID Mapping list too, which only the formats with a mapping read
	// (`detail_screen.py::Enum` and its subclasses, `app_strings.py`).
	if (!MAPPING_FORMATS.has(format)) column.drop("enum", C.enumElsewhere);
	if (column.used("optimization")) {
		column.refuse("optimization", C.optimization);
		ok = false;
	}
	if (column.used("endpoint_action_id")) {
		if (format === "enum-image")
			column.drop("endpoint_action_id", C.endpointOnImage);
		else if (format !== "clickable-icon" && screen === "long")
			column.drop("endpoint_action_id", C.endpointOther);
		else if (format !== "clickable-icon") {
			column.refuse("endpoint_action_id", C.endpointOnList);
			ok = false;
		}
	}
	const known = new Set([...BOOKKEEPING_KEYS, ...CELL_KEYS]);
	for (const key of column.undeclared()) {
		if (known.has(key)) continue;
		// A stored key is no word a person knows from HQ's pages, so the finding names nothing.
		column.refuse(key, C.undeclared);
		ok = false;
	}
	return ok;
}

/** The column's `{ field, useXpathExpression }` as a property name, an attribute, or text. */
function fieldOf(column: JsonCursor): { text: string; xpath: boolean } {
	const field = column.peek("field");
	return {
		text: typeof field === "string" ? field : "",
		xpath: column.peek("useXpathExpression") === true,
	};
}

/** What reading one column gives: the Nova column it would be, `"dropped"` where its row is an
 *  inert one that changes no build, or `undefined` where its row raised a finding. */
export type ColumnReading = ColumnProposal | "dropped" | undefined;

/** What a column's reading needs of its detail and its menu. */
export interface ColumnOptions {
	/** Whether a property is one whose choices the reading's catalog keeps. */
	readonly selectProperty: SelectProperty;
	/** Whether the short detail is a custom tile. */
	readonly inTile: boolean;
	/** How many columns of each format the detail holds. */
	readonly formats: ReadonlyMap<string, number>;
	/** Whether the menu is an advanced module. */
	readonly advanced: boolean;
	/** Whether the menu offers search (`util.py::module_offers_search`). */
	readonly offersSearch: boolean;
	/** For a `filter` column, whether it changes HQ's build of its detail. */
	readonly filterChangesBuild: boolean;
}

/** HQ's word for a column's property a relation path reads: `parent/prop`, `host/prop`. */
function isRelationPath(field: string): boolean {
	return (
		field.includes("/") && !field.startsWith("user/") && !field.includes(":")
	);
}

/** A non-calculated `translatable-enum` column, by its rows: a key outside the editor's grammar or
 *  two entries of one key first, then the property it reads. Always a finding. */
function readOwnTranslatableEnum(
	column: JsonCursor,
	field: string,
	offersSearch: boolean,
): undefined {
	const entries = enumEntries(column, []);
	if (
		entries.some(
			(entry) =>
				typeof entry.key !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.key),
		)
	) {
		column.refuse("enum", C.translatableEnumKey);
		return undefined;
	}
	const keys = entries.map((entry) => entry.key as string);
	if (new Set(keys).size !== keys.length) {
		column.refuse("enum", C.enumDuplicateKey);
		return undefined;
	}
	const named = field === "" ? undefined : { name: field.slice(0, 200) };
	if (!isRelationPath(field)) {
		const classified = classifyField(field);
		if (classified.kind === "finding") {
			column.refuse(
				"field",
				classified.claim,
				classified.claim === C.fieldInvalid ? undefined : named,
			);
			return undefined;
		}
	}
	column.take("field", C.field, String).value;
	column.refuse(
		"format",
		!isRelationPath(field)
			? C.translatableEnumOwn
			: offersSearch
				? C.translatableEnumRelationOffers
				: C.translatableEnumRelationDoes,
		named,
	);
	return undefined;
}

/**
 * One detail column as the Nova column it would be. `undefined` where the column's row raised a
 * finding, `"dropped"` where its row changes no build. `screen` is the detail it stands in.
 */
export function readDetailColumn(
	ctx: ReadContext,
	module: DraftModule,
	column: JsonCursor,
	screen: "short" | "long",
	options: ColumnOptions,
): ColumnReading {
	const codes = appCodes(ctx);
	// The header as HQ's build shows it in each language; one the reader cannot know is left
	// unclaimed, for the close to name, and the column is no proposal.
	const heldHeader = heldTextsIn(
		column.peek("header"),
		codes,
		sourceCode(ctx),
		"case-list-header",
	);
	const header = heldHeader?.texts;
	if (header !== undefined) {
		column.take("header", C.header, () => header).value;
		noteRespelled(
			ctx,
			C.header.entry,
			`${column.pointer}/header`,
			column.peek("header"),
			heldHeader,
		);
	}
	const place = column.place;
	if (column.peek("model") === "product") {
		column.refuse("model", C.modelProduct);
		return undefined;
	}
	/* A case list's column reads the case, which every column of the document does. */
	if (column.peek("model") === "case") column.derived("model", C.modelCase);
	const format =
		typeof column.peek("format") === "string"
			? (column.peek("format") as string)
			: "plain";
	const others = claimOtherKeys(column, format, screen) && header !== undefined;
	const field = fieldOf(column);
	const base = { header: sourceText(ctx, header ?? {}) };
	const proposal = (
		kind: ColumnProposal["column"],
		extra: Partial<
			Pick<ColumnProposal, "texts" | "expression" | "invisible">
		> = {},
	): ColumnProposal | undefined =>
		others
			? {
					column: kind,
					header: header ?? {},
					texts: extra.texts ?? {},
					...(extra.expression !== undefined && {
						expression: extra.expression,
					}),
					invisible: extra.invisible ?? false,
					json: column,
				}
			: undefined;

	// A calculated field: an expression column, an attribute, or one of Nova's two projections.
	// An `invisible` short column outside a custom tile reads its expression as a `plain` one does,
	// and stands on the list hidden: Nova writes a hidden calculated or attribute-backed field so.
	const hiddenOnList =
		format === "invisible" && screen === "short" && !options.inTile;
	if (field.xpath) {
		const tree = parse(field.text);
		const attribute = oneAttribute(tree);
		const formatClaim = hiddenOnList ? C.invisible : C.plain;
		if (
			(format === "plain" || hiddenOnList) &&
			attribute !== undefined &&
			ATTRIBUTE_PROPERTIES.has(attribute)
		) {
			column.take("useXpathExpression", C.fieldAttribute, Boolean).value;
			column.take("field", C.fieldAttributeField, String).value;
			column.take("format", formatClaim, String).value;
			return proposal(
				{
					kind: "plain",
					field: attribute,
					...base,
				} as ColumnProposal["column"],
				{ invisible: hiddenOnList },
			);
		}
		if (format === "plain" || hiddenOnList) {
			column.take("useXpathExpression", C.fieldCalculated, Boolean).value;
			column.take("format", formatClaim, String).value;
			return proposal(
				{
					kind: "calculated",
					...base,
					expression: pendingPlaceholder("value"),
				} as ColumnProposal["column"],
				{
					expression: {
						text: field.text,
						at: { json: column, key: "field" },
						mode: { target: "hq-json", interpolation: "none" },
						place,
						key: "schema:DetailColumn.field",
					},
					invisible: hiddenOnList,
				},
			);
		}
		if (format === "markdown" || format === "translatable-enum")
			return readProjection(
				ctx,
				column,
				format,
				field.text,
				header ?? {},
				base,
				others,
			);
	}

	if (format === "translatable-enum")
		return readOwnTranslatableEnum(column, field.text, options.offersSearch);

	if (format === "invisible" && screen === "long") {
		column.take("format", C.invisibleLong, String).value;
	} else if (format === "invisible" && options.inTile) {
		column.refuse("format", C.invisibleInTile, formatName(format));
		return undefined;
	}

	// A column of any other format over one case attribute: Nova writes a column over `case_id`,
	// `owner_id` or `status` as the expression `@<name>` with its kind's format.
	const attribute = field.xpath ? oneAttribute(parse(field.text)) : undefined;
	const classified: FieldClass =
		attribute !== undefined && ATTRIBUTE_PROPERTIES.has(attribute)
			? { kind: "property", name: attribute }
			: classifyField(field.text);
	if (classified.kind === "finding") {
		// A field HQ's page would not accept is no property name a person typed there, so it names nothing.
		const named = field.text !== "" && classified.claim !== C.fieldInvalid;
		column.refuse(
			"field",
			classified.claim,
			named ? { name: field.text.slice(0, 200) } : undefined,
		);
		return undefined;
	}
	if (attribute !== undefined && classified.name === attribute) {
		column.take("useXpathExpression", C.fieldAttribute, Boolean).value;
		column.take("field", C.fieldAttributeField, String).value;
	} else column.take("field", C.field, String).value;
	const name = classified.name;
	const fieldName = { name };

	switch (format) {
		case "plain": {
			// A property select questions write keeps no choices where no column shows their
			// labels (`details.ts::withholdRawShownChoices`), so a plain column over it shows its
			// values, as Nova writes one; where another column shows them, Nova's would too.
			if (options.selectProperty(name)) {
				column.refuse("format", C.plainSelect, fieldName);
				return undefined;
			}
			column.take("format", C.plain, String).value;
			return proposal({
				kind: "plain",
				field: name,
				...base,
			} as ColumnProposal["column"]);
		}
		case "invisible": {
			if (screen === "short") column.take("format", C.invisible, String).value;
			return proposal(
				{ kind: "plain", field: name, ...base } as ColumnProposal["column"],
				{
					invisible: screen === "short",
				},
			);
		}
		case "date": {
			const pattern = column.peek("date_format");
			if (
				typeof pattern !== "string" ||
				!COMMCARE_DATE_PATTERN_REGEX.test(pattern)
			) {
				column.refuse("date_format", C.dateOther, fieldName);
				return undefined;
			}
			column.take("format", C.date, String).value;
			column.take("date_format", C.datePattern, String).value;
			return proposal({
				kind: "date",
				field: name,
				pattern,
				...base,
			} as ColumnProposal["column"]);
		}
		case "phone":
			column.take("format", C.phone, String).value;
			return proposal({
				kind: "phone",
				field: name,
				...base,
			} as ColumnProposal["column"]);
		case "enum":
			return readIdMapping(ctx, column, name, base, proposal);
		case "enum-image":
			return readImageMap(ctx, module, column, name, base, proposal);
		case "late-flag": {
			const flag = column.peek("late_flag");
			const zero = typeof flag === "number" && flag <= 0;
			column.refuse(
				"format",
				zero ? C.lateFlagZero : C.lateFlag,
				formatName(format),
			);
			column.refuse(
				"late_flag",
				zero ? C.lateFlagZeroValue : C.lateFlagValue,
				formatName(format),
			);
			return undefined;
		}
		case "time-ago": {
			const interval = column.peek("time_ago_interval");
			const onMenu =
				typeof interval === "number" && TIME_AGO_MENU.includes(interval);
			column.refuse(
				"format",
				onMenu ? C.timeAgo : C.timeAgoOther,
				formatName(format),
			);
			column.refuse(
				"time_ago_interval",
				onMenu ? C.timeAgoInterval : C.timeAgoOtherInterval,
				formatName(format),
			);
			return undefined;
		}
		case "clickable-icon":
			column.refuse(
				"format",
				screen === "long"
					? C.clickableIconLong
					: column.peek("endpoint_action_id") === "" ||
							column.peek("endpoint_action_id") == null
						? C.clickableIconEmpty
						: C.clickableIcon,
				formatName(format),
			);
			return undefined;
		case "markdown":
			column.refuse("format", C.markdownOther, formatName(format));
			return undefined;
		case "filter":
			// HQ's build writes no field for it (`detail_screen.py::Filter`); the detail decides
			// whether it moves the default sort, a sort element, a calculated column's index or a
			// template tile's slot.
			if (options.filterChangesBuild) {
				column.refuse("format", C.filterRefused, fieldName);
				return undefined;
			}
			column.drop("format", C.filterInert);
			return others ? "dropped" : undefined;
	}
	// Several of a format HQ admits once per detail: refused before the format's own row.
	const count = options.formats.get(format) ?? 0;
	if (count > 1 && (format === "address" || ONCE_PER_DETAIL.has(format))) {
		column.refuse(
			"format",
			!options.advanced
				? C.severalOfOneFormat
				: format === "address"
					? C.severalAddressAdvanced
					: C.severalImageGeoAdvanced,
			formatName(format),
		);
		return undefined;
	}
	const dependencies = GEO_DEPENDENCIES[format];
	if (dependencies !== undefined) {
		if (dependencies.some((one) => (options.formats.get(one) ?? 0) === 0)) {
			column.refuse("format", C.geoWithout, formatName(format));
			return undefined;
		}
		if (screen === "long") {
			column.take("format", C.geoOnDetail, String).value;
			return proposal({
				kind: "plain",
				field: name,
				...base,
			} as ColumnProposal["column"]);
		}
	}
	if (format === "address" && options.inTile && screen === "short") {
		column.refuse("format", C.invisibleInTile, formatName(format));
		return undefined;
	}
	const finding = FORMAT_FINDING[format];
	if (finding !== undefined) {
		column.refuse("format", finding, formatName(format));
		return undefined;
	}
	if (!REGISTERED_FORMATS.has(format)) {
		column.take("format", C.unregistered, String).value;
		return proposal({
			kind: "plain",
			field: name,
			...base,
		} as ColumnProposal["column"]);
	}
	ctx.accounting.circumstance("unrecognized", place, {
		name: "schema:DetailColumn.format",
	});
	return undefined;
}

/** A key HQ's enum editor admits: one word with none of `& < > " '`. */
function enumKeyProblem(key: unknown): "blank" | "special" | undefined {
	if (typeof key !== "string" || key.trim() === "" || /\s/.test(key))
		return "blank";
	if (/[&<>"']/.test(key)) return "special";
	return undefined;
}

function readIdMapping(
	ctx: ReadContext,
	column: JsonCursor,
	field: string,
	base: { header: string },
	proposal: (
		column: ColumnProposal["column"],
		extra?: Partial<Pick<ColumnProposal, "texts">>,
	) => ColumnProposal | undefined,
): ColumnProposal | undefined {
	const codes = appCodes(ctx);
	const entries = enumEntries(column, codes, sourceCode(ctx));
	const seen = new Set<string>();
	for (const entry of entries) {
		const problem = enumKeyProblem(entry.key);
		if (problem !== undefined) {
			column.refuse(
				"enum",
				problem === "blank" ? C.enumBlankKey : C.enumSpecialKey,
				{ name: field },
			);
			return undefined;
		}
		if (seen.has(entry.key as string)) {
			column.refuse("enum", C.enumDuplicateKey, { name: field });
			return undefined;
		}
		seen.add(entry.key as string);
	}
	column.take("format", C.enumFormat, String).value;
	if (!claimAltTexts(ctx, column, codes)) return undefined;
	const texts: Record<string, Readonly<Record<string, string>>> = {};
	for (const entry of entries) texts[entry.key as string] = entry.value ?? {};
	return proposal(
		{
			kind: "id-mapping",
			field,
			...base,
			mapping: entries.map((entry) => ({
				value: entry.key as string,
				label: sourceText(ctx, entry.value ?? {}),
			})),
		} as ColumnProposal["column"],
		{ texts },
	);
}

/** The text of a column's property as HQ's build substitutes it into each image map key
 *  (`detail_screen.py::Enum._template_xpath`, `models/case_list.py::MappingItem.key_as_condition`). */
export function imageMapPropertyText(field: string): string {
	return hqXPathText(hqXPath(casePropertyPath(field)));
}

/**
 * The value an image map's key selects, where the key is the condition Nova writes for some value:
 * the key and Nova's key for that value, each with its dots put to the column's property as HQ's
 * build puts them (`dot_interpolate`), are one tree. The value is proposed from the interpolated
 * key's own `selected(…, '<value>')` and confirmed by printing Nova's key back.
 */
function selectedValue(key: string, property: string): string | undefined {
	const interpolated = dotInterpolate(key, property);
	const node = parse(interpolated);
	if (
		node?.kind !== "call" ||
		node.name !== "selected" ||
		node.args.length !== 2
	)
		return undefined;
	const value = literalText(node.args[1]);
	if (value === undefined) return undefined;
	return sameXPathText(
		interpolated,
		dotInterpolate(imageMapEnumKey(value), property),
	)
		? value
		: undefined;
}

/** The text a string literal spells, or a `concat` of string literals, which is how a literal
 *  holding both quote marks is printed. */
function literalText(node: FormSyntax | undefined): string | undefined {
	if (node?.kind === "string") return node.value;
	if (node?.kind !== "call" || node.name !== "concat") return undefined;
	let out = "";
	for (const arg of node.args) {
		const part = literalText(arg);
		if (part === undefined) return undefined;
		out += part;
	}
	return out;
}

function readImageMap(
	ctx: ReadContext,
	_module: DraftModule,
	column: JsonCursor,
	field: string,
	base: { header: string },
	proposal: (column: ColumnProposal["column"]) => ColumnProposal | undefined,
): ColumnProposal | undefined {
	const codes = appCodes(ctx);
	const entries = enumEntries(column, []);
	const values: string[] = [];
	for (const entry of entries) {
		if (typeof entry.key !== "string") {
			column.refuse("format", C.enumImageOther, { name: field });
			return undefined;
		}
		const value = selectedValue(entry.key, imageMapPropertyText(field));
		if (value === undefined) {
			const plain = parse(entry.key);
			column.refuse(
				"format",
				plain === undefined || plain.kind === "name" || plain.kind === "number"
					? C.enumImagePlain
					: C.enumImageOther,
				{ name: field },
			);
			return undefined;
		}
		if (values.includes(value)) {
			column.refuse("enum", C.enumDuplicateKey, { name: field });
			return undefined;
		}
		values.push(value);
	}
	column.take("format", C.enumImage, String).value;
	const items = column.list("enum", "MappingItem", C.enumImageMapping);
	const mapping: { value: string; assetId: string }[] = [];
	let ok = true;
	items.forEach((item, index) => {
		item.derived("key", ITEM_CLAIMS.imageKey);
		if (!claimAltText(item, codes, true)) ok = false;
		const asset = readImageAsset(ctx, item);
		const value = values[index];
		if (asset === undefined || value === undefined) ok = false;
		else mapping.push({ value, assetId: asset });
	});
	if (!ok) return undefined;
	return proposal({
		kind: "image-map",
		field,
		...base,
		mapping,
	} as ColumnProposal["column"]);
}

/** The asset of one image map entry's `{lang: jr://...}` map, through the media reader. */
function readImageAsset(
	ctx: ReadContext,
	item: JsonCursor,
): string | undefined {
	// Each language's image as HQ's build writes its app string, so a path stored in one
	// language is the image of every language.
	// A path the reader cannot know is left unclaimed, for the close to name at the entry.
	const shown = shownTexts(item.peek("value"), appCodes(ctx));
	if (shown === undefined) return undefined;
	const read = readMediaMap(ctx, shown, {
		site: { json: item, key: "value" },
		place: item.place,
		slot: "image_map_mapping",
		mediaKind: "image",
	});
	if (read.kind !== "asset") return undefined;
	item.take("value", C.enumImageValue, languageMap).value;
	// A path is no text: it is held as shown, and no worker reads another.
	noteRespelled(
		ctx,
		C.enumImageValue.entry,
		`${item.pointer}/value`,
		item.peek("value"),
		{ texts: shown, workersSeeAnother: false },
	);
	return read.assetId;
}

/** The printed text of a wire tree, as HQ JSON holds it. */
function printed(expression: WireExpr): string {
	return hqXPathText(hqXPath(expression));
}

/** Every string literal and number literal of a tree, and the case properties it reads, in
 *  document order. */
function literalsOf(node: FormSyntax | undefined): {
	strings: string[];
	numbers: number[];
	properties: string[];
} {
	const out = {
		strings: [] as string[],
		numbers: [] as number[],
		properties: [] as string[],
	};
	const walk = (at: FormSyntax | undefined): void => {
		if (at === undefined) return;
		switch (at.kind) {
			case "string":
				out.strings.push(at.value);
				return;
			case "number":
				out.numbers.push(at.value);
				return;
			case "name":
				if (!at.wildcard) out.properties.push(at.name);
				return;
			case "axis": {
				const attribute = oneAttribute(at);
				if (attribute !== undefined) out.properties.push(attribute);
				return;
			}
			case "group":
			case "negative":
				walk(at.value);
				return;
			case "child":
				walk(at.left);
				walk(at.step);
				return;
			case "filter":
				walk(at.base);
				walk(at.where);
				return;
			case "binary":
				walk(at.left);
				walk(at.right);
				return;
			case "call":
				for (const arg of at.args) walk(arg);
				return;
		}
	};
	walk(node);
	return out;
}

/** The link column `text` reads back into, where `linkColumnDisplayXpath` writes the text. */
function linkCandidate(
	text: string,
): ArmOmit<Extract<ColumnBody, { kind: "link" }>, "header"> | undefined {
	const tree = parse(text);
	const { strings, properties } = literalsOf(tree);
	const field = properties[0];
	const open = strings.find((one) => one.startsWith("[") && one.endsWith("]("));
	if (field === undefined || open === undefined) return undefined;
	const linkText = open.slice(1, -2);
	const back = printed(
		linkColumnDisplayXpath(casePropertyPath(field), linkText),
	);
	return sameXPathText(back, text)
		? { kind: "link", field, linkText }
		: undefined;
}

/** The interval column `text` reads back into, the first candidate `intervalColumnDisplayXpath`
 *  writes back as the stored text. */
function intervalCandidate(
	text: string,
	stored: string,
): ArmOmit<Extract<ColumnBody, { kind: "interval" }>, "header"> | undefined {
	const { numbers, properties } = literalsOf(parse(text));
	const field = properties[0];
	if (field === undefined) return undefined;
	for (const display of INTERVAL_DISPLAYS)
		for (const unit of TIME_SINCE_UNITS)
			for (const number of numbers)
				for (const threshold of new Set([
					number,
					number / TIME_SINCE_UNIT_DAYS[unit],
				])) {
					if (!Number.isInteger(threshold) || threshold < 0) continue;
					const candidate = {
						kind: "interval" as const,
						field,
						threshold,
						unit,
						display,
						text: stored,
					};
					const column = {
						...candidate,
						uuid: "" as Column["uuid"],
						header: "",
					};
					if (
						sameXPathText(
							printed(intervalColumnDisplayXpath(column, w.hqEnumVar(0))),
							text,
						)
					)
						return candidate;
				}
	return undefined;
}

/** A calculated `markdown` or `translatable-enum` column, read as one of Nova's projections:
 *  a link, an interval, or a plain column over a select property with the choices its label
 *  projection holds (which the comparison of the whole menu holds against the catalog). */
function readProjection(
	ctx: ReadContext,
	column: JsonCursor,
	format: "markdown" | "translatable-enum",
	text: string,
	header: Readonly<Record<string, string>>,
	base: { header: string },
	others: boolean,
): ColumnProposal | undefined {
	const codes = appCodes(ctx);
	const entries = enumEntries(column, codes, sourceCode(ctx));
	let candidate: ArmOmit<ColumnBody, "header"> | undefined;
	let choices: SelectChoices | undefined;
	const texts: Record<string, Readonly<Record<string, string>>> = {};
	if (format === "markdown") candidate = linkCandidate(text);
	else {
		if (
			entries.some(
				(entry) =>
					typeof entry.key !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.key),
			)
		) {
			column.refuse("enum", C.translatableEnumKey);
			return undefined;
		}
		const first = entries[0];
		if (entries.length === 1 && first?.value !== undefined) {
			candidate = intervalCandidate(text, sourceText(ctx, first.value));
			if (candidate !== undefined) texts[""] = first.value;
		}
		if (candidate === undefined) {
			const select = selectLabelCandidate(text, entries);
			if (select !== undefined) {
				candidate = { kind: "plain", field: select.field };
				choices = {
					dataType: select.dataType,
					options: select.values.map((value, index) => ({
						value,
						labels: entries[index]?.value ?? {},
					})),
				};
			}
		}
	}
	if (candidate === undefined) {
		column.refuse(
			"format",
			format === "markdown" ? C.markdownOther : C.translatableEnumOther,
			formatName(format),
		);
		return undefined;
	}
	column.take("useXpathExpression", C.projectionXpath, Boolean).value;
	column.take("field", C.projectionField, String).value;
	if (format === "markdown")
		column.take("format", C.markdownLink, String).value;
	else {
		column.take("format", C.translatableEnum, String).value;
		for (const item of column.list(
			"enum",
			"MappingItem",
			C.translatableEnumMapping,
		)) {
			item.derived("key", ITEM_CLAIMS.labelKey);
			// A label whose shown text the reader cannot know is left for the close to name.
			const value = heldTextsIn(
				item.peek("value"),
				codes,
				sourceCode(ctx),
				choices === undefined
					? "case-list-interval-text"
					: "case-property-option-label",
			);
			if (value !== undefined) {
				item.derived("value", ITEM_CLAIMS.labelValue);
				noteRespelled(
					ctx,
					ITEM_CLAIMS.labelValue.entry,
					`${item.pointer}/value`,
					item.peek("value"),
					value,
				);
			}
			claimAltText(item, codes, false);
		}
	}
	if (
		!others ||
		(format === "translatable-enum" &&
			entries.some((entry) => entry.value === undefined))
	)
		return undefined;
	return {
		column: { ...candidate, ...base } as ColumnProposal["column"],
		header,
		texts,
		invisible: false,
		json: column,
		...(choices !== undefined && { choices }),
	};
}

/**
 * The property a stored column shows by its choices' labels: a calculated `translatable-enum`
 * column whose expression and `enum` are Nova's label projection of a select property
 * (`selectLabelCandidate`). Read over the stored JSON before any column is claimed, so a menu's
 * columns know which properties the reading's catalog keeps choices for.
 */
export function labelShownProperty(column: unknown): string | undefined {
	if (
		!isJsonObject(column) ||
		column.format !== "translatable-enum" ||
		column.useXpathExpression !== true ||
		typeof column.field !== "string"
	)
		return undefined;
	return selectLabelCandidate(column.field, enumEntriesOf(column.enum, []))
		?.field;
}

/** The document a label projection is printed against: its labels are enum variables, so it
 *  names nothing. */
const NO_REFERENCES = { fields: {}, forms: {}, fieldOrder: {} };

/** The second argument of every `selected(…, '<value>')` of a tree, in document order. */
function selectedValues(node: FormSyntax | undefined, out: string[]): string[] {
	if (node === undefined) return out;
	switch (node.kind) {
		case "call": {
			const value = node.args[1];
			if (node.name === "selected" && node.args.length === 2) {
				const text = literalText(value);
				if (text !== undefined) out.push(text);
			}
			for (const arg of node.args) selectedValues(arg, out);
			return out;
		}
		case "group":
		case "negative":
			return selectedValues(node.value, out);
		case "binary":
			selectedValues(node.left, out);
			return selectedValues(node.right, out);
		default:
			return out;
	}
}

/**
 * The select property a `translatable-enum` column's text is Nova's label projection of: the
 * property, its kind and its option values, the first of a single and a multiple choice that
 * `plainSelectDisplayXpath` prints back as `text`, one enum variable per entry
 * (`hqJson/caseList.ts::projectColumnToDetail`, a plain column over a select property). Each
 * entry's key must be the variable the projection names for its option.
 */
function selectLabelCandidate(
	text: string,
	entries: readonly { key: unknown }[],
):
	| {
			field: string;
			dataType: SelectChoices["dataType"];
			values: readonly string[];
	  }
	| undefined {
	if (entries.some((entry, index) => entry.key !== hqEnumPlaceholder(index)))
		return undefined;
	const tree = parse(text);
	const { strings, properties } = literalsOf(tree);
	const field = properties[0];
	if (field === undefined) return undefined;
	const proposals: [SelectChoices["dataType"], readonly string[]][] = [
		["single_select", strings],
		["multi_select", selectedValues(tree, [])],
	];
	for (const [dataType, values] of proposals) {
		if (
			values.length !== entries.length ||
			values.length === 0 ||
			values.some((value) => value === "") ||
			new Set(values).size !== values.length
		)
			continue;
		const property: CaseProperty = {
			name: field,
			label: proseText(field),
			data_type: dataType,
			options: values.map((value) => ({ value, label: proseText(value) })),
		};
		const back = printed(
			plainSelectDisplayXpath(
				casePropertyPath(field),
				property,
				NO_REFERENCES,
				(_option, index) => w.hqEnumVar(index),
			),
		);
		if (sameXPathText(back, text)) return { field, dataType, values };
	}
	return undefined;
}
