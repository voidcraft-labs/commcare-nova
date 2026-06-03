/**
 * Map over `items` running at most `limit` calls of `fn` concurrently,
 * preserving input order in the result. A bounded alternative to
 * `Promise.all(items.map(fn))` for when each call holds a real resource
 * (an open GCS read stream, an upstream HTTP request) and firing all of
 * them at once would spike memory / sockets or self-inflict a rate limit.
 *
 * Workers pull from a shared cursor, so one slow item doesn't stall the
 * rest — the pool stays full until the queue drains. Rejection propagates
 * like `Promise.all`: the first failing call rejects the whole call;
 * in-flight workers run to completion but their results are discarded.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	// A shared cursor the workers advance. `cursor++` is atomic in
	// single-threaded JS — no two workers ever claim the same index.
	let cursor = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const worker = async (): Promise<void> => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: workerCount }, worker));
	return results;
}
