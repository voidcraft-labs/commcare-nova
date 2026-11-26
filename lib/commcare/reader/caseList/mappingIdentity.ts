/** Equal effective predicates in distinct native rows retain separate
 * identities. The first occurrence keeps the existing external key. */
export function mappingIdentityAt(
	comparison: string,
	counts: Map<string, number>,
): string {
	const ordinal = counts.get(comparison) ?? 0;
	counts.set(comparison, ordinal + 1);
	return ordinal
		? JSON.stringify(["occurrence", comparison, ordinal])
		: comparison;
}
