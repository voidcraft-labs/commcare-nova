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

/**
 * Every escape a string or template literal can spell, cooked to the
 * character it stands for: a code point (`\u{...}`), a code unit (`\uXXXX`,
 * `\xXX`, a legacy octal), nothing for a line continuation, and the character
 * itself for any other. `\n` and its kin cook to their letter here, never to
 * the character they name, which can only add a match.
 */
const ESCAPE =
	/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g;

function cookEscapes(text: string): string {
	return text.replace(
		ESCAPE,
		(whole, point, unit, hex, octal, _continuation, other) => {
			if (point !== undefined) {
				const value = Number.parseInt(point, 16);
				return value <= 0x10ffff ? String.fromCodePoint(value) : whole;
			}
			if (unit !== undefined || hex !== undefined)
				return String.fromCharCode(Number.parseInt(unit ?? hex, 16));
			if (octal !== undefined)
				return String.fromCharCode(Number.parseInt(octal, 8));
			return other ?? "";
		},
	);
}

/** A static specifier reaching the package spells its directory segment,
 * plainly or through escapes. This prefilter keeps every file whose text
 * spells it once each escape is cooked, read as one literal from the start:
 * an escape never spans a literal's opening quote, so each literal's own
 * escapes cook as the parser cooks them. It keeps a superset; only the parse
 * establishes a finding. */
function checkImportPolicy(
	sources: Readonly<Record<string, string>>,
): Finding[] {
	const segment = path.posix.basename(FROZEN_DIRECTORY);
	const candidates = Object.fromEntries(
		Object.entries(sources).filter(
			([, text]) =>
				text.includes(segment) ||
				(text.includes("\\") && cookEscapes(text).includes(segment)),
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
		// Spelled only through escapes, so it reaches the parse only through
		// the prefilter's cooking.
		const escapedOnly = "lib/db/escapedReader.ts";
		const escapedText = [
			`import a from "@/lib/case-store/migrations/\\u{32}0260728000000_canonical_identity_foundation/x";`,
			`import b from "@/lib/case-store/migrations/2026072800\\\n0000_canonical_identity_foundation/x";`,
			`import c from "@/lib/case-store/migrations/20260728000000_\\canonical_identity_foundation/x";`,
			`import d from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundatio\\u006e/x";`,
			'const help = "no specifier \\\\ here";',
		].join("\n");
		const samples = {
			[escapedOnly]: escapedText,
			[file]: text,
			[`${FROZEN_DIRECTORY}inside.ts`]: text,
			"scripts/scan-canonical-identity-foundation.ts": text,
			"lib/case-store/migrations/__tests__/oracle.test.ts": text,
		};
		expect(checkImportPolicy(samples)).toEqual([
			{
				file: escapedOnly,
				line: 1,
				value:
					"@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/x",
			},
			{
				file: escapedOnly,
				line: 2,
				value:
					"@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/x",
			},
			{
				file: escapedOnly,
				line: 4,
				value:
					"@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/x",
			},
			{
				file: escapedOnly,
				line: 5,
				value:
					"@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/x",
			},
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
