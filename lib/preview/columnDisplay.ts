/** Shared worker-facing cell values for Preview and disposable app tests. */

import type { ProseTemplate } from "@/lib/domain";
import { workerDistanceValueId } from "@/lib/domain";
import type { CaseMappingRow } from "@/lib/domain/caseMappingRows";
import type { LanguageTag } from "@/lib/domain/localization";
import { isCalendarCaseProperty } from "@/lib/domain/standardCaseProperties";

type ProseProjector = (template: ProseTemplate) => string;

import {
	type CaseProperty,
	type Column,
	DATE_COUNT_DAYS,
	hqInstantText,
	type PropertyColumn,
	TIME_SINCE_UNIT_DAYS,
} from "@/lib/domain";
import type { ExpressionContext } from "@/lib/domain/expression";
import {
	type CaseReading,
	resolveCaseListTemporalType,
} from "@/lib/domain/expression/temporalType";
import { isOpenableAddress } from "@/lib/links/openableAddress";
import {
	caseRowDisplaySourceValue,
	caseRowDisplayValue,
} from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CalculatedValue,
	CaseRowWithCalculated,
} from "@/lib/preview/engine/caseDataBindingTypes";
import type { PreviewPlatformRules } from "@/lib/preview/platform";
import { toDate } from "@/lib/preview/xpath/coerce";
import { formatConcreteCommCareDate } from "@/lib/preview/xpath/dateFormatting";
import { javaTrim } from "@/lib/preview/xpath/javaString";
import { XPathDate } from "@/lib/preview/xpath/types";

export type CalculatedTemporalType = "date" | "datetime";

/**
 * Context that changes a column's human display without changing its stored
 * value. Results rendering and the Quick Filter's reading of a field
 * (`lib/preview/engine/caseListFilterFields.ts`) both consume this exact
 * object, so option labels, calculated temporal semantics, and the current
 * interval date never drift between what a worker sees and what a device's
 * search reads.
 */
export type ColumnDisplayContext = {
	/** Worker platform labels; omitted by authoring callers. */
	readonly language?: LanguageTag;
	/** Per-output option text and screen-reader descriptions. */
	readonly columnProperties?: ReadonlyMap<Column["uuid"], CaseProperty>;
	readonly imageDescription?: (
		column: Column["uuid"],
		row: CaseMappingRow,
	) => string | undefined;
	readonly caseProperties: readonly CaseProperty[];
	/** The catalog entry of the property each column read through a relation
	 *  shows, from the case type its walk reaches, by column. Absent or
	 *  missing reads the property as untyped with no options. */
	readonly relatedProperties?: ReadonlyMap<
		Column["uuid"],
		CaseProperty | undefined
	>;
	readonly calculatedTemporalTypes: ReadonlyMap<
		Column["uuid"],
		CalculatedTemporalType
	>;
	readonly today: Date;
	/** What the rows stand for: a device's case database (the default) or the
	 *  results instance HQ's search returns, whose system dates are HQ's text. */
	readonly reading?: Extract<CaseReading, "casedb" | "results">;
	/** Spells an option label's references against the owning document. Rides
	 *  the display context rather than being read per cell, so the Results
	 *  list and the Quick Filter that matches it can never disagree. */
	readonly projectProse: ProseProjector;
	/** How a `link` column reads in a Results row or a tile: the link (Web
	 *  Apps, and every case detail), or on Android the literal `[text](value)`
	 *  the column holds, since its markdown arm is on the case detail alone
	 *  (`views/EntityDetailView.java`). Absent reads as the link. */
	readonly readsCaseImageDescriptions?: boolean;
	readonly caseLocationDetail?: PreviewPlatformRules["caseLocationDetail"];
	readonly markdownRendering?: PreviewPlatformRules["labelMarkdown"];
	readonly tileText?: "html";
	readonly linkColumnInList?: PreviewPlatformRules["linkColumnInList"];
};

/** Resolve the authored expression type once per calculated column. */
export function resolveCalculatedTemporalType(
	column: Column,
	context: ExpressionContext,
	reading: Extract<CaseReading, "casedb" | "results">,
): CalculatedTemporalType | undefined {
	if (column.kind !== "calculated") return undefined;
	return resolveCaseListTemporalType(column.expression, context, reading);
}

