/**
 * Where two documents differ, as paths from the document's root. Pure and
 * client-safe: it reads the two documents and nothing else.
 *
 * The walk reads each document's persisted shape (`toPersistableDoc`), so a
 * derived slot (`fieldParent`, `refIndex`) is never a difference, and a key
 * whose value is `undefined` is absent, as JSON leaves it out. Arrays are
 * compared position by position; an object's keys are visited in code-unit
 * order. Where one side holds an object or an array and the other holds
 * something else at the same path, the path itself is one `value`
 * difference and the walk does not descend.
 */

import type { BlueprintDoc } from "@/lib/domain";
import { toPersistableDoc } from "./fieldParent";

/** One differing path of two documents, as the keys from the document's root. */
export interface DocumentDifference {
	readonly path: readonly string[];
	/** `value`: both hold the path and differ. `missing`: only the expected document holds it.
	 *  `added`: only the other does. */
	readonly kind: "value" | "missing" | "added";
}

type Shape = "array" | "object" | "scalar";

function shapeOf(value: unknown): Shape {
	if (Array.isArray(value)) return "array";
	return value !== null && typeof value === "object" ? "object" : "scalar";
}

/** The keys of a container that hold a value, `undefined` counted as absent. */
function presentKeys(value: unknown, shape: Shape): string[] {
	if (shape === "array")
		return (value as unknown[]).map((_, index) => String(index));
	return Object.keys(value as Record<string, unknown>).filter(
		(key) => (value as Record<string, unknown>)[key] !== undefined,
	);
}

function walk(
	expected: unknown,
	actual: unknown,
	path: readonly string[],
	out: DocumentDifference[],
): void {
	if (Object.is(expected, actual)) return;
	const shape = shapeOf(expected);
	if (shape !== shapeOf(actual)) {
		out.push({ path, kind: "value" });
		return;
	}
	if (shape === "scalar") {
		out.push({ path, kind: "value" });
		return;
	}
	const expectedKeys = presentKeys(expected, shape);
	const actualKeys = new Set(presentKeys(actual, shape));
	const keys = [...new Set([...expectedKeys, ...actualKeys])];
	// An array's positions are walked in order; an object's keys in code-unit
	// order, so the walk does not depend on the order the keys were written.
	if (shape === "array") keys.sort((a, b) => Number(a) - Number(b));
	else keys.sort();
	const held = new Set(expectedKeys);
	for (const key of keys) {
		const at = [...path, key];
		if (!actualKeys.has(key)) out.push({ path: at, kind: "missing" });
		else if (!held.has(key)) out.push({ path: at, kind: "added" });
		else
			walk(
				(expected as Record<string, unknown>)[key],
				(actual as Record<string, unknown>)[key],
				at,
				out,
			);
	}
}

/** Every differing path of two documents, in a depth-first walk with object keys sorted. */
export function documentDifferences(
	expected: BlueprintDoc,
	actual: BlueprintDoc,
): readonly DocumentDifference[] {
	const out: DocumentDifference[] = [];
	walk(toPersistableDoc(expected), toPersistableDoc(actual), [], out);
	return out;
}
