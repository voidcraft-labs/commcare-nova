import type { CheckPath } from "./types";

/** Half-open source offsets, keyed by the checker's semantic node address. */
export interface ExpressionSpan {
	readonly from: number;
	readonly to: number;
}
export type ExpressionSpans = ReadonlyMap<string, ExpressionSpan>;

export function spanKey(path: CheckPath): string {
	return JSON.stringify(path);
}

/** Findings at an implicit child use the nearest printed parent. */
export function spanFor(
	spans: ExpressionSpans,
	path: CheckPath,
): ExpressionSpan | undefined {
	for (let length = path.length; length >= 0; length--) {
		const span = spans.get(spanKey(path.slice(0, length)));
		if (span !== undefined) return span;
	}
	return undefined;
}