/**
 * Pure semantic projection for a case-list cell, the sole source of visible
 * cell text; consumers never scrape a React node or fall back to a different
 * raw-value coercion. The Quick Filter reads it for every kind whose cell
 * shows the text a device's entity holds
 * (`lib/preview/engine/caseListFilterFields.ts::columnDeviceText`).
 */
export function projectColumnDisplay(
	column: Column,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
): PreviewFormattedValue {
	switch (column.kind) {
		case "plain":
			return projectPlainValue(
				columnSourceValue(column, row, context.reading),
				column.showChoice === "saved-value"
					? undefined
					: columnProperty(column, context),
				context.projectProse,
			);
		case "phone":
			return {
				kind: "value",
				text: columnDisplayText(column, row, context.reading),
			};
		case "link": {
			// The cell: authored wording for a web link, the visible raw
			// fallback otherwise, and nothing for blank data.
			const value = columnDisplayText(column, row, context.reading);
			/* The column's display expression: blank in, blank out, else
			 * `[text](value)` (`linkColumnDisplayXpath`). */
			if (context.linkColumnInList === "raw-text")
				return {
					kind: "value",
					text: value === "" ? "" : `[${column.linkText}](${value})`,
				};
			const address = value.trim();
			return {
				kind: "value",
				text: isOpenableAddress(address) ? column.linkText : address,
			};
		}
		case "worker-distance":
			return {
				kind: "value",
				text: String(row.calculated[workerDistanceValueId(column.uuid)] ?? ""),
			};
		case "map-location":
		case "map-layer":
		case "formatted-text":
			return {
				kind: "value",
				text: columnDisplayText(column, row, context.reading),
			};
		case "overdue-marker":
		case "date-count": {
			const raw = columnDisplayText(column, row, context.reading);
			if (raw === "")
				return {
					kind: "value",
					text: column.kind === "overdue-marker" ? "*" : "",
				};
			const date = toDate(raw);
			if (date === null)
				return {
					kind: "fallback",
					text: raw,
					message:
						"Preview can’t count from this date because the saved value isn’t a valid date",
				};
			const today = XPathDate.localDateOf(
				(context.today ?? new Date()).getTime(),
			);
			const days = today.calendarDays - date.calendarDays;
			if (column.kind === "overdue-marker")
				return { kind: "value", text: days > column.afterDays ? "*" : "" };
			return {
				kind: "value",
				text: String(Math.trunc(days / DATE_COUNT_DAYS[column.period])),
			};
		}
		case "date":
			return formatDateForPreview(
				columnDisplayText(column, row, context.reading),
				column.pattern,
			);
		case "interval":
			return formatIntervalForPreview(
				columnDisplayText(column, row, context.reading),
				column,
				context.today,
			);
		case "id-mapping":
			return projectMappedValue(
				columnSourceValue(column, row, context.reading),
				column.mapping,
				row,
				column.behavior,
			);
		case "image-map":
			return projectImageMappedValue(
				columnSourceValue(column, row, context.reading),
				column.mapping,
				row,
				columnProperty(column, context),
				context.projectProse,
				context.readsCaseImageDescriptions !== false,
				(row) => context.imageDescription?.(column.uuid, row),
			);
		case "calculated":
			return projectCalculatedValue(
				row.calculated[column.uuid],
				context.calculatedTemporalTypes.get(column.uuid),
			);
	}
}

/** The catalog entry of the property a column shows: the list's own type's,
 *  or for a column read through a relation the reached type's. */
function columnProperty(
	column: PropertyColumn,
	context: ColumnDisplayContext,
): CaseProperty | undefined {
	const projected = context.columnProperties?.get(column.uuid);
	if (projected) return projected;
	if (column.via !== undefined || column.readFrom)
		return context.relatedProperties?.get(column.uuid);
	return context.caseProperties.find(
		(property) => property.name === column.field,
	);
}

/**
 * The value a property column reads for the row. A column read through a
 * relation reads the related case's value as the device holds it, which the
 * case store projects beside the row under the column's uuid
 * (`QueryArgs.related`), blank where the walk reaches no case; any other
 * reads the row's own (`caseListDisplaySourceValue`).
 */
