import path from "node:path";
import {
	type Expression,
	isAsExpression,
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isImportTypeNode,
	isLiteralTypeNode,
	isNonNullExpression,
	isNoSubstitutionTemplateLiteral,
	isParenthesizedExpression,
	isSatisfiesExpression,
	isStringLiteral,
	isTypeAssertion,
	type Node,
	type SourceFile,
	SyntaxKind,
} from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import {
	readTypeScriptSources,
	visitTypeScript,
	withTypeScriptSources,
} from "@/__tests__/helpers/typescriptSources";

const FROZEN_DIRECTORY =
	"lib/case-store/migrations/20260728000000_canonical_identity_foundation/";
const ALLOWED_IMPORTERS = new Set([
	"scripts/audit-canonical-identity-foundation.ts",
	"scripts/repair-canonical-identity-foundation.ts",
	"scripts/scan-canonical-identity-foundation.ts",
	"lib/case-store/migrations/20260728000000_canonical_identity_foundation.ts",
]);

function unwrap(expression: Expression): Expression {
	let current = expression;
	while (
		isParenthesizedExpression(current) ||
		isAsExpression(current) ||
		isSatisfiesExpression(current) ||
		isTypeAssertion(current) ||
		isNonNullExpression(current)
	)
		current = current.expression;
	return current;
}

function literal(node: Node | undefined): string | undefined {
	return node &&
		(isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;
}

/** Static module specifiers only; computed runtime loaders are outside this policy. */
function moduleSpecifier(node: Node): string | undefined {
	if (isImportDeclaration(node) || isExportDeclaration(node))
		return literal(node.moduleSpecifier);
	if (isExternalModuleReference(node)) return literal(node.expression);
	if (isImportTypeNode(node) && isLiteralTypeNode(node.argument))
		return literal(node.argument.literal);
	if (isCallExpression(node)) {
		const callee = unwrap(node.expression);
		if (
			callee.kind === SyntaxKind.ImportKeyword ||
			(isIdentifier(callee) && callee.text === "require")
		)
			return literal(node.arguments[0]);
	}
	return undefined;
}

type Finding = { file: string; line: number; value: string };
function importFindings(file: string, source: SourceFile): Finding[] {
	if (
		file.startsWith(FROZEN_DIRECTORY) ||
		ALLOWED_IMPORTERS.has(file) ||
		file.startsWith("lib/case-store/migrations/__tests__/")
	)
		return [];
	const result: Finding[] = [];
	visitTypeScript(source, (node) => {
		const specifier = moduleSpecifier(node);
		if (!specifier) return;
		const resolved = specifier.startsWith(".")
			? path.posix.normalize(
					path.posix.join(path.posix.dirname(file), specifier),
				)
			: specifier.startsWith("@/")
				? path.posix.normalize(specifier.slice(2))
				: undefined;
		if (resolved?.startsWith(FROZEN_DIRECTORY))
			result.push({
				file,
				line:
					source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				value: specifier,
			});
	});
	return result;
}

/** A static specifier reaching the package must spell its directory segment or
 * use an escape. This conservative prefilter skips unrelated ASTs; escaped
 * spellings still reach the parser, and text matches never establish a finding. */
function checkImportPolicy(
	sources: Readonly<Record<string, string>>,
): Finding[] {
	const candidates = Object.fromEntries(
		Object.entries(sources).filter(
			([, text]) =>
				text.includes(path.posix.basename(FROZEN_DIRECTORY)) ||
				text.includes("\\"),
		),
	);
	if (Object.keys(candidates).length === 0) return [];
	return withTypeScriptSources(candidates, (parsed) =>
		[...parsed].flatMap(([file, source]) => importFindings(file, source)),
	);
}

describe("frozen migration import policy", () => {
	it("keeps runtime static imports outside the frozen migration package", () => {
		const sources = readTypeScriptSources(
			["__tests__", "app", "components", "e2e", "lib", "scripts"],
			true,
		);
		expect(checkImportPolicy(sources)).toEqual([]);
	});

	it("resolves static imports, exports, import types and loaders through the quarantine", () => {
		const file = "lib/db/reader.ts";
		const alias = `@/${FROZEN_DIRECTORY}frozenScanner`;
		const relative =
			"../case-store/migrations/20260728000000_canonical_identity_foundation/frozenScanner";
		const escaped = alias.replace("2026", "\\x32026");
		const text = [
			`import { scan } from "${alias}";`,
			`export { scan } from "${relative}";`,
			`import "${alias}";`,
			`const dynamic = import( /* whitespace */ "${relative}");`,
			`const required = require(\`${alias}\`);`,
			`import scanner = require("${relative}");`,
			`type Scanner = import("${alias}").Scanner;`,
			`// import "${alias}";`,
			`const help = 'import "${relative}"';`,
			'import entry from "../case-store/migrations/20260728000000_canonical_identity_foundation";',
			'import pkg from "some-package/frozenScanner";',
			`import { escaped } from "${escaped}";`,
		].join("\n");
		const samples = {
			[file]: text,
			[`${FROZEN_DIRECTORY}inside.ts`]: text,
			"scripts/scan-canonical-identity-foundation.ts": text,
			"lib/case-store/migrations/__tests__/oracle.test.ts": text,
		};
		expect(checkImportPolicy(samples)).toEqual([
			{ file, line: 1, value: alias },
			{ file, line: 2, value: relative },
			{ file, line: 3, value: alias },
			{ file, line: 4, value: relative },
			{ file, line: 5, value: alias },
			{ file, line: 6, value: relative },
			{ file, line: 7, value: alias },
			{ file, line: 12, value: alias },
		]);
	});

	it("refuses malformed source and closes the compiler before a subsequent parse", () => {
		expect(() =>
			withTypeScriptSources({ "broken.ts": "const = ;" }, () => null),
		).toThrow("Invalid syntax in broken.ts");
		expect(
			withTypeScriptSources(
				{ "valid.ts": "const value = 1;" },
				(parsed) => parsed.size,
			),
		).toBe(1);
	});
});
