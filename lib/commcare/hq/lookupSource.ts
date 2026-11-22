import "server-only";

import { createHash } from "node:crypto";
import { ownRecordValue } from "@/lib/domain/records";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import {
	HQ_LOOKUP_DEFINITION_MAX_BYTES,
	HQ_LOOKUP_DETAIL_MAX_BYTES,
	HQ_LOOKUP_PAGE_MAX_BYTES,
} from "./bounds";
import { withHqRequestDeadline } from "./deadline";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
} from "./http";
import {
	type HqFixtureRow,
	type HqLookupRows,
	type HqLookupTable,
	readHqLookupTableRows,
	toFixtureRowFields,
	toHqFixtureRow,
	toHqLookupTable,
} from "./lookupTables";
import { chargeHeld, giveBackHeld } from "./memoryMeter";
import {
	decodeHqPage,
	HQ_LIST_MOVED,
	type HqPastLimit,
	isHqObject,
} from "./readCollection";
import { readHqJson } from "./readJson";

const REMOTE_ID = /^[a-f0-9]{32}$/;
const LABEL = "selected lookup table";
const WORK_LIMIT: CommCareApiError = {
	success: false,
	status: 502,
	cause: "too-large",
};

interface ReadBudget {
	remaining: number;
	requests: number;
	readonly signal: AbortSignal;
	readonly authorizePage?: () => Promise<void>;
}

async function readWithinBudget(
	creds: CommCareCredentials,
	url: string,
	limit: number,
	budget: ReadBudget,
) {
	if (budget.signal.aborted)
		return { success: false, status: 503, cause: "network" } as const;
	if (budget.remaining <= 0 || budget.requests <= 0) return WORK_LIMIT;
	budget.requests--;
	const read = await readHqJson(creds, url, LABEL, {
		maxBytes: Math.min(budget.remaining, limit),
		cancel: budget.signal,
	});
	if (!("success" in read)) budget.remaining -= read.bytes;
	return read;
}

function sourceRoot(creds: CommCareCredentials, domain: string) {
	return `${baseUrl(creds)}/a/${domain}/api`;
}

async function checkDefinition(
	creds: CommCareCredentials,
	root: string,
	table: HqLookupTable,
	budget: ReadBudget,
): Promise<CommCareApiError | null> {
	const answer = await readWithinBudget(
		creds,
		`${root}/lookup_table/v1/${table.id}/`,
		HQ_LOOKUP_DEFINITION_MAX_BYTES,
		budget,
	);
	if ("success" in answer) return answer;
	try {
		const current = toHqLookupTable(answer.data);
		if (current === null) return HQ_MALFORMED_ANSWER;
		return canonicalJsonDigest(current) === canonicalJsonDigest(table)
			? null
			: HQ_LIST_MOVED;
	} finally {
		giveBackHeld("text", answer.bytes);
	}
}

/** Bind a selected fixture tag to the same scoped table on both sides of an
 * observation made through a different HQ resource. */
export async function verifyHqLookupDefinition(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	cancel?: AbortSignal,
) {
	if (!isValidDomainSlug(domain) || !REMOTE_ID.test(table.id))
		return INVALID_DOMAIN_SLUG;
	return withHqRequestDeadline(
		(signal) =>
			checkDefinition(creds, sourceRoot(creds, domain), table, {
				signal,
				requests: 1,
				remaining: HQ_LOOKUP_DEFINITION_MAX_BYTES,
			}),
		undefined,
		cancel,
	);
}

function agreesWithInventory(
	inventory: HqFixtureRow["fields"],
	detail: HqFixtureRow["fields"],
): boolean {
	if (Object.keys(inventory).length !== Object.keys(detail).length)
		return false;
	for (const [field, values] of Object.entries(inventory)) {
		const occurrences = ownRecordValue(detail, field);
		if (!Array.isArray(occurrences)) return false;
		if (typeof values === "string") {
			// The fixture list discards singleton properties. The selected detail owns them.
			if (occurrences.length !== 1 || occurrences[0].value !== values)
				return false;
		} else if (canonicalJsonDigest(occurrences) !== canonicalJsonDigest(values))
			return false;
	}
	return true;
}

type DetailedRow = HqFixtureRow & {
	readonly sortKey: number;
	readonly itemAttributes: Readonly<Record<string, string>>;
};