function columnSourceValue(
	column: PropertyColumn,
	row: CaseRowWithCalculated,
	reading?: Extract<CaseReading, "casedb" | "results">,
): ReturnType<typeof caseRowDisplaySourceValue> {
	if (column.via === undefined && !column.readFrom && !column.showOwner)
		return caseListDisplaySourceValue(row, column.field, reading);
	const related = row.calculated[column.uuid];
	return related === undefined || related === null ? "" : String(related);
}

/** The text a property column reads for the row (`columnSourceValue`). */
function columnDisplayText(
	column: PropertyColumn,
	row: CaseRowWithCalculated,
	reading?: Extract<CaseReading, "casedb" | "results">,
): string {
	if (column.via === undefined && !column.readFrom && !column.showOwner)
		return caseListDisplayValue(row, column.field, reading);
	return String(columnSourceValue(column, row, reading) ?? "");
}

/**
 * The raw text a device holds for a property column's value: the column's
 * own property (`caseListRawText`), or the related case's value for a column
 * read through a relation. A hidden field's template and HQ's appended order
 * carrier both hold it.
 */
export function columnRawText(
	column: Pick<
		PropertyColumn,
		"uuid" | "field" | "via" | "readFrom" | "showOwner"
	>,
	row: CaseRowWithCalculated,
	reading?: Extract<CaseReading, "casedb" | "results">,
): string {
	if (column.via === undefined && !column.readFrom && !column.showOwner)
		return caseListRawText(row, column.field, reading);
	const related = row.calculated[column.uuid];
	return related === undefined || related === null ? "" : String(related);
}

/** A column reads the value the device holds for the row. In a device's case
 * database both system dates are the worker's day (Core's `DateData`). In HQ's
 * search results `date_opened` is the UTC day and `last_modified` HQ's instant
 * text (`casexml/apps/case/xml/generator.py::date_to_xml_string`,
 * `::datetime_to_xml_string`). The raw row accessor stays unchanged: it also
 * serves stored data. */
function caseListDisplaySourceValue(
	row: CaseRowWithCalculated,
	field: string,
	reading: Extract<CaseReading, "casedb" | "results"> = "casedb",
) {
	const source = caseRowDisplaySourceValue(row, field);
	if (!isCalendarCaseProperty(field) || source === null || source === undefined)
		return source;
	const date = source instanceof Date ? source : new Date(String(source));
	if (Number.isNaN(date.getTime())) return source;
	if (reading === "results")
		return field === "date_opened"
			? date.toISOString().slice(0, 10)
			: hqInstantText(date.getTime());
	return XPathDate.localDateOf(date.getTime()).toISOString();
}

/**
 * The text a device holds for a case property: the value a column reads
 * (`caseListDisplaySourceValue`), with a multi select's tokens joined by one
 * space, as a form writes them, and blank for a value the row lacks. A
 * hidden field's template and HQ's appended order carrier both hold it.
 */
export function caseListRawText(
	row: CaseRowWithCalculated,
	field: string,
	reading?: Extract<CaseReading, "casedb" | "results">,
): string {
	const source = caseListDisplaySourceValue(row, field, reading);
	if (source === null || source === undefined) return "";
	if (Array.isArray(source))
		return source
			.map((token) =>
				token === null
					? ""
					: typeof token === "object"
						? JSON.stringify(token)
						: String(token),
			)
			.join(" ");
	if (source instanceof Date) return source.toISOString();
	if (typeof source === "object") return JSON.stringify(source);
	return String(source);
}

function caseListDisplayValue(
	row: CaseRowWithCalculated,
	field: string,
	reading?: Extract<CaseReading, "casedb" | "results">,
): string {
	if (!isCalendarCaseProperty(field)) return caseRowDisplayValue(row, field);
	const source = caseListDisplaySourceValue(row, field, reading);
	return source === null || source === undefined ? "" : String(source);
}

