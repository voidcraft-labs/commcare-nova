/**
 * Structural equality over JSON-shaped values: primitives, plain objects,
 * and arrays — the value space blueprint config slots (case-list columns,
 * Search settings) carry. Compares own enumerable keys only; Maps, Sets,
 * and class instances are outside the contract.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	const aArray = Array.isArray(a);
	const bArray = Array.isArray(b);
	if (aArray !== bArray) return false;
	if (aArray && bArray) {
		if (a.length !== b.length) return false;
		return a.every((value, index) => deepEqual(value, b[index]));
	}
	const aObject = a as Record<string, unknown>;
	const bObject = b as Record<string, unknown>;
	const aKeys = Object.keys(aObject);
	const bKeys = Object.keys(bObject);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every(
		(key) =>
			Object.hasOwn(bObject, key) && deepEqual(aObject[key], bObject[key]),
	);
}
