import { describe, expect, it } from "vitest";
import { nodeSetJavaRosaFunctions } from "../nodeSetJavaRosaFunctions";
import {
	type XPathNode,
	XPathNodeSet,
	type XPathRuntimeValue,
	XPathSequence,
} from "../runtimeValues";
import type { XPathValue } from "../types";

function node(value: XPathValue, index: number): XPathNode {
	return {
		instanceId: null,
		path: `/data/item[${index + 1}]`,
		name: "item",
		kind: "element",
		multiplicity: index,
		value: () => value,
		parent: () => undefined,
		children: () => [],
		attributes: () => [],
		hasChildTemplate: () => false,
		hasAttributeTemplate: () => false,
		isRelevant: () => true,
	};
}

function nodes(...values: XPathValue[]): XPathNodeSet {
	return new XPathNodeSet(values.map(node));
}

function invalidNodes(): XPathNodeSet {
	return new XPathNodeSet([], false);
}

function call(name: string, ...args: XPathRuntimeValue[]): XPathRuntimeValue {
	const fn = nodeSetJavaRosaFunctions.get(name);
	if (!fn) throw new Error(`Missing nodeset JavaRosa function ${name}()`);
	return fn(args);
}

describe("nodeset and sequence JavaRosa function ports", () => {
	it("implements count() without dereferencing an invalid path", () => {
		expect(call("count", nodes("a", "b"))).toBe(2);
		expect(call("count", nodes())).toBe(0);
		// Core XPathNodeset.size() returns zero when its backing nodes are null.
		expect(call("count", invalidNodes())).toBe(0);
		expect(() => call("count", "a b")).toThrow("requires a nodeset");
	});

	it("implements sum(), min(), and max() over nodesets", () => {
		expect(call("sum", nodes("1", 2, "3.5"))).toBe(6.5);
		expect(call("sum", nodes())).toBe(0);
		expect(call("min", nodes("8", 2, "3.5"))).toBe(2);
		expect(call("max", nodes("8", 2, "3.5"))).toBe(8);
		expect(call("min", nodes())).toBeNaN();
		expect(call("max", nodes())).toBeNaN();
		expect(() => call("sum", invalidNodes())).toThrow("does not exist");
	});

	it("joins nodesets and Core sequences only in the signatures Core overloads", () => {
		expect(call("concat", nodes("Utah", "Montana"))).toBe("UtahMontana");
		expect(call("join", " ", nodes("Utah", "Montana"))).toBe("Utah Montana");
		expect(call("join", ",", new XPathSequence(["a", "b"]))).toBe("a,b");
		expect(call("join-chunked", "-", 5, nodes("Utah", "Montana"))).toBe(
			"UtahM-ontan-a",
		);
		// Core recognizes Object[] only in join(); the other functions try and
		// fail to coerce the sequence object itself.
		expect(() => call("concat", new XPathSequence(["a", "b"]))).toThrow(
			"sequence cannot be converted",
		);
		expect(() => call("min", new XPathSequence([1, 2]))).toThrow(
			"sequence cannot be converted",
		);
	});

	it("preserves ordered string identity for distinct-values()", () => {
		const fromNodes = call(
			"distinct-values",
			nodes("us", "ca", "us", "mx", "ca"),
		);
		expect(fromNodes).toBeInstanceOf(XPathSequence);
		expect((fromNodes as XPathSequence).values).toEqual(["us", "ca", "mx"]);
		const fromString = call("distinct-values", "a b c a b d");
		expect((fromString as XPathSequence).values).toEqual(["a", "b", "c", "d"]);
		expect((call("distinct-values", nodes()) as XPathSequence).values).toEqual(
			[],
		);
		expect(() => call("distinct-values", invalidNodes())).toThrow(
			"does not exist",
		);
	});

	it("implements index-of() as zero-based number or blank", () => {
		expect(call("index-of", nodes("ma", "ks", "ca"), "ca")).toBe(2);
		expect(call("index-of", "ma ks ca", "ca")).toBe(2);
		expect(call("index-of", new XPathSequence(["na", "eu"]), "na")).toBe(0);
		expect(call("index-of", nodes("ma", "ks"), "ca")).toBe("");
		// Core compares each sequence object's type strictly to the string target.
		expect(call("index-of", nodes(1), "1")).toBe("");
	});

	it("handles nodeset checklist overloads and weighted length errors", () => {
		expect(call("checklist", 1, 2, nodes(true, false, true))).toBe(true);
		expect(call("checklist", -1, 1, nodes(true, true))).toBe(false);
		expect(
			call("weighted-checklist", 2, 4, nodes(true, true), nodes(1.5, 2)),
		).toBe(true);
		expect(() =>
			call("weighted-checklist", 0, 5, nodes(true, false), nodes(1)),
		).toThrow("same length");
	});
});
