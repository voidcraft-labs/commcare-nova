import "server-only";

import { createHash, type Hash } from "node:crypto";
import { log } from "@/lib/logger";
import { type HqReadDeadline, withHqRequestDeadline } from "./deadline";
import {
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
	isHqCount,
} from "./http";
import { giveBackHeld } from "./memoryMeter";
import { readHqJson } from "./readJson";

export function isHqObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One list of CommCare HQ's, as `readHqCollection` reads it. Every limit is
 * required: a list is never read without a bound on its rows and its bytes.
 */
export interface HqCollectionSpec<T> {
	readonly parse?: (text: string) => unknown;
	readonly digestRow?: (value: unknown) => string;
	/** What the list is, for its log lines. Never holds a project space's data. */
	readonly label: string;
	/**
	 * The first page's URL: the list's own selector and the page size the
	 * resource allows. Every later page is this URL with `offset` set to the
	 * rows read so far. Nova builds each page's URL itself and requests nothing
	 * CommCare HQ sends: `meta.next` is read as "more" or "no more".
	 */
	readonly firstUrl: string;
	/** A bound on pages, so a list that never ends cannot hold a request open. */
	readonly maxPages: number;
	/**
	 * The most rows the caller can use. A first page whose `meta.total_count`
	 * is over it answers `past-limit` with no row held and no page after it.
	 */
	readonly maxRows: number;
	/**
	 * The most bytes of one pass, every page together, a constant of
	 * `bounds.ts`. A page is read at most as far as what remains of it, and a
	 * pass past it answers `past-limit` by bytes.
	 */
	readonly maxBytes: number;
	/** One row, or null where it is not what the list serves (the read is then malformed). */
	readonly row: (raw: unknown) => T | null;
	/** The row's identity in the list: the same row on two pages is the list moving. */
	readonly identity: (row: T) => string;
	/**
	 * `whole` (the default): one deadline owns every page of a pass. `page`:
	 * each page has its own, for a list whose length grows with data a person
	 * enters, so the bound is `maxPages` deadlines. A deadline the caller
	 * holds (its signal and its instant) owns every page of every pass, for a
	 * read inside a shorter check.
	 */
	readonly deadline?: "whole" | "page" | HqReadDeadline;
	/**
	 * The caller's way to stop the read early, joined to every page's
	 * deadline. A read it ended answers `{ status: 503, cause: "network" }`
	 * and sends no further page. Never a deadline.
	 */
	readonly cancel?: AbortSignal;
	/** Passed to every page's `readHqJson`, so a refused page keeps its bounded body. */
	readonly keepRefusedBody?: boolean;
}

/** A whole list: its rows in CommCare HQ's order, its total, and the bytes of the pass the rows are. */
export interface HqCollection<T> {
	readonly rows: readonly T[];
	readonly totalCount: number;
	readonly bytes: number;
}

/**
 * A list that holds more than its caller can use: more rows than `maxRows`
 * (`by: "rows"`, with CommCare HQ's total), or more bytes than `maxBytes`
 * (`by: "bytes"`, with the total the first page named, null where the first
 * page alone passed it).
 */
export type HqPastLimit =
	| {
			readonly kind: "past-limit";
			readonly by: "rows";
			readonly totalCount: number;
	  }
	| {
			readonly kind: "past-limit";
			readonly by: "bytes";
			readonly totalCount: number | null;
	  };

/** A list that changed under every pass Nova made of it. */
export const HQ_LIST_MOVED: CommCareApiError = Object.freeze({
	success: false,
	status: 503,
	cause: "moved",
});

type Pass<T> =
	| {
			readonly kind: "pass";
			readonly rows: readonly T[] | null;
			readonly totalCount: number;
			readonly bytes: number;
			readonly pages: number;
			readonly digest: string;
	  }
	| HqPastLimit
	| CommCareApiError;

/** The URL of the page at `offset`: the first URL as given, or it with `offset` set. */
function pageUrl(firstUrl: string, offset: number): string {
	if (offset === 0) return firstUrl;
	// The first URL is a path on the credentials' server (`sendHq`); only its
	// query moves, on a placeholder origin that never leaves this function.
	const url = new URL(firstUrl, "https://hq.invalid");
	url.searchParams.set("offset", String(offset));
	return `${url.pathname}${url.search}`;
}

