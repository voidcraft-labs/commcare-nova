import { describe, expect, it } from "vitest";
import { registeredPreviewFunctions } from "@/lib/preview/xpath/functions";
import { FUNCTION_REGISTRY } from "../../validator/functionRegistry";
import {
	assertCsqlQueryFunction,
	assertCsqlValueFunction,
	CSQL_QUERY_FUNCTIONS,
	CSQL_VALUE_FUNCTIONS,
	inspectXPathFunctionCalls,
	JAVAROSA_CONTEXT_FUNCTIONS,
	JAVAROSA_LOWERED_FUNCTIONS,
	JAVAROSA_NATIVE_FUNCTIONS,
	JAVAROSA_PATH_INITIALIZERS,
	javaRosaFunctionCapability,
	PREVIEW_NATIVE_FUNCTIONS,
	PREVIEW_PATH_INITIALIZERS,
} from "../functionCapabilities";

describe("XPath carrier capability contract", () => {
	it("admits only JavaRosa-native, lowered, or path-initializer functions", () => {
		for (const name of FUNCTION_REGISTRY.keys()) {
			expect(javaRosaFunctionCapability(name), name).not.toBe("unsupported");
		}
		expect(FUNCTION_REGISTRY.has("normalize-space")).toBe(true);
		expect(FUNCTION_REGISTRY.has("last")).toBe(false);
		expect(FUNCTION_REGISTRY.has("substring")).toBe(false);
		expect(FUNCTION_REGISTRY.has("here")).toBe(false);
	});

	it("tracks Core's native table independently from path intrinsics", () => {
		expect(JAVAROSA_NATIVE_FUNCTIONS.size).toBe(76);
		expect(JAVAROSA_NATIVE_FUNCTIONS.has("replace")).toBe(true);
		expect(JAVAROSA_NATIVE_FUNCTIONS.has("normalize-space")).toBe(false);
		expect([...JAVAROSA_LOWERED_FUNCTIONS]).toEqual(["normalize-space"]);
		expect([...JAVAROSA_PATH_INITIALIZERS].sort()).toEqual([
			"current",
			"instance",
		]);
		expect([...JAVAROSA_CONTEXT_FUNCTIONS]).toEqual(["here"]);
	});

	it("keeps Preview's declared support equal to its actual registrations", () => {
		expect([...registeredPreviewFunctions()].sort()).toEqual(
			[...PREVIEW_NATIVE_FUNCTIONS].sort(),
		);
		expect([...PREVIEW_PATH_INITIALIZERS]).toEqual(["instance"]);
		expect(
			inspectXPathFunctionCalls(
				"instance('commcaresession')/session/context/userid",
			),
		).toMatchObject([
			{
				name: "instance",
				javaRosa: "path-initializer",
				preview: "path-initializer",
				validPathInitializer: true,
			},
		]);
		expect(inspectXPathFunctionCalls("current()/name")).toMatchObject([
			{
				name: "current",
				javaRosa: "path-initializer",
				preview: "unsupported",
				validPathInitializer: true,
			},
		]);
		expect(inspectXPathFunctionCalls("instance(#form/id)/name")).toMatchObject([
			{
				name: "instance",
				validPathInitializer: false,
			},
		]);
		expect(
			inspectXPathFunctionCalls("current('unexpected')/name"),
		).toMatchObject([
			{
				name: "current",
				validPathInitializer: false,
			},
		]);
	});

	it("keeps CSQL value and query whitelists distinct", () => {
		expect(CSQL_VALUE_FUNCTIONS.has("date-add")).toBe(true);
		expect(CSQL_VALUE_FUNCTIONS.has("normalize-space")).toBe(false);
		expect(CSQL_QUERY_FUNCTIONS.has("selected-any")).toBe(true);
		expect(CSQL_QUERY_FUNCTIONS.has("normalize-space")).toBe(false);
		expect(() => assertCsqlValueFunction("normalize-space")).toThrow(
			"CCHQ does not register it as a value function",
		);
		expect(() => assertCsqlQueryFunction("normalize-space")).toThrow(
			"CCHQ does not register it as a query function",
		);
	});
});
