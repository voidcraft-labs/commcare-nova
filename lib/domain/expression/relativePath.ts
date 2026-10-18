/** The shortest identity path from one context node to a target. A filtered
 * target step must still be named, so the common prefix stops before it. */
export function relativePath<T>(
	from: readonly T[],
	to: readonly T[],
	same: (left: T, right: T) => boolean,
	firstRequiredStep?: number,
): { readonly up: number; readonly down: readonly T[] } {
	let common = 0;
	const limit = Math.min(
		from.length,
		to.length,
		firstRequiredStep ?? Number.POSITIVE_INFINITY,
	);
	while (common < limit && same(from[common], to[common])) common++;
	return { up: from.length - common, down: to.slice(common) };
}
