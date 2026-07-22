import {
	type LookupColumnId,
	lookupColumnIdSchema,
} from "@/lib/domain/lookupIds";
import {
	LOOKUP_INT4_MAX,
	LOOKUP_INT4_MIN,
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_VALIDATION_DETAILS,
} from "./constants";
import { createLookupIssueCollector } from "./errors";
import { hasUnpairedUtf16Surrogate, utf8ByteLength } from "./schema";
import type {
	LookupCellValue,
	LookupColumn,
	LookupDataType,
	LookupRowValues,
	LookupValidationDetail,
} from "./types";

const CANONICAL_INT_PATTERN = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const JSON_NUMBER_PATTERN =
	/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN =
	/^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2})(?::?(\d{2}))?)$/i;
const DATE_TIME_SEPARATOR = /t|\s/i;

export type LookupCoercionSource = "typed" | "csv";

export interface ValidateLookupRowValuesOptions {
	source?: LookupCoercionSource;
	/** One-based CSV record number, including its header. */
	sourceRow?: number;
	/** Clamped to the public 100-detail ceiling. */
	maxIssues?: number;
}

export type LookupRowValuesValidation =
	| {
			success: true;
			values: LookupRowValues;
			issues: [];
			totalIssueCount: 0;
	  }
	| {
			success: false;
			/** Safe partial normalization; callers must not persist it on failure. */
			values: LookupRowValues;
			issues: LookupValidationDetail[];
			totalIssueCount: number;
	  };

type CellCoercion =
	| { success: true; value: LookupCellValue }
	| { success: false; message: string; code: string };

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Matches the `ajv-formats` full `date` validator used by case data. */
export function isLookupDate(value: string): boolean {
	const match = DATE_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const days = [
		0,
		31,
		isLeapYear(year) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return month >= 1 && month <= 12 && day >= 1 && day <= days[month];
}

/** Matches the timezone-required `ajv-formats` full `time` validator. */
export function isLookupTime(value: string): boolean {
	const match = TIME_PATTERN.exec(value);
	if (!match) return false;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = Number(match[3]);
	const sign = match[5] === "-" ? -1 : 1;
	const offsetHour = Number(match[6] ?? 0);
	const offsetMinute = Number(match[7] ?? 0);
	if (offsetHour > 23 || offsetMinute > 59) return false;
	if (hour <= 23 && minute <= 59 && second < 60) return true;
	// RFC 3339 leap second, adjusted into UTC like ajv-formats.
	const utcMinute = minute - offsetMinute * sign;
	const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0);
	return (
		(utcHour === 23 || utcHour === -1) &&
		(utcMinute === 59 || utcMinute === -1) &&
		second < 61
	);
}

/** Matches the case-data `date-time` format, including required timezone. */
export function isLookupDatetime(value: string): boolean {
	const parts = value.split(DATE_TIME_SEPARATOR);
	return parts.length === 2 && isLookupDate(parts[0]) && isLookupTime(parts[1]);
}

function invalidText(value: string): CellCoercion | undefined {
	if (value.includes("\0")) {
		return {
			success: false,
			code: "nul_cell",
			message: "Cell text may not contain NUL.",
		};
	}
	if (hasUnpairedUtf16Surrogate(value)) {
		return {
			success: false,
			code: "invalid_unicode",
			message: "Cell text contains an unpaired UTF-16 surrogate.",
		};
	}
	if (utf8ByteLength(value) > LOOKUP_MAX_CELL_BYTES) {
		return {
			success: false,
			code: "cell_too_large",
			message: `Cell text exceeds ${LOOKUP_MAX_CELL_BYTES} UTF-8 bytes.`,
		};
	}
	return undefined;
}

