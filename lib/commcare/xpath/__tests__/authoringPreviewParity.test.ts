import { describe, expect, it } from "vitest";
import { ASYNC_XPATH_FUNCTIONS } from "@/lib/preview/xpath/asyncEvaluator";
import { PREVIEW_EXECUTABLE_PATH_INITIALIZERS } from "@/lib/preview/xpath/evaluator";
import { PREVIEW_EXECUTABLE_FUNCTIONS } from "@/lib/preview/xpath/functions";
import { FUNCTION_REGISTRY } from "../../validator/functionRegistry";
import { JAVAROSA_PATH_INITIALIZERS } from "../functionCapabilities";

// Registration is a separate invariant from execution. Native value and Preview
// function tests own behavioral compatibility; these sets detect missing wiring.
describe("XPath admission and Preview registration agreement", () => {
	it("registers every ordinary function admitted for authored XPath", () => {
		const admittedFunctions = [...FUNCTION_REGISTRY.keys()].filter(
			(name) => !JAVAROSA_PATH_INITIALIZERS.has(name),
		);

		expect(
			[
				...new Set([...PREVIEW_EXECUTABLE_FUNCTIONS, ...ASYNC_XPATH_FUNCTIONS]),
			].sort(),
		).toEqual(admittedFunctions.sort());
	});

	it("registers each admitted path initializer", () => {
		expect([...PREVIEW_EXECUTABLE_PATH_INITIALIZERS].sort()).toEqual(
			[...JAVAROSA_PATH_INITIALIZERS].sort(),
		);
	});
});
