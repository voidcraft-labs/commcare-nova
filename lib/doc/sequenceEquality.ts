/**
 * Element-wise identity equality over two sequences — true iff same length and
 * every index holds the identical reference.
 *
 * The equality predicate the display-order hooks (`useModuleIds`,
 * `useOrderedFields`, …) hand `useBlueprintDocEq`: it returns the PRIOR array
 * reference when the sequence is unchanged, so a doc edit touching neither
 * membership nor position doesn't churn `React.memo` consumers.
 *
 * This is all that outlived `lib/doc/order`. It was never about order keys —
 * it is a render-stability helper that happened to live beside them.
 */
export function sameSequenceByIdentity<T>(
	a: readonly T[],
	b: readonly T[],
): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
