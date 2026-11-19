/**
 * The check when the builder opens is a Route Handler's `fetch` and never a
 * Server Action: Next.js sends a tab's Server Actions one at a time, so a
 * check made as one would hold the Publish dialog's records, Check status
 * and every other action of the tab behind CommCare HQ's answer.
 *
 * A source guard over `app`, `components` and `lib`, read by the compiler's
 * own parser: no module whose directive prologue holds `"use server"`
 * imports `lib/deployment/hqChanges/check.ts` or the folder's server surface
 * that re-exports it, or names `peekHqAppChanged` or `checkHqChangesForApp`;
 * and the builder's `HqChangesCheck.tsx` imports no such module and calls
 * `fetch`. It would catch a Server Action added for the check, and the
 * component reaching CommCare HQ through one. A direct-import rule, as the
 * other source guards are, and no proof over the module graph.
 */

import path from "node:path";
import {
	isCallExpression,
	isExportDeclaration,
	isExpressionStatement,
	isIdentifier,
	isImportDeclaration,
	isStringLiteral,
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

const CHECK = "lib/deployment/hqChanges/check";
const SURFACE = "lib/deployment/hqChanges/index";
const SURFACE_DIR = "lib/deployment/hqChanges";
const COMPONENT = "components/builder/HqChangesCheck.tsx";
const SERVER_ACTION_NAMES = ["peekHqAppChanged", "checkHqChangesForApp"];

/** Whether the file's directive prologue holds `"use server"`. */
function isServerActionModule(source: SourceFile): boolean {
	for (const statement of source.statements) {
		if (
			!isExpressionStatement(statement) ||
			!isStringLiteral(statement.expression)
		)
			return false;
		if (statement.expression.text === "use server") return true;
	}
	return false;
}

/** Each module the file imports, re-exports or loads, as a repository path without its extension. */
function importsOf(file: string, source: SourceFile): string[] {
	const found: string[] = [];
	visitTypeScript(source, (node: Node) => {
		const value =
			isImportDeclaration(node) || isExportDeclaration(node)
				? node.moduleSpecifier
				: isCallExpression(node) &&
						node.expression.kind === SyntaxKind.ImportKeyword
					? node.arguments[0]
					: undefined;
		if (value === undefined || !isStringLiteral(value)) return;
		const specifier = value.text;
		const resolved = specifier.startsWith("@/")
			? specifier.slice(2)
			: specifier.startsWith(".")
				? path.posix.normalize(
						path.posix.join(path.posix.dirname(file), specifier),
					)
				: specifier;
		found.push(resolved.replace(/\.[cm]?[jt]sx?$/, ""));
	});
	return found;
}

/** Each identifier of the file, once. */
function identifiersOf(source: SourceFile): ReadonlySet<string> {
	const found = new Set<string>();
	visitTypeScript(source, (node: Node) => {
		if (isIdentifier(node)) found.add(node.text);
	});
	return found;
}

/** Whether the file calls `fetch` by that name. */
function callsFetch(source: SourceFile): boolean {
	let calls = false;
	visitTypeScript(source, (node: Node) => {
		if (
			isCallExpression(node) &&
			isIdentifier(node.expression) &&
			node.expression.text === "fetch"
		)
			calls = true;
	});
	return calls;
}

/** The files that might be Server Action modules, and the component, parsed once. */
function readGuarded() {
	const all = readTypeScriptSources(["app", "components", "lib"]);
	const candidates = Object.fromEntries(
		Object.entries(all).filter(
			([file, text]) => file === COMPONENT || text.includes("use server"),
		),
	);
	return withTypeScriptSources(candidates, (parsed) => {
		const actions = new Map<
			string,
			{ readonly imports: string[]; readonly names: ReadonlySet<string> }
		>();
		let component: {
			readonly imports: string[];
			readonly fetches: boolean;
		} | null = null;
		for (const [file, source] of parsed) {
			if (isServerActionModule(source))
				actions.set(file, {
					imports: importsOf(file, source),
					names: identifiersOf(source),
				});
			if (file === COMPONENT)
				component = {
					imports: importsOf(file, source),
					fetches: callsFetch(source),
				};
		}
		return { actions, component };
	});
}

const guarded = readGuarded();

describe("the check when the builder opens", () => {
	it("finds the Server Action modules it guards", () => {
		expect([...guarded.actions.keys()]).toContain("lib/deployment/actions.ts");
	});

	it.each([...guarded.actions].map(([file, facts]) => [file, facts] as const))(
		"is not reached from the Server Action module %s",
		(_, facts) => {
			expect(facts.imports).not.toContain(CHECK);
			expect(facts.imports).not.toContain(SURFACE);
			expect(facts.imports).not.toContain(SURFACE_DIR);
			for (const name of SERVER_ACTION_NAMES)
				expect(facts.names.has(name)).toBe(false);
		},
	);

	it("is asked by the builder through fetch, and through no Server Action module", () => {
		const { component } = guarded;
		expect(component).not.toBeNull();
		const actionModules = new Set(
			[...guarded.actions.keys()].map((file) =>
				file.replace(/\.[cm]?[jt]sx?$/, ""),
			),
		);
		expect(
			component?.imports.filter((module) => actionModules.has(module)),
		).toEqual([]);
		expect(component?.fetches).toBe(true);
	});
});
