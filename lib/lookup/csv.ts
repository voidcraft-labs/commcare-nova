import type { LookupColumnId } from "@/lib/domain/lookupIds";
import { validateLookupRowValues } from "./coercion";
import {
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_CSV_BYTES,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_VALIDATION_DETAILS,
} from "./constants";
import { createLookupIssueCollector } from "./errors";
import type {
	LookupColumn,
	LookupCsvDocument,
	LookupCsvWireRow,
	LookupResult,
	LookupValidationDetail,
	ValidatedLookupCsv,
} from "./types";

export type LookupCsvParseResult = LookupResult<
	LookupCsvDocument,
	"invalid_csv"
>;
export type LookupCsvValidationResult = LookupResult<
	ValidatedLookupCsv,
	"invalid_csv"
>;

interface CsvRecord {
	fields: string[];
	blank: boolean;
}

function invalidCsv(
	message: string,
	details: LookupValidationDetail[],
	totalDetailCount: number,
): LookupCsvParseResult {
	return {
		success: false,
		code: "invalid_csv",
		message,
		details,
		totalDetailCount,
	};
}

/**
 * Parses raw RFC-4180 bytes without binding headers to a possibly stale table
 * definition. The successful document deliberately keeps exact wire-name keys;
 * {@link validateLookupCsv} resolves them to immutable column UUIDs and is safe
 * to rerun after the service locks and rereads the table definition.
 */
export function parseLookupCsv(bytes: Uint8Array): LookupCsvParseResult {
	if (bytes.byteLength > LOOKUP_MAX_CSV_BYTES) {
		return invalidCsv(
			`CSV exceeds the ${LOOKUP_MAX_CSV_BYTES}-byte limit.`,
			[
				{
					code: "csv_too_large",
					message: `CSV exceeds the ${LOOKUP_MAX_CSV_BYTES}-byte limit.`,
				},
			],
			1,
		);
	}
	if (bytes.includes(0)) {
		return invalidCsv(
			"CSV contains a NUL byte.",
			[{ code: "nul_byte", message: "CSV may not contain NUL bytes." }],
			1,
		);
	}

	let text: string;
	try {
		// `ignoreBOM: true` asks TextDecoder to retain BOM so this boundary can
		// accept exactly one leading marker and detect a duplicate explicitly.
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		return invalidCsv(
			"CSV is not valid UTF-8.",
			[
				{
					code: "invalid_utf8",
					message: "CSV must be valid UTF-8.",
				},
			],
			1,
		);
	}
	if (text.startsWith("\uFEFF")) text = text.slice(1);
	if (text.startsWith("\uFEFF")) {
		return invalidCsv(
			"CSV has more than one leading UTF-8 BOM.",
			[
				{
					code: "duplicate_bom",
					message: "CSV may contain at most one leading UTF-8 BOM.",
				},
			],
			1,
		);
	}

	const issues = createLookupIssueCollector();
	let headers: string[] | undefined;
	const rows: LookupCsvWireRow[] = [];
	let dataRecordCount = 0;
	let rowLimitReported = false;

	const consumeRecord = (record: CsvRecord) => {
		const sourceRow = headers === undefined ? 1 : dataRecordCount + 2;
		if (headers === undefined) {
			headers = record.fields;
			const seen = new Set<string>();
			for (const header of headers) {
				if (header.length === 0) {
					issues.add({
						code: "empty_header",
						row: 1,
						message: "CSV headers may not be empty.",
					});
				} else if (seen.has(header)) {
					issues.add({
						code: "duplicate_header",
						row: 1,
						column: header,
						message: `CSV header "${header}" appears more than once.`,
					});
				}
				seen.add(header);
			}
			return;
		}

		dataRecordCount++;
		if (dataRecordCount > LOOKUP_MAX_ROWS) {
			if (!rowLimitReported) {
				issues.add({
					code: "row_limit",
					row: sourceRow,
					message: `CSV may contain at most ${LOOKUP_MAX_ROWS} data rows.`,
				});
				rowLimitReported = true;
			}
			return;
		}
		if (record.blank) {
			issues.add({
				code: "blank_row",
				row: sourceRow,
				message: "Blank rows are not allowed inside a CSV file.",
			});
			return;
		}
		if (record.fields.length !== headers.length) {
			issues.add({
				code: "inconsistent_width",
				row: sourceRow,
				message: `Row has ${record.fields.length} cells; expected ${headers.length}.`,
			});
			return;
		}

		const entries: [string, string][] = [];
		for (let index = 0; index < headers.length; index++) {
			const value = record.fields[index];
			// CSV has one absence spelling: an empty cell omits the UUID after
			// resolution. Whitespace is data and remains byte-identical.
			if (value !== "") entries.push([headers[index], value]);
		}
		// Object.fromEntries defines `__proto__` as ordinary data, unlike
		// assignment onto `{}`; that wire-safe spelling must not mutate a
		// parser object's prototype.
		const values = Object.fromEntries(entries);
		rows.push({ sourceRow, values });
	};

	let fields: string[] = [];
	let field = "";
	let inQuotes = false;
	let afterQuote = false;
	let recordRawLength = 0;
	let endedOnRecordDelimiter = false;
	let pending: CsvRecord | undefined;
	let emittedRecords = 0;

	const emit = () => {
		const record = {
			fields: [...fields, field],
			blank: recordRawLength === 0,
		};
		if (pending) consumeRecord(pending);
		pending = record;
		emittedRecords++;
		fields = [];
		field = "";
		afterQuote = false;
		recordRawLength = 0;
	};

	const malformed = (message: string): LookupCsvParseResult =>
		invalidCsv(
			"CSV has invalid RFC-4180 syntax.",
			[
				{
					code: "malformed_csv",
					row: emittedRecords + 1,
					message,
				},
			],
			1,
		);
	const finishDelimitedField = (): LookupCsvParseResult | undefined => {
		fields.push(field);
		field = "";
		if (emittedRecords === 0) {
			// A delimiter means another field follows, so the 250th completed
			// header already proves a 251-column record. Apply this in the one
			// shared path for quoted and unquoted fields.
			if (fields.length >= LOOKUP_MAX_COLUMNS) {
				return invalidCsv(
					"CSV has too many columns.",
					[
						{
							code: "column_limit",
							row: 1,
							message: `CSV may contain at most ${LOOKUP_MAX_COLUMNS} columns.`,
						},
					],
					1,
				);
			}
			return undefined;
		}

		// The header may still be the delayed `pending` record when the first
		// data row is scanned. Stop as soon as one extra delimiter proves the
		// row is too wide, rather than allocating an array entry for every byte.
		const headerWidth = headers?.length ?? pending?.fields.length;
		if (headerWidth !== undefined && fields.length >= headerWidth) {
			if (pending) consumeRecord(pending);
			issues.add({
				code: "inconsistent_width",
				row: emittedRecords + 1,
				message: `Row has more than ${headerWidth} cells; expected ${headerWidth}.`,
			});
			return invalidCsv(
				"CSV could not be imported.",
				issues.details,
				issues.totalDetailCount,
			);
		}
		return undefined;
	};

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		endedOnRecordDelimiter = false;
		if (inQuotes) {
			recordRawLength++;
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index++;
					recordRawLength++;
				} else {
					inQuotes = false;
					afterQuote = true;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (afterQuote) {
			if (char === ",") {
				recordRawLength++;
				const widthFailure = finishDelimitedField();
				if (widthFailure) return widthFailure;
				afterQuote = false;
				continue;
			}
			if (char === "\n" || char === "\r") {
				if (char === "\r") {
					if (text[index + 1] !== "\n") {
						return malformed(
							"A bare carriage return is not a record delimiter.",
						);
					}
					index++;
				}
				emit();
				endedOnRecordDelimiter = true;
				continue;
			}
			return malformed("Only a comma or newline may follow a closing quote.");
		}

		if (char === '"') {
			if (field.length !== 0) {
				return malformed("A quote inside an unquoted field must be doubled.");
			}
			inQuotes = true;
			recordRawLength++;
			continue;
		}
		if (char === ",") {
			recordRawLength++;
			const widthFailure = finishDelimitedField();
			if (widthFailure) return widthFailure;
			continue;
		}
		if (char === "\n" || char === "\r") {
			if (char === "\r") {
				if (text[index + 1] !== "\n") {
					return malformed("A bare carriage return is not a record delimiter.");
				}
				index++;
			}
			emit();
			endedOnRecordDelimiter = true;
			continue;
		}
		field += char;
		recordRawLength++;
	}

	if (inQuotes) return malformed("A quoted field is not terminated.");
	if (!endedOnRecordDelimiter) emit();
	// `pending` after a delimiter is the real record before that delimiter;
	// the implicit empty record after it is never emitted. Thus exactly one
	// trailing newline is accepted, while a second newline already consumed
	// the preceding blank record and reports it as interior.
	if (pending) consumeRecord(pending);

	if (issues.totalDetailCount > 0) {
		return invalidCsv(
			"CSV could not be imported.",
			issues.details,
			issues.totalDetailCount,
		);
	}
	return {
		success: true,
		value: { headers: headers ?? [""], rows },
	};
}

