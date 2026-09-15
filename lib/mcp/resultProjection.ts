import {
	type SavedDataReview,
	sharedToolPayload,
	withSavedDataReview,
} from "@/lib/agent/toolResults";
import type {
	MutatingToolResult,
	ReadToolResult,
} from "@/lib/agent/tools/common";

/** MCP receives outcome facts; transcript presentation stays in Nova. */
export function projectResult(
	raw: MutatingToolResult<unknown> | ReadToolResult<unknown>,
	dataReview?: SavedDataReview,
): unknown {
	return withSavedDataReview(sharedToolPayload(raw), dataReview);
}
