import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/** Request execution time shared by every worker, including nested searches and
 * after-submit evaluation. It is never serialized into a worker or persisted. */
const deadlines = new AsyncLocalStorage<number>();

export class EvaluationDeadlineError extends Error {
	readonly name = "EvaluationDeadlineError";
	constructor() {
		super(
			"The app test execution deadline expired before the call could finish.",
		);
	}
}

export function withEvaluationDeadline<T>(
	deadlineAt: number,
	body: () => Promise<T>,
): Promise<T> {
	const remaining = deadlineAt - Date.now();
	const monotonicDeadline = performance.now() + remaining;
	return deadlines.run(
		Math.min(deadlines.getStore() ?? Infinity, monotonicDeadline),
		body,
	);
}

export function remainingEvaluationTime(): number {
	const deadline = deadlines.getStore();
	if (deadline === undefined) return Infinity;
	const remaining = deadline - performance.now();
	if (remaining <= 0) throw new EvaluationDeadlineError();
	return remaining;
}
