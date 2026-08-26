import { describe, expect, it, vi } from "vitest";
import {
	createJavaPatternFunctions,
	type JavaPatternEngine,
} from "../javaPatternBoundary";

describe("Java Pattern integration boundary", () => {
	it("preserves Core's argument order and find operation", () => {
		const find = vi.fn(() => true);
		const engine: JavaPatternEngine = {
			find,
			replaceAllLiteral: vi.fn(() => ""),
		};
		expect(createJavaPatternFunctions(engine).regex("subject", "pattern")).toBe(
			true,
		);
		expect(find).toHaveBeenCalledWith("pattern", "subject");
	});

	it("delegates replace through the literal-replacement operation", () => {
		const replaceAllLiteral = vi.fn(() => "literal-result");
		const engine: JavaPatternEngine = {
			find: vi.fn(() => false),
			replaceAllLiteral,
		};
		expect(
			createJavaPatternFunctions(engine).replace("subject", "pattern", "$1\\"),
		).toBe("literal-result");
		expect(replaceAllLiteral).toHaveBeenCalledWith(
			"pattern",
			"subject",
			"$1\\",
		);
	});
});
