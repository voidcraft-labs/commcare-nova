import "server-only";

/**
 * Settle the media jobs CommCare HQ accepted for one HQ app that Nova stopped
 * watching, by the job ids it recorded (`store.ts::readOpenMediaJobs`).
 *
 * A media job saves the app once when it ends (`hqmedia/tasks.py::
 * process_bulk_upload_zip`), so an open one is both a write that may still
 * land on the HQ app and a save that may fall inside a later publish's read.
 * A bring-in reads each before its claim, and a publish before it reads the
 * save counter its import is checked against: a job HQ reports done settles
 * at once, and one still running, or whose status cannot be read, stays open
 * until its hold ends.
 */

import type {
	CommCareApiError,
	CommCareCredentials,
} from "@/lib/commcare/client";
import { readAppMediaBundleStatus } from "@/lib/commcare/client";
import { readOpenMediaJobs, settleRemoteWrites } from "./store";

/**
 * Whether CommCare HQ answered a write, which settles its admission at once,
 * or whether the answer never reached Nova and HQ may still apply the write
 * after Nova stopped waiting, which holds it open for its grace.
 *
 * Decided by every cause a failure can carry, so a new one is a decision
 * here rather than a silent `answered`. A status HQ or its edge sent, and a
 * body Nova could not use (`malformed`, `too-large`, `browser-page`), are
 * answers: the request ended where HQ ended it. `network` and `timeout` are
 * not. `moved` is a list read's cause, a list that changed under every pass
 * Nova made of it: each of those passes was answered, so were a write ever
 * to report it, HQ answered that write too.
 */
export function hqAnsweredWrite(
	result: { readonly success: true } | CommCareApiError,
): boolean {
	if (result.success) return true;
	const cause = result.cause;
	switch (cause) {
		case undefined:
		case "malformed":
		case "too-large":
		case "browser-page":
		case "moved":
			return true;
		case "network":
		case "timeout":
			return false;
		default: {
			const unclassified: never = cause;
			throw new Error(
				`A write to CommCare HQ failed with the cause "${String(unclassified)}", which Nova does not yet classify as answered or not. Add it to hqAnsweredWrite.`,
			);
		}
	}
}

export async function settleFinishedMediaJobs(
	creds: CommCareCredentials,
	key: {
		readonly server: string;
		readonly domain: string;
		readonly remoteAppId: string;
	},
): Promise<void> {
	const jobs = await readOpenMediaJobs(key);
	for (const job of jobs) {
		const status = await readAppMediaBundleStatus(
			creds,
			key.domain,
			key.remoteAppId,
			job.jobId,
		);
		if (status === "complete")
			await settleRemoteWrites([job.writeId], { kind: "settled" });
	}
}
