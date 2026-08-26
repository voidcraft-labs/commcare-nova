import { toBoolean, toNumber, xpathToString } from "./coerce";
import { javaRosaSplitOnSpaces } from "./javaString";
import {
	isXPathNodeSet,
	isXPathSequence,
	type XPathRuntimeValue,
	XPathSequence,
} from "./runtimeValues";
import type { XPathValue } from "./types";

export type NodeSetJavaRosaFunction = (
	args: readonly XPathRuntimeValue[],
) => XPathRuntimeValue;

function requireNodeSetValues(value: XPathRuntimeValue): readonly XPathValue[] {
	if (!isXPathNodeSet(value)) {
		throw new Error("XPath function requires a nodeset argument.");
	}
	if (!value.validPath) {
		throw new Error(
			"XPath references a path that does not exist in the instance.",
		);
	}
	return value.nodes.map((node) => node.value());
}

function sequenceValues(value: XPathRuntimeValue): readonly XPathValue[] {
	if (isXPathNodeSet(value)) return requireNodeSetValues(value);
	if (isXPathSequence(value)) return value.values;
	if (typeof value !== "string") {
		throw new Error("XPath sequence function requires a string or sequence.");
	}
	return javaRosaSplitOnSpaces(value);
}

function joinValues(
	separator: XPathRuntimeValue,
	values: readonly XPathRuntimeValue[],
): string {
	const delimiter = xpathToString(separator);
	return values.map((value) => xpathToString(value)).join(delimiter);
}

function javaInt32(value: XPathRuntimeValue): number {
	const number = toNumber(value);
	if (Number.isNaN(number)) return 0;
	if (number >= 2_147_483_647) return 2_147_483_647;
	if (number <= -2_147_483_648) return -2_147_483_648;
	return Math.trunc(number);
}

function joinChunkedValues(
	separator: XPathRuntimeValue,
	chunkSizeValue: XPathRuntimeValue,
	values: readonly XPathRuntimeValue[],
): string {
	const delimiter = xpathToString(separator);
	const chunkSize = javaInt32(chunkSizeValue);
	const input = values.map((value) => xpathToString(value)).join("");
	let output = "";
	for (let index = 0; index < input.length; index += 1) {
		if (index !== 0) {
			if (chunkSize === 0) {
				throw new Error("join-chunked() cannot use a zero chunk size.");
			}
			if (index % chunkSize === 0) output += delimiter;
		}
		output += input[index] ?? "";
	}
	return output;
}

function concat(args: readonly XPathRuntimeValue[]): string {
	const values =
		args.length === 1 && isXPathNodeSet(args[0])
			? requireNodeSetValues(args[0])
			: args;
	return joinValues("", values);
}

function join(args: readonly XPathRuntimeValue[]): string {
	const tail =
		args.length === 2 && (isXPathNodeSet(args[1]) || isXPathSequence(args[1]))
			? sequenceValues(args[1])
			: args.slice(1);
	return joinValues(args[0] ?? "", tail);
}

function joinChunked(args: readonly XPathRuntimeValue[]): string {
	const tail =
		args.length === 3 && isXPathNodeSet(args[2])
			? requireNodeSetValues(args[2])
			: args.slice(2);
	return joinChunkedValues(args[0] ?? "", args[1] ?? Number.NaN, tail);
}

function extrema(
	args: readonly XPathRuntimeValue[],
	kind: "min" | "max",
): number {
	const values =
		args.length === 1 && isXPathNodeSet(args[0])
			? requireNodeSetValues(args[0])
			: args;
	if (values.length === 0) return Number.NaN;
	let result = kind === "min" ? Number.MAX_VALUE : Number.NEGATIVE_INFINITY;
	for (const value of values) {
		result =
			kind === "min"
				? Math.min(result, toNumber(value))
				: Math.max(result, toNumber(value));
	}
	return result;
}

function checklist(args: readonly XPathRuntimeValue[]): boolean {
	const min = javaInt32(args[0] ?? Number.NaN);
	const max = javaInt32(args[1] ?? Number.NaN);
	const factors =
		args.length === 3 && isXPathNodeSet(args[2])
			? requireNodeSetValues(args[2])
			: args.slice(2);
	const count = factors.filter((factor) => toBoolean(factor)).length;
	return (min < 0 || count >= min) && (max < 0 || count <= max);
}

function weightedChecklist(args: readonly XPathRuntimeValue[]): boolean {
	const min = toNumber(args[0] ?? Number.NaN);
	const max = toNumber(args[1] ?? Number.NaN);
	let flags: readonly XPathRuntimeValue[];
	let weights: readonly XPathRuntimeValue[];
	if (args.length === 4 && isXPathNodeSet(args[2]) && isXPathNodeSet(args[3])) {
		flags = requireNodeSetValues(args[2]);
		weights = requireNodeSetValues(args[3]);
		if (flags.length !== weights.length) {
			throw new Error(
				"weighted-checklist() nodesets must have the same length.",
			);
		}
	} else {
		flags = args.filter((_, index) => index >= 2 && index % 2 === 0);
		weights = args.filter((_, index) => index >= 3 && index % 2 === 1);
	}
	let sum = 0;
	for (let index = 0; index < flags.length; index += 1) {
		if (toBoolean(flags[index] ?? "")) {
			sum += toNumber(weights[index] ?? Number.NaN);
		}
	}
	return sum >= min && sum <= max;
}

function count(args: readonly XPathRuntimeValue[]): number {
	const value = args[0];
	if (!isXPathNodeSet(value)) {
		throw new Error("count() requires a nodeset argument.");
	}
	// Core's invalid-path nodeset has a null backing collection and size() = 0;
	// count() is the one nodeset consumer that does not dereference it.
	return value.validPath ? value.size : 0;
}

function sum(args: readonly XPathRuntimeValue[]): number {
	return requireNodeSetValues(args[0] ?? "").reduce<number>(
		(total, value) => total + toNumber(value),
		0,
	);
}

function distinctValues(args: readonly XPathRuntimeValue[]): XPathSequence {
	const seen = new Set<string>();
	const values: XPathValue[] = [];
	for (const value of sequenceValues(args[0] ?? "")) {
		const text = xpathToString(value);
		if (seen.has(text)) continue;
		seen.add(text);
		values.push(text);
	}
	return new XPathSequence(values);
}

function sameJavaObject(left: XPathValue, right: string): boolean {
	if (typeof left === "string") return left === right;
	// Java's Object.equals does not coerce numeric, boolean, or Date nodes to
	// the string target used by index-of().
	return false;
}

function indexOf(args: readonly XPathRuntimeValue[]): number | string {
	const values = sequenceValues(args[0] ?? "");
	const target = xpathToString(args[1] ?? "");
	for (let index = 0; index < values.length; index += 1) {
		if (sameJavaObject(values[index] ?? "", target)) return index;
	}
	return "";
}

export const nodeSetJavaRosaFunctions: ReadonlyMap<
	string,
	NodeSetJavaRosaFunction
> = new Map<string, NodeSetJavaRosaFunction>([
	["count", count],
	["sum", sum],
	["distinct-values", distinctValues],
	["index-of", indexOf],
	["concat", concat],
	["join", join],
	["join-chunked", joinChunked],
	["min", (args) => extrema(args, "min")],
	["max", (args) => extrema(args, "max")],
	["checklist", checklist],
	["weighted-checklist", weightedChecklist],
]);