async function readDetail(
	creds: CommCareCredentials,
	root: string,
	table: HqLookupTable,
	id: string,
	budget: ReadBudget,
): Promise<{ row: DetailedRow; bytes: number } | CommCareApiError> {
	// /lookup_table_item/v1/ LIST is unfiltered. Only these detail URLs may be constructed.
	if (!REMOTE_ID.test(id)) return HQ_MALFORMED_ANSWER;
	const answer = await readWithinBudget(
		creds,
		`${root}/lookup_table_item/v1/${id}/`,
		HQ_LOOKUP_DETAIL_MAX_BYTES,
		budget,
	);
	if ("success" in answer) return answer;
	let kept = false;
	try {
		const raw = answer.data;
		if (
			!isHqObject(raw) ||
			!isHqObject(raw.fields) ||
			!isHqObject(raw.item_attributes) ||
			!Object.values(raw.item_attributes).every(
				(value) => typeof value === "string",
			) ||
			typeof raw.sort_key !== "number" ||
			!Number.isSafeInteger(raw.sort_key) ||
			raw.sort_key < -2147483648 ||
			raw.sort_key > 2147483647
		)
			return HQ_MALFORMED_ANSWER;
		if (raw.id !== id || raw.data_type_id !== table.id) return HQ_LIST_MOVED;
		const fields = toFixtureRowFields(raw.fields);
		if (
			fields === null ||
			Object.values(fields).some((x) => typeof x === "string")
		)
			return HQ_MALFORMED_ANSWER;
		kept = true;
		return {
			row: {
				id,
				sortKey: raw.sort_key,
				itemAttributes: raw.item_attributes as Record<string, string>,
				fields,
			},
			bytes: answer.bytes,
		};
	} finally {
		if (!kept) giveBackHeld("text", answer.bytes);
	}
}

/** Read a bounded, selected set of proposed row identities. This operation does
 * not establish completeness. Callers must supply an independent global count
 * and compare the entire device projection before granting access to its result. */
export async function readSelectedLookupDetails(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	ids: readonly string[],
	maxBytes: number,
	cancel?: AbortSignal,
): Promise<{ rows: DetailedRow[]; bytes: number } | CommCareApiError> {
	if (
		!isValidDomainSlug(domain) ||
		!REMOTE_ID.test(table.id) ||
		ids.some((id) => !REMOTE_ID.test(id)) ||
		new Set(ids).size !== ids.length
	)
		return HQ_MALFORMED_ANSWER;
	return withHqRequestDeadline(
		async (signal) => {
			const budget = { remaining: maxBytes, requests: ids.length, signal };
			const root = sourceRoot(creds, domain);
			const rows: DetailedRow[] = [];
			let bytes = 0;
			let kept = false;
			try {
				for (const id of ids) {
					const result = await readDetail(creds, root, table, id, budget);
					if ("success" in result) return result;
					rows.push(result.row);
					bytes += result.bytes;
				}
				rows.sort(
					(a, b) =>
						a.sortKey - b.sortKey || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
				);
				kept = true;
				return { rows, bytes };
			} finally {
				if (!kept) giveBackHeld("text", bytes);
			}
		},
		120_000,
		cancel,
	);
}
export interface LookupSourceCheckpoint {
	/** Number of rows seen in the immutable prefix. */
	readonly offset: number;
	/** SHA-256 over the scoped definition followed by the complete ordered prefix. */
	readonly throughDigest: string;
}

export interface LookupSourcePage extends LookupSourceCheckpoint {
	/** First row in this batch, zero-based. offset is its exclusive end. */
	readonly start: number;
	readonly rows: readonly HqFixtureRow[];
	readonly bytes: number;
}

export interface LookupSourceWitness extends LookupSourceCheckpoint {
	readonly totalCount: number;
	readonly definitionDigest: string;
}

export interface LookupSourceReadOptions {
	readonly cancel?: AbortSignal;
	/** Work quotas across both passes and the bracketing reads. */
	readonly maxBytes: number;
	readonly maxRequests: number;
	readonly deadlineMs: number;
	readonly checkpoint?: LookupSourceCheckpoint;
	/** Recheck caller, job and source authorization before each ordered page on both passes. */
	readonly authorizePage?: () => Promise<void>;
	/** Runs for each row of the complete second observation, including a resumed prefix. */
	readonly verifyRow?: (row: HqFixtureRow) => void;
	/** Called under backpressure. A private generation must enforce unique remote row IDs
	 * across all pages, and exact, idempotent (start, offset, throughDigest) progress.
	 * False refuses the read. No staged page grants authority to serve a row. */
	readonly stage: (page: LookupSourcePage) => Promise<boolean>;
}

function hasRichDefinition(table: HqLookupTable) {
	return (
		table.itemAttributes.length > 0 ||
		Object.values(table.fieldProperties).some(
			(properties) => properties.length > 0,
		)
	);
}

