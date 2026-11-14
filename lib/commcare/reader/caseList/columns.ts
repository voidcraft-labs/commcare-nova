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
import type { Column } from "@/lib/domain";
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
import type { HqPlace } from "@/lib/publish/hqFindings";
import { hqXPath, hqXPathText } from "../../hqJson/xpath";
import {
	intervalColumnDisplayXpath,
	linkColumnDisplayXpath,
} from "../../suite/case-list/columns";
import { casePropertyPath } from "../../suite/wire";
import { type FormSyntax, readFormSyntax } from "../../xpath/formSyntax";
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
import { HQ_PAGE_LABELS } from "../hqPageLabels";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { pendingPlaceholder, type ReadMode } from "../pendingExpressions";
import { sameXPathText } from "../syntaxCompare";
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
}

/** A `{lang: text}` map, every value a string. */
export function languageMap(value: unknown): Record<string, string> {
	if (!isJsonObject(value)) return {};
	const out: Record<string, string> = {};
	for (const [lang, text] of Object.entries(value))
		if (typeof text === "string") out[lang] = text;
	return out;
}

/** The app's language codes in HQ's order. */
export function appCodes(ctx: ReadContext): readonly string[] {
	return applicationReading(ctx)?.languages.codes ?? [];
}

/** The text of `map` in the app's first language. */
export function firstText(
	ctx: ReadContext,
	map: Readonly<Record<string, string>>,
): string {
	const first = appCodes(ctx)[0];
	return first === undefined ? "" : (map[first] ?? "");
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

type FieldClass =
	| { readonly kind: "property"; readonly name: string }
	| { readonly kind: "finding"; readonly claim: Claim<"refuse"> };

/** HQ's `details/utils.js::isValidPropertyName`, one word or a path of words. */
const HQ_WORD = "[a-zA-Z][\\w_-]*";
const HQ_PROPERTY_NAME = new RegExp(
	`^(${HQ_WORD}:)*(${HQ_WORD}\\/)*#?${HQ_WORD}$`,
);

/** The column field a property-backed column reads, classified by the rows of the field. */
function classifyField(field: string): FieldClass {
	if (field.startsWith("#owner_name") || field === "#owner_name")
		return { kind: "finding", claim: C.ownerName };
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
	if (
		!AUTHORED_CASE_PROPERTY_NAME_PATTERN.test(renamed) ||
		renamed.length > MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH
	)
		return { kind: "finding", claim: C.fieldOutsideGrammar };
	return { kind: "property", name: renamed };
}

/** Whether a property is written by a select question of the app's forms: Nova's plain column
 *  there shows the choice's label. */
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

/** The enum entries of a column: each key and its value map. */
function enumEntries(
	column: JsonCursor,
): readonly { key: unknown; value: Record<string, string> }[] {
	const stored = column.peek("enum");
	if (!Array.isArray(stored)) return [];
	return stored.map((entry) => ({
		key: isJsonObject(entry) ? entry.key : undefined,
		value: isJsonObject(entry) ? languageMap(entry.value) : {},
	}));
}

/** Claims each enum entry's `alt_text`, blank by its HELD row and with text by its finding. */
function claimAltTexts(column: JsonCursor): boolean {
	let ok = true;
	for (const item of column.list("enum", "MappingItem", C.enumMapping)) {
		const alt = languageMap(item.peek("alt_text"));
		if (Object.values(alt).some((text) => text.trim() !== "")) {
			item.refuse("alt_text", C.altText);
			ok = false;
		} else item.derived("alt_text", C.altTextBlank);
		item.derived("key", derivedEnumKey);
		item.derived("value", derivedEnumValue);
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
		column.refuse(key, C.undeclared, { name: key });
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

/**
 * One detail column as the Nova column it would be. `undefined` where the column's row raised a
 * finding. `screen` is the detail it stands in; `selectProperty` says whether a property is one
 * the app's select questions write; `inTile` whether the short detail is a custom tile.
 */
export function readDetailColumn(
	ctx: ReadContext,
	module: DraftModule,
	column: JsonCursor,
	screen: "short" | "long",
	options: {
		readonly selectProperty: SelectProperty;
		readonly inTile: boolean;
	},
): ColumnProposal | undefined {
	const header = column.take("header", C.header, languageMap).value;
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
	const others = claimOtherKeys(column, format, screen);
	const field = fieldOf(column);
	const base = { header: firstText(ctx, header) };
	const proposal = (
		kind: ColumnProposal["column"],
		extra: Partial<
			Pick<ColumnProposal, "texts" | "expression" | "invisible">
		> = {},
	): ColumnProposal | undefined =>
		others
			? {
					column: kind,
					header,
					texts: extra.texts ?? {},
					...(extra.expression !== undefined && {
						expression: extra.expression,
					}),
					invisible: extra.invisible ?? false,
					json: column,
				}
			: undefined;

	// A calculated field: an expression column, an attribute, or one of Nova's two projections.
	if (field.xpath) {
		const tree = parse(field.text);
		const attribute = oneAttribute(tree);
		if (
			format === "plain" &&
			attribute !== undefined &&
			ATTRIBUTE_PROPERTIES.has(attribute)
		) {
			column.take("useXpathExpression", C.fieldAttribute, Boolean).value;
			column.take("field", C.fieldAttributeField, String).value;
			column.take("format", C.plain, String).value;
			return proposal({
				kind: "plain",
				field: attribute,
				...base,
			} as ColumnProposal["column"]);
		}
		if (format === "plain") {
			column.take("useXpathExpression", C.fieldCalculated, Boolean).value;
			column.take("format", C.plain, String).value;
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
				},
			);
		}
		if (format === "markdown" || format === "translatable-enum")
			return readProjection(
				ctx,
				column,
				format,
				field.text,
				header,
				base,
				others,
				options.selectProperty,
			);
	}

	if (format === "invisible" && screen === "long") {
		column.take("format", C.invisibleLong, String).value;
	} else if (format === "invisible" && options.inTile) {
		column.refuse("format", C.invisibleInTile, formatName(format));
		return undefined;
	}

	const classified = classifyField(field.text);
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
	column.take("field", C.field, String).value;
	const name = classified.name;
	const fieldName = { name };

	switch (format) {
		case "plain": {
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
			return readIdMapping(ctx, column, name, base, header, proposal);
		case "enum-image":
			return readImageMap(ctx, module, column, name, base, proposal);
		case "late-flag": {
			const flag = column.peek("late_flag");
			column.refuse(
				"format",
				typeof flag === "number" && flag <= 0 ? C.lateFlagZero : C.lateFlag,
				formatName(format),
			);
			return undefined;
		}
		case "time-ago":
			column.refuse("format", C.timeAgo, formatName(format));
			return undefined;
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
		case "translatable-enum":
			column.refuse("format", C.translatableEnumOwn, fieldName);
			return undefined;
		case "filter":
			// Its effect on the build is judged with the whole short detail (`details.ts`).
			return proposal({
				kind: "plain",
				field: name,
				...base,
			} as ColumnProposal["column"]);
	}
	if (format.startsWith("geo-") && screen === "long") {
		column.take("format", C.geoOnDetail, String).value;
		return proposal({
			kind: "plain",
			field: name,
			...base,
		} as ColumnProposal["column"]);
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
	_header: Readonly<Record<string, string>>,
	proposal: (
		column: ColumnProposal["column"],
		extra?: Partial<Pick<ColumnProposal, "texts">>,
	) => ColumnProposal | undefined,
): ColumnProposal | undefined {
	const entries = enumEntries(column);
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
	if (!claimAltTexts(column)) return undefined;
	const texts: Record<string, Record<string, string>> = {};
	for (const entry of entries) texts[entry.key as string] = entry.value;
	return proposal(
		{
			kind: "id-mapping",
			field,
			...base,
			mapping: entries.map((entry) => ({
				value: entry.key as string,
				label: firstText(ctx, entry.value),
			})),
		} as ColumnProposal["column"],
		{ texts },
	);
}

/** `selected(., '<value>')` as HQ's key, the one condition shape an image map's key holds. */
function selectedValue(key: string): string | undefined {
	const node = parse(key);
	if (
		node?.kind !== "call" ||
		node.name !== "selected" ||
		node.args.length !== 2
	)
		return undefined;
	const [subject, value] = node.args;
	if (subject?.kind !== "self" || value?.kind !== "string") return undefined;
	return value.value;
}

function readImageMap(
	ctx: ReadContext,
	_module: DraftModule,
	column: JsonCursor,
	field: string,
	base: { header: string },
	proposal: (column: ColumnProposal["column"]) => ColumnProposal | undefined,
): ColumnProposal | undefined {
	const entries = enumEntries(column);
	const values: string[] = [];
	for (const entry of entries) {
		if (typeof entry.key !== "string") {
			column.refuse("format", C.enumImageOther, { name: field });
			return undefined;
		}
		const value = selectedValue(entry.key);
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
		const alt = languageMap(item.peek("alt_text"));
		if (Object.values(alt).some((text) => text.trim() !== "")) {
			item.refuse("alt_text", C.altText);
			ok = false;
		} else item.derived("alt_text", C.altTextBlank);
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
	const read = readMediaMap(ctx, languageMap(item.peek("value")), {
		site: { json: item, key: "value" },
		place: item.place,
		slot: "image_map_mapping",
		mediaKind: "image",
	});
	if (read.kind !== "asset") return undefined;
	item.take("value", C.enumImageValue, languageMap).value;
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
 *  a link, an interval, or a plain column over a select property (whose label projection
 *  the comparison of the whole menu holds). */
function readProjection(
	ctx: ReadContext,
	column: JsonCursor,
	format: "markdown" | "translatable-enum",
	text: string,
	header: Readonly<Record<string, string>>,
	base: { header: string },
	others: boolean,
	selectProperty: SelectProperty,
): ColumnProposal | undefined {
	const entries = enumEntries(column);
	let candidate: ArmOmit<ColumnBody, "header"> | undefined;
	const texts: Record<string, Record<string, string>> = {};
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
		if (entries.length === 1 && first !== undefined) {
			candidate = intervalCandidate(text, firstText(ctx, first.value));
			if (candidate !== undefined) texts[""] = first.value;
		}
		if (candidate === undefined) {
			const field = literalsOf(parse(text)).properties[0];
			if (field !== undefined && selectProperty(field))
				candidate = { kind: "plain", field };
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
			item.derived("value", ITEM_CLAIMS.labelValue);
			item.derived("alt_text", C.altTextBlank);
		}
	}
	if (!others) return undefined;
	return {
		column: { ...candidate, ...base } as ColumnProposal["column"],
		header,
		texts,
		invisible: false,
		json: column,
	};
}
