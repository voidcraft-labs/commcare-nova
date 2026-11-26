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

import type {
	BlueprintDoc,
	CaseProperty,
	Column,
	ColumnVia,
	LanguageTag,
} from "@/lib/domain";
import { caseMappingComparison } from "@/lib/domain/caseMappingRows";
import { AUTHORED_CASE_PROPERTY_NAME_PATTERN } from "@/lib/domain/casePropertyName";
import { COMMCARE_DATE_PATTERN_REGEX } from "@/lib/domain/commCareDatePattern";
import type { ColumnRecordSource } from "@/lib/domain/modules";
import {
	CASE_MAP_LAYER_KINDS,
	type ColumnLoadBehavior,
	DATE_COUNT_DAYS,
	DATE_COUNT_PERIODS,
	INTERVAL_DISPLAYS,
	idMappingValueHoldsForbiddenCharacter,
	TIME_SINCE_UNIT_DAYS,
	TIME_SINCE_UNITS,
	type TimeSinceUnit,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { TranslationUnitRole } from "@/lib/domain/translationUnits";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { hqXPath, hqXPathText } from "../../hqJson/xpath";
import { type SourceTable, tableOf } from "../../sourceKeys";
import {
	imageMapEnumKey,
	intervalColumnDisplayXpath,
	linkColumnDisplayXpath,
	plainSelectDisplayXpath,
} from "../../suite/case-list/columns";
import { hqMappingKeyIsExpression } from "../../suite/case-list/keyVariable";
import { CASE_MAP_FORMATS } from "../../suite/case-list/mapLayers";
import { hqEnumPlaceholder } from "../../suite/case-list/orderPlanOptions";
import { columnPropertyPath, isHqDetailField } from "../../suite/wire";
import { type FormSyntax, literalInstanceId } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import type { WireExpr } from "../../xpath/wire/tree";
import { applicationReading } from "../appShell";
import { withCandidate } from "../candidate";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { instanceIdsRead } from "../expressions/surfaceUses";
import {
	heldText,
	hqDeviceText,
	LINE_END_DEFINES_KEY,
	recordTextRewrite,
	storedKeyDefinedAfterLineEnd,
	type UnheldText,
	unheldRefusal,
	unheldText,
} from "../heldText";
import { dotInterpolate } from "../hqInterpolation";
import { COLUMN_FORMAT_LABELS } from "../hqPageLabels";
import { shownText } from "../hqText";
import { isJsonObject, type JsonCursor, sameJson } from "../jsonCursor";
import { pendingPlaceholder, type ReadMode } from "../pendingExpressions";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { readMediaMap } from "../xform/media";
import {
	ATTRIBUTE_PROPERTIES,
	calculatedAttributeField,
} from "./attributeColumns";
import { claimRestOfRefusedColumn } from "./refusedWhole";

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
	longProperty: take(
		`${A}column-reading-a-property-name-over-255-characters`,
		"schema:DetailColumn.field",
	),
	hashProperty: refuse(
		`${A}column-reading-an-unknown-hash-property`,
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
	fieldSearchInstances: refuse(
		`${A}calculated-column-reading-results-search-input-instances-in-a`,
		"schema:DetailColumn.field",
	),
	fieldAttributeField: take(
		`${A}usexpathexpression-field-reading-one-case-attribute`,
		"schema:DetailColumn.field",
	),
	relationField: take(
		`${A}idx-prop-parent-host-any-index-names-other-than-a-first-step`,
		"detail-field-type:property",
	),
	/** A property column's field by the property it names: a case property, the case's
	 *  `last_modified`, or one of the names HQ's build renames (`detail_screen.py::CASE_PROPERTY_MAP`). */
	propertyType: take(`${A}prop`, "detail-field-type:property"),
	lastModifiedType: take(`${A}last-modified`, "detail-field-type:property"),
	renamedType: take(
		`${A}name-date-opened-external-id-status-owner-id-hq-renames-to-case`,
		"detail-field-type:property",
	),
	relationPath: take(
		`${A}idx-prop-in-a-menu-that-offers-search-or-through-an-index`,
		"detail-field-type:property",
	),
	userProp: take(`${A}user-prop-usercase`, "detail-field-type:property"),
	userSteps: take(`${A}user-steps-prop`, "detail-field-type:property"),
	ownerName: take(`${A}owner-name`, "detail-field-type:property"),
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
	plainSelect: take(
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
	timeAgo: take(
		`${A}3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
		"schema:DetailColumn.format",
	),
	timeAgoOther: refuse(
		`${A}3p-time-ago-other-interval`,
		"schema:DetailColumn.format",
	),
	timeAgoInterval: take(
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

	enumSpecialKey: refuse(
		`${A}5p-enum-key-containing`,
		"schema:DetailColumn.enum",
	),
	enumDuplicateKey: refuse(
		`${A}an-enum-enum-image-conditional-enum-or-translatable-enum-column`,
		"schema:DetailColumn.enum",
	),
	lateFlag: take(`${A}6-late-flag-late-flag-1`, "schema:DetailColumn.format"),
	lateFlagZero: take(
		`${A}6p-late-flag-late-flag-0`,
		"schema:DetailColumn.format",
	),
	lateFlagValue: take(
		`${A}6-late-flag-late-flag-1`,
		"schema:DetailColumn.late_flag",
	),
	lateFlagZeroValue: take(
		`${A}6p-late-flag-late-flag-0`,
		"schema:DetailColumn.late_flag",
	),
	invisible: take(
		`${A}7-invisible-search-only-on-the-case-list-outside-a-custom-tile`,
		"schema:DetailColumn.format",
	),
	dataTabOrder: take(
		`${A}7pp-invisible-inside-a-data-tab-over-a-nodeset`,
		"schema:DetailColumn.format",
	),
	invisibleLong: take(
		`${A}7p-invisible-on-the-case-detail-outside-a-data-tab-over-a`,
		"schema:DetailColumn.format",
	),
	namedInvisible: take(
		`${A}raw-value-in-a-named-case-tile`,
		"schema:DetailColumn.format",
	),
	invisibleInTile: take(
		`${A}invisible-or-address-column-in-a-custom-tile`,
		"schema:DetailColumn.format",
	),
	address: take(`${A}8-address`, "schema:DetailColumn.format"),
	distance: take(`${A}9-distance`, "schema:DetailColumn.format"),
	markdownLink: take(
		`${A}10-markdown-any-property-or-expression`,
		"schema:DetailColumn.format",
	),
	markdownOther: take(
		`${A}10-markdown-outside-the-link-shape`,
		"schema:DetailColumn.format",
	),
	geoBoundary: take(`${A}11-geo-boundary`, "schema:DetailColumn.format"),
	geoBoundaryColor: take(
		`${A}12-geo-boundary-color-on-the-case-list-only-needs-an-address`,
		"schema:DetailColumn.format",
	),
	geoPoints: take(
		`${A}13-geo-points-on-the-case-list-only`,
		"schema:DetailColumn.format",
	),
	geoPointsColors: take(
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
	severalAddressAdvanced: take(
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
	enumImagePlain: take(
		`${A}19-enum-image-whose-keys-are-plain-values`,
		"schema:DetailColumn.format",
	),
	enumImageOther: take(
		`${A}19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot`,
		"schema:DetailColumn.format",
	),
	conditionalMapping: take(
		`${A}20-conditional-enum`,
		"schema:DetailColumn.enum",
	),
	conditionalEnum: take(
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
	translatableEnumOther: take(
		`${A}21-translatable-enum-outside-nova-s-two-projections`,
		"schema:DetailColumn.format",
	),
	translatableEnumKey: refuse(
		`${A}21p-translatable-enum-key-outside-a-za-z0-9`,
		"schema:DetailColumn.enum",
	),
	translatableEnumOwn: take(
		`${A}translatable-enum-on-a-column-that-is-not-a-calculated-property-over-a-property`,
		"schema:DetailColumn.format",
	),
	translatableEnumRelationOffers: refuse(
		`${A}translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-offers`,
		"schema:DetailColumn.format",
	),
	translatableEnumRelationDoes: take(
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
	altText: take(
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
	optimization: take(
		`${A}optimization-cache-lazy-load-cache-and-lazy-load`,
		"schema:DetailColumn.optimization",
	),
	optimizationUnread: drop(
		`${A}optimization-on-a-column-that-cannot-use-it`,
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
export const HQ_PROPERTY_RENAMES: SourceTable<string> = tableOf({
	"external-id": "external_id",
	"date-opened": "date_opened",
	status: "status",
	name: "case_name",
	owner_id: "owner_id",
});

/** A property column's field as HQ's build reads it: its last word renamed by `CASE_PROPERTY_MAP`
 *  (`HQ_PROPERTY_RENAMES`), every index before it as written. */
export function renamedField(field: string): string {
	const parts = field.split("/");
	const last = parts.pop() as string;
	return [
		...(parts[0] === "user" ? ["user"] : parts),
		HQ_PROPERTY_RENAMES.get(last) ?? last,
	].join("/");
}

/** The text of a property field of indices and a property, as HQ's build substitutes it into
 *  each image map key: the walk its indices name and the property read there. */
export function imageMapFieldText(field: string): string {
	const parts = field.split("/");
	const last = parts.pop() as string;
	const readFrom = parts[0] === "user" ? ("worker-record" as const) : undefined;
	const owner = last === "#owner_name";
	const prop = owner ? "owner_id" : (HQ_PROPERTY_RENAMES.get(last) ?? last);
	const [first, ...rest] = parts.map((identifier) => ({ identifier }));
	return imageMapPropertyText(
		prop,
		readFrom || !first ? undefined : [first, ...rest],
		{ readFrom, showOwner: owner ? "name" : undefined },
	);
}

/** The three case attributes a Nova column reads as `@<name>`. */
/**
 * A calculated column whose value is the read of its case's id
 * (`attributeColumns.ts::ATTRIBUTE_PROPERTIES`), and the plain column over that
 * attribute: Nova writes both as the expression `@<name>` with the `plain`
 * format, so both print one column, and the reader returns the plain one
 * (`readDetailColumn`, an attribute field), under the identity a re-read gives
 * the calculated one (`identityMap.ts::externalIdentityMap` keys it as that
 * plain column).
 */
export function calculatedAttributeColumnsArePlain(
	doc: BlueprintDoc,
): BlueprintDoc {
	const holds = doc.moduleOrder.some((uuid) => {
		const module = doc.modules[uuid];
		return (module?.caseListConfig?.columns ?? []).some(
			(column) =>
				calculatedAttributeField(column, module?.caseType) !== undefined,
		);
	});
	if (!holds) return doc;
	return withCandidate(doc, (draft) => {
		for (const module of Object.values(draft.modules)) {
			const config = module.caseListConfig;
			if (config === undefined) continue;
			config.columns = config.columns.map((column) => {
				const field = calculatedAttributeField(column, module.caseType);
				if (field === undefined || column.kind !== "calculated") return column;
				const { expression: _value, kind: _kind, ...rest } = column;
				return { ...rest, kind: "plain", field } as Column;
			});
		}
	});
}

/**
 * The threshold and unit the reader gives a flag interval column whose threshold is `days` days:
 * the first unit, in `TIME_SINCE_UNITS`' order, in which `days` is a whole number of units, as
 * `intervalCandidate` tries them over the number the column prints.
 */
function flagThresholdAsRead(
	days: number,
): { readonly threshold: number; readonly unit: TimeSinceUnit } | undefined {
	for (const unit of TIME_SINCE_UNITS) {
		const threshold = days / TIME_SINCE_UNIT_DAYS[unit];
		if (Number.isInteger(threshold) && threshold >= 0)
			return { threshold, unit };
	}
	return undefined;
}

/**
 * The reader's canonical choice `flag-interval-thresholds-as-read`: an interval column that shows
 * its text only past its threshold prints the threshold as days alone
 * (`suite/case-list/columns.ts::intervalFlagXpath`: today's distance from the date, compared
 * with `threshold × TIME_SINCE_UNIT_DAYS[unit]`), so two weeks and fourteen days print one
 * column; the reader returns the first unit in which those days are a whole number
 * (`intervalCandidate`). A column that shows the count of units (`always`) prints its unit, and
 * is left as it is.
 */
export function flagIntervalThresholdsAsRead(doc: BlueprintDoc): BlueprintDoc {
	const moved = (column: Column) => {
		if (column.kind !== "interval" || column.display !== "flag")
			return undefined;
		const read = flagThresholdAsRead(
			column.threshold * TIME_SINCE_UNIT_DAYS[column.unit],
		);
		return read === undefined ||
			(read.unit === column.unit && read.threshold === column.threshold)
			? undefined
			: read;
	};
	const holds = doc.moduleOrder.some((uuid) =>
		(doc.modules[uuid]?.caseListConfig?.columns ?? []).some(
			(column) => moved(column) !== undefined,
		),
	);
	if (!holds) return doc;
	return withCandidate(doc, (draft) => {
		for (const module of Object.values(draft.modules)) {
			const config = module.caseListConfig;
			if (config === undefined) continue;
			config.columns = config.columns.map((column) => {
				const read = moved(column);
				return read === undefined ? column : ({ ...column, ...read } as Column);
			});
		}
	});
}

/** The bookkeeping keys of HQ's column editor, which no build reads: every key
 *  `details/bootstrap5/column.js` gives a column that `DetailColumn` does not declare. */
const BOOKKEEPING_KEYS = [
	"hasAutocomplete",
	"calc_xpath",
	"isTab",
	"hasNodeset",
	"nodeset",
	"nodesetCaseType",
	"nodesetFilter",
	"relevant",
];

/** The formats a geo format needs beside it in its detail
 *  (`static/app_manager/js/details/utils.js::COLUMN_FORMAT_DEPENDENCIES`). */
const GEO_DEPENDENCIES: SourceTable<readonly string[]> = tableOf({
	"geo-boundary": ["address"],
	"geo-points": ["address"],
	"geo-boundary-color": ["address", "geo-boundary"],
	"geo-points-colors": ["address", "geo-points"],
});

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
		(format === "invisible" || GEO_DEPENDENCIES.has(format))
	)
		return "plain";
	return format;
}

/** The formats HQ's Case List and Case Detail saves admit once per detail (`screen.js::save`). */
const ONCE_PER_DETAIL = new Set(["image", ...GEO_DEPENDENCIES.keys()]);

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
	/** The column's own read claims the node (`PendingExpression.readerClaimed`). */
	readonly readerClaimed?: true;
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
	readonly conditions?: ReadonlyMap<number, ColumnExpressionSource>;
	readonly textKeys?: readonly string[];
	/** True for an `invisible` short column, which joins by `field` and header alone. */
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
	const out = recordFromEntries<string>([]);
	if (!isJsonObject(value)) return out;
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
	const out = recordFromEntries<string>([]);
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

/** The text of a stored `{lang: text}` app string that `heldTextsIn` holds no spelling of, and
 *  why (`heldText.ts::unheldText`); undefined where the build prints a value whose text the
 *  reader cannot know, the reading names no source language, or every text is held. */
export function unheldTextsIn(
	stored: unknown,
	codes: readonly string[],
	source: string | undefined,
	role: TranslationUnitRole,
): UnheldText | undefined {
	const shown = shownTexts(stored, codes);
	return shown === undefined || source === undefined
		? undefined
		: unheldText(shown, codes, source, role);
}

/** Refuses the key `key` of `cursor`, a stored app string of role `role`, where Nova's gate
 *  admits no spelling of a text it holds for a reason the manifest names
 *  (`heldText.ts::unheldRefusal`): one finding at the cursor's place. Any other map is left for
 *  the close to name. */
export function refuseUnheldKey(
	cursor: JsonCursor,
	key: string,
	codes: readonly string[],
	source: string | undefined,
	role: TranslationUnitRole,
): void {
	const refusal = unheldRefusal(
		unheldTextsIn(cursor.peek(key), codes, source, role),
	);
	if (refusal !== undefined)
		cursor.refuse(key, refusal.claim, { name: refusal.name });
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
	includeSource = false,
): Map<LanguageTag, T> {
	const tags = applicationReading(ctx)?.languages.tagOf;
	const source = sourceCode(ctx);
	return new Map(
		Object.entries(map).flatMap(([code, text]) => {
			const tag = tags?.get(code);
			return tag === undefined || (!includeSource && code === source)
				? []
				: [[tag, text] as const];
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

/** The column field a property-backed column reads, classified by the rows of the field: also
 *  the field of the hidden column HQ's build appends for a sort element no column joins
 *  (`util.py::create_temp_sort_column`). */
export function classifyField(field: string): FieldClass {
	if (field === "#owner_name") return { kind: "property", name: "owner_id" };
	const colon = field.indexOf(":");
	if (colon > 0) {
		const prefix = field.slice(0, colon);
		// An indicator names its set before `/`; HQ's call-center set is
		// `call-center` (`callcenter/indicator_sets.py::CallCenterIndicators.name`).
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
								? field.startsWith("indicator:call-center/")
									? C.callCenter
									: C.indicator
								: prefix === "property"
									? C.prefixed
									: C.prefixed;
		return { kind: "finding", claim };
	}
	// HQ's build reads `user/…/prop` from the worker's own case and drops
	// every step between `user` and the property
	// (`detail_screen.py::PropertyXpathGenerator.xpath`).
	if (field.startsWith("user/")) {
		if (!isHqDetailField(field))
			return { kind: "finding", claim: C.fieldInvalid };
		return classifyField(field.slice(field.lastIndexOf("/") + 1));
	}
	if (field.includes("/") && isHqDetailField(field))
		return classifyField(field.slice(field.lastIndexOf("/") + 1));
	if (!isHqDetailField(field))
		return { kind: "finding", claim: C.fieldInvalid };
	// HQ's page accepts a `#` before the last word and a name of any length;
	// Core accepts the long child name. Only #owner_name has a native rewrite.
	const renamed = HQ_PROPERTY_RENAMES.get(field) ?? field;
	// HQ's build reads a property field through `CASE_PROPERTY_MAP`, which maps `status` and
	// `owner_id` to their attributes and has no entry for `case_id`, so it reads the child element
	// `case_id`, which no case holds (Core holds the id as the attribute alone,
	// `CaseChildElement`): the column is blank for every case.
	if (renamed === "case_id") return { kind: "finding", claim: C.caseIdElement };
	if (!AUTHORED_CASE_PROPERTY_NAME_PATTERN.test(renamed))
		return { kind: "finding", claim: C.hashProperty };
	return { kind: "property", name: renamed };
}

/** Whether a property is one whose choices the reading's catalog keeps, so Nova's plain column
 *  over it shows the choice's label: a select question of the app's forms writes it, and a column
 *  of the app shows it by its choices' labels (`labelShownProperty`). */
export type SelectProperty = (property: string, caseType?: string) => boolean;

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

const FORMAT_FINDING: SourceTable<Claim<"refuse">> = tableOf({
	"address-popup": C.addressPopup,
	picture: C.picture,
	audio: C.audio,
	graph: C.graph,
	image: C.image,
});

/** What `COLUMN_FORMAT_LABELS` shows for a column's format, where HQ's page has a label for it. */
function formatName(format: string): { name: string } | undefined {
	const label = COLUMN_FORMAT_LABELS.get(format);
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
			isJsonObject(entry) ? entry.value : NO_ENTRIES,
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
 * name, where the build prints a value the reader cannot know. Blank is what a device shows
 * (`heldText.ts::hqDeviceText`), not JavaScript's trim: U+001F, which HQ's build writes as a
 * non-breaking space, is blank, and U+FEFF, which it writes and a device keeps, is text. On a
 * format that builds an image, a rest after a carriage return that defines an app string is
 * refused, and a blank map spelled otherwise than Nova writes it (none) is respelled by the first
 * publish. Whether the entry's alt text is Nova's.
 */
function claimAltText(
	ctx: ReadContext,
	item: JsonCursor,
	codes: readonly string[],
	buildsImage: boolean,
	keep?: (texts: Readonly<Record<string, string>>) => void,
): boolean {
	const stored = item.peek("alt_text");
	const alt = shownTexts(stored, codes);
	const lineEnd = buildsImage
		? storedKeyDefinedAfterLineEnd(stored, codes)
		: undefined;
	if (lineEnd !== undefined) {
		item.refuse("alt_text", LINE_END_DEFINES_KEY, { name: lineEnd });
		return false;
	}
	if (
		alt !== undefined &&
		Object.values(alt).every((text) => hqDeviceText(text) === "")
	) {
		item.derived("alt_text", C.altTextBlank);
		if (buildsImage && item.used("alt_text"))
			recordTextRewrite(
				ctx,
				{ entry: C.altTextBlank.entry, path: `${item.pointer}/alt_text` },
				"list-settings-respelled",
				false,
			);
	} else if (!buildsImage) item.drop("alt_text", C.altTextNoImage);
	else if (alt === undefined) return false;
	else {
		const held = heldTextsIn(
			stored,
			codes,
			sourceCode(ctx),
			"case-list-image-description",
		);
		if (!held) {
			refuseUnheldKey(
				item,
				"alt_text",
				codes,
				sourceCode(ctx),
				"case-list-image-description",
			);
			return false;
		}
		item.take("alt_text", C.altText, languageMap).value;
		keep?.(held.texts);
		noteRespelled(
			ctx,
			C.altText.entry,
			`${item.pointer}/alt_text`,
			stored,
			held,
		);
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
	conditional?: (item: JsonCursor, index: number) => boolean,
): boolean {
	let ok = true;
	for (const [index, item] of column
		.list(
			"enum",
			"MappingItem",
			conditional ? C.conditionalMapping : C.enumMapping,
		)
		.entries()) {
		if (!claimAltText(ctx, item, codes, false)) ok = false;
		const key = item.peek("key");
		if (!conditional?.(item, index))
			item.derived(
				"key",
				conditional
					? ITEM_CLAIMS.conditionalKey
					: typeof key === "string" && (key === "" || /\s/.test(key))
						? ITEM_CLAIMS.sequenceKey
						: derivedEnumKey,
			);
		const value = heldTextsIn(
			item.peek("value"),
			codes,
			sourceCode(ctx),
			"case-list-mapping-label",
		);
		if (value === undefined) {
			ok = false;
			refuseUnheldKey(
				item,
				"value",
				codes,
				sourceCode(ctx),
				"case-list-mapping-label",
			);
		} else {
			item.derived(
				"value",
				conditional ? ITEM_CLAIMS.conditionalValue : derivedEnumValue,
			);
			noteRespelled(
				ctx,
				(conditional ? ITEM_CLAIMS.conditionalValue : derivedEnumValue).entry,
				`${item.pointer}/value`,
				item.peek("value"),
				value,
			);
		}
	}
	return ok;
}

const ITEM_CLAIMS = defineClaims("caseList.columns.item", {
	conditionalValue: derived(
		`${A}20-conditional-enum`,
		"schema:MappingItem.value",
	),
	conditionalKey: derived(`${A}20-conditional-enum`, "schema:MappingItem.key"),
	key: derived(`${A}5-enum-id-mapping`, "schema:MappingItem.key"),
	sequenceKey: derived(
		`${A}5pp-enum-key-that-is-empty-or-holds-whitespace`,
		"schema:MappingItem.key",
	),
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
	namedTile: boolean,
	optimizationsOn: boolean,
): boolean {
	let ok = true;
	column.drop("filter_xpath", C.filterXpath);
	column.drop("advanced", C.advanced);
	if (!namedTile || !column.used("case_tile_field"))
		column.drop("case_tile_field", C.tileFieldInert);
	// A configuration at HQ's default (an empty graph) is of neither class, so it is left unclaimed.
	if (column.peek("graph_configuration") === null)
		column.drop("graph_configuration", C.graphNull);
	else if (column.used("graph_configuration"))
		column.drop("graph_configuration", C.graphOther);
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
	// HQ keeps a load behavior only on an expression column of a format that can use it, and
	// discards any other as it reads the column (`models/case_list.py::DetailColumn.wrap`); its
	// build writes one only where the menu's faster loading is on.
	if (column.used("optimization")) {
		const behavior = optimizationsOn ? storedLoadBehavior(column) : undefined;
		if (behavior !== undefined)
			column.take("optimization", C.optimization, () => behavior).value;
		else column.drop("optimization", C.optimizationUnread);
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

/** The format of a column whose field is refused, where that format reads nothing but the
 *  field: Nova holds a plain, phone or (on the list) hidden column over any property it holds, so
 *  the refusal of the field is the column's one finding. Every other format is left to its own
 *  claims, which read more than the field. */
function claimPlainFormat(
	column: JsonCursor,
	format: string,
	screen: "short" | "long",
): void {
	if (format === "plain") column.take("format", C.plain, String).value;
	else if (format === "phone") column.take("format", C.phone, String).value;
	else if (format === "invisible" && screen === "short")
		column.take("format", C.invisible, String).value;
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

/** HQ's formats that keep a load behavior (`const.py::FORMATS_SUPPORTING_CASE_LIST_OPTIMIZATIONS`). */
const OPTIMIZED_FORMATS: ReadonlySet<string> = new Set([
	"address",
	"date",
	"markdown",
	"phone",
	"plain",
	"enum",
]);

const LOAD_BEHAVIORS = {
	cache: "cache",
	lazy_load: "defer",
	cache_and_lazy_load: "cache-and-defer",
} as const satisfies Record<string, ColumnLoadBehavior>;

/** The load behavior a stored column keeps as HQ reads it: an expression column of a format
 *  that can use one (`models/case_list.py::DetailColumn.supports_optimizations`), else none. */
export function storedLoadBehavior(
	column: JsonCursor,
): ColumnLoadBehavior | undefined {
	const stored = column.peek("optimization");
	const format = column.peek("format") ?? "plain";
	if (
		column.peek("useXpathExpression") !== true ||
		typeof format !== "string" ||
		!OPTIMIZED_FORMATS.has(format) ||
		typeof stored !== "string" ||
		!Object.hasOwn(LOAD_BEHAVIORS, stored)
	)
		return undefined;
	return LOAD_BEHAVIORS[stored as keyof typeof LOAD_BEHAVIORS];
}

/** What a column's reading needs of its detail and its menu. */
export interface ColumnOptions {
	/** Whether a property is one whose choices the reading's catalog keeps. */
	readonly selectProperty: SelectProperty;
	/** Whether the short detail is a custom tile. */
	readonly inTile: boolean;
	readonly namedTile?: boolean;
	/** Whether the menu's faster loading is on, without which HQ's build writes no column's
	 *  load behavior (`detail_screen.py::FormattedDetailColumn.fields`). */
	readonly optimizationsOn?: boolean;
	readonly dataRows?: boolean;
	readonly fixtureRow?: boolean;
	/** How many columns of each format the detail holds. */
	readonly formats: ReadonlyMap<string, number>;
	/** Whether the menu is an advanced module. */
	readonly advanced: boolean;
	/** Whether the menu offers search (`util.py::module_offers_search`). */
	readonly offersSearch: boolean;
	/** For a `filter` column, whether it changes HQ's build of its detail. */
	readonly filterChangesBuild: boolean;
	/** Whether HQ's build admits a calculated column of the detail reading the search's
	 *  instances: a detail of the search's results, or a menu whose search launches by itself
	 *  (`helpers/validators.py::ModuleBaseValidator.validate_detail_columns`). */
	readonly searchInstancesRead: boolean;
	/** The walk a column's indices name from the menu's case type, each step typed as Nova types
	 *  it (`parent` by the catalog's parent, any other index by the type the app links it to), and
	 *  the type it reaches; undefined where a step reaches no type. */
	readonly relationVia?: (
		steps: readonly string[],
	) => { readonly via: ColumnVia; readonly caseType?: string } | undefined;
}

/** The last word of a native field is mapped by HQ before it joins each saved
 * index. The case roster comes from the detail and can be the Search results.
 * A historical link that no current form writes still reads its reached case. */
export function readRelationField(
	field: string,
	options: Pick<ColumnOptions, "offersSearch" | "relationVia">,
):
	| {
			readonly kind: "property";
			readonly name: string;
			readonly via?: ColumnVia;
			readonly caseType?: string;
			readonly readFrom?: "worker-record";
			readonly showOwner?: "name";
	  }
	| { readonly kind: "finding"; readonly claim: Claim<"refuse"> }
	| undefined {
	if (field === "#owner_name")
		return { kind: "property", name: "owner_id", showOwner: "name" };
	if (field.startsWith("user/")) {
		const source = classifyField(field);
		if (source.kind === "finding") return source;
		return {
			...source,
			readFrom: "worker-record",
			caseType: USERCASE_CASE_TYPE,
			...(field.endsWith("/#owner_name") && { showOwner: "name" }),
		};
	}
	if (!isRelationPath(field)) return undefined;
	if (!isHqDetailField(field))
		return { kind: "finding", claim: C.fieldInvalid };
	const parts = field.split("/");
	const last = parts.pop() as string;
	const classified = classifyField(last);
	if (classified.kind === "finding") return classified;
	const walk = options.relationVia?.(parts) ?? {
		via: parts.map((identifier) => ({ identifier })) as ColumnVia,
	};
	const name = classified.name;
	return {
		kind: "property",
		name,
		via: walk.via,
		...(walk.caseType !== undefined && { caseType: walk.caseType }),
		...(last === "#owner_name" && { showOwner: "name" }),
	};
}

/** HQ's word for a column's property a relation path reads: `parent/prop`, `host/prop`. */
function isRelationPath(field: string): boolean {
	return (
		field.includes("/") && !field.startsWith("user/") && !field.includes(":")
	);
}

/** The fields HQ's build reads under another name (`detail_screen.py::CASE_PROPERTY_MAP`). */
const HQ_RENAMED_FIELDS: ReadonlySet<string> = new Set([
	"external-id",
	"date-opened",
	"status",
	"name",
	"owner_id",
]);

/** Claims the field of a property column that reads another case: the
 *  worker's own (`user/prop`, `user/…/prop`, whose intermediate steps HQ's
 *  build drops and Nova writes back as `user/prop`), a case its indices
 *  reach, or the owner's name (`#owner_name`) of either or of the row. */
function claimPropertySource(
	ctx: ReadContext,
	column: JsonCursor,
	field: string,
	relation: {
		readonly via?: ColumnVia;
		readonly caseType?: string;
		readonly readFrom?: "worker-record";
		readonly showOwner?: "name";
	},
	offersSearch: boolean,
): void {
	const claimField = (claim: Claim<"take">) => {
		if (claim.key !== null)
			ctx.accounting.claimEntry(
				{ json: column, key: "field" },
				claim.entry,
				claim.key,
				column.place,
			);
	};
	if (relation.via !== undefined) {
		column.take(
			"field",
			offersSearch || relation.caseType === undefined
				? C.relationPath
				: C.relationField,
			String,
		).value;
	} else {
		column.take("field", C.field, String).value;
		if (relation.readFrom) {
			const steps = field.split("/").length > 2;
			claimField(steps ? C.userSteps : C.userProp);
			if (steps)
				recordTextRewrite(
					ctx,
					{ entry: C.userSteps.entry, path: `${column.pointer}/field` },
					"list-settings-respelled",
					false,
				);
		}
	}
	// An owner's name read from a reached case or the worker's record is a
	// use of both classes at the one field.
	if (relation.showOwner && C.ownerName.key !== null)
		ctx.accounting.claimEntryClass(
			{ json: column, key: "field" },
			C.ownerName.entry,
			C.ownerName.key,
			column.place,
		);
}

/** Read an ordinary saved property with a native translation table. HQ also
 * retains table rows its display does not reference, so keep every phrase.
 * Check the native field and table keys independently for refusal recovery. */
function readOwnTranslatableEnum(
	ctx: ReadContext,
	column: JsonCursor,
	field: string,
	options: ColumnOptions,
	header: Readonly<Record<string, string>>,
	base: { header: string },
	others: boolean,
): ColumnProposal | undefined {
	const relation = readRelationField(field, options);
	const source = relation ?? classifyField(field);
	const keysOk = calculationKeysAreEditable(column);
	// A search fetches the related cases a non-calculated path of more than one step names
	// (`case_search/utils.py::get_search_detail_relationship_paths` reads only non-calculated
	// columns, the worker's `user/` among them), which the calculated spelling Nova keeps would
	// not ask for.
	if (
		options.offersSearch &&
		field.includes("/") &&
		relation?.kind === "property"
	) {
		if (isRelationPath(field))
			column.take("field", C.relationPath, String).value;
		else claimPropertySource(ctx, column, field, relation, true);
		column.refuse("format", C.translatableEnumRelationOffers, { name: field });
		return undefined;
	}
	if (relation?.kind === "property")
		return readRelationTranslatableEnum(
			ctx,
			column,
			field,
			relation,
			header,
			base,
			others,
		);
	column.take("format", C.translatableEnumOwn, String).value;
	if (source.kind === "finding") {
		column.refuse(
			"field",
			source.claim,
			source.claim === C.fieldInvalid ? undefined : { name: field },
		);
		return undefined;
	}
	column.take("field", C.field, String).value;
	if (!keysOk) return undefined;
	const property = imageMapPropertyText(source.name);
	return readGeneralCalculation(
		ctx,
		column,
		property,
		header,
		base,
		others,
		C.translatableEnumOwn,
		false,
	);
}

/**
 * A non-calculated `translatable-enum` over a path that leaves the row: a walk of its indices
 * (`parent/prop`, `host/parent/prop`) or the worker's record (`user/prop`). HQ's build reads
 * the path's last word on the case the walk reaches, of whatever type, or on the worker's
 * record (`detail_screen.py::PropertyXpathGenerator`), and the column's calculation over that
 * read is the same state (`TranslatableEnum` hands `self.xpath` to the enum either way). Nova
 * holds it as the calculation: the expression stage binds the walk as a reached read
 * (`PropertyRef.readReached`), whose print is HQ's. A read the stage holds no tree for (an
 * owner's name, HQ's `owner_name` over the groups fixture) is the stage's finding at the field
 * (`provisional.ts::applyExpressionReading`), never an empty calculation.
 */
function readRelationTranslatableEnum(
	ctx: ReadContext,
	column: JsonCursor,
	field: string,
	relation: Extract<
		ReturnType<typeof readRelationField>,
		{ readonly kind: "property" }
	>,
	header: Readonly<Record<string, string>>,
	base: { header: string },
	others: boolean,
): ColumnProposal | undefined {
	column.take("format", C.translatableEnumRelationDoes, String).value;
	claimPropertySource(ctx, column, field, relation, false);
	if (!calculationKeysAreEditable(column)) return undefined;
	const expression = imageMapPropertyText(
		relation.name,
		relation.via,
		relation,
	);
	const proposed = readGeneralCalculation(
		ctx,
		column,
		expression,
		header,
		base,
		others,
		C.translatableEnumRelationDoes,
		false,
	);
	// HQ substitutes each enum variable key throughout the original XPath.
	// Only a field whose calculation uses none of those keys is a spelling change.
	if (proposed?.textKeys?.every((key) => !expression.includes(key))) {
		ctx.facts.sameStateRewrites.push({
			entry: C.translatableEnumRelationDoes.entry,
			path: column.pointer,
			register: "legacy-related-case-text-rekeyed",
		});
	}
	return proposed;
}

function calculationKeysAreEditable(column: JsonCursor): boolean {
	const keys = enumEntries(column, []).map((entry) => entry.key);
	if (
		keys.some((key) => typeof key !== "string" || !/^[A-Za-z0-9_-]+$/.test(key))
	) {
		column.refuse("enum", C.translatableEnumKey);
		return false;
	}
	if (new Set(keys).size !== keys.length) {
		column.refuse("enum", C.enumDuplicateKey);
		return false;
	}
	return true;
}
function readGeneralCalculation(
	ctx: ReadContext,
	column: JsonCursor,
	field: string,
	header: Readonly<Record<string, string>>,
	base: { header: string },
	others: boolean,
	claim: Claim<"take">,
	calculated: boolean,
): ColumnProposal | undefined {
	const codes = appCodes(ctx);
	const entries = enumEntries(column, codes, sourceCode(ctx));
	if (calculated) {
		column.take("format", claim, String).value;
		column.take("useXpathExpression", C.projectionXpath, Boolean).value;
		if (!calculationKeysAreEditable(column)) {
			column.take("field", C.projectionField, String).value;
			return undefined;
		}
	}
	const keys = entries.map((entry) => entry.key as string);
	const texts = recordFromEntries(
		entries.map((entry, index) => [keys[index], entry.value ?? NO_ENTRIES]),
	);
	for (const item of column.list(
		"enum",
		"MappingItem",
		C.translatableEnumMapping,
	)) {
		item.derived("key", ITEM_CLAIMS.labelKey);
		const value = heldTextsIn(
			item.peek("value"),
			codes,
			sourceCode(ctx),
			"case-list-calculation-text",
		);
		if (!value) {
			refuseUnheldKey(
				item,
				"value",
				codes,
				sourceCode(ctx),
				"case-list-calculation-text",
			);
			return undefined;
		}
		item.derived("value", ITEM_CLAIMS.labelValue);
		noteRespelled(
			ctx,
			ITEM_CLAIMS.labelValue.entry,
			`${item.pointer}/value`,
			item.peek("value"),
			value,
		);
		claimAltText(ctx, item, codes, false);
	}
	return others
		? {
				column: {
					kind: "calculated",
					...base,
					expression: pendingPlaceholder("value"),
				},
				header,
				texts,
				textKeys: keys,
				invisible: false,
				json: column,
				expression: {
					text: field,
					at: { json: column, key: "field" },
					mode: { target: "hq-json", interpolation: "none" },
					place: column.place,
					key: "schema:DetailColumn.field",
					...(!calculated && { readerClaimed: true as const }),
				},
			}
		: undefined;
}

/**
 * One detail column as the Nova column it would be. `undefined` where the column's row raised a
 * finding, `"dropped"` where its row changes no build. `screen` is the detail it stands in. A
 * refused column is refused whole: every key of it its reading left is claimed under its refusal
 * (`refusedWhole.ts`), a tile cell's keys among them on a custom tile's list, where no cell of a
 * refused column is read; elsewhere the tile reading drops them by their own row.
 */
export function readDetailColumn(
	ctx: ReadContext,
	module: DraftModule,
	column: JsonCursor,
	screen: "short" | "long",
	options: ColumnOptions,
): ColumnReading {
	const reading = readColumn(ctx, module, column, screen, options);
	if (reading === undefined) {
		const cellsRead = screen === "short" && options.inTile;
		claimRestOfRefusedColumn(
			ctx,
			column,
			(key) => cellsRead || !(CELL_KEYS as readonly string[]).includes(key),
		);
	}
	return reading;
}

function readColumn(
	ctx: ReadContext,
	module: DraftModule,
	column: JsonCursor,
	screen: "short" | "long",
	options: ColumnOptions,
): ColumnReading {
	const codes = appCodes(ctx);
	// The header as HQ's build shows it in each language; one Nova's gate admits no spelling of
	// is refused at its key where the manifest names why, one the reader cannot know is left
	// unclaimed, for the close to name, and either way the column is no proposal.
	const heldHeader = heldTextsIn(
		column.peek("header"),
		codes,
		sourceCode(ctx),
		"case-list-header",
	);
	const header = heldHeader?.texts;
	if (header === undefined)
		refuseUnheldKey(
			column,
			"header",
			codes,
			sourceCode(ctx),
			"case-list-header",
		);
	else {
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
	const others =
		claimOtherKeys(
			column,
			format,
			screen,
			options.namedTile === true,
			options.optimizationsOn === true,
		) && header !== undefined;
	const field = fieldOf(column);
	const base = { header: sourceText(ctx, header ?? NO_ENTRIES) };
	// The walk of a property column read through a relation, once its field is read.
	let via: ColumnVia | undefined;
	let recordSource: ColumnRecordSource = {};
	const loadBehavior =
		options.optimizationsOn === true ? storedLoadBehavior(column) : undefined;
	const proposal = (
		kind: ColumnProposal["column"],
		extra: Partial<
			Pick<ColumnProposal, "texts" | "expression" | "invisible" | "conditions">
		> = {},
	): ColumnProposal | undefined =>
		others
			? {
					column:
						kind.kind === "calculated"
							? {
									...kind,
									...(loadBehavior !== undefined &&
										kind.texts === undefined && { loadBehavior }),
								}
							: ({
									...kind,
									...(via && { via }),
									...recordSource,
								} as ColumnProposal["column"]),
					header: header ?? NO_ENTRIES,
					texts: extra.texts ?? NO_ENTRIES,
					...(extra.conditions && { conditions: extra.conditions }),
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
	const hiddenOnList = format === "invisible" && screen === "short";
	const rowOrder =
		format === "invisible" && screen === "long" && options.dataRows;
	if (
		field.xpath &&
		!options.searchInstancesRead &&
		readsSearchInstances(field.text)
	) {
		column.refuse("field", C.fieldSearchInstances);
		return undefined;
	}
	if (
		!field.xpath &&
		options.fixtureRow &&
		(format === "plain" || rowOrder) &&
		!field.text.includes("/") &&
		isHqDetailField(field.text)
	) {
		const name = renamedField(field.text);
		const text = ["status", "owner_id"].includes(name) ? `@${name}` : name;
		if (column.used("useXpathExpression"))
			column.take("useXpathExpression", C.fieldCalculated, Boolean).value;
		column.take("format", rowOrder ? C.dataTabOrder : C.plain, String).value;
		return proposal(
			{
				kind: "calculated",
				rowField: true,
				...base,
				expression: pendingPlaceholder("value"),
			},
			{
				expression: {
					text,
					at: { json: column, key: "field" },
					mode: { target: "hq-json", interpolation: "none" },
					place,
					key: "schema:DetailColumn.field",
				},
			},
		);
	}
	if (field.xpath) {
		const tree = parse(field.text);
		const attribute = oneAttribute(tree);
		const formatClaim = rowOrder
			? C.dataTabOrder
			: hiddenOnList
				? options.namedTile
					? C.namedInvisible
					: options.inTile
						? C.invisibleInTile
						: C.invisible
				: C.plain;
		// A load behavior is a calculated value's, so an attribute column that keeps one reads as
		// the calculation it is (below), which Nova writes back with the behavior.
		if (
			(format === "plain" || hiddenOnList || rowOrder) &&
			attribute !== undefined &&
			ATTRIBUTE_PROPERTIES.has(attribute) &&
			loadBehavior === undefined
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
		const authoredMarkdown =
			format === "markdown" && linkCandidate(field.text, options) === undefined;
		if (format === "plain" || hiddenOnList || authoredMarkdown || rowOrder) {
			column.take("useXpathExpression", C.fieldCalculated, Boolean).value;
			column.take(
				"format",
				authoredMarkdown ? C.markdownOther : formatClaim,
				String,
			).value;
			return proposal(
				{
					kind: "calculated",
					...(authoredMarkdown && { showAs: "formatted-text" }),
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
				header ?? NO_ENTRIES,
				base,
				others,
				options,
				loadBehavior,
			);
	}

	if (format === "translatable-enum")
		return readOwnTranslatableEnum(
			ctx,
			column,
			field.text,
			options,
			header ?? NO_ENTRIES,
			base,
			others,
		);

	if (format === "invisible" && screen === "long") {
		column.take("format", rowOrder ? C.dataTabOrder : C.invisibleLong, String)
			.value;
	} else if (format === "invisible" && options.inTile && options.namedTile) {
		column.take("format", C.namedInvisible, String).value;
	}

	// A column of any other format over the case's id: Nova writes a column over `case_id` as the
	// expression `@case_id` with its kind's format (`attributeColumns.ts::ATTRIBUTE_PROPERTIES`).
	const attribute = field.xpath ? oneAttribute(parse(field.text)) : undefined;
	// A field of indices and a property reads that property of the case the indices reach.
	const relation = field.xpath
		? undefined
		: readRelationField(field.text, options);
	const classified: FieldClass =
		attribute !== undefined && ATTRIBUTE_PROPERTIES.has(attribute)
			? { kind: "property", name: attribute }
			: (relation ?? classifyField(field.text));
	if (classified.kind === "finding") {
		// A field HQ's page would not accept is no property name a person typed there, so it names nothing.
		const named = field.text !== "" && classified.claim !== C.fieldInvalid;
		column.refuse(
			"field",
			classified.claim,
			named ? { name: field.text } : undefined,
		);
		claimPlainFormat(column, format, screen);
		return undefined;
	}
	if (attribute !== undefined && classified.name === attribute) {
		column.take("useXpathExpression", C.fieldAttribute, Boolean).value;
		column.take("field", C.fieldAttributeField, String).value;
	} else if (relation?.kind === "property") {
		claimPropertySource(
			ctx,
			column,
			field.text,
			relation,
			options.offersSearch,
		);
	} else {
		column.take(
			"field",
			field.text.length > 255 ? C.longProperty : C.field,
			String,
		).value;
		const type = HQ_RENAMED_FIELDS.has(field.text)
			? C.renamedType
			: field.text === "last_modified"
				? C.lastModifiedType
				: C.propertyType;
		if (type.key !== null)
			ctx.accounting.claimEntry(
				{ json: column, key: "field" },
				type.entry,
				type.key,
				column.place,
			);
	}
	const name = classified.name;
	const fieldName = { name };
	const relatedType =
		relation?.kind === "property" ? relation.caseType : undefined;
	if (relation?.kind === "property") {
		via = relation.via;
		recordSource = {
			...(relation.readFrom && { readFrom: relation.readFrom }),
			...(relation.showOwner && { showOwner: relation.showOwner }),
		};
	}

	switch (format) {
		case "plain": {
			const saved = options.selectProperty(name, relatedType);
			column.take("format", saved ? C.plainSelect : C.plain, String).value;
			return proposal({
				kind: "plain",
				...(saved && { showChoice: "saved-value" }),
				field: name,
				...base,
			} as ColumnProposal["column"]);
		}
		case "invisible": {
			if (screen === "short")
				column.take(
					"format",
					options.namedTile
						? C.namedInvisible
						: options.inTile
							? C.invisibleInTile
							: C.invisible,
					String,
				).value;
			return proposal(
				{ kind: "plain", field: name, ...base } as ColumnProposal["column"],
				{
					invisible: screen === "short",
				},
			);
		}
		case "date": {
			const pattern = column.peek("date_format");
			// An empty pattern is no date Nova shows: the column holds one it writes.
			if (
				typeof pattern !== "string" ||
				pattern === "" ||
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
		case "conditional-enum":
			return readIdMapping(
				ctx,
				column,
				name,
				base,
				proposal,
				format === "conditional-enum",
				via,
				recordSource,
			);
		case "enum-image":
			return readImageMap(
				ctx,
				module,
				column,
				name,
				base,
				proposal,
				via,
				recordSource,
			);
		case "late-flag": {
			const flag = column.peek("late_flag") ?? 30;
			if (typeof flag !== "number" || !Number.isSafeInteger(flag))
				return undefined;
			column.take("format", flag <= 0 ? C.lateFlagZero : C.lateFlag, String)
				.value;
			column.take(
				"late_flag",
				flag <= 0 ? C.lateFlagZeroValue : C.lateFlagValue,
				Number,
			).value;
			return proposal({
				kind: "overdue-marker",
				field: name,
				afterDays: flag,
				...base,
			} as ColumnProposal["column"]);
		}
		case "time-ago": {
			const interval = column.peek("time_ago_interval") ?? 365.25;
			const period = DATE_COUNT_PERIODS.find(
				(one) => DATE_COUNT_DAYS[one] === interval,
			);
			if (period === undefined) {
				column.refuse("format", C.timeAgoOther, formatName(format));
				column.refuse(
					"time_ago_interval",
					C.timeAgoOtherInterval,
					formatName(format),
				);
				return undefined;
			}
			column.take("format", C.timeAgo, String).value;
			column.take("time_ago_interval", C.timeAgoInterval, Number).value;
			return proposal({
				kind: "date-count",
				field: name,
				period,
				...base,
			} as ColumnProposal["column"]);
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
			column.take("format", C.markdownOther, String).value;
			return proposal({
				kind: "formatted-text",
				field: name,
				...base,
			} as ColumnProposal["column"]);
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
	if (format === "distance") {
		column.take("format", C.distance, String).value;
		return proposal({
			kind: "worker-distance",
			field: name,
			...base,
		} as ColumnProposal["column"]);
	}
	if (format === "address") {
		if (count > 1 && !options.advanced) {
			column.refuse("format", C.severalOfOneFormat, formatName(format));
			return undefined;
		}
		// HQ writes an address with a zero template width, so a custom
		// Results tile hides it on Web Apps and Android draws it at its cell.
		column.take(
			"format",
			count > 1
				? C.severalAddressAdvanced
				: options.inTile && screen === "short"
					? C.invisibleInTile
					: C.address,
			String,
		).value;
		return proposal({
			kind: "map-location",
			field: name,
			...base,
		} as ColumnProposal["column"]);
	}
	if (count > 1 && ONCE_PER_DETAIL.has(format)) {
		column.refuse(
			"format",
			options.advanced ? C.severalImageGeoAdvanced : C.severalOfOneFormat,
			formatName(format),
		);
		return undefined;
	}
	const dependencies = GEO_DEPENDENCIES.get(format);
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
		const layer = CASE_MAP_LAYER_KINDS.find(
			(one) => CASE_MAP_FORMATS[one].hq === format,
		);
		if (layer === undefined) return undefined;
		const claims = {
			boundary: C.geoBoundary,
			"boundary-color": C.geoBoundaryColor,
			points: C.geoPoints,
			"point-colors": C.geoPointsColors,
		};
		column.take("format", claims[layer], String).value;
		return proposal({
			kind: "map-layer",
			field: name,
			layer,
			...base,
		} as ColumnProposal["column"]);
	}
	const finding = FORMAT_FINDING.get(format);
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

/** Whether a calculated column's expression reads an instance of the search, `results` or
 *  `search-input` and its named ones, which HQ's build refuses in a detail of the case database
 *  where the search does not launch by itself ("case search instance used in casedb case
 *  details", `helpers/validators.py::ModuleBaseValidator.validate_detail_columns`). */
function readsSearchInstances(text: string): boolean {
	return instanceIdsRead(text).some((id) => {
		const scheme = id.split(":")[0];
		return scheme === "results" || scheme === "search-input";
	});
}

/** Read ordered value labels, preserving each key exactly as HQ's mapping editor stores it. */
/** The property that a native dot denotes is bound by the ordinary record
 * parser. The shorthand has no persistent meaning outside this source column. */
type MappingSource = { value: string; match?: "exact" } | { text: string };
function nativeSource(
	key: string,
	property: string,
	image: boolean,
): MappingSource {
	if (!hqMappingKeyIsExpression(key))
		return image ? { value: key, match: "exact" } : { value: key };
	const text = dotInterpolate(key, property);
	if (image) {
		const selected = selectedValue(key, property);
		if (selected !== undefined) return { value: selected };
	}
	const comparison = parse(key);
	if (
		comparison?.kind === "binary" &&
		comparison.op === "=" &&
		comparison.left.kind === "self"
	) {
		const value = literalText(comparison.right);
		if (value !== undefined)
			return image ? { value, match: "exact" } : { value };
	}
	return { text };
}
/** The editor rejects equal *keys*. A label or image can still have two
 * differently spelled rules that match the same case. Prefer a plain key's
 * ordinary value form and keep equivalent XPath rows as scoped conditions. */
function readMappingSources(
	keys: readonly string[],
	property: string,
	image: boolean,
): MappingSource[] {
	const sources = keys.map((key) => nativeSource(key, property, image));
	const preferred = new Map<string, number>();
	sources.forEach((source, index) => {
		if (!("value" in source)) return;
		const id = caseMappingComparison(source);
		if (!preferred.has(id) || !hqMappingKeyIsExpression(keys[index]))
			preferred.set(id, index);
	});
	return sources.map((source, index) =>
		"value" in source && preferred.get(caseMappingComparison(source)) !== index
			? { text: dotInterpolate(keys[index], property) }
			: source,
	);
}
function mappingConditionSource(
	item: JsonCursor,
	text: string,
): ColumnExpressionSource {
	return {
		text,
		place: item.place,
		at: { json: item, key: "key" },
		key: "schema:MappingItem.key",
		mode: { target: "hq-json", interpolation: "none" },
	};
}
function readIdMapping(
	ctx: ReadContext,
	column: JsonCursor,
	field: string,
	base: { header: string },
	proposal: (
		column: ColumnProposal["column"],
		extra?: Partial<Pick<ColumnProposal, "texts" | "conditions">>,
	) => ColumnProposal | undefined,
	conditional: boolean,
	via?: ColumnVia,
	source?: ColumnRecordSource,
): ColumnProposal | undefined {
	const codes = appCodes(ctx);
	const entries = enumEntries(column, codes, sourceCode(ctx));
	const keys: string[] = [];
	for (const entry of entries) {
		if (typeof entry.key !== "string") return undefined;
		if (!conditional && idMappingValueHoldsForbiddenCharacter(entry.key)) {
			column.refuse("enum", C.enumSpecialKey, { name: field });
			return undefined;
		}
		keys.push(entry.key);
	}
	if (new Set(keys).size !== keys.length) {
		column.refuse("enum", C.enumDuplicateKey, { name: field });
		return undefined;
	}
	const sources: MappingSource[] = conditional
		? readMappingSources(keys, imageMapPropertyText(field, via, source), false)
		: keys.map((value) => ({ value }));
	column.take("format", conditional ? C.conditionalEnum : C.enumFormat, String)
		.value;
	const conditions = new Map<number, ColumnExpressionSource>();
	if (
		!claimAltTexts(
			ctx,
			column,
			codes,
			conditional
				? (item, index) => {
						const source = sources[index];
						if ("text" in source) {
							conditions.set(index, mappingConditionSource(item, source.text));
							return true;
						}
						return false;
					}
				: undefined,
		)
	)
		return undefined;
	const texts = recordFromEntries(
		entries.map((entry, index) => [String(index), entry.value ?? NO_ENTRIES]),
	);
	return proposal(
		{
			kind: "id-mapping",
			...(conditional && { behavior: "first-match" }),
			field,
			...base,
			mapping: sources.map((source, index) => ({
				...("text" in source
					? { when: pendingPlaceholder("condition") }
					: { value: source.value }),
				label: sourceText(ctx, entries[index].value ?? NO_ENTRIES),
			})),
		},
		{ texts, conditions },
	);
}

/** The text of a column's property as HQ's build substitutes it into each image map key
 *  (`detail_screen.py::Enum._template_xpath`, `models/case_list.py::MappingItem.key_as_condition`). */
export function imageMapPropertyText(
	field: string,
	via?: ColumnVia,
	source?: ColumnRecordSource,
): string {
	return hqXPathText(
		hqXPath(
			columnPropertyPath({
				field,
				via,
				readFrom: source?.readFrom,
				showOwner: source?.showOwner,
			}),
		),
	);
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
	proposal: (
		column: ColumnProposal["column"],
		extra?: Pick<ColumnProposal, "texts" | "conditions">,
	) => ColumnProposal | undefined,
	via?: ColumnVia,
	source?: ColumnRecordSource,
): ColumnProposal | undefined {
	const codes = appCodes(ctx);
	const entries = enumEntries(column, []);
	const keys: string[] = [];
	for (const entry of entries) {
		if (typeof entry.key !== "string") return undefined;
		keys.push(entry.key);
	}
	if (new Set(keys).size !== keys.length) {
		column.refuse("enum", C.enumDuplicateKey, { name: field });
		return undefined;
	}
	const definitions = readMappingSources(
		keys,
		imageMapPropertyText(field, via, source),
		true,
	);
	column.take(
		"format",
		definitions.some((item) => "text" in item)
			? C.enumImageOther
			: definitions.some((item) => "match" in item && item.match === "exact")
				? C.enumImagePlain
				: C.enumImage,
		String,
	).value;
	const conditions = new Map<number, ColumnExpressionSource>();
	const items = column.list("enum", "MappingItem", C.enumImageMapping);
	// The proposal holds the asset id the media reader read; the column's
	// schema brands it when the reading is parsed.
	const mapping: (Omit<
		Extract<Column, { kind: "image-map" }>["mapping"][number],
		"assetId"
	> & { assetId?: string })[] = [];
	const texts = recordFromEntries<Readonly<Record<string, string>>>([]);
	let ok = true;
	items.forEach((item, index) => {
		const source = definitions[index];
		if ("text" in source)
			conditions.set(index, mappingConditionSource(item, source.text));
		else item.derived("key", ITEM_CLAIMS.imageKey);
		let description: string | undefined;
		if (
			!claimAltText(ctx, item, codes, true, (byCode) => {
				texts[String(index)] = byCode;
				description = sourceText(ctx, byCode);
			})
		)
			ok = false;
		const asset = readImageAsset(ctx, item);
		const definition = definitions[index];
		if (asset === undefined || definition === undefined) ok = false;
		else
			mapping.push({
				...("text" in definition
					? { when: pendingPlaceholder("condition") }
					: definition),
				...(asset !== null && { assetId: asset }),
				...(description !== undefined && { altText: description }),
			});
	});
	if (!ok) return undefined;
	return proposal(
		{
			kind: "image-map",
			field,
			...base,
			mapping,
		} as ColumnProposal["column"],
		{ texts, conditions },
	);
}

/** The asset of one image map entry's `{lang: jr://...}` map, through the media reader. */
function readImageAsset(
	ctx: ReadContext,
	item: JsonCursor,
): string | null | undefined {
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
	if (read.kind !== "asset" && read.kind !== "none") return undefined;
	item.take("value", C.enumImageValue, languageMap).value;
	// A path is no text: it is held as shown, and no worker reads another.
	noteRespelled(
		ctx,
		C.enumImageValue.entry,
		`${item.pointer}/value`,
		item.peek("value"),
		{ texts: shown, workersSeeAnother: false },
	);
	return read.kind === "none" ? null : read.assetId;
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
				// An instance's id names where a read reads, never a value of the column.
				if (at.name !== "instance") for (const arg of at.args) walk(arg);
				return;
		}
	};
	walk(node);
	return out;
}

/** Whether a node is `instance('casedb')/casedb/case`, the case rows a related read walks. */
function isCaseRows(node: FormSyntax | undefined): boolean {
	if (
		node?.kind !== "child" ||
		node.step.kind !== "name" ||
		node.step.name !== "case"
	)
		return false;
	const root = node.left;
	if (
		root?.kind !== "child" ||
		root.step.kind !== "name" ||
		root.step.name !== "casedb"
	)
		return false;
	return literalInstanceId(root.left)?.value === "casedb";
}

/** The indices a case nodeset walks from `current()`, where it is
 *  `instance('casedb')/casedb/case[@case_id = <origin>/index/<step>]`, each origin `current()` or
 *  an earlier such nodeset. */
function caseWalk(node: FormSyntax | undefined): string[] | undefined {
	if (node?.kind !== "filter" || !isCaseRows(node.base)) return undefined;
	const where = node.where;
	if (
		where.kind !== "binary" ||
		where.op !== "=" ||
		oneAttribute(where.left) !== "case_id"
	)
		return undefined;
	const id = where.right;
	if (id.kind !== "child" || id.step.kind !== "name" || id.step.wildcard)
		return undefined;
	const index = id.left;
	if (
		index?.kind !== "child" ||
		index.step.kind !== "name" ||
		index.step.name !== "index"
	)
		return undefined;
	const origin = index.left;
	if (
		origin?.kind === "call" &&
		origin.name === "current" &&
		origin.args.length === 0
	)
		return [id.step.name];
	const earlier = caseWalk(origin);
	return earlier === undefined ? undefined : [...earlier, id.step.name];
}

/**
 * The first related property read of a tree, in document order: a case nodeset's walk
 * (`caseWalk`) and the property read off it, as `suite/wire.ts::columnPropertyPath` prints a
 * column read through a relation. A proposal: every caller prints its candidate back and compares.
 */
function relatedRead(
	node: FormSyntax | undefined,
):
	| { readonly steps: readonly string[]; readonly property: string }
	| undefined {
	if (node === undefined) return undefined;
	if (
		node.kind === "child" &&
		node.step.kind === "name" &&
		!node.step.wildcard
	) {
		const steps = caseWalk(node.left);
		if (steps !== undefined) return { steps, property: node.step.name };
	}
	switch (node.kind) {
		case "group":
		case "negative":
			return relatedRead(node.value);
		case "child":
			return relatedRead(node.left) ?? relatedRead(node.step);
		case "filter":
			return relatedRead(node.base) ?? relatedRead(node.where);
		case "binary":
			return relatedRead(node.left) ?? relatedRead(node.right);
		case "call":
			for (const arg of node.args) {
				const found = relatedRead(arg);
				if (found !== undefined) return found;
			}
			return undefined;
		default:
			return undefined;
	}
}

/** The property a projection's text reads and the walk it reads it through: a related read's,
 *  typed by the menu's walk (`ColumnOptions.relationVia`), or the first property it names. */
function projectionRead(
	tree: FormSyntax | undefined,
	properties: readonly string[],
	options: Pick<ColumnOptions, "relationVia">,
): { readonly field: string; readonly via?: ColumnVia } | undefined {
	const related = relatedRead(tree);
	if (related === undefined) {
		const field = properties[0];
		return field === undefined ? undefined : { field };
	}
	const walk = options.relationVia?.(related.steps);
	return walk === undefined
		? undefined
		: { field: related.property, via: walk.via };
}

/** The link column `text` reads back into, where `linkColumnDisplayXpath` writes the text. */
function linkCandidate(
	text: string,
	options: Pick<ColumnOptions, "relationVia">,
): ArmOmit<Extract<ColumnBody, { kind: "link" }>, "header"> | undefined {
	const tree = parse(text);
	const { strings, properties } = literalsOf(tree);
	const read = projectionRead(tree, properties, options);
	const open = strings.find((one) => one.startsWith("[") && one.endsWith("]("));
	if (read === undefined || open === undefined) return undefined;
	const linkText = open.slice(1, -2);
	const back = printed(
		linkColumnDisplayXpath(columnPropertyPath(read), linkText),
	);
	return sameXPathText(back, text)
		? { kind: "link", ...read, linkText }
		: undefined;
}

/** The interval column `text` reads back into, the first candidate `intervalColumnDisplayXpath`
 *  writes back as the stored text. */
function intervalCandidate(
	text: string,
	stored: string,
	options: Pick<ColumnOptions, "relationVia">,
): ArmOmit<Extract<ColumnBody, { kind: "interval" }>, "header"> | undefined {
	const tree = parse(text);
	const { numbers, properties } = literalsOf(tree);
	const read = projectionRead(tree, properties, options);
	if (read === undefined) return undefined;
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
						...read,
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
 *  a link (with the load behavior it keeps), an interval, or a plain column over a select
 *  property with the choices its label projection holds (which the comparison of the whole menu
 *  holds against the catalog). */
function readProjection(
	ctx: ReadContext,
	column: JsonCursor,
	format: "markdown" | "translatable-enum",
	text: string,
	header: Readonly<Record<string, string>>,
	base: { header: string },
	others: boolean,
	options: Pick<ColumnOptions, "relationVia">,
	loadBehavior: ColumnLoadBehavior | undefined,
): ColumnProposal | undefined {
	const codes = appCodes(ctx);
	const entries = enumEntries(column, codes, sourceCode(ctx));
	let candidate: ArmOmit<ColumnBody, "header"> | undefined;
	let choices: SelectChoices | undefined;
	const texts = recordFromEntries<Readonly<Record<string, string>>>([]);
	if (format === "markdown") candidate = linkCandidate(text, options);
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
			candidate = intervalCandidate(
				text,
				sourceText(ctx, first.value),
				options,
			);
			if (candidate !== undefined) texts[""] = first.value;
		}
		if (candidate === undefined) {
			const select = selectLabelCandidate(text, entries, options);
			if (select !== undefined) {
				candidate = {
					kind: "plain",
					field: select.field,
					...(select.via !== undefined && { via: select.via }),
				};
				choices = {
					dataType: select.dataType,
					options: select.values.map((value, index) => ({
						value,
						labels: entries[index]?.value ?? NO_ENTRIES,
					})),
				};
			}
		}
	}
	if (candidate === undefined) {
		return readGeneralCalculation(
			ctx,
			column,
			text,
			header,
			base,
			others,
			C.translatableEnumOther,
			true,
		);
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
			// A label Nova's gate admits no spelling of is refused at its key where the manifest
			// names why, and one whose shown text the reader cannot know is left for the close.
			const role =
				choices === undefined
					? "case-list-interval-text"
					: "case-property-option-label";
			const value = heldTextsIn(
				item.peek("value"),
				codes,
				sourceCode(ctx),
				role,
			);
			if (value === undefined)
				refuseUnheldKey(item, "value", codes, sourceCode(ctx), role);
			else {
				item.derived("value", ITEM_CLAIMS.labelValue);
				noteRespelled(
					ctx,
					ITEM_CLAIMS.labelValue.entry,
					`${item.pointer}/value`,
					item.peek("value"),
					value,
				);
			}
			claimAltText(ctx, item, codes, false);
		}
	}
	if (
		!others ||
		(format === "translatable-enum" &&
			entries.some((entry) => entry.value === undefined))
	)
		return undefined;
	return {
		// A link is the one projection a load behavior is stored on (`storedLoadBehavior`: a
		// markdown expression column); a translatable-enum's format keeps none.
		column: {
			...candidate,
			...base,
			...(candidate.kind === "link" &&
				loadBehavior !== undefined && { loadBehavior }),
		} as ColumnProposal["column"],
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
export function labelShownProperty(
	column: unknown,
	relationVia: ColumnOptions["relationVia"],
): { field: string; via?: ColumnVia } | undefined {
	if (
		!isJsonObject(column) ||
		column.format !== "translatable-enum" ||
		column.useXpathExpression !== true ||
		typeof column.field !== "string"
	)
		return undefined;
	// A projection of a related case's property shows that case's choices, never the menu's own.
	const select = selectLabelCandidate(
		column.field,
		enumEntriesOf(column.enum, []),
		{ relationVia },
	);
	return select;
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
	options: Pick<ColumnOptions, "relationVia">,
):
	| {
			field: string;
			via?: ColumnVia;
			dataType: SelectChoices["dataType"];
			values: readonly string[];
	  }
	| undefined {
	if (entries.some((entry, index) => entry.key !== hqEnumPlaceholder(index)))
		return undefined;
	const tree = parse(text);
	const { strings, properties } = literalsOf(tree);
	const read = projectionRead(tree, properties, options);
	if (read === undefined) return undefined;
	const { field } = read;
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
				columnPropertyPath(read),
				property,
				NO_REFERENCES,
				(_option, index) => w.hqEnumVar(index),
			),
		);
		if (sameXPathText(back, text)) return { ...read, dataType, values };
	}
	return undefined;
}