function sortedAfter(
	row: DetailedRow,
	previous?: Pick<DetailedRow, "sortKey" | "id">,
) {
	return (
		previous === undefined ||
		row.sortKey > previous.sortKey ||
		(row.sortKey === previous.sortKey && row.id > previous.id)
	);
}

/** Calls stage only for the prefix not already proven identical on this pass. */
async function streamPass(
	creds: CommCareCredentials,
	root: string,
	table: HqLookupTable,
	definitionDigest: string,
	budget: ReadBudget,
	options: Pick<LookupSourceReadOptions, "checkpoint" | "stage"> | undefined,
	forceDetail: boolean,
	verifyRow?: (row: HqFixtureRow) => void,
): Promise<LookupSourceWitness | CommCareApiError> {
	const digest = createHash("sha256").update(definitionDigest).update("\n");
	const checkpoint = options?.checkpoint;
	let matched =
		checkpoint === undefined ||
		(checkpoint.offset === 0 &&
			checkpoint.throughDigest === digest.copy().digest("hex"));
	let total: number | null = null;
	let offset = 0;
	let previous: Pick<DetailedRow, "sortKey" | "id"> | undefined;
	for (;;) {
		await budget.authorizePage?.();
		const url = new URL(`${root}/fixture/v1/`);
		url.searchParams.set("fixture_type_id", table.id);
		if (offset > 0) url.searchParams.set("offset", String(offset));
		const answer = await readWithinBudget(
			creds,
			url.toString(),
			HQ_LOOKUP_PAGE_MAX_BYTES,
			budget,
		);
		if ("success" in answer) return answer;
		let detailBytes = 0;
		try {
			const page = decodeHqPage(answer.data, offset, LABEL);
			if ("success" in page) return page;
			if (page.more && page.total === null) return HQ_MALFORMED_ANSWER;
			if (offset === 0) total = page.total ?? page.objects.length;
			else if (page.total !== total) return HQ_LIST_MOVED;
			const end = offset + page.objects.length;
			if (total === null || end > total || page.more !== end < total)
				return HQ_LIST_MOVED;
			let batch: HqFixtureRow[] = [];
			let batchBytes = 0;
			let start = offset;
			const flush = async () => {
				if (
					batch.length &&
					options &&
					!(await options.stage({
						start,
						offset,
						rows: batch,
						bytes: batchBytes,
						throughDigest: digest.copy().digest("hex"),
					}))
				)
					return false;
				batch = [];
				batchBytes = 0;
				start = offset;
				giveBackHeld("text", detailBytes);
				detailBytes = 0;
				return true;
			};
			for (const raw of page.objects) {
				const listed = toHqFixtureRow(raw, table.tag);
				if (listed === null || !REMOTE_ID.test(listed.id))
					return HQ_MALFORMED_ANSWER;
				let row = listed;
				if (
					forceDetail ||
					Object.values(listed.fields).some(
						(field) => typeof field !== "string",
					)
				) {
					const result = await readDetail(
						creds,
						root,
						table,
						listed.id,
						budget,
					);
					if ("success" in result) return result;
					detailBytes += result.bytes;
					if (
						!sortedAfter(result.row, previous) ||
						!agreesWithInventory(listed.fields, result.row.fields)
					)
						return HQ_LIST_MOVED;
					previous = { id: result.row.id, sortKey: result.row.sortKey };
					row = result.row;
				}
				verifyRow?.(row);
				const text = canonicalJsonText(row);
				digest.update(text).update("\n");
				offset++;
				if (matched && options) {
					batch.push(row);
					batchBytes += Buffer.byteLength(text);
				} else if (!matched && offset === checkpoint?.offset) {
					if (digest.copy().digest("hex") !== checkpoint.throughDigest)
						return HQ_LIST_MOVED;
					matched = true;
					start = offset;
				}
				if (batchBytes >= 2 * 1024 * 1024 || !options || !matched) {
					if (!(await flush())) return HQ_LIST_MOVED;
				}
			}
			if (!(await flush())) return HQ_LIST_MOVED;
			if (!page.more)
				return matched
					? {
							offset,
							totalCount: offset,
							throughDigest: digest.digest("hex"),
							definitionDigest,
						}
					: HQ_LIST_MOVED;
		} finally {
			giveBackHeld("text", answer.bytes + detailBytes);
		}
	}
}

export function lookupSourceDefinitionDigest(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
) {
	return canonicalJsonDigest([
		"selected-lookup-v1",
		creds.server,
		domain,
		creds.username,
		table,
	]);
}

/** The only production path from a scoped, selected row inventory to selected row details.
 * Two complete observations bracket a private staging generation. Their digest includes
 * IDs, sort keys where present, all lexical data and the granted server/domain/table. */
