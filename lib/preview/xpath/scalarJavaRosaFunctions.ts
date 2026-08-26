import { toBoolean, toNumber, xpathToString } from "./coerce";
import { javaBmpDecimalDigit } from "./javaInteger";
import { javaRosaJsonStringProperty } from "./javaRosaJson";
import { javaRosaSplitOnSpaces, javaTrim } from "./javaString";
import {
	unpackXPathRuntimeValue,
	type XPathRuntimeValue,
} from "./runtimeValues";

export type ScalarJavaRosaFunction = (
	args: readonly XPathRuntimeValue[],
) => XPathRuntimeValue;

function javaInt32(value: XPathRuntimeValue): number {
	const number = toNumber(value);
	if (Number.isNaN(number)) return 0;
	if (number >= 2_147_483_647) return 2_147_483_647;
	if (number <= -2_147_483_648) return -2_147_483_648;
	return Math.trunc(number);
}

function javaStringList(value: XPathRuntimeValue): string[] {
	return javaRosaSplitOnSpaces(xpathToString(value));
}

function compareJavaStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function cryptoRandomDouble(): number {
	const words = new Uint32Array(2);
	globalThis.crypto.getRandomValues(words);
	const high21 = (words[0] ?? 0) & 0x1f_ffff;
	return (high21 * 0x1_0000_0000 + (words[1] ?? 0)) / 0x20_0000_0000_0000;
}

function cryptoBase36(length: number): string {
	let result = "";
	const bytes = new Uint8Array(Math.max(1, Math.min(length * 2, 4096)));
	while (result.length < length) {
		globalThis.crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			// 252 is the largest multiple of 36 below 256. Rejecting the tail
			// keeps every base-36 digit equiprobable.
			if (byte >= 252) continue;
			result += (byte % 36).toString(36).toUpperCase();
			if (result.length === length) break;
		}
	}
	return result;
}

function checklist(args: readonly XPathRuntimeValue[]): boolean {
	const min = javaInt32(args[0] ?? Number.NaN);
	const max = javaInt32(args[1] ?? Number.NaN);
	const count = args.slice(2).filter(toBoolean).length;
	return (min < 0 || count >= min) && (max < 0 || count <= max);
}

function weightedChecklist(args: readonly XPathRuntimeValue[]): boolean {
	const min = toNumber(args[0] ?? Number.NaN);
	const max = toNumber(args[1] ?? Number.NaN);
	let sum = 0;
	for (let index = 2; index < args.length; index += 2) {
		if (toBoolean(args[index] ?? "")) {
			sum += toNumber(args[index + 1] ?? Number.NaN);
		}
	}
	return sum >= min && sum <= max;
}

function joinChunked(args: readonly XPathRuntimeValue[]): string {
	const separator = xpathToString(args[0] ?? "");
	const chunkSize = javaInt32(args[1] ?? Number.NaN);
	const input = args
		.slice(2)
		.map((value) => xpathToString(value))
		.join("");
	let output = "";
	for (let index = 0; index < input.length; index += 1) {
		if (index !== 0) {
			if (chunkSize === 0) {
				throw new Error("join-chunked() cannot use a zero chunk size.");
			}
			if (index % chunkSize === 0) output += separator;
		}
		output += input[index] ?? "";
	}
	return output;
}

