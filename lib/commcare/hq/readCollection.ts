import "server-only";

import { log } from "@/lib/logger";
import { type HqReadDeadline, withHqRequestDeadline } from "./deadline";
import type { CommCareApiError, CommCareCredentials } from "./http";
import { readHqJson } from "./readJson";

export function isHqObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ReadHqCollectionOptions {
	/** Called with each page's `meta`, for a caller that reads more of it than the cursor. */
	readonly onMeta?: (meta: Readonly<Record<string, unknown>>) => void;
	/**
	 * `whole` (the default): one deadline owns every page and body read.
	 * `page`: each page has its own, for a collection whose length grows
	 * with data a person enters, so the bound is `maxPages` deadlines.
	 */
	readonly deadline?: "whole" | "page";
	/**
	 * The caller's way to stop the read early, joined to every page's
	 * deadline. A read it ended answers `{ status: 503, cause: "network" }`
	 * and sends no further page. Never a deadline.
	 */
	readonly cancel?: AbortSignal;
	/** Passed to every page's `readHqJson`, so a refused page keeps its bounded body. */
	readonly keepRefusedBody?: boolean;
	/**
	 * How many rows the caller can use. Where a page's `meta.total_count` is a
	 * number over it, or the rows read so far pass it, the read ends there and
	 * answers `past-limit`.
	 */
	readonly stopPast?: number;
}

/**
 * A list that holds more rows than its caller can use. `totalCount` is HQ's
 * own, or null where no page named one.
 */
export interface HqPastLimit {
	readonly kind: "past-limit";
	readonly totalCount: number | null;
}

/** A page's `meta.total_count` where it is a count; null otherwise. */
function namedTotal(meta: Readonly<Record<string, unknown>>): number | null {
	const total = meta.total_count;
	return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
		? total
		: null;
}

/** Inventory authorizes remote replacement. Only a complete list from the
 * requested collection can establish absence. Every page and body read runs
 * under a deadline, so a stalled page cannot hold a publish open
 * indefinitely. Without `stopPast` the whole list is read; with it the read
 * may end early as `past-limit`. */
export function readHqCollection(
	creds: CommCareCredentials,
	firstUrl: string,
	label: string,
	maxPages: number,
	options?: Omit<ReadHqCollectionOptions, "stopPast">,
): Promise<readonly unknown[] | CommCareApiError>;
export function readHqCollection(
	creds: CommCareCredentials,
	firstUrl: string,
	label: string,
	maxPages: number,
	options: ReadHqCollectionOptions & { readonly stopPast: number },
): Promise<readonly unknown[] | HqPastLimit | CommCareApiError>;
export async function readHqCollection(
	creds: CommCareCredentials,
	firstUrl: string,
	label: string,
	maxPages: number,
	options: ReadHqCollectionOptions = {},
): Promise<readonly unknown[] | HqPastLimit | CommCareApiError> {
	const {
		onMeta,
		deadline = "whole",
		cancel,
		keepRefusedBody,
		stopPast,
	} = options;
	const target = new URL(firstUrl);

	const rows: unknown[] = [];
	let url = firstUrl;
	/* The first count a page named, for a `past-limit` the rows reached. */
	let total: number | null = null;
	/* With no list deadline, `readHqJson` owns a deadline of its own for the page. */
	const readPages = async (
		within: HqReadDeadline | undefined,
	): Promise<readonly unknown[] | HqPastLimit | CommCareApiError> => {
		for (let page = 0; page < maxPages; page++) {
			if (cancel?.aborted)
				return { success: false, status: 503, cause: "network" };
			const result = await readHqJson(
				creds,
				url,
				label,
				within === undefined
					? { cancel, keepRefusedBody }
					: { ...within, keepRefusedBody },
			);
			if ("success" in result) return result;
			const body = result.data;
			if (
				!isHqObject(body) ||
				!Array.isArray(body.objects) ||
				!isHqObject(body.meta) ||
				(body.meta.next !== null && typeof body.meta.next !== "string")
			) {
				log.error(`[commcare] ${label} is malformed`, undefined, {});
				return { success: false, status: 502, cause: "malformed" };
			}
			onMeta?.(body.meta);
			rows.push(...body.objects);
			if (stopPast !== undefined) {
				const named = namedTotal(body.meta);
				total ??= named;
				if (named !== null && named > stopPast)
					return { kind: "past-limit", totalCount: named };
				if (rows.length > stopPast)
					return { kind: "past-limit", totalCount: total };
			}
			if (body.meta.next === null) return rows;
			let next: URL;
			try {
				next = new URL(body.meta.next, url);
			} catch {
				return { success: false, status: 502, cause: "malformed" };
			}
			if (
				body.meta.next === "" ||
				next.origin !== target.origin ||
				next.pathname !== target.pathname ||
				next.username !== "" ||
				next.password !== "" ||
				next.hash !== ""
			) {
				log.error(
					`[commcare] ${label} pagination changed target`,
					undefined,
					{},
				);
				return { success: false, status: 502, cause: "malformed" };
			}
			url = next.toString();
		}
		log.error(`[commcare] ${label} did not terminate`, undefined, {
			pages: maxPages,
		});
		return { success: false, status: 508, cause: "malformed" };
	};
	return deadline === "page"
		? readPages(undefined)
		: withHqRequestDeadline(
				(signal, instant) => readPages({ signal, deadline: instant }),
				undefined,
				cancel,
			);
}