export async function streamHqLookupTable(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	options: LookupSourceReadOptions,
	requireDetail = false,
): Promise<LookupSourceWitness | CommCareApiError> {
	if (!isValidDomainSlug(domain) || !REMOTE_ID.test(table.id))
		return INVALID_DOMAIN_SLUG;
	if (
		![options.maxBytes, options.maxRequests, options.deadlineMs].every(
			(n) => Number.isSafeInteger(n) && n > 0,
		)
	)
		return WORK_LIMIT;
	const forceDetail = requireDetail || hasRichDefinition(table);
	const root = sourceRoot(creds, domain);
	const definitionDigest = lookupSourceDefinitionDigest(creds, domain, table);
	return withHqRequestDeadline(
		async (signal) => {
			const budget = {
				remaining: options.maxBytes,
				requests: options.maxRequests,
				authorizePage: options.authorizePage,
				signal,
			};
			const initial = await checkDefinition(creds, root, table, budget);
			if (initial) return initial;
			const first = await streamPass(
				creds,
				root,
				table,
				definitionDigest,
				budget,
				options,
				forceDetail,
			);
			if ("success" in first) return first;
			const second = await streamPass(
				creds,
				root,
				table,
				definitionDigest,
				budget,
				undefined,
				forceDetail,
				options.verifyRow,
			);
			if ("success" in second) return second;
			if (second.throughDigest !== first.throughDigest) return HQ_LIST_MOVED;
			return (await checkDefinition(creds, root, table, budget)) ?? first;
		},
		options.deadlineMs,
		options.cancel,
	);
}

/** Small ordinary tables need only HQ's scoped fixture list. A definition or row with
 * richer content needs the selected details, including on a single-page table. */
export async function readSelectedHqLookupRows(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	options: { maxRows: number; maxBytes: number; cancel?: AbortSignal },
): Promise<HqLookupRows | HqPastLimit | CommCareApiError> {
	const listed = await readHqLookupTableRows(creds, domain, table, options);
	if ("success" in listed || "kind" in listed) return listed;
	if (
		!hasRichDefinition(table) &&
		!listed.rows.some((row) =>
			Object.values(row.fields).some((value) => typeof value !== "string"),
		)
	)
		return listed;
	const total = listed.totalCount;
	const expectedIds = listed.rows.map((row) => row.id);
	giveBackHeld("text", listed.bytes);
	const rows: HqFixtureRow[] = [];
	const ids = new Set<string>();
	let bytes = 0;
	let kept = false;
	let pastInlineBudget = false;
	let memoryRefused = false;
	try {
		const result = await streamHqLookupTable(
			creds,
			domain,
			table,
			{
				maxBytes: options.maxBytes * 6,
				// HQ chooses its own page size. Even one listed row per page
				// remains within this interactive two-pass request budget.
				maxRequests: total * 4 + 4,
				deadlineMs: 120_000,
				cancel: options.cancel,
				async stage(page) {
					if (page.offset > total) return false;
					if (bytes + page.bytes > options.maxBytes) {
						pastInlineBudget = true;
						return false;
					}
					if (!chargeHeld("text", page.bytes)) {
						memoryRefused = true;
						return false;
					}
					bytes += page.bytes;
					for (const row of page.rows) {
						if (ids.has(row.id) || expectedIds[rows.length] !== row.id)
							return false;
						ids.add(row.id);
						rows.push(row);
					}
					return true;
				},
			},
			true,
		);
		if (
			pastInlineBudget ||
			("success" in result && result.cause === "too-large")
		)
			return { kind: "past-limit", by: "bytes", totalCount: total };
		if (memoryRefused) return { success: false, status: 503, cause: "network" };
		if ("success" in result) return result;
		if (result.totalCount !== total) return HQ_LIST_MOVED;
		kept = true;
		return { rows, bytes, totalCount: total };
	} finally {
		if (!kept) giveBackHeld("text", bytes);
	}
}

/** Recheck one position from a completed inline inventory before a live editor
 * inspection. A precise filtered page proves row-read permission, identity
 * and total without fetching the rest of the source inventory. */
