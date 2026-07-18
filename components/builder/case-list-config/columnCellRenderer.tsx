// components/builder/case-list-config/columnCellRenderer.tsx
//
// Shared per-cell render helpers for the running case-list Preview. Edit mode
// composes labels and reading order without inventing a sample row; real case
// values reach this renderer only in Preview, where their full row context is
// available.
//
// Each column kind has its own render path. This is the running Preview, so
// interactions and formatting follow the same authored semantics Nova emits:
// phone values are actionable, date patterns use JavaRosa's supported tokens,
// and interval thresholds share the emitter's exact unit divisors.
//
// Calculated columns project their result through the case-store's
// `query` SELECT slot (under the optional `calculated` projection
// arg); the value lands on `row.calculated[col.uuid]` per the v2
// case-store contract. The dispatcher reads the slot and routes
// through `renderCalculatedCell`.

"use client";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import {
	type CaseProperty,
	type Column,
	TIME_SINCE_UNIT_DAYS,
} from "@/lib/domain";
import {
	type CheckError,
	checkExpression,
	type TypeContext,
} from "@/lib/domain/predicate";
import {
	caseRowDisplaySourceValue,
	caseRowDisplayValue,
} from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CalculatedValue,
	CaseRowWithCalculated,
} from "@/lib/preview/engine/caseDataBindingTypes";
import { toDate } from "@/lib/preview/xpath/coerce";
import { formatCommCareDate } from "@/lib/preview/xpath/dateFormatting";
import { XPathDate } from "@/lib/preview/xpath/types";

/**
 * Render one column's cell for one row. Dispatches on the
 * column's `kind` discriminator; each branch handles the
 * authored shape with a best-effort runtime-mirroring format.
 *
 * The exhaustive `switch` forces a branch per kind — adding a
 * new column kind to the discriminated union surfaces here as a
 * type error first, not a silent rendering regression.
 *
 * Calculated arm reads `row.calculated[column.uuid]` — the case-
 * store's `query` keys results by the column's uuid (the wire-side
 * stable handle). Other arms read the case property named by
 * `column.field` via the shared display-value helper.
 */
export function renderColumnCell(
	column: Column,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
): React.ReactNode {
	const displayed = projectColumnDisplay(column, row, context);
	if (column.kind === "phone") {
		const phoneNumber = displayed.text.trim();
		return phoneNumber ? (
			<a
				href={`tel:${phoneNumber}`}
				aria-label={`Call ${phoneNumber}`}
				className="inline-flex min-h-11 min-w-11 items-center text-nova-violet-bright underline decoration-current/50 underline-offset-2 [overflow-wrap:anywhere]"
			>
				{displayed.text}
			</a>
		) : (
			renderEmptyCell()
		);
	}
	return renderPreviewValue(displayed);
}

export type CalculatedTemporalType = "date" | "datetime";

/**
 * Context that changes a column's human display without changing its stored
 * value. Results rendering and Quick Filter both consume this exact object so
 * option labels, calculated temporal semantics, and the current interval date
 * can never drift between what a worker sees and what they can search for.
 */
export type ColumnDisplayContext = {
	readonly caseProperties: readonly CaseProperty[];
	readonly calculatedTemporalTypes: ReadonlyMap<
		Column["uuid"],
		CalculatedTemporalType
	>;
	readonly today: Date;
};

/** Resolve the authored expression type once per calculated column. */
export function resolveCalculatedTemporalType(
	column: Column,
	context: TypeContext,
): CalculatedTemporalType | undefined {
	if (column.kind !== "calculated") return undefined;
	const errors: CheckError[] = [];
	const resolved = checkExpression(column.expression, context, errors, []);
	return errors.length === 0 && (resolved === "date" || resolved === "datetime")
		? resolved
		: undefined;
}

/**
 * Pure semantic projection for a case-list cell. This is the sole source for
 * both visible cell text and Quick Filter matching; consumers never scrape a
 * React node or fall back to a different raw-value coercion.
 */
export function projectColumnDisplay(
	column: Column,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
): PreviewFormattedValue {
	switch (column.kind) {
		case "plain":
			return projectPlainValue(
				row,
				column.field,
				context.caseProperties.find(
					(property) => property.name === column.field,
				),
			);
		case "phone":
			return {
				kind: "value",
				text: caseRowDisplayValue(row, column.field),
			};
		case "date":
			return formatDateForPreview(
				caseRowDisplayValue(row, column.field),
				column.pattern,
			);
		case "interval":
			return formatIntervalForPreview(
				caseRowDisplayValue(row, column.field),
				column,
				context.today,
			);
		case "id-mapping": {
			const source = caseRowDisplaySourceValue(row, column.field);
			return projectMappedValue(source, column.mapping);
		}
		case "image-map":
			return projectImageMappedValue(
				caseRowDisplaySourceValue(row, column.field),
				column.mapping,
				context.caseProperties.find(
					(property) => property.name === column.field,
				),
			);
		case "calculated":
			return projectCalculatedValue(
				row.calculated[column.uuid],
				context.calculatedTemporalTypes.get(column.uuid),
			);
	}
}

function projectPlainValue(
	row: CaseRowWithCalculated,
	field: string,
	property: CaseProperty | undefined,
): PreviewFormattedValue {
	const source = caseRowDisplaySourceValue(row, field);
	if (
		property?.data_type === "multi_select" &&
		(Array.isArray(source) || typeof source === "string")
	) {
		const rawTokens = Array.isArray(source)
			? source.map((item) => projectStoredScalar(item, undefined))
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
					.map((option) => option.label),
				...tokens.filter((token) => !knownValues.has(token)),
			].join(" "),
		};
	}
	if (Array.isArray(source)) {
		const labels: string[] = [];
		for (const item of source) {
			const label = projectStoredScalar(item, property);
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
		text: projectStoredScalar(source, property) ?? "",
	};
}