export function coerceLookupCell(
	dataType: LookupDataType,
	input: unknown,
	source: LookupCoercionSource = "typed",
): CellCoercion {
	if (typeof input === "string") {
		const textError = invalidText(input);
		if (textError) return textError;
	}

	switch (dataType) {
		case "text":
			return typeof input === "string"
				? { success: true, value: input }
				: {
						success: false,
						code: "invalid_text",
						message: "Text cells must be strings.",
					};

		case "int": {
			let value: number;
			if (source === "csv") {
				if (typeof input !== "string" || !CANONICAL_INT_PATTERN.test(input)) {
					return {
						success: false,
						code: "invalid_int",
						message:
							"Integer cells must use canonical signed base-10 notation.",
					};
				}
				value = Number(input);
			} else if (typeof input === "number") {
				value = input;
			} else {
				return {
					success: false,
					code: "invalid_int",
					message: "Integer cells must be JSON integers.",
				};
			}
			if (
				!Number.isInteger(value) ||
				value < LOOKUP_INT4_MIN ||
				value > LOOKUP_INT4_MAX
			) {
				return {
					success: false,
					code: "invalid_int",
					message: `Integer cells must be between ${LOOKUP_INT4_MIN} and ${LOOKUP_INT4_MAX}.`,
				};
			}
			return { success: true, value: Object.is(value, -0) ? 0 : value };
		}

		case "decimal": {
			let value: number;
			if (source === "csv") {
				if (typeof input !== "string" || !JSON_NUMBER_PATTERN.test(input)) {
					return {
						success: false,
						code: "invalid_decimal",
						message: "Decimal cells must use JSON number notation.",
					};
				}
				value = Number(input);
			} else if (typeof input === "number") {
				value = input;
			} else {
				return {
					success: false,
					code: "invalid_decimal",
					message: "Decimal cells must be JSON numbers.",
				};
			}
			return Number.isFinite(value)
				? { success: true, value: Object.is(value, -0) ? 0 : value }
				: {
						success: false,
						code: "invalid_decimal",
						message: "Decimal cells must be finite JSON numbers.",
					};
		}

		case "date":
			return typeof input === "string" && isLookupDate(input)
				? { success: true, value: input }
				: {
						success: false,
						code: "invalid_date",
						message: "Date cells must use a valid YYYY-MM-DD date.",
					};

		case "time":
			return typeof input === "string" && isLookupTime(input)
				? { success: true, value: input }
				: {
						success: false,
						code: "invalid_time",
						message: "Time cells must use an RFC 3339 time with a timezone.",
					};

		case "datetime":
			return typeof input === "string" && isLookupDatetime(input)
				? { success: true, value: input }
				: {
						success: false,
						code: "invalid_datetime",
						message:
							"Datetime cells must use an RFC 3339 date-time with a timezone.",
					};
	}
}

/**
 * Validates a complete UUID-keyed row against the current column definition.
 * The result always includes a normalized (possibly partial) value object and
 * a bounded issue sample; persistence is legal only on `success: true`.
 */
export function validateLookupRowValues(
	columns: readonly LookupColumn[],
	values: unknown,
	options: ValidateLookupRowValuesOptions = {},
): LookupRowValuesValidation {
	const requestedMax = options.maxIssues ?? LOOKUP_MAX_VALIDATION_DETAILS;
	const maxIssues = Math.min(
		LOOKUP_MAX_VALIDATION_DETAILS,
		Math.max(0, Number.isSafeInteger(requestedMax) ? requestedMax : 0),
	);
	const issues = createLookupIssueCollector(maxIssues);
	const normalized: LookupRowValues = {};
	const source = options.source ?? "typed";
	const detailBase =
		options.sourceRow === undefined ? {} : { row: options.sourceRow };

	if (typeof values !== "object" || values === null || Array.isArray(values)) {
		issues.add({
			...detailBase,
			code: "invalid_row",
			message: "Row values must be an object keyed by column UUID.",
		});
		return {
			success: false,
			values: normalized,
			issues: issues.details,
			totalIssueCount: issues.totalDetailCount,
		};
	}

	const columnById = new Map(columns.map((column) => [column.id, column]));
	const entries = Object.entries(values as Record<string, unknown>);
	if (entries.length > LOOKUP_MAX_COLUMNS) {
		issues.add({
			...detailBase,
			code: "too_many_cells",
			message: `A row may contain at most ${LOOKUP_MAX_COLUMNS} cells.`,
		});
	}

	const seen = new Set<LookupColumnId>();
	for (const [rawId, input] of entries) {
		const idResult = lookupColumnIdSchema.safeParse(rawId);
		if (!idResult.success) {
			issues.add({
				...detailBase,
				code: "invalid_column_id",
				message: `Row key "${rawId}" is not a UUIDv7 column identifier.`,
			});
			continue;
		}
		const id = idResult.data;
		if (seen.has(id)) {
			issues.add({
				...detailBase,
				code: "duplicate_column_id",
				message: `Column UUID "${id}" appears more than once.`,
			});
			continue;
		}
		seen.add(id);
		const column = columnById.get(id);
		if (!column) {
			issues.add({
				...detailBase,
				code: "unknown_column",
				message: `Column UUID "${id}" is not part of this table.`,
			});
			continue;
		}

		const result = coerceLookupCell(column.dataType, input, source);
		if (!result.success) {
			issues.add({
				...detailBase,
				column: column.wireName,
				code: result.code,
				message: result.message,
			});
			continue;
		}
		normalized[id] = result.value;
	}

	if (issues.totalDetailCount > 0) {
		return {
			success: false,
			values: normalized,
			issues: issues.details,
			totalIssueCount: issues.totalDetailCount,
		};
	}
	return {
		success: true,
		values: normalized,
		issues: [],
		totalIssueCount: 0,
	};
}
