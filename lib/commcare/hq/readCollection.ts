import { withHqRequestDeadline } from "./deadline";
import "server-only";

import { log } from "@/lib/logger";
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
}

/** Inventory authorizes remote replacement. Only a complete list from the
 * requested collection can establish absence. Every page and body read runs
 * under a deadline, so a stalled page cannot hold a publish open
 * indefinitely. */
export async function readHqCollection(
	creds: CommCareCredentials,
	firstUrl: string,
	label: string,
	maxPages: number,
	options: ReadHqCollectionOptions = {},
): Promise<readonly unknown[] | CommCareApiError> {
	const { onMeta, deadline = "whole" } = options;
	const target = new URL(firstUrl);

	const rows: unknown[] = [];
	let url = firstUrl;
	/* With no signal, `readHqJson` owns a deadline of its own for the page. */
	const readPages = async (
		signal: AbortSignal | undefined,
	): Promise<readonly unknown[] | CommCareApiError> => {
		for (let page = 0; page < maxPages; page++) {
			const result = await readHqJson(creds, url, label, { signal });
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
		return { success: false, status: 508 };
	};
	return deadline === "page"
		? readPages(undefined)
		: withHqRequestDeadline((signal) => readPages(signal));
}
