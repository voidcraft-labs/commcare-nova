import { readFileSync } from "node:fs";
import path from "node:path";
import {
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isNoSubstitutionTemplateLiteral,
	isStringLiteral,
	type Node,
	SyntaxKind,
} from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import {
	readTypeScriptSources,
	visitTypeScript,
	withTypeScriptSources,
} from "@/__tests__/helpers/typescriptSources";

/** Source architecture rule for direct client imports. Relative paths,
 * exports and literal runtime loaders count; comments and prose do not.
 * Runtime behavior remains owned by the logger's tests. */
function moduleSpecifier(node: Node): string | undefined {
	const value =
		isImportDeclaration(node) || isExportDeclaration(node)
			? node.moduleSpecifier
			: isExternalModuleReference(node)
				? node.expression
				: isCallExpression(node) &&
						(node.expression.kind === SyntaxKind.ImportKeyword ||
							(isIdentifier(node.expression) &&
								node.expression.text === "require"))
					? node.arguments[0]
					: undefined;
	return value &&
		(isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
		? value.text
		: undefined;
}
function findings(sources: Record<string, string>): string[] {
	const candidates = Object.fromEntries(
		Object.entries(sources).filter(
			([, text]) => text.includes("logger") || text.includes("\\"),
		),
	);
	if (Object.keys(candidates).length === 0) return [];
	return withTypeScriptSources(candidates, (parsed) => {
		const result: string[] = [];
		for (const [file, source] of parsed)
			visitTypeScript(source, (node) => {
				const name = moduleSpecifier(node);
				if (!name) return;
				const resolved = name.startsWith("@/")
					? name.slice(2)
					: name.startsWith(".")
						? path.posix.normalize(
								path.posix.join(path.posix.dirname(file), name),
							)
						: undefined;
				if (resolved?.replace(/\.[cm]?[jt]sx?$/, "") === "lib/logger")
					result.push(file);
			});
		return result;
	});
}

describe("client document code avoids the structured server logger", () => {
	it("has no direct logger import in reducers, hooks or commit-boundary modules", () => {
		const sources = readTypeScriptSources([
			"lib/doc/mutations",
			"lib/doc/hooks",
		]);
		for (const file of [
			"lib/doc/commitVerdicts.ts",
			"lib/doc/identifierVerdicts.ts",
			"lib/doc/connectConfig.ts",
		])
			sources[file] = readFileSync(file, "utf8");
		expect(Object.keys(sources).length).toBeGreaterThan(3);
		expect(findings(sources)).toEqual([]);
	});
	it("finds alias, relative, re-export and dynamic imports while ignoring comments", () => {
		expect(
			findings({
				"lib/doc/mutations/example.ts": [
					'import log from "@/lib/logger";',
					'export {log} from "../../logger";',
					'const loaded = import("../../logger.ts");',
					'// import "@/lib/logger";',
					"const prose = 'import \"@/lib/logger\"';",
				].join("\n"),
			}),
		).toEqual(Array(3).fill("lib/doc/mutations/example.ts"));
	});
});