function projectPlainValue(
	source: ReturnType<typeof caseRowDisplaySourceValue>,
	property: CaseProperty | undefined,
	projectProse: ProseProjector,
): PreviewFormattedValue {
	if (
		property?.data_type === "multi_select" &&
		(Array.isArray(source) || typeof source === "string")
	) {
		const rawTokens = Array.isArray(source)
			? source.map((item) => projectStoredScalar(item, undefined, projectProse))
			: source.split(/\s+/).filter(Boolean);
		if (rawTokens.some((token) => token === undefined)) {
			return unsupportedStoredValue();
		}
		const tokens = rawTokens as string[];
		const selected = new Set(tokens);
		const knownValues = new Set(
			(property.options ?? []).map((option) => option.value),
		);
		return {
			kind: "value",
			text: [
				...(property.options ?? [])
					.filter((option) => selected.has(option.value))
					.map((option) => projectProse(option.label)),
				...tokens.filter((token) => !knownValues.has(token)),
			].join(" "),
		};
	}
	if (Array.isArray(source)) {
		const labels: string[] = [];
		for (const item of source) {
			const label = projectStoredScalar(item, property, projectProse);
			if (label === undefined) return unsupportedStoredValue();
			if (label !== "") labels.push(label);
		}
		return { kind: "value", text: labels.join(" ") };
	}
	if (
		source !== null &&
		source !== undefined &&
		typeof source === "object" &&
		!(source instanceof Date)
	) {
		return unsupportedStoredValue();
	}
	if (source instanceof Date) {
		return projectCalculatedValue(
			source,
			property?.data_type === "date" ? "date" : "datetime",
		);
	}
	return {
		kind: "value",
		text: projectStoredScalar(source, property, projectProse) ?? "",
	};
}

function projectMappedValue(
	source: ReturnType<typeof caseRowDisplaySourceValue>,
	mapping: Extract<Column, { kind: "id-mapping" }>["mapping"],
	row: CaseRowWithCalculated,
	behavior?: "first-match",
): PreviewFormattedValue {
	if (behavior === "first-match") {
		const index = firstMatchingRuleIndex(mapping, source, row, true);
		return index === undefined
			? unsupportedStoredValue()
			: { kind: "value", text: mapping[index]?.label ?? "" };
	}
	const matches = mappingValueMatcher(source);
	if (!matches) return unsupportedStoredValue();
	return {
		kind: "value",
		// Wire uses mapping order and drops every unmapped token via the empty
		// arm of selected(...), then collapses the join to single spaces.
		text: mapping
			.filter((entry) => matches(entry.value ?? ""))
			.map((entry) => entry.label)
			.join(" "),
	};
}

function projectImageMappedValue(
	source: ReturnType<typeof caseRowDisplaySourceValue>,
	mapping: Extract<Column, { kind: "image-map" }>["mapping"],
	row: CaseRowWithCalculated,
	property: CaseProperty | undefined,
	projectProse: ProseProjector,
	readsDescription: boolean,
	description: (row: CaseMappingRow) => string | undefined,
): PreviewFormattedValue {
	const index = firstMatchingRuleIndex(mapping, source, row);
	if (index === undefined) return unsupportedStoredValue();
	const match = mapping[index];
	const option = property?.options?.find(
		(candidate) => candidate.value === match?.value,
	);
	// This view's own description replaces the rule's description.
	const altText = !readsDescription
		? undefined
		: match && (description(match) ?? match.altText);
	return match?.assetId === undefined
		? {
				kind: "value",
				text: readsDescription && match ? altText || "\u00a0" : "",
			}
		: {
				kind: "image",
				text: option
					? projectProse(option.label)
					: (match.value ?? match.altText ?? ""),
				...(altText !== undefined && { altText }),
				assetId: match.assetId,
			};
}

/**
 * An ID mapping's or an image map's sort text for a row: the index of the
 * first entry the value holds as a token, as text, `""` where it holds none,
 * as the device's `if(selected(<value>, '<entry>'), <index>, ...)` gives it
 * (`lib/commcare/suite/case-list/sortKeys.ts::idMappingSortXpath`). A value no
 * column can show holds no entry.
 */
export function mappingPositionText(
	column: Extract<Column, { kind: "id-mapping" | "image-map" }>,
	row: CaseRowWithCalculated,
	reading?: Extract<CaseReading, "casedb" | "results">,
): string {
	const index = firstMatchingRuleIndex(
		column.mapping,
		columnSourceValue(column, row, reading),
		row,
		column.kind === "id-mapping" && column.behavior === "first-match",
	);
	return index === undefined || index < 0 ? "" : String(index);
}

