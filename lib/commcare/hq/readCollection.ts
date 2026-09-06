import "server-only";

import { log } from "@/lib/logger";
import {
	authHeader,
	type CommCareApiError,
	type CommCareCredentials,
	warnAndReturnError,
} from "./http";

export function isHqObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inventory authorizes remote replacement. Only a complete list from the
 * requested collection can establish absence. One deadline owns all pages and
 * body reads; a stalled page cannot hold a publish open indefinitely. */
export async function readHqCollection(
	creds: CommCareCredentials,
	firstUrl: string,
	label: string,
	maxPages: number,
): Promise<readonly unknown[] | CommCareApiError> {
	const target = new URL(firstUrl);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	const rows: unknown[] = [];
	let url = firstUrl;
	try {
		for (let page = 0; page < maxPages; page++) {
			let response: Response;
			try {
				response = await fetch(url, {
					headers: { Authorization: authHeader(creds) },
					redirect: "manual",
					cache: "no-store",
					signal: controller.signal,
				});
			} catch (error) {
				log.warn(`[commcare] ${label} unavailable`, { error });
				return { success: false, status: 503 };
			}
			if (!response.ok)
				return await warnAndReturnError(`${label} refused`, response);
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				return {
					success: false,
					status: controller.signal.aborted ? 503 : 502,
				};
			}
			if (
				!isHqObject(body) ||
				!Array.isArray(body.objects) ||
				!isHqObject(body.meta) ||
				(body.meta.next !== null && typeof body.meta.next !== "string")
			) {
				log.error(`[commcare] ${label} is malformed`, undefined, {});
				return { success: false, status: 502 };
			}
			rows.push(...body.objects);
			if (body.meta.next === null) return rows;
			let next: URL;
			try {
				next = new URL(body.meta.next, url);
			} catch {
				return { success: false, status: 502 };
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
				return { success: false, status: 502 };
			}
			url = next.toString();
		}
		log.error(`[commcare] ${label} did not terminate`, undefined, {
			pages: maxPages,
		});
		return { success: false, status: 508 };
	} finally {
		clearTimeout(timer);
	}
}
