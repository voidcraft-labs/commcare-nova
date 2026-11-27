import { CaptureSubmissionRejectedError } from "./errors";

// Runtime resource limits for a close that touches only its selected cases.
// An HQ-authored maximum cannot increase any of these budgets.
export const FLAT_CLOSE_SELECTED_RECORDS = 500;
export const FLAT_CLOSE_CASE_EFFECTS = 101;
export const FLAT_CLOSE_CASE_BYTES = 256 * 1024;

export class FlatClosePayloadTooLargeError extends CaptureSubmissionRejectedError {
	constructor() {
		super("These records hold too much data to open together.");
	}
}
