"use client";

// The browser half of CSV replacement.
//
// This is a raw route rather than a Server Action for one reason: a `File`
// argument makes React encode the call as `multipart/form-data`, whose part
// headers the edge WAF reads as header injection. The bytes go up as a plain
// `text/csv` body instead, and no parsed row array ever crosses an action.
//
// The client parses the file FIRST, purely to tell the author what is wrong
// before spending an upload: the server re-parses the same bytes against the
// table it locks, and that pass is the authority. A client that said "looks
// fine" and a server that then refused would be worse than no preview at all,
// so both run `parseLookupCsv` + `validateLookupCsv`: the same functions, on
// the same bytes.

import type { LookupTableId } from "@/lib/domain/lookupIds";
import { LOOKUP_MAX_CSV_BYTES } from "@/lib/lookup/constants";
import { parseLookupCsv, validateLookupCsv } from "@/lib/lookup/csv";
import { formatLookupBytes } from "@/lib/lookup/format";
import type {
	LookupColumn,
	LookupFailure,
	LookupImportErrorCode,
	LookupMutationReceipt,
	LookupRevision,
} from "@/lib/lookup/types";

export type LookupImportResult =
	| { readonly success: true; readonly value: LookupMutationReceipt }
	| LookupFailure<LookupImportErrorCode>;

/**
 * Check a chosen file against the table it would replace, without uploading.
 *
 * Returns `null` when the file would be accepted. Everything it can refuse,
 * the server refuses identically: this only moves the answer earlier.
 */
export function inspectLookupCsv(
	bytes: Uint8Array,
	columns: readonly LookupColumn[],
): LookupFailure<"invalid_csv"> | null {
	if (bytes.byteLength > LOOKUP_MAX_CSV_BYTES) {
		const limit = formatLookupBytes(LOOKUP_MAX_CSV_BYTES);
		return {
			success: false,
			code: "invalid_csv",
			message: `That CSV is ${formatLookupBytes(bytes.byteLength)}, which is over the ${limit} limit for one import.`,
			details: [
				{
					code: "csv_too_large",
					message: `Split it into smaller files, or remove some rows, so each import is at most ${limit}.`,
				},
			],
			totalDetailCount: 1,
		};
	}
	const parsed = parseLookupCsv(bytes);
	if (!parsed.success) return parsed;
	const validated = validateLookupCsv(parsed.value, columns);
	return validated.success ? null : validated;
}

/** How many data rows a checked CSV would land, for the confirmation. */
export function countLookupCsvRows(bytes: Uint8Array): number | null {
	const parsed = parseLookupCsv(bytes);
	return parsed.success ? parsed.value.rows.length : null;
}

/** Replace every row in a table with the CSV's, in one transaction. */
export async function importLookupCsv(args: {
	projectId: string;
	tableId: LookupTableId;
	expectedTableRevision: LookupRevision;
	bytes: Uint8Array;
	signal?: AbortSignal;
}): Promise<LookupImportResult> {
	const url = `/api/projects/${encodeURIComponent(args.projectId)}/lookup/tables/${encodeURIComponent(args.tableId)}/import?expectedTableRevision=${encodeURIComponent(args.expectedTableRevision)}`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "text/csv" },
			/* A fresh buffer, because `fetch` wants an `ArrayBuffer` and the
			 * caller's view may be a slice of a larger one. */
			body: new Uint8Array(args.bytes).buffer as ArrayBuffer,
			...(args.signal === undefined ? {} : { signal: args.signal }),
		});
	} catch {
		return {
			success: false,
			code: "internal_error",
			message:
				"The CSV could not be sent. Check your connection and try again.",
		};
	}
	try {
		return (await response.json()) as LookupImportResult;
	} catch {
		return {
			success: false,
			code: "internal_error",
			message:
				"The import did not finish. Reload the table to see where it got to.",
		};
	}
}
