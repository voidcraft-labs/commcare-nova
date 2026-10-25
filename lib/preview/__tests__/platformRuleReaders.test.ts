/**
 * One rule table: no Preview code chooses a behavior by comparing a
 * platform.
 *
 * Every Preview surface reads one field of `previewPlatformRules(platform)`
 * (`lib/preview/platform.ts`), and the per-platform choices a field cannot
 * hold live in that file and in `engine/previewDevice.ts` (the device's
 * input parse, `serverPreviewDevice` and `withNavigationWidth`). This reads
 * every `.ts` and `.tsx` file of Preview, its screens, App Tests and the
 * authoring evaluator and fails on a string literal naming a platform
 * anywhere else, naming the file and line. A new behavior that differs by
 * platform is a rule field, not a comparison.
 *
 * Each file is read as code, never matched as text: esbuild erases its
 * types and turns its JSX into calls (so JSX text and a type's literal
 * union are no false findings), and TypeScript's own scanner tokenizes the
 * result, rescanning template continuations and regular expressions the way
 * the parser does. TypeScript 7 serves no parser to JavaScript; its scanner
 * is the part of the compiler it does serve.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	createScanner,
	LanguageVariant,
	SyntaxKind,
} from "@typescript/native-preview/unstable/ast";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { PLATFORMS } from "@/lib/domain/platforms";

const ROOT = process.cwd();
const SCANNED = [
	"lib/preview",
	"components/preview",
	"lib/agent/authoring/evaluationContext.ts",
];
const ALLOWED = new Set([
	"lib/preview/platform.ts",
	"lib/preview/engine/previewDevice.ts",
]);

function sourceFiles(path: string): string[] {
	const absolute = join(ROOT, path);
	if (statSync(absolute).isFile()) return [path];
	return readdirSync(absolute).flatMap((name) => {
		const child = `${path}/${name}`;
		if (name === "__tests__" || name === "node_modules") return [];
		if (statSync(join(ROOT, child)).isDirectory()) return sourceFiles(child);
		return /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [child] : [];
	});
}

/** A slash after one of these divides; after anything else it opens a
 *  regular expression (the parser's own distinction, made from context). */
const DIVISION_FOLLOWS = new Set<SyntaxKind>([
	SyntaxKind.Identifier,
	SyntaxKind.NumericLiteral,
	SyntaxKind.BigIntLiteral,
	SyntaxKind.StringLiteral,
	SyntaxKind.NoSubstitutionTemplateLiteral,
	SyntaxKind.TemplateTail,
	SyntaxKind.RegularExpressionLiteral,
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
	SyntaxKind.CloseBraceToken,
	SyntaxKind.ThisKeyword,
	SyntaxKind.TrueKeyword,
	SyntaxKind.FalseKeyword,
	SyntaxKind.NullKeyword,
	SyntaxKind.PlusPlusToken,
	SyntaxKind.MinusMinusToken,
]);

/** Every string literal's value in JavaScript `code`, in order. */
function stringLiterals(code: string): string[] {
	const scanner = createScanner(true, LanguageVariant.Standard, code);
	const values: string[] = [];
	/* The brace depth at which each open template substitution closes. */
	const substitutions: number[] = [];
	let depth = 0;
	let previous = SyntaxKind.Unknown;
	for (
		let token = scanner.scan();
		token !== SyntaxKind.EndOfFile;
		token = scanner.scan()
	) {
		if (
			(token === SyntaxKind.SlashToken ||
				token === SyntaxKind.SlashEqualsToken) &&
			!DIVISION_FOLLOWS.has(previous)
		)
			token = scanner.reScanSlashToken();
		if (token === SyntaxKind.OpenBraceToken) depth += 1;
		else if (token === SyntaxKind.CloseBraceToken) {
			if (substitutions.at(-1) === depth) {
				token = scanner.reScanTemplateToken(false);
				if (token === SyntaxKind.TemplateTail) substitutions.pop();
			} else depth -= 1;
		}
		if (token === SyntaxKind.TemplateHead) substitutions.push(depth);
		if (
			token === SyntaxKind.StringLiteral ||
			token === SyntaxKind.NoSubstitutionTemplateLiteral
		)
			values.push(scanner.getTokenValue());
		previous = token;
	}
	return values;
}

function platformLiterals(path: string): string[] {
	const text = readFileSync(join(ROOT, path), "utf8");
	const { code } = transformSync(text, {
		loader: path.endsWith(".tsx") ? "tsx" : "ts",
		jsx: "transform",
		jsxFactory: "h",
		jsxFragment: "Fragment",
		legalComments: "none",
	});
	const platforms: readonly string[] = PLATFORMS;
	const lines = text.split("\n");
	return stringLiterals(code)
		.filter((value) => platforms.includes(value))
		.map((value) => {
			const line = lines.findIndex((candidate) =>
				[`"${value}"`, `'${value}'`, `\`${value}\``].some((quoted) =>
					candidate.includes(quoted),
				),
			);
			return `${path}:${line + 1} names the platform "${value}". Read a field of previewPlatformRules(platform) from lib/preview/platform.ts instead, or add the behavior there as a rule field.`;
		});
}

describe("Preview's platform rule readers", () => {
	it("compare no platform outside the rule table and the device", () => {
		const files = SCANNED.flatMap(sourceFiles).filter(
			(path) => !ALLOWED.has(path),
		);
		expect(files.length).toBeGreaterThan(50);
		expect(files.flatMap(platformLiterals)).toEqual([]);
	});

	it("finds the literals the rule table itself writes", () => {
		/* The scanner sees what it is meant to refuse elsewhere. */
		expect(platformLiterals("lib/preview/platform.ts").length).toBeGreaterThan(
			0,
		);
	});

	it("reads strings inside template substitutions and past a regular expression", () => {
		expect(
			stringLiterals(
				[
					"const a = `$",
					"{b}'s $",
					"{`in$",
					'{"android"}`} end`; const c = /"/.test(d); const e = 4 / 2; const f = "web-apps";',
				].join(""),
			),
		).toEqual(["android", "web-apps"]);
	});
});