function projectMappedValue(
	source: ReturnType<typeof caseRowDisplaySourceValue>,
	mapping: readonly { readonly value: string; readonly label: string }[],
): PreviewFormattedValue {
	const selected = selectedTokens(source);
	if (selected === undefined) return unsupportedStoredValue();
	return {
		kind: "value",
		// Wire uses mapping order and drops every unmapped token via the empty
		// arm of selected(...), then collapses the join to single spaces.
		text: mapping
			.filter((entry) => selected.has(entry.value))
			.map((entry) => entry.label)
			.join(" "),
	};
}

function projectImageMappedValue(
	source: ReturnType<typeof caseRowDisplaySourceValue>,
	mapping: Extract<Column, { kind: "image-map" }>["mapping"],
	property: CaseProperty | undefined,
): PreviewFormattedValue {
	const selected = selectedTokens(source);
	if (selected === undefined) return unsupportedStoredValue();
	const match = mapping.find((entry) => selected.has(entry.value));
	return match === undefined
		? { kind: "value", text: "" }
		: {
				kind: "image",
				text:
					property?.options?.find((option) => option.value === match.value)
						?.label ?? match.value,
				assetId: match.assetId,
			};
}

function selectedTokens(
	source: ReturnType<typeof caseRowDisplaySourceValue>,
): ReadonlySet<string> | undefined {
	if (source === null || source === undefined) return new Set();
	if (Array.isArray(source)) {
		const tokens = new Set<string>();
		for (const item of source) {
			if (typeof item === "object") return undefined;
			tokens.add(String(item));
		}
		return tokens;
	}
	if (typeof source === "object") return undefined;
	return new Set(String(source).split(/\s+/).filter(Boolean));
}

function projectStoredScalar(
	value: unknown,
	property: CaseProperty | undefined,
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
	if (option !== undefined) return option.label;
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return raw;
}

function unsupportedStoredValue(): PreviewFormattedValue {
	return {
		kind: "fallback",
		text: "Unavailable",
		message: "Preview can’t display this saved value in a case list",
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
 *     string — pg's per-OID deserializer materializes the typed
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
export function renderCalculatedCell(
	value: CalculatedValue | undefined,
	temporalType?: CalculatedTemporalType,
): React.ReactNode {
	return renderPreviewValue(projectCalculatedValue(value, temporalType));
}

function projectCalculatedValue(
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
				message: "Preview can’t display this calculated date",
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
		message: "Preview can’t display this calculated value in a case list",
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
 * Parse a stored date and apply the column's authored JavaRosa pattern. A
 * malformed value or unsupported legacy style stays visible as raw data with
 * a plain-language explanation; Preview never substitutes a locale default.
 */
export type PreviewFormattedValue =
	| {
			readonly kind: "value";
			readonly text: string;
			readonly dateTime?: string;
	  }
	| {
			readonly kind: "image";
			readonly text: string;
			readonly assetId: Extract<
				Column,
				{ kind: "image-map" }
			>["mapping"][number]["assetId"];
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
			message: "Showing the original value because it isn’t a valid date",
		};
	}
	const formatted = formatCommCareDate(parsed, pattern);
	if (formatted.kind === "unsupported-pattern") {
		return {
			kind: "fallback",
			text: raw,
			message:
				"Showing the original value because Preview can’t use this saved date style",
		};
	}
	return { kind: "value", text: formatted.text };
}

/**
 * Runtime-aligned interval renderer. Dispatches on the column's
 * `display` discriminator:
 *
 *   - `"always"` — render the integer unit count until the threshold is
 *     crossed, then replace it with the authored text.
 *   - `"flag"` — render the `text` slot when the interval has
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
				"Preview can’t calculate this interval because the value isn’t a valid date",
		};
	}
	const diffDays = localCalendarDate(today).days - parsed.days;
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

/** Device `today()` is the worker's local calendar day. Construct a UTC
 * midnight from local fields before handing it to XPathDate, whose JS-Date
 * adapter intentionally reads UTC fields for deterministic date arithmetic. */
function localCalendarDate(value: Date): XPathDate {
	return XPathDate.fromJSDateOnly(
		new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())),
	);
}

function renderPreviewValue(value: PreviewFormattedValue): React.ReactNode {
	if (value.kind === "image") {
		return (
			<SimpleTooltip content={value.text}>
				{/* biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth */}
				<img
					src={mediaSrc(value.assetId)}
					alt={value.text}
					className="inline-block size-5 rounded object-cover"
				/>
			</SimpleTooltip>
		);
	}
	if (value.kind === "value") {
		if (!value.text) return renderEmptyCell();
		return value.dateTime === undefined ? (
			<span>{value.text}</span>
		) : (
			<time dateTime={value.dateTime}>{value.text}</time>
		);
	}
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="link"
						className="h-auto min-h-11 min-w-11 max-w-full justify-start whitespace-normal rounded-sm p-0 text-left font-normal text-inherit underline decoration-dotted decoration-nova-text-muted underline-offset-4 [overflow-wrap:anywhere]"
					/>
				}
				aria-label={`${value.text}. More information`}
			>
				{value.text}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64">
				<PopoverHeader>
					<PopoverTitle>Why this value is shown</PopoverTitle>
				</PopoverHeader>
				<PopoverDescription>{value.message}</PopoverDescription>
			</PopoverContent>
		</Popover>
	);
}

function renderEmptyCell(): React.ReactNode {
	return (
		<span>
			<span aria-hidden="true" className="text-nova-text-muted">
				—
			</span>
			<span className="sr-only">No value</span>
		</span>
	);
}
