/**
 * The pinned JavaRosa json-property() implementation delegates to
 * org.json.JSONObject(String), whose default parser is intentionally more
 * permissive than JSON.parse. This small reader implements the syntax that
 * parser accepts without evaluating user-authored text as JavaScript.
 */

import { parseJavaDouble } from "./javaRosaGeo";
import { javaTrim } from "./javaString";
import { openJdk17DoubleToString } from "./openJdk17DoubleString";

const SIMPLE_VALUE_DELIMITERS = new Set(`,:]}/\\"[{;=#`.split(""));

const JSON_NULL = Symbol("org.json.JSONObject.NULL");
interface JavaJsonNumber {
	readonly kind: "number";
	/** Number.toString(), which JSONObject uses when an unquoted number is a key. */
	readonly keyText: string;
}
type JavaJsonValue =
	| string
	| JavaJsonNumber
	| boolean
	| typeof JSON_NULL
	| JavaJsonValue[]
	| JavaJsonObject;
type JavaJsonObject = Map<string, JavaJsonValue>;

export function javaRosaJsonStringProperty(
	input: string,
	property: string,
): string {
	try {
		const object = new JavaJsonReader(input).parseObject();
		const value = object.get(property);
		return typeof value === "string" ? value : "";
	} catch {
		return "";
	}
}

class JavaJsonReader {
	private index = 0;

	constructor(private readonly input: string) {}

	parseObject(): JavaJsonObject {
		this.expect("{");
		const result: JavaJsonObject = new Map();
		if (this.peekClean() === "}") {
			this.nextClean();
			return result;
		}

		while (true) {
			const key = javaJsonKeyText(this.parseSimpleValue(this.nextClean()));
			if (this.nextClean() !== ":") throw new Error("Expected colon");
			if (result.has(key)) throw new Error("Duplicate key");
			result.set(key, this.parseValue());

			const end = this.nextClean();
			if (end === "}") return result;
			if (end !== "," && end !== ";") throw new Error("Expected separator");
			if (this.peekClean() === "}") {
				this.nextClean();
				return result;
			}
		}
	}

	private parseArray(): JavaJsonValue[] {
		const result: JavaJsonValue[] = [];
		let first = this.nextClean();
		if (first === "]") {
			return result;
		}
		while (true) {
			if (first === ",") {
				// Default JSONArray treats an initial missing element as JSONObject.NULL.
				// A second comma terminates its nested parse early and leaves invalid outer
				// input, so reject it directly while preserving `[,]` and `[, value]`.
				result.push(JSON_NULL);
				first = this.nextClean();
				if (first === "]") return result;
				if (first === ",") throw new Error("Missing array value");
				this.index -= 1;
			} else {
				this.index -= 1;
			}
			result.push(this.parseValue());
			const end = this.nextClean();
			if (end === "]") return result;
			if (end !== ",") throw new Error("Expected separator");
			if (this.peekClean() === "]") {
				this.nextClean();
				return result;
			}
			if (this.peekClean() === ",") throw new Error("Missing array value");
			first = this.nextClean();
		}
	}

	private parseValue(): JavaJsonValue {
		const first = this.nextClean();
		if (first === "{") return this.parseObjectAfterOpeningBrace();
		if (first === "[") return this.parseArray();
		return this.parseSimpleValue(first);
	}

	private parseObjectAfterOpeningBrace(): JavaJsonObject {
		// parseObject owns the opening brace; rewind one character so nested
		// objects follow exactly the same path as the root object.
		this.index -= 1;
		return this.parseObject();
	}

	private parseSimpleValue(first: string): JavaJsonValue {
		if (first === '"' || first === "'") return this.parseString(first);
		if (first.charCodeAt(0) < 32 || SIMPLE_VALUE_DELIMITERS.has(first)) {
			this.index -= 1;
			throw new Error("Missing value");
		}
		let token = first;
		while (this.index < this.input.length) {
			const current = this.input[this.index] ?? "";
			if (current.charCodeAt(0) < 32 || SIMPLE_VALUE_DELIMITERS.has(current)) {
				break;
			}
			token += current;
			this.index += 1;
		}
		token = javaTrim(token);
		if (token === "") throw new Error("Missing value");
		if (/^true$/i.test(token)) return true;
		if (/^false$/i.test(token)) return false;
		if (/^null$/i.test(token)) return JSON_NULL;
		const number = orgJsonNumber(token);
		if (number !== undefined) return number;
		return token;
	}