/** A condition reading the case has its own projected truth value. An
 * unsupported stored property matters only if a value rule reaches it. */
function firstMatchingRuleIndex(
	rules: readonly CaseMappingRow[],
	source: ReturnType<typeof caseRowDisplaySourceValue>,
	row: CaseRowWithCalculated,
	exact = false,
): number | undefined {
	const matches = mappingValueMatcher(source);
	for (const [index, rule] of rules.entries()) {
		if (rule.when) {
			if (rule.uuid && row.calculated[rule.uuid] === "1") return index;
		} else {
			if (!matches) return undefined;
			if (matches(rule.value ?? "", exact ? "exact" : rule.match)) return index;
		}
	}
	return -1;
}

/** Core's selected() compares a sequence between literal spaces. Blank keys match a
 * blank value, adjacent spaces, or leading/trailing spaces. The source stays verbatim. */
function mappingValueMatcher(
	source: ReturnType<typeof caseRowDisplaySourceValue>,
): ((value: string, match?: "exact") => boolean) | undefined {
	if (Array.isArray(source) && source.some((part) => typeof part === "object"))
		return undefined;
	if (source != null && typeof source === "object" && !Array.isArray(source))
		return undefined;
	const text = Array.isArray(source) ? source.join(" ") : String(source ?? "");
	const padded = ` ${text} `;
	return (value, match) =>
		match === "exact"
			? text === value
			: padded.includes(` ${javaTrim(value)} `);
}

function projectStoredScalar(
	value: unknown,
	property: CaseProperty | undefined,
	projectProse: ProseProjector,
): string | undefined {
	if (value === null || value === undefined) return "";
	if (
		typeof value === "object" ||
		typeof value === "symbol" ||
		typeof value === "function"
	) {
		return undefined;
	}
	const raw = String(value);
	const option = property?.options?.find((entry) => entry.value === raw);
	if (option !== undefined) return projectProse(option.label);
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return raw;
}

function unsupportedStoredValue(): PreviewFormattedValue {
	return {
		kind: "fallback",
		text: "Unavailable",
		message: "Preview can't display this saved value in a case list",
	};
}

/**
 * Render a calculated column's value. The case-store returns each
 * value typed per the SQL expression's resolved Postgres type:
 *
 *   - **text** → JS string
 *   - **integer** → JS number
 *   - **numeric** (decimal) → JS string (pg's arbitrary-precision
 *     deserializer hands these back as strings to avoid lossy
 *     IEEE-754 round-tripping)
 *   - **boolean** → JS boolean
 *   - **date** / **timestamptz** → JS Date object (NOT an ISO
 *     string: pg's per-OID deserializer materializes the typed
 *     value)
 *   - **jsonb** → JS object / array (pg's JSONB deserializer
 *     parses the wire payload)
 *
 * The Date arm needs an explicit branch because an ISO wire value is not
 * worker-facing display copy. Date-shaped values render on their authored UTC
 * calendar day; datetime-shaped values render in the worker's local timezone.
 * Both use the browser locale with a long month name, matching the running
 * search date controls. The machine-readable ISO value stays on `<time>`'s
 * `dateTime` attribute rather than leaking into visible text.
 *
 * The contract test
 * `lib/case-store/__tests__/storeContract.ts → "returns a Date object
 * for a date-typed calculated expression"` pins the Date arm; a
 * regression to a string-shaped date would break the test, surfacing
 * the renderer's coupling to pg-driver behavior.
 */
export function projectCalculatedValue(
	value: CalculatedValue | undefined,
	temporalType?: CalculatedTemporalType,
): PreviewFormattedValue {
	if (value === undefined || value === null) {
		return { kind: "value", text: "" };
	}
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			return {
				kind: "fallback",
				text: "Invalid date",
				message: "Preview can't display this calculated date",
			};
		}
		const iso = value.toISOString();
		// The authored expression type disambiguates a date from a datetime at
		// midnight. An absent type defaults to datetime; guessing from the clock
		// value would misclassify a real midnight instant as a calendar-only date.
		const isDate = temporalType === "date";
		const text = isDate
			? value.toLocaleDateString(undefined, CALCULATED_DATE_FORMAT_OPTIONS)
			: value.toLocaleString(undefined, CALCULATED_DATETIME_FORMAT_OPTIONS);
		return { kind: "value", text, dateTime: iso };
	}
	if (typeof value === "string") {
		return { kind: "value", text: value };
	}
	if (typeof value === "boolean") {
		return { kind: "value", text: value ? "Yes" : "No" };
	}
	if (typeof value === "number") {
		return { kind: "value", text: String(value) };
	}
	// Structured storage values have no truthful scalar case-list rendering.
	// Name the limitation instead of leaking a serialized data structure.
	return {
		kind: "fallback",
		text: "Unavailable",
		message: "Preview can't display this calculated value in a case list",
	};
}

