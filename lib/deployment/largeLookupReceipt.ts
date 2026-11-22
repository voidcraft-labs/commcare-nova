import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import { streamHqLookupTable } from "@/lib/commcare/hq/lookupSource";
import type { HqLookupTable } from "@/lib/commcare/hq/lookupTables";
import type { ExpectedLookupData } from "@/lib/commcare/lookup/workbookReceipt";
import { readSelectedHqLookupRows } from "@/lib/commcare/hq/lookupSource";
import { HQ_LOOKUP_TABLE_ROWS_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import type { CanonicalLookupTable } from "./types";
import { LOOKUP_MAX_ROWS } from "@/lib/lookup/constants";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	canonicalLookupObservation,
	streamingLookupRowsDigest,
} from "./hqResourceBaseline";

/** Compare the saved native observation that preflight just revalidated
 * against this particular file's intent before resuming another file. */
export function matchesRecordedLookup(
	seen: CanonicalLookupTable,
	expected: ExpectedLookupData,
) {
	return (
		seen.rowCount === expected.count &&
		seen.rowsDigest === expected.digest &&
		seen.isGlobal === expected.isGlobal &&
		canonicalJsonDigest(seen.fields) ===
			canonicalJsonDigest(
				expected.fields.map((name) => ({
					name,
					properties: expected.fieldProperties[name] ?? [],
				})),
			) &&
		canonicalJsonDigest(seen.itemAttributes) ===
			canonicalJsonDigest(expected.attributes)
	);
}

/** A read-back certifies the intended state, including table-wide visibility.
 * HQ's ordinary rows do not attest private owners or index flags. Callers also
 * need current independent evidence for those properties. */
export async function readLookupReceipt(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	expected: ExpectedLookupData,
	authorize?: () => Promise<void>,
) {
	const unknown = { kind: "unverified-target" as const };
	if (
		table.isGlobal !== expected.isGlobal ||
		canonicalJsonDigest([table.fields, table.itemAttributes]) !==
			canonicalJsonDigest([expected.fields, expected.attributes])
	)
		return unknown;
	for (const field of expected.fields)
		if (
			canonicalJsonDigest(table.fieldProperties[field] ?? []) !==
			canonicalJsonDigest(expected.fieldProperties[field] ?? [])
		)
			return unknown;
	if (authorize) {
		const answer = await observeLargeLookup(creds, domain, table, authorize);
		if (!("canonical" in answer)) return answer;
		return answer.canonical.rowCount === expected.count &&
			answer.canonical.rowsDigest === expected.digest
			? answer
			: unknown;
	}
	const read = await readSelectedHqLookupRows(creds, domain, table, {
		maxRows: LOOKUP_MAX_ROWS,
		maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
	});
	if ("success" in read || "kind" in read) return read;
	const observed = streamingLookupRowsDigest();
	for (const row of read.rows) observed.row(row);
	const { count, digest } = observed.finish();
	return count === expected.count && digest === expected.digest
		? { canonical: canonicalLookupObservation(table, count, digest) }
		: unknown;
}

export async function observeLargeLookup(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	authorize: () => Promise<void>,
) {
	const verified = streamingLookupRowsDigest();
	const result = await streamHqLookupTable(creds, domain, table, {
		maxBytes: 64 * 1024 ** 3,
		maxRequests: 250_000,
		deadlineMs: 120_000,
		authorizePage: authorize,
		stage: async () => true,
		verifyRow: (row) => verified.row(row),
	});
	if ("success" in result) return result;
	const { count, digest } = verified.finish();
	return { canonical: canonicalLookupObservation(table, count, digest) };
}
