import type { MutatingToolResult, ReadToolResult } from "./tools/common";

/** Write-tool payloads reserve `summary` for transcript presentation. Read
 * payloads are domain data and must never pass through this projection. */
export function withoutToolPresentation(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return value;
	const { summary: _summary, ...facts } = value as Record<string, unknown>;
	return facts;
}

export function sharedToolPayload(
	value: MutatingToolResult<unknown> | ReadToolResult<unknown>,
): unknown {
	return value.kind === "read"
		? value.data
		: withoutToolPresentation(value.result);
}

/** A committed data migration's consequence, independent of tool wording or
 * whether a later reporting step failed. It is not a second commit receipt. */
export interface SavedDataReview {
	values: number;
	reasons: readonly string[];
	additionalReasons: number;
	location: "Case data";
}

export function savedDataReview(outcome: {
	readonly parked: number;
	readonly failureReasons: readonly string[];
}): SavedDataReview {
	return {
		values: outcome.parked,
		reasons: outcome.failureReasons.slice(0, 3),
		additionalReasons: Math.max(0, outcome.failureReasons.length - 3),
		location: "Case data",
	};
}

export function withSavedDataReview(
	value: unknown,
	dataReview: SavedDataReview | undefined,
): unknown {
	if (dataReview === undefined) return value;
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? { ...value, dataReview }
		: { result: value, dataReview };
}