/**
 * Every row of one CommCare HQ list, read as one state of it.
 *
 * Inventory authorizes remote replacement: only a complete list from the
 * requested collection can establish absence. So the reader, and no caller,
 * holds a list together. Each page asks for its own offset on the first
 * page's URL, and nothing CommCare HQ names is requested. A list of several
 * pages names its `meta.total_count` on every page, the first page's, and
 * every page names the offset asked for; a page with more to come holds rows,
 * no identity appears twice, and the rows read equal the total (a list of one
 * page that names no total is its rows). A total, an identity or a count
 * broken across pages is the list moving; any other break is malformed.
 * CommCare HQ
 * evaluates its list afresh for every page, unordered for some lists, so a
 * list of more than one page is read a second time, its rows digested and
 * dropped, and taken only where both passes agree on every row in order. On
 * disagreement a third pass is compared with the second, and a list that
 * moved under both is `moved`. Two agreeing passes prove the list one state
 * CommCare HQ held, unless a row changed and changed back between them.
 *
 * A first page whose total is over `maxRows` answers `past-limit` by rows; a
 * pass whose pages pass `maxBytes` answers `past-limit` by bytes. Each pass
 * runs under its own deadline, or each page under its own with `page`.
 */
export async function readHqCollection<T>(
	creds: CommCareCredentials,
	spec: HqCollectionSpec<T>,
): Promise<HqCollection<T> | HqPastLimit | CommCareApiError> {
	const first = await confirmFirstPass(creds, spec);
	if (!("retryDigest" in first)) return first;
	const third = await readPass(creds, spec, true);
	if ("success" in third || third.kind === "past-limit") return third;
	if (third.digest === first.retryDigest)
		return collected(third.rows, third.totalCount, third.bytes);
	giveBackHeld("text", third.bytes);
	log.warn(`[commcare] ${spec.label} moved while it was read`, {
		passes: 3,
		pages: third.pages,
	});
	return HQ_LIST_MOVED;
}

/** Release the first pass's rows before a third pass begins. Only the
 * comparison digest survives a disagreement. */
async function confirmFirstPass<T>(
	creds: CommCareCredentials,
	spec: HqCollectionSpec<T>,
): Promise<
	HqCollection<T> | HqPastLimit | CommCareApiError | { retryDigest: string }
> {
	const first = await readPass(creds, spec, true);
	if ("success" in first || first.kind === "past-limit") return first;
	if (first.pages === 1)
		return collected(first.rows, first.totalCount, first.bytes);
	let agreed = false;
	try {
		const second = await readPass(creds, spec, false);
		if ("success" in second || second.kind === "past-limit") return second;
		agreed = second.digest === first.digest;
		return agreed
			? collected(first.rows, first.totalCount, first.bytes)
			: { retryDigest: second.digest };
	} finally {
		if (!agreed) giveBackHeld("text", first.bytes);
	}
}

function collected<T>(
	rows: readonly T[] | null,
	totalCount: number,
	bytes: number,
): HqCollection<T> {
	if (rows === null)
		throw new Error("A kept pass of a CommCare HQ list holds no rows.");
	return { rows, totalCount, bytes };
}

function readPass<T>(
	creds: CommCareCredentials,
	spec: HqCollectionSpec<T>,
	keep: boolean,
): Promise<Pass<T>> {
	const { deadline } = spec;
	if (typeof deadline === "object")
		return readPages(creds, spec, keep, deadline);
	return deadline === "page"
		? readPages(creds, spec, keep, undefined)
		: withHqRequestDeadline(
				(signal, instant) =>
					readPages(creds, spec, keep, { signal, deadline: instant }),
				undefined,
				spec.cancel,
			);
}

function malformed(label: string, why: string): CommCareApiError {
	log.error(`[commcare] ${label} is malformed`, undefined, { why });
	return HQ_MALFORMED_ANSWER;
}

function moved(label: string, why: string, pages: number): CommCareApiError {
	log.warn(`[commcare] ${label} moved between its pages`, { why, pages });
	return HQ_LIST_MOVED;
}

/** Tastypie's envelope shared by inline inventory and disk-backed lookup reads.
 * Only the presence of a continuation is consumed. No peer-provided URL is followed. */
