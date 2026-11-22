/**
 * The one way text CommCare HQ wrote becomes values in Nova: an answer's body
 * (`readJson.ts`) and a stored baseline of an app's source
 * (`lib/deployment/store.ts`, `lib/deployment/hqChanges/baselineSource.ts`).
 *
 * Every object of the value holds its own keys and nothing else: its
 * prototype is null, so a lookup by a name the app supplies (a language code,
 * a property, a table's tag) answers only what CommCare HQ wrote, and never
 * `constructor` or `toString` of an object's prototype. `JSON.parse` already
 * keeps a `"__proto__"` key as a key of its own.
 *
 * Client-safe: no import.
 */

/**
 * The deepest nesting of arrays and objects Nova takes from CommCare HQ. HQ
 * copies an app whole before it answers it (`models/applications.py::export_json`,
 * `deepcopy`), which Python's recursion limit of 1,000 frames stops well short
 * of this, so no answer HQ can give is deeper; every walk Nova makes of what it
 * holds is then shallow enough for the stack.
 */
export const HQ_JSON_MAX_DEPTH = 1_000;

/** Text that is no JSON value Nova takes: `JSON.parse` refused it, or it nests
 *  deeper than `HQ_JSON_MAX_DEPTH`. Every caller reads it as text that is no
 *  JSON, as it reads `JSON.parse`'s own `SyntaxError`. */
export class HqJsonTextError extends SyntaxError {
	constructor(message: string) {
		super(message);
		this.name = "HqJsonTextError";
	}
}

/** `JSON.parse(text)`, each object of it holding no prototype. Throws a
 *  `SyntaxError` where `JSON.parse` does and where the value nests too deep. */
export function parseHqJsonText(text: string, reviver?: (this: object, key: string, value: unknown, context?: { source?: string }) => unknown): unknown {
	const value: unknown = JSON.parse(text, reviver);
	withoutPrototypes(value);
	return value;
}

/**
 * Takes the prototype off every object of `value`, a value `JSON.parse` has
 * just made and nothing else holds, and refuses one that nests deeper than
 * `HQ_JSON_MAX_DEPTH`. A loop, not a recursion, so no nesting reaches the
 * stack.
 */
function withoutPrototypes(value: unknown): void {
	const pending: [unknown, number][] = [[value, 0]];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const [node, depth] = next;
		if (typeof node !== "object" || node === null) continue;
		if (depth >= HQ_JSON_MAX_DEPTH)
			throw new HqJsonTextError(
				`The value nests deeper than ${HQ_JSON_MAX_DEPTH} levels.`,
			);
		if (Array.isArray(node)) {
			for (const element of node)
				if (typeof element === "object" && element !== null)
					pending.push([element, depth + 1]);
			continue;
		}
		Object.setPrototypeOf(node, null);
		for (const key in node) {
			const element = (node as Record<string, unknown>)[key];
			if (typeof element === "object" && element !== null)
				pending.push([element, depth + 1]);
		}
	}
}