const VERHOEFF_MULTIPLICATION = [
	[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
	[1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
	[2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
	[3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
	[4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
	[5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
	[6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
	[7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
	[8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
	[9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const VERHOEFF_PERMUTATION = [
	[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
	[1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
	[5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
	[8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
	[9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
	[4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
	[2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
	[7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;
const VERHOEFF_INVERSE = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

function checksum(args: readonly XPathRuntimeValue[]): string {
	const algorithm = xpathToString(args[0] ?? "");
	if (algorithm !== "verhoeff") {
		throw new Error(
			`Bad algorithm key ${algorithm}. Only 'verhoeff' is supported.`,
		);
	}
	// Core reverses a List<Character>, so supplementary code points remain two
	// invalid surrogate chars rather than becoming one ECMAScript code point.
	const input = xpathToString(args[1] ?? "")
		.split("")
		.reverse();
	let check = 0;
	for (let index = 0; index < input.length; index += 1) {
		const digit = input[index] ?? "";
		const numeric = javaBmpDecimalDigit(digit);
		if (numeric === undefined) {
			throw new Error(`Illegal character '${digit}' in checksum().`);
		}
		check =
			VERHOEFF_MULTIPLICATION[check]?.[
				VERHOEFF_PERMUTATION[(index + 1) % 8]?.[numeric] ?? 0
			] ?? 0;
	}
	return String(VERHOEFF_INVERSE[check] ?? 0);
}

function idCompress(args: readonly XPathRuntimeValue[]): string {
	let input = javaInt32(args[0] ?? Number.NaN);
	const growth = xpathToString(args[1] ?? "");
	const lead = xpathToString(args[2] ?? "");
	const body = xpathToString(args[3] ?? "");
	const bodyCount = javaInt32(args[4] ?? Number.NaN);
	if (input < 0 || bodyCount < 0) {
		throw new Error(
			"ID compression requires a nonnegative input and body digit count.",
		);
	}
	if (growth.length === 0 || lead.length === 0) {
		throw new Error(
			"ID compression requires non-empty growth and lead symbols.",
		);
	}
	// Java validates UTF-16 char units rather than Unicode code points.
	for (let index = 0; index < growth.length; index += 1) {
		const character = growth[index] ?? "";
		if (lead.includes(character)) {
			throw new Error(
				`ID compression growth and lead symbols overlap at '${character}'.`,
			);
		}
	}
	const fixedCapacity = body.length ** bodyCount * lead.length;
	if (bodyCount > 0 && body.length === 0) {
		throw new Error(
			"ID compression body symbols must be non-empty when body digits are requested.",
		);
	}
	if (input >= fixedCapacity && growth.length < 2) {
		throw new Error(
			"ID compression growth symbols cannot encode values beyond the fixed portion.",
		);
	}
	let growthCount = 0;
	if (input >= fixedCapacity) {
		growthCount =
			Math.floor(Math.log(input / fixedCapacity) / Math.log(growth.length)) + 1;
	}
	const bases = [
		...Array.from({ length: growthCount }, () => growth.length),
		lead.length,
		...Array.from({ length: bodyCount }, () => body.length),
	];
	const counts: number[] = [];
	for (let index = 0; index < bases.length; index += 1) {
		const divisor = bases.slice(index + 1).reduce((a, value) => a * value, 1);
		counts.push(Math.floor(input / divisor));
		input %= divisor;
	}
	let output = "";
	for (let index = 0; index < growthCount; index += 1) {
		output += growth[counts[index] ?? -1] ?? "";
	}
	output += lead[counts[growthCount] ?? -1] ?? "";
	for (let index = 0; index < bodyCount; index += 1) {
		output += body[counts[growthCount + 1 + index] ?? -1] ?? "";
	}
	return output;
}

function sort(args: readonly XPathRuntimeValue[]): string {
	const values = javaStringList(args[0] ?? "");
	if (values.length === 0) throw new Error("sort() cannot sort an empty list.");
	const direction = args.length === 1 || toBoolean(args[1] ?? "") ? 1 : -1;
	return values.sort((a, b) => direction * compareJavaStrings(a, b)).join(" ");
}

function sortBy(args: readonly XPathRuntimeValue[]): string {
	const targets = javaStringList(args[0] ?? "");
	const comparisons = javaStringList(args[1] ?? "");
	if (targets.length !== comparisons.length) {
		throw new Error("sort-by() requires lists of the same length.");
	}
	if (targets.length === 0) {
		throw new Error("sort-by() cannot sort an empty list.");
	}
	const direction = args.length === 2 || toBoolean(args[2] ?? "") ? 1 : -1;
	return targets
		.map((target, index) => ({ target, comparison: comparisons[index] ?? "" }))
		.sort((a, b) => {
			const compared = compareJavaStrings(a.comparison, b.comparison);
			return direction * (compared || compareJavaStrings(a.target, b.target));
		})
		.map(({ target }) => target)
		.join(" ");
}

function jsonProperty(args: readonly XPathRuntimeValue[]): string {
	return javaRosaJsonStringProperty(
		xpathToString(args[0] ?? ""),
		xpathToString(args[1] ?? ""),
	);
}

export const scalarJavaRosaFunctions: ReadonlyMap<
	string,
	ScalarJavaRosaFunction
> = new Map<string, ScalarJavaRosaFunction>([
	["pi", () => Math.PI],
	[
		"boolean-from-string",
		(args) => {
			const value = xpathToString(args[0] ?? "");
			return value.toLowerCase() === "true" || value === "1";
		},
	],
	["log", (args) => Math.log(toNumber(args[0] ?? Number.NaN))],
	["log10", (args) => Math.log10(toNumber(args[0] ?? Number.NaN))],
	["sqrt", (args) => Math.sqrt(toNumber(args[0] ?? Number.NaN))],
	["exp", (args) => Math.exp(toNumber(args[0] ?? Number.NaN))],
	["sin", (args) => Math.sin(toNumber(args[0] ?? Number.NaN))],
	["cos", (args) => Math.cos(toNumber(args[0] ?? Number.NaN))],
	["tan", (args) => Math.tan(toNumber(args[0] ?? Number.NaN))],
	["asin", (args) => Math.asin(toNumber(args[0] ?? Number.NaN))],
	["acos", (args) => Math.acos(toNumber(args[0] ?? Number.NaN))],
	["atan", (args) => Math.atan(toNumber(args[0] ?? Number.NaN))],
	[
		"atan2",
		(args) =>
			Math.atan2(
				toNumber(args[0] ?? Number.NaN),
				toNumber(args[1] ?? Number.NaN),
			),
	],
	["upper-case", (args) => xpathToString(args[0] ?? "").toLocaleUpperCase()],
	["lower-case", (args) => xpathToString(args[0] ?? "").toLocaleLowerCase()],
	[
		"ends-with",
		(args) =>
			xpathToString(args[0] ?? "").endsWith(xpathToString(args[1] ?? "")),
	],
	[
		"substring-before",
		(args) => {
			const source = xpathToString(args[0] ?? "");
			const index = source.indexOf(xpathToString(args[1] ?? ""));
			return source.length === 0 || index <= 0 ? "" : source.slice(0, index);
		},
	],
	[
		"substring-after",
		(args) => {
			const source = xpathToString(args[0] ?? "");
			if (source.length === 0) return "";
			const needle = xpathToString(args[1] ?? "");
			const index = source.indexOf(needle);
			return index === -1 ? source : source.slice(index + needle.length);
		},
	],
	[
		"is-selected",
		(args) => {
			const value = requireJavaString(args[0] ?? "", "is-selected", 1);
			const option = javaTrim(
				requireJavaString(args[1] ?? "", "is-selected", 2),
			);
			return ` ${value} `.includes(` ${option} `);
		},
	],
	["depend", (args) => args[0] ?? ""],
	["random", () => cryptoRandomDouble()],
	[
		"uuid",
		(args) =>
			args.length === 0
				? globalThis.crypto.randomUUID()
				: cryptoBase36(javaInt32(args[0] ?? Number.NaN)),
	],
	["checklist", checklist],
	["weighted-checklist", weightedChecklist],
	["join-chunked", joinChunked],
	["json-property", jsonProperty],
	["checksum", checksum],
	["id-compress", idCompress],
	["sort", sort],
	["sort-by", sortBy],
]);

function requireJavaString(
	value: XPathRuntimeValue,
	name: string,
	position: number,
): string {
	const unpacked = unpackXPathRuntimeValue(value);
	if (typeof unpacked !== "string") {
		throw new Error(`${name}() argument #${position} must be a string.`);
	}
	return unpacked;
}

/**
 * Return the argument index selected by JavaRosa's lazy cond(). The callback is
 * invoked only for predicate positions; the caller evaluates the returned
 * value/default expression, preserving Core's unreachable-branch behavior.
 */
export function selectCondArgument(
	argumentCount: number,
	evaluatePredicate: (index: number) => XPathRuntimeValue,
): number {
	for (let index = 0; index < argumentCount - 2; index += 2) {
		if (toBoolean(evaluatePredicate(index))) return index + 1;
	}
	return argumentCount - 1;
}

/** depend() evaluates every argument before returning the first. */
export const EAGER_SCALAR_JAVAROSA_FUNCTIONS: ReadonlySet<string> = new Set([
	"depend",
]);