export function decodeHqPage(
	body: unknown,
	offset: number,
	label: string,
):
	| { objects: readonly unknown[]; more: boolean; total: number | null }
	| CommCareApiError {
	if (
		!isHqObject(body) ||
		!Array.isArray(body.objects) ||
		!isHqObject(body.meta)
	)
		return malformed(label, "envelope");
	const { meta, objects } = body;
	const next = meta.next;
	if (next !== null && next !== undefined && typeof next !== "string")
		return malformed(label, "next");
	if (next === "") return malformed(label, "next");
	const more = typeof next === "string";
	/* A count named null says the paginator does not know it, which no
	 * complete list can be read from. */
	if (meta.total_count !== undefined && !isHqCount(meta.total_count))
		return malformed(label, "total");
	const total = isHqCount(meta.total_count) ? meta.total_count : null;
	if (meta.offset !== undefined && meta.offset !== offset)
		return malformed(label, "offset");
	if (more && (meta.offset === undefined || objects.length === 0))
		return malformed(label, "page");
	return { objects, more, total };
}

async function readPages<T>(
	creds: CommCareCredentials,
	spec: HqCollectionSpec<T>,
	keep: boolean,
	within: HqReadDeadline | undefined,
): Promise<Pass<T>> {
	const { label, cancel, keepRefusedBody } = spec;
	const rows: T[] = [];
	const identities = new Set<string>();
	const digest: Hash = createHash("sha256");
	let total: number | null = null;
	let offset = 0;
	let bytes = 0;
	let retainedBytes = 0;
	try {
		for (let page = 0; page < spec.maxPages; page++) {
			if (cancel?.aborted)
				return { success: false, status: 503, cause: "network" };
			const remaining = spec.maxBytes - bytes;
			if (remaining < 1)
				return { kind: "past-limit", by: "bytes", totalCount: total };
			const result = await readHqJson(
				creds,
				pageUrl(spec.firstUrl, offset),
				label,
				within === undefined
					? {
							maxBytes: remaining,
							pastBound: "quiet",
							cancel,
							keepRefusedBody,
							parse: spec.parse,
						}
					: {
							...within,
							parse: spec.parse,
							maxBytes: remaining,
							pastBound: "quiet",
							keepRefusedBody,
						},
			);
			if ("success" in result) {
				if (result.cause === "too-large") {
					log.warn(`[commcare] ${label} is longer than Nova reads`, {
						maxBytes: spec.maxBytes,
						pages: page + 1,
					});
					return { kind: "past-limit", by: "bytes", totalCount: total };
				}
				return result;
			}
			bytes += result.bytes;
			const decoded = decodeHqPage(result.data, offset, label);
			if ("success" in decoded) return decoded;
			const { more, objects, total: named } = decoded;
			if (page === 0) {
				/* A total binds pages together: a list of one page may name none, a
				 * list of several must. */
				if (named === null && more) return malformed(label, "total");
				total = named;
				if (total !== null && total > spec.maxRows)
					return { kind: "past-limit", by: "rows", totalCount: total };
			} else if (named !== total) {
				return moved(label, "total", page + 1);
			}
			for (const raw of objects) {
				const row = spec.row(raw);
				if (row === null) return malformed(label, "row");
				const identity = spec.identity(row);
				if (identities.has(identity))
					return page === 0
						? malformed(label, "identity")
						: moved(label, "identity", page + 1);
				identities.add(identity);
				digest.update((spec.digestRow ?? JSON.stringify)(raw));
				digest.update("\n");
				if (keep) rows.push(row);
			}
			offset += objects.length;
			if (total !== null && offset > total)
				return page === 0
					? malformed(label, "count")
					: moved(label, "count", page + 1);
			if (!more) {
				if (total === null) {
					/* One page that named no total: its rows are the list. */
					if (offset > spec.maxRows)
						return { kind: "past-limit", by: "rows", totalCount: offset };
					total = offset;
				} else if (offset !== total)
					return page === 0
						? malformed(label, "count")
						: moved(label, "count", page + 1);
				if (keep) retainedBytes = bytes;
				return {
					kind: "pass",
					rows: keep ? rows : null,
					totalCount: total,
					bytes,
					pages: page + 1,
					digest: digest.digest("hex"),
				};
			}
		}
		log.error(`[commcare] ${label} did not terminate`, undefined, {
			pages: spec.maxPages,
		});
		return { success: false, status: 508, cause: "malformed" };
	} finally {
		giveBackHeld("text", bytes - retainedBytes);
	}
}