export async function inspectSelectedHqRowAt(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	expected: { ordinal: number; total: number; id: string | null },
	cancel?: AbortSignal,
) {
	if (
		!isValidDomainSlug(domain) ||
		!REMOTE_ID.test(table.id) ||
		(expected.id !== null && !REMOTE_ID.test(expected.id)) ||
		!Number.isSafeInteger(expected.ordinal) ||
		!Number.isSafeInteger(expected.total) ||
		expected.total < 0 ||
		expected.ordinal < 0 ||
		expected.ordinal >= Math.max(1, expected.total)
	)
		return HQ_MALFORMED_ANSWER;
	return withHqRequestDeadline(
		async (signal) => {
			const root = sourceRoot(creds, domain),
				budget = {
					remaining:
						HQ_LOOKUP_PAGE_MAX_BYTES +
						HQ_LOOKUP_DETAIL_MAX_BYTES +
						2 * HQ_LOOKUP_DEFINITION_MAX_BYTES,
					requests: 4,
					signal,
				};
			const initial = await checkDefinition(creds, root, table, budget);
			if (initial) return initial;
			const url = new URL(`${root}/fixture/v1/`);
			url.searchParams.set("fixture_type_id", table.id);
			url.searchParams.set("limit", "1");
			url.searchParams.set("offset", String(expected.ordinal));
			const page = await readWithinBudget(
				creds,
				url.toString(),
				HQ_LOOKUP_PAGE_MAX_BYTES,
				budget,
			);
			if ("success" in page) return page;
			try {
				const parsed = decodeHqPage(page.data, expected.ordinal, LABEL);
				if ("success" in parsed) return parsed;
				if (
					parsed.total !== expected.total ||
					parsed.objects.length !== (expected.id === null ? 0 : 1) ||
					parsed.more !== expected.ordinal + 1 < expected.total
				)
					return HQ_LIST_MOVED;
				const listed =
					expected.id === null
						? null
						: toHqFixtureRow(parsed.objects[0], table.tag);
				if ((listed?.id ?? null) !== expected.id) return HQ_LIST_MOVED;
				const selected = listed
					? await readDetail(creds, root, table, listed.id, budget)
					: null;
				if (selected && "success" in selected) return selected;
				let retained = false;
				try {
					if (
						listed &&
						selected &&
						!agreesWithInventory(listed.fields, selected.row.fields)
					)
						return HQ_LIST_MOVED;
					const after = await checkDefinition(creds, root, table, budget);
					if (after) return after;
					retained = true;
					return { row: selected?.row ?? null, bytes: selected?.bytes ?? 0 };
				} finally {
					if (selected && !retained) giveBackHeld("text", selected.bytes);
				}
			} finally {
				giveBackHeld("text", page.bytes);
			}
		},
		undefined,
		cancel,
	);
}

/** A historical inventory is private. The definition endpoint alone cannot
 * renew access to its rows: FixtureResource separately requires edit_apps.
 * Probe just the selected resource and its first row. A zero-row answer can
 * prove access, never a previous generation's completeness or freshness. */
export async function probeHqInventoryRead(
	creds: CommCareCredentials,
	domain: string,
	id: string,
	tag: string,
) {
	if (!isValidDomainSlug(domain) || !REMOTE_ID.test(id)) return false;
	const root = sourceRoot(creds, domain);
	return withHqRequestDeadline(async (signal) => {
		const budget: ReadBudget = {
			signal,
			requests: 3,
			remaining:
				HQ_LOOKUP_DEFINITION_MAX_BYTES +
				HQ_LOOKUP_PAGE_MAX_BYTES +
				HQ_LOOKUP_DETAIL_MAX_BYTES,
		};
		const definition = await readWithinBudget(
			creds,
			`${root}/lookup_table/v1/${id}/`,
			HQ_LOOKUP_DEFINITION_MAX_BYTES,
			budget,
		);
		if ("success" in definition) return false;
		let table: HqLookupTable | null;
		try {
			table = toHqLookupTable(definition.data);
		} finally {
			giveBackHeld("text", definition.bytes);
		}
		if (!table || table.id !== id || table.tag !== tag) return false;
		const response = await readWithinBudget(
			creds,
			`${root}/fixture/v1/?fixture_type_id=${id}&limit=1`,
			HQ_LOOKUP_PAGE_MAX_BYTES,
			budget,
		);
		if ("success" in response) return false;
		try {
			const page = decodeHqPage(response.data, 0, LABEL);
			if ("success" in page || page.objects.length > 1) return false;
			if (!page.objects.length)
				return !page.more && (page.total === 0 || page.total === null);
			const row = toHqFixtureRow(page.objects[0], tag);
			if (!row || !REMOTE_ID.test(row.id)) return false;
			if (
				!hasRichDefinition(table) &&
				Object.values(row.fields).every((v) => typeof v === "string")
			)
				return true;
			const detail = await readDetail(creds, root, table, row.id, budget);
			if ("success" in detail) return false;
			giveBackHeld("text", detail.bytes);
			return true;
		} finally {
			giveBackHeld("text", response.bytes);
		}
	});
}
