import { describe, expect, it } from "vitest";
import { ASYNC_XPATH_FUNCTIONS } from "@/lib/preview/xpath/asyncEvaluator";
import { PREVIEW_EXECUTABLE_PATH_INITIALIZERS } from "@/lib/preview/xpath/evaluator";
import { PREVIEW_EXECUTABLE_FUNCTIONS } from "@/lib/preview/xpath/functions";
import { FUNCTION_REGISTRY } from "../../validator/functionRegistry";
import { JAVAROSA_PATH_INITIALIZERS } from "../functionCapabilities";

describe("valid-by-construction XPath Preview parity", () => {
	it("executes every ordinary function Nova admits for authored XPath", () => {
		const admittedFunctions = [...FUNCTION_REGISTRY.keys()].filter(
			(name) => !JAVAROSA_PATH_INITIALIZERS.has(name),
		);

		expect(
			[
				...new Set([...PREVIEW_EXECUTABLE_FUNCTIONS, ...ASYNC_XPATH_FUNCTIONS]),
			].sort(),
		).toEqual(admittedFunctions.sort());
	});

	it("executes every JavaRosa path initializer Nova admits", () => {
		expect([...PREVIEW_EXECUTABLE_PATH_INITIALIZERS].sort()).toEqual(
			[...JAVAROSA_PATH_INITIALIZERS].sort(),
		);
	});
});
