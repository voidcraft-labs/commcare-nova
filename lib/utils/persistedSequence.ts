/**
 * Admit one persisted sequence at the JavaScript number protocol boundary.
 *
 * PostgreSQL `bigint` values normally arrive through node-postgres as decimal
 * strings. Nova's app and case-schema sequence protocols are nonnegative safe
 * integers: accepting any wider value would round two durable positions onto
 * one JavaScript number, while accepting alternate spellings would make the
 * same position have more than one wire representation.
 */
export function safePersistedSequence(
	value: string | number,
	context = "Persisted sequence",
): number {
	if (typeof value === "number") {
		if (Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)) {
			return value;
		}
		throw new Error(`${context} must be a nonnegative safe integer.`);
	}
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error(`${context} must be a nonnegative decimal integer.`);
	}
	const exact = BigInt(value);
	if (exact > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`${context} exceeds JavaScript's safe-integer range.`);
	}
	return Number(exact);
}

/** Advance one admitted sequence without crossing the safe-integer boundary. */
export function nextPersistedSequence(
	value: string | number,
	context = "Persisted sequence",
): number {
	const current = safePersistedSequence(value, context);
	if (current === Number.MAX_SAFE_INTEGER) {
		throw new Error(`${context} cannot advance beyond the safe-integer range.`);
	}
	return current + 1;
}
