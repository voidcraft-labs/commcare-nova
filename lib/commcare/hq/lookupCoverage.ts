import "server-only";

import { ownRecordValue, recordFromEntries } from "@/lib/domain/records";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
} from "./http";
import {
	cleanLookupFixtureField,
	type LookupWorker,
	lookupDeviceWitness,
	readGlobalLookupRestoreWitness,
	readLookupWorkerRestore,
	type WorkerLookupRow,
} from "./lookupRestore";
import {
	type LookupSourceReadOptions,
	readSelectedLookupDetails,
	streamHqLookupTable,
	verifyHqLookupDefinition,
} from "./lookupSource";
import type { HqFixtureRow, HqLookupRows, HqLookupTable } from "./lookupTables";
import { giveBackHeld } from "./memoryMeter";
import { HQ_LIST_MOVED } from "./readCollection";

/** ItemListsProvider.to_xml uses the definition's field order. No element is
 * emitted for [], one empty element for a missing field. XML 1.0 normalizes
 * raw text CR/CRLF to LF; ElementTree escapes attribute line breaks. */
export function lookupDeviceRow(
	table: HqLookupTable,
	row: HqFixtureRow,
): WorkerLookupRow | null {
	const attributes: [string, string][] = [];
	for (const name of table.itemAttributes) {
		const value = ownRecordValue(row.itemAttributes, name);
		if (value === undefined) return null;
		attributes.push([name, value]);
	}
	const fields = table.fields.flatMap((field) => {
		const name = cleanLookupFixtureField(field);
		const value = ownRecordValue(row.fields, field);
		const occurrences =
			value === undefined || typeof value === "string"
				? [{ value: value ?? "", properties: {} }]
				: value;
		return occurrences.map((item) => ({
			name,
			text: item.value.replace(/\r\n?/g, "\n"),
			properties: item.properties,
		}));
	});
	return { attributes: recordFromEntries(attributes), fields };
}

/** Complete a global table that HQ's ordered fixture list cannot serialize.
 * distinct scoped candidate IDs + independent authoritative cardinality establish
 * coverage. Equal visible rows never assign identities. Two observations check
 * the full ordered projection, definition and exact details including hidden blanks. */
export async function readVerifiedGlobalLookupRows(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	options: {
		readonly binding: string;
		readonly candidates: readonly string[];
		readonly worker?: LookupWorker;
		readonly maxBytes: number;
		readonly cancel?: AbortSignal;
	},
): Promise<
	| (HqLookupRows & { readonly indexedFields: readonly string[] })
	| CommCareApiError
> {
	if (
		!table.isGlobal ||
		new Set(options.candidates).size !== options.candidates.length
	)
		return HQ_MALFORMED_ANSWER;
	const worker = options.worker ?? { username: creds.username };
	let first: { digest: string; workerId: string } | undefined;
	for (let pass = 0; pass < 2; pass++) {
		const before = await verifyHqLookupDefinition(
			creds,
			domain,
			table,
			options.cancel,
		);
		if (before) return before;
		const sample = await readLookupWorkerRestore(creds, domain, table, worker, {
			binding: options.binding,
			cancel: options.cancel,
		});
		if ("success" in sample) return sample;
		if (
			sample.read !== "full" ||
			sample.rows.length !== options.candidates.length
		)
			return HQ_LIST_MOVED;
		const details = await readSelectedLookupDetails(
			creds,
			domain,
			table,
			options.candidates,
			options.maxBytes,
			options.cancel,
		);
		if ("success" in details) return details;
		let kept = false;
		try {
			for (const [index, row] of details.rows.entries()) {
				const projected = lookupDeviceRow(table, row);
				if (
					projected === null ||
					canonicalJsonDigest(projected) !==
						canonicalJsonDigest(sample.rows[index])
				)
					return HQ_LIST_MOVED;
			}
			const digest = canonicalJsonDigest([details.rows, sample.indexedFields]);
			if (
				first &&
				(first.digest !== digest || sample.workerId !== first.workerId)
			)
				return HQ_LIST_MOVED;
			const after = await verifyHqLookupDefinition(
				creds,
				domain,
				table,
				options.cancel,
			);
			if (after) return after;
			if (pass === 1) {
				kept = true;
				return {
					rows: details.rows,
					bytes: details.bytes,
					totalCount: details.rows.length,
					indexedFields: sample.indexedFields,
				};
			}
			first = { digest, workerId: sample.workerId };
		} finally {
			if (!kept) giveBackHeld("text", details.bytes);
		}
	}
	throw new Error("Missing verified lookup observation.");
}

/** Refresh the authority for transferring one completed global generation. The
 * immutable generation's ordered upstream digest binds the administrative identities,
 * lexical fields and sort sequence. A complete native fixture independently verifies
 * current global visibility, device values, multiplicity and the observed index flags. */
export async function readGlobalGenerationTransferWitness(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	options: Pick<
		LookupSourceReadOptions,
		"cancel" | "maxBytes" | "maxRequests" | "deadlineMs" | "authorizePage"
	> & {
		binding: string;
		expected: {
			throughDigest: string;
			definitionDigest: string;
			count: number;
		};
	},
) {
	if (!table.isGlobal) return HQ_MALFORMED_ANSWER;
	const observe = () =>
		readGlobalLookupRestoreWitness(creds, domain, table, {
			binding: options.binding,
			cancel: options.cancel,
		});
	await options.authorizePage?.();
	const before = await observe();
	if ("success" in before) return before;
	if (before.count !== options.expected.count) return HQ_LIST_MOVED;
	const device = lookupDeviceWitness();
	let representable = true;
	const result = await streamHqLookupTable(creds, domain, table, {
		...options,
		stage: async () => true,
		verifyRow(row) {
			const projection = lookupDeviceRow(table, row);
			if (!projection) representable = false;
			else device.observe(projection);
		},
	});
	if ("success" in result) return result;
	const measured = device.finish();
	if (
		!representable ||
		result.definitionDigest !== options.expected.definitionDigest ||
		result.throughDigest !== options.expected.throughDigest ||
		result.totalCount !== before.count ||
		measured.count !== before.count ||
		measured.digest !== before.digest
	)
		return HQ_LIST_MOVED;
	await options.authorizePage?.();
	const after = await observe();
	if ("success" in after) return after;
	if (
		before.count !== after.count ||
		before.digest !== after.digest ||
		before.workerId !== after.workerId ||
		canonicalJsonDigest(before.indexedFields) !==
			canonicalJsonDigest(after.indexedFields)
	)
		return HQ_LIST_MOVED;
	const moved = await verifyHqLookupDefinition(
		creds,
		domain,
		table,
		options.cancel,
	);
	return (
		moved ?? {
			indexedFields: after.indexedFields,
			throughDigest: result.throughDigest,
		}
	);
}