/** Resolve/coerce a parsed document against one exact column snapshot. */
export function validateLookupCsv(
	document: LookupCsvDocument,
	columns: readonly LookupColumn[],
): LookupCsvValidationResult {
	const details: LookupValidationDetail[] = [];
	let totalDetailCount = 0;
	const add = (detail: LookupValidationDetail) => {
		totalDetailCount++;
		if (details.length < LOOKUP_MAX_VALIDATION_DETAILS) details.push(detail);
	};
	const columnByWireName = new Map(
		columns.map((column) => [column.wireName, column]),
	);
	const headerSet = new Set(document.headers);

	for (const header of document.headers) {
		if (!columnByWireName.has(header)) {
			add({
				code: "unknown_header",
				row: 1,
				column: header,
				message: `CSV header "${header}" is not a column in this table.`,
			});
		}
	}
	for (const column of columns) {
		if (!headerSet.has(column.wireName)) {
			add({
				code: "missing_header",
				row: 1,
				column: column.wireName,
				message: `CSV is missing the "${column.wireName}" column.`,
			});
		}
	}

	const rows = [] as ValidatedLookupCsv["rows"];
	for (const row of document.rows) {
		const uuidValues: Record<LookupColumnId, string> = {};
		for (const [wireName, value] of Object.entries(row.values)) {
			const column = columnByWireName.get(wireName);
			if (column) uuidValues[column.id] = value;
		}
		const result = validateLookupRowValues(columns, uuidValues, {
			source: "csv",
			sourceRow: row.sourceRow,
			maxIssues: Math.max(0, LOOKUP_MAX_VALIDATION_DETAILS - details.length),
		});
		if (result.success) {
			rows.push(result.values);
		} else {
			totalDetailCount += result.totalIssueCount;
			for (const detail of result.issues) {
				if (details.length >= LOOKUP_MAX_VALIDATION_DETAILS) break;
				details.push(detail);
			}
		}
	}

	if (totalDetailCount > 0) {
		return {
			success: false,
			code: "invalid_csv",
			message: "CSV values do not match this lookup table.",
			details,
			totalDetailCount,
		};
	}
	return { success: true, value: { document, rows } };
}