	private parseString(quote: string): string {
		let result = "";
		while (this.index < this.input.length) {
			const current = this.input[this.index] ?? "";
			this.index += 1;
			if (current === "\0") throw new Error("Unterminated string");
			if (current === quote) return result;
			if (current === "\n" || current === "\r") {
				throw new Error("Unterminated string");
			}
			if (current !== "\\") {
				result += current;
				continue;
			}
			const escaped = this.input[this.index] ?? "";
			this.index += 1;
			if ("\"'/\\".includes(escaped)) result += escaped;
			else if (escaped === "b") result += "\b";
			else if (escaped === "f") result += "\f";
			else if (escaped === "n") result += "\n";
			else if (escaped === "r") result += "\r";
			else if (escaped === "t") result += "\t";
			else if (escaped === "u") {
				const hex = this.input.slice(this.index, this.index + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Bad escape");
				result += String.fromCharCode(Number.parseInt(hex, 16));
				this.index += 4;
			} else throw new Error("Bad escape");
		}
		throw new Error("Unterminated string");
	}

	private expect(expected: string): void {
		if (this.nextClean() !== expected) throw new Error("Unexpected token");
	}

	private peekClean(): string {
		const saved = this.index;
		const value = this.nextClean();
		this.index = saved;
		return value;
	}

	private nextClean(): string {
		while (this.index < this.input.length) {
			const current = this.input[this.index] ?? "";
			this.index += 1;
			if (current === "\0") throw new Error("Unexpected end of input");
			if (current.charCodeAt(0) > 32) return current;
		}
		throw new Error("Unexpected end of input");
	}
}

/**
 * Match the ordinary decimal forms accepted by pinned JSONObject.stringToNumber.
 * Its integer path rejects a leading zero, but any token containing a decimal
 * point or exponent goes through BigDecimal instead and therefore accepts one.
 * This distinction is observable through json-property(): getString() returns
 * an unparsed token but rejects a parsed Number.
 */
function javaJsonKeyText(value: JavaJsonValue): string {
	if (value === JSON_NULL) return "null";
	if (typeof value === "object" && !Array.isArray(value) && "kind" in value) {
		return value.keyText;
	}
	return String(value);
}

function orgJsonNumber(token: string): JavaJsonNumber | undefined {
	if (!/^[0-9-]/.test(token)) return undefined;
	if (token === "-0") return { kind: "number", keyText: "-0.0" };
	const decimalNotation = token.includes(".") || /[eE]/.test(token);
	if (!decimalNotation) {
		if (!/^-?(?:0|[1-9]\d*)$/.test(token)) return undefined;
		return { kind: "number", keyText: BigInt(token).toString() };
	}

	const bigDecimal = bigDecimalKeyText(token);
	if (bigDecimal !== undefined) {
		return { kind: "number", keyText: bigDecimal };
	}

	// BigDecimal(String), followed by Double.valueOf(String) on failure. The
	// latter adds Java float/double suffixes and hexadecimal floating-point
	// literals. JSONObject only reaches this branch when isDecimalNotation()
	// spotted '.', 'e', or 'E', even for a hexadecimal token.
	try {
		const value = parseJavaDouble(token);
		return Number.isFinite(value)
			? { kind: "number", keyText: openJdk17DoubleToString(value) }
			: undefined;
	} catch {
		return undefined;
	}
}

/** BigDecimal(String).toString(), for JSONObject's first numeric parse arm. */
function bigDecimalKeyText(token: string): string | undefined {
	const match = /^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(
		token,
	);
	if (match === null) return undefined;

	const negative = match[1] === "-";
	const whole = match[2] ?? "";
	const fraction = match[3] ?? match[4] ?? "";
	const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
	let exponent: bigint;
	try {
		exponent = BigInt(match[5] ?? "0");
	} catch {
		return undefined;
	}
	const scale = BigInt(fraction.length) - exponent;
	if (scale < BigInt("-2147483648") || scale > BigInt("2147483647")) {
		return undefined;
	}
	if (digits === "0" && negative) return "-0.0";

	const sign = negative ? "-" : "";
	const precision = BigInt(digits.length);
	const adjustedExponent = precision - BigInt(1) - scale;
	if (scale >= BigInt(0) && adjustedExponent >= BigInt(-6)) {
		const numericScale = Number(scale);
		if (numericScale === 0) return `${sign}${digits}`;
		if (numericScale < digits.length) {
			const point = digits.length - numericScale;
			return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
		}
		return `${sign}0.${"0".repeat(numericScale - digits.length)}${digits}`;
	}

	const coefficient =
		digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
	const exponentText =
		adjustedExponent >= BigInt(0)
			? `+${adjustedExponent.toString()}`
			: adjustedExponent.toString();
	return `${sign}${coefficient}E${exponentText}`;
}
