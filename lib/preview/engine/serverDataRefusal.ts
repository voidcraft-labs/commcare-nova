/**
 * Core's refusal of data the device lacks, as a server read meets it.
 *
 * A read compiled to SQL refuses a worker-data key the worker's device does
 * not hold while it compiles (`AbsentWorkerFieldError`, the place keys of a
 * worker assigned nowhere), as Core refuses the same read on a device; an
 * XPath read on the server refuses through `dataRefusal.ts` as in the
 * browser. Both are the worker's data, never a fault: each read action returns
 * the refusal for its screen to show, and nothing reaches telemetry. This
 * module reads the case store's error type, so it stays out of the browser
 * bundle; the browser reads the refusal the action returns.
 */

import { AbsentWorkerFieldError } from "@/lib/case-store";
import {
	PreviewDataRefusal,
	previewDataRefusalOf,
	WORKER_INFORMATION_REFUSAL,
} from "./dataRefusal";

/** The refusal a server read's error stands for, or `undefined` for every
 *  other error. */
export function serverPreviewDataRefusalOf(
	error: unknown,
): PreviewDataRefusal | undefined {
	if (error instanceof AbsentWorkerFieldError)
		return new PreviewDataRefusal(WORKER_INFORMATION_REFUSAL);
	return previewDataRefusalOf(error);
}