const CALCULATED_DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "long",
	timeZone: "UTC",
	year: "numeric",
};

const CALCULATED_DATETIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "long",
	year: "numeric",
};

// ── Runtime-aligned formatters ────────────────────────────────────

/**
 * Parse a stored date and apply the column's exact authored JavaRosa pattern.
 * A malformed value stays visible as raw data with a plain-language
 * explanation; Preview never substitutes a locale default or resolves the
 * expression layer's semantic preset names.
 */
export type PreviewFormattedValue =
	| {
			readonly kind: "value";
			readonly text: string;
			readonly dateTime?: string;
	  }
	| {
			readonly kind: "image";
			readonly altText?: string;
			readonly text: string;
			readonly assetId: NonNullable<
				Extract<Column, { kind: "image-map" }>["mapping"][number]["assetId"]
			>;
	  }
	| {
			readonly kind: "fallback";
			readonly text: string;
			readonly message: string;
	  };

export function formatDateForPreview(
	raw: string,
	pattern: string,
): PreviewFormattedValue {
	if (!raw) return { kind: "value", text: "" };
	const parsed = toDate(raw);
	if (parsed === null) {
		return {
			kind: "fallback",
			text: raw,
			message: "Showing the original value because it isn't a valid date",
		};
	}
	const formatted = formatConcreteCommCareDate(parsed, pattern);
	if (formatted.kind === "unsupported-pattern") {
		throw new Error(
			"Unsupported case-list date pattern reached Preview after document admission.",
		);
	}
	return { kind: "value", text: formatted.text };
}

/**
 * Runtime-aligned interval renderer. Dispatches on the column's
 * `display` discriminator:
 *
 *   - `"always"`: render the integer unit count until the threshold is
 *     crossed, then replace it with the authored text.
 *   - `"flag"`: render the `text` slot when the interval has
 *     crossed the threshold; otherwise empty cell.
 *
 * Empty values and future dates intentionally follow the emitted XPath shape.
 * Unit conversion uses the domain's exact CCHQ divisors (including 30.4375-day
 * months and 365.25-day years), and `Math.trunc` mirrors XPath `int(...)`.
 */
export function formatIntervalForPreview(
	raw: string,
	column: Extract<Column, { kind: "interval" }>,
	today: Date = new Date(),
): PreviewFormattedValue {
	if (!raw) {
		return {
			kind: "value",
			text: column.display === "flag" ? column.text : "",
		};
	}
	const parsed = toDate(raw);
	if (parsed === null) {
		return {
			kind: "fallback",
			text: raw,
			message:
				"Preview can't calculate this interval because the value isn't a valid date",
		};
	}
	// Both sides of the difference must sit on the LOCAL calendar-day axis:
	// device `date(@prop)` truncates a datetime in the device-local zone
	// (commcare-core `DateUtils.roundDate` uses the default-timezone
	// calendar) and `today()` is the local calendar day. A date-only value
	// already IS a calendar day; a datetime instant converts to the viewer's
	// local day first: reading its UTC fields instead would shift the count
	// by one near midnight for non-UTC viewers. `calendarDays` is that local
	// day for both shapes.
	const diffDays =
		XPathDate.localDateOf(today.getTime()).calendarDays - parsed.calendarDays;
	const divisor = TIME_SINCE_UNIT_DAYS[column.unit];
	const thresholdDays = column.threshold * divisor;
	if (column.display === "flag") {
		return {
			kind: "value",
			text: diffDays > thresholdDays ? column.text : "",
		};
	}
	return {
		kind: "value",
		text:
			diffDays > thresholdDays
				? column.text
				: String(Math.trunc(diffDays / divisor)),
	};
}
