import { parseHqJsonText } from "./jsonText";

/** Only the service's location endpoints use this parser. JSON.parse's
 * source context preserves the original Python integer/float distinction
 * and integers outside JavaScript's safe range. Metadata remains ordinary
 * JSON to callers that only need the projected worker text. */
const numberSources = new WeakMap<object, Map<string, string>>();
type NumberContext = { source?: string };
const rawJSON = (JSON as typeof JSON & { rawJSON: (source: string) => unknown })
	.rawJSON;

export function parseLocationJson(text: string): unknown {
	return parseHqJsonText(text, function (key, value, context) {
		if (
			typeof value === "number" &&
			context?.source !== undefined &&
			context.source !== JSON.stringify(value)
		) {
			const held = numberSources.get(this) ?? new Map<string, string>();
			held.set(key, context.source);
			numberSources.set(this, held);
		}
		return value;
	});
}

export function exactLocationJson(value: unknown): string {
	return JSON.stringify(value, function (key, item) {
		const source = numberSources.get(this)?.get(key);
		return source === undefined ? item : rawJSON(source);
	});
}

/** An individual stored value for a resource PATCH. Native raw JSON is
 * used only for a numeric primitive already accepted by JSON.parse. */
export function locationWireValue(source: string): unknown {
	return JSON.parse(
		source,
		(_key: string, value: unknown, context?: NumberContext) =>
			typeof value === "number" && context?.source !== undefined
				? rawJSON(context.source)
				: value,
	);
}

function quotedPythonString(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	let out = quote;
	for (const char of value) {
		if (char === quote || char === "\\") out += "\\" + char;
		else if (char === "\n") out += "\\n";
		else if (char === "\r") out += "\\r";
		else if (char === "\t") out += "\\t";
		else if (char !== " " && /[\p{C}\p{Z}]/u.test(char)) {
			const code = char.codePointAt(0) as number;
			const width = code <= 255 ? 2 : code <= 65535 ? 4 : 8;
			out +=
				(width === 2 ? "\\x" : width === 4 ? "\\u" : "\\U") +
				code.toString(16).padStart(width, "0");
		} else out += char;
	}
	return out + quote;
}

/** Tastypie sorts every dictionary on the wire. For a multi-key dictionary
 * Python str() depends on the original ordering, which neither location
 * endpoint exposes. Undefined means the worker string needs its own source
 * observation. Never substitute the order in the transport. Numeric tokens
 * from HQ are emitted by Python's own JSON encoder (the same repr as str).
 */
export function workerMetadataText(
	value: unknown,
	holder?: object,
	key?: string,
	nested = false,
): string | undefined {
	if (value === null) return "None";
	if (typeof value === "string")
		return nested ? quotedPythonString(value) : value;
	if (typeof value === "boolean") return value ? "True" : "False";
	if (typeof value === "number")
		return (
			(holder && key !== undefined
				? numberSources.get(holder)?.get(key)
				: undefined) ?? String(value)
		);
	if (Array.isArray(value)) {
		const parts = value.map((item, index) =>
			workerMetadataText(item, value, String(index), true),
		);
		return parts.some((item) => item === undefined)
			? undefined
			: "[" + parts.join(", ") + "]";
	}
	if (typeof value !== "object") return undefined;
	const entries = Object.entries(value);
	if (entries.length > 1) return undefined;
	if (!entries.length) return "{}";
	const [field, item] = entries[0];
	const text = workerMetadataText(item, value, field, true);
	return text === undefined
		? undefined
		: "{" + quotedPythonString(field) + ": " + text + "}";
}

export function observedLocationMetadata(
	bag: Readonly<Record<string, unknown>>,
) {
	const wire = Object.create(null) as Record<string, string>;
	const worker = Object.create(null) as Record<string, string>;
	for (const [key, value] of Object.entries(bag)) {
		wire[key] = numberSources.get(bag)?.get(key) ?? exactLocationJson(value);
		const text = workerMetadataText(value, bag, key);
		if (text !== undefined) worker[key] = text;
	}
	return { wire, worker };
}
