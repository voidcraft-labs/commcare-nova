// scripts/__tests__/blueprintScan.test.ts
//
// Pure-function coverage for the blueprint-node walker behind
// `scan-blueprints.ts`. The walker's contract — exact paths (dotted
// keys, bracketed array indices), AND-matching over primitive-valued
// keys, canonical string forms for numbers/booleans, structural values
// never matching — is what makes the scan's output trustworthy as a
// prod-exposure answer, so each clause gets pinned here.

import { describe, expect, it } from "vitest";
import {
	countKeyValues,
	parseWherePair,
	scanNodes,
} from "../lib/blueprintScan";

/* A miniature persisted-blueprint shape: keyed module map, nested
 * expression trees, an array of columns, and primitive metadata at the
 * root. Small enough that every asserted path and tally is checkable
 * by hand. */
const doc = {
	schemaVersion: 3,
	published: true,
	modules: {
		m1: {
			caseListConfig: {
				filter: {
					kind: "comparison",
					left: { kind: "datetime-coerce", value: { kind: "prop" } },
				},
				columns: [
					{ kind: "display", field: "status" },
					{ kind: "calculated", expression: { kind: "datetime-coerce" } },
				],
			},
		},
	},
};

describe("scanNodes", () => {
	it("finds every node carrying the pair, with exact paths", () => {
		const matches = scanNodes(doc, new Map([["kind", "datetime-coerce"]]));
		expect(matches.map((m) => m.path)).toEqual([
			"modules.m1.caseListConfig.filter.left",
			"modules.m1.caseListConfig.columns[1].expression",
		]);
	});

	it("ANDs multiple pairs over the same node", () => {
		const hit = scanNodes(
			doc,
			new Map([
				["kind", "display"],
				["field", "status"],
			]),
		);
		expect(hit.map((m) => m.path)).toEqual([
			"modules.m1.caseListConfig.columns[0]",
		]);

		const miss = scanNodes(
			doc,
			new Map([
				["kind", "display"],
				["field", "owner"],
			]),
		);
		expect(miss).toEqual([]);
	});

	it("matches numbers and booleans by canonical string form, at the root's empty path", () => {
		expect(
			scanNodes(doc, new Map([["schemaVersion", "3"]])).map((m) => m.path),
		).toEqual([""]);
		expect(
			scanNodes(doc, new Map([["published", "true"]])).map((m) => m.path),
		).toEqual([""]);
	});

	it("never matches a key holding a structural value", () => {
		/* Every module node carries `caseListConfig`, but its value is an
		 * object — there is no string spelling of it to match against. */
		expect(
			scanNodes(doc, new Map([["caseListConfig", "[object Object]"]])),
		).toEqual([]);
	});

	it("matches nothing when no pairs were asked for", () => {
		expect(scanNodes(doc, new Map())).toEqual([]);
	});
});

describe("countKeyValues", () => {
	it("tallies every primitive value the key takes across the tree", () => {
		expect([...countKeyValues(doc, "kind").entries()]).toEqual([
			["comparison", 1],
			["datetime-coerce", 2],
			["prop", 1],
			["display", 1],
			["calculated", 1],
		]);
	});

	it("returns an empty tally for a key that never holds a primitive", () => {
		expect(countKeyValues(doc, "modules").size).toBe(0);
	});
});

describe("parseWherePair", () => {
	it("splits on the first '=' and keeps later ones in the value", () => {
		expect(parseWherePair("kind=datetime-coerce")).toEqual([
			"kind",
			"datetime-coerce",
		]);
		expect(parseWherePair("expr=a=b")).toEqual(["expr", "a=b"]);
	});

	it("rejects a pair with no '=' or an empty key, naming the repair", () => {
		expect(() => parseWherePair("kind")).toThrow(/joined by "="/);
		expect(() => parseWherePair("=value")).toThrow(/joined by "="/);
	});
});
