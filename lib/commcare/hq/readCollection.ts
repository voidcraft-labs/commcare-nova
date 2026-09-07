import { withHqRequestDeadline } from "./deadline";
import "server-only";

import { log } from "@/lib/logger";
import type { CommCareApiError, CommCareCredentials } from "./http";
import { readHqJson } from "./readJson";

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

	const rows: unknown[] = [];
	let url = firstUrl;
	return withHqRequestDeadline(async (signal) => {
		for (let page = 0; page < maxPages; page++) {
			const result = await readHqJson(creds, url, label, signal);
			if ("success" in result) return result;
			const body = result.data;
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
	});
}
