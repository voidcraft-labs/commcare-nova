import { describe, expect, it } from "vitest";
import {
	assertCsqlQueryFunction,
	assertCsqlValueFunction,
	inspectXPathFunctionCalls,
	javaRosaFunctionCapability,
} from "../functionCapabilities";

// Native dispatch is proved by XPathCarrierCompatibilityTest against the actual
// exported table. These tests own classification and structural call discovery.
describe("XPath capability classification", () => {
	it.each([
		["replace", "native"],
		["normalize-space", "lowered"],
		["current", "path-initializer"],
		["instance", "path-initializer"],
		["here", "context-handler"],
		["invented", "unsupported"],
	] as const)("classifies %s as %s", (name, expected) => {
		expect(javaRosaFunctionCapability(name)).toBe(expected);
	});
	it("finds nested calls, exact arity and offsets while ignoring literal spellings and axis tests", () => {
		const source =
			"concat('if(1,2,3)', normalize-space(' x '), current()/parent::node()/name)";
		expect(inspectXPathFunctionCalls(source)).toEqual([
			{
				name: "concat",
				from: 0,
				argumentCount: 3,
				javaRosa: "native",
				validPathInitializer: true,
			},
			{
				name: "normalize-space",
				from: source.indexOf("normalize-space"),
				argumentCount: 1,
				javaRosa: "lowered",
				validPathInitializer: true,
			},
			{
				name: "current",
				from: source.indexOf("current"),
				argumentCount: 0,
				javaRosa: "path-initializer",
				validPathInitializer: true,
			},
		]);
	});
	it.each([
		["instance('casedb')/casedb/case", true],
		["instance('casedb')", false],
		["instance(#form/id)/name", false],
		["instance('casedb', 'extra')/name", false],
		["current()/name", true],
		["current('unexpected')/name", false],
		["current()", false],
	] as const)(
		"checks the path-initializer position and literal arguments of %s",
		(source, valid) => {
			const calls = inspectXPathFunctionCalls(source);
			expect(calls).toHaveLength(1);
			expect(calls[0].validPathInitializer).toBe(valid);
		},
	);
	it("keeps CSQL query and value guards distinct with successful counterparts", () => {
		expect(() => assertCsqlValueFunction("date-add")).not.toThrow();
		expect(() => assertCsqlQueryFunction("selected-any")).not.toThrow();
		expect(() => assertCsqlQueryFunction("date-add")).toThrow(
			"CCHQ does not register it as a query function",
		);
		expect(() => assertCsqlValueFunction("selected-any")).toThrow(
			"CCHQ does not register it as a value function",
		);
		for (const name of ["normalize-space", "unknown"]) {
			expect(() => assertCsqlValueFunction(name)).toThrow(
				"CCHQ does not register it as a value function",
			);
			expect(() => assertCsqlQueryFunction(name)).toThrow(
				"CCHQ does not register it as a query function",
			);
		}
	});
});
