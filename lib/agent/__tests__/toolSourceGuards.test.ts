/**
 * Structural bypass guards for the shared tool surface.
 *
 * A shared tool body reaches persistence ONLY through its
 * `ToolInvocationContext` (`applyBatch` / `applyStages`) — the workspace owns
 * the gate and the canonical boundary. A tool that imported the canonical
 * writers, the commit kernel, or an external write service directly could
 * bypass both, so those imports fail here at source level. The narrow
 * exceptions are declared capability adapters: a file may import an external
 * service at the explicitly reviewed adapter files below. The runtime registry tests
 * separately exercise capability admission.
 *
 * This is a direct-import rule, not a transitive module-graph proof.
 * TypeScript already keeps `recordMutations` off the invocation context;
 * `workspace/__tests__/canonicalWorkspace.test.ts` proves the runtime object
 * matches.
 */

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

const TOOLS_ROOT = "lib/agent/tools";

/** Direct literal imports and re-exports only. The compiler owns JavaScript
 * syntax, including quotes and escapes; runtime capability tests own invocation. */
function importedSpecifier(node: Node): string | undefined {
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

function directImports(sources: Record<string, string>): Map<string, string[]> {
	return withTypeScriptSources(sources, (parsed) => {
		const imports = new Map<string, string[]>();
		for (const [file, source] of parsed) {
			const names: string[] = [];
			visitTypeScript(source, (node) => {
				const specifier = importedSpecifier(node);
				if (specifier === undefined) return;
				const resolved = specifier.startsWith("@/")
					? specifier.slice(2)
					: specifier.startsWith(".")
						? path.posix.normalize(
								path.posix.join(path.posix.dirname(file), specifier),
							)
						: specifier;
				names.push(resolved.replace(/\.[cm]?[jt]sx?$/, ""));
			});
			imports.set(file, names);
		}
		return imports;
	});
}

interface ForbiddenImportRule {
	/** Human name for the failure message. */
	readonly what: string;
	readonly matches: (specifier: string) => boolean;
	/**
	 * Files (relative to lib/agent/tools) reviewed as adapters for this import.
	 */
	readonly allowedFiles: readonly string[];
}

const RULES: readonly ForbiddenImportRule[] = [
	{
		what: "the canonical commit kernel",
		matches: (s) => s.includes("db/canonicalCommitKernel"),
		allowedFiles: [],
	},
	{
		what: "applyBlueprintChange (the case-schema-coupled canonical writer)",
		matches: (s) => s.includes("db/applyBlueprintChange"),
		allowedFiles: [],
	},
	{
		what: "lib/db/apps (canonical persistence + run lifecycle)",
		matches: (s) => s.includes("db/apps"),
		allowedFiles: [
			// deleteMediaAssetForChatRun — the declared media-write adapter.
			"media/removeMediaAsset.ts",
			// loadAppProjectId — a read helper for the at-source attach verdict.
			"media/shared.ts",
		],
	},
	{
		what: "the event-log writer",
		matches: (s) => s.includes("log/writer"),
		allowedFiles: [],
	},
	{
		what: "the organization row service (external writer)",
		matches: (s) => s.includes("organization/service"),
		allowedFiles: ["organization.ts", "automations.ts"],
	},
	{
		what: "the media deletion service (external writer)",
		matches: (s) => s.includes("db/mediaDeletion"),
		allowedFiles: ["media/removeMediaAsset.ts"],
	},
	{
		what: "the lookup authoring service (external writer)",
		matches: (s) => s.includes("lookup/agentService"),
		allowedFiles: ["getLookupTables.ts", "lookupTables.ts"],
	},
	{
		what: "the lookup row service (external reader)",
		matches: (s) => s.includes("lookup/service"),
		allowedFiles: ["lookupTables.ts"],
	},
	{
		what: "media asset metadata persistence",
		matches: (s) => s.includes("db/mediaAssets"),
		allowedFiles: ["media/listMediaAssets.ts", "media/removeMediaAsset.ts"],
	},
];

function violations(sources: Record<string, string>): string[] {
	const failures: string[] = [];
	for (const [file, imports] of directImports(sources)) {
		const relative = path.posix.relative(TOOLS_ROOT, file);
		for (const rule of RULES) {
			if (!rule.allowedFiles.includes(relative) && imports.some(rule.matches))
				failures.push(`${relative}: ${rule.what}`);
		}
	}
	return failures;
}

describe("shared tool direct-import architecture", () => {
	it("has no undeclared direct persistence import", () => {
		const sources = readTypeScriptSources([TOOLS_ROOT]);
		expect(Object.keys(sources)).toContain("lib/agent/tools/common.ts");
		expect(violations(sources)).toEqual([]);
	});

	it("detects equivalent literal module syntax and ignores comments and prose", () => {
		const sources = {
			"lib/agent/tools/probe.ts": `
    import '@\\x2flib/db/apps';
    export { commit } from '../../db/canonicalCommitKernel.ts';
    const a = import(\`../../db/applyBlueprintChange\`);
    const b = require('../../log/writer');
    // import "@/lib/db/mediaDeletion";
    const prose = 'import "@/lib/db/mediaDeletion"';
   `,
		};
		expect(violations(sources)).toEqual([
			"probe.ts: the canonical commit kernel",
			"probe.ts: applyBlueprintChange (the case-schema-coupled canonical writer)",
			"probe.ts: lib/db/apps (canonical persistence + run lifecycle)",
			"probe.ts: the event-log writer",
		]);
	});

	it("keeps exceptions file-specific", () => {
		const source = 'import { deleteMediaAsset } from "@/lib/db/mediaDeletion";';
		expect(
			violations({ "lib/agent/tools/media/removeMediaAsset.ts": source }),
		).toEqual([]);
		expect(violations({ "lib/agent/tools/media/shared.ts": source })).toEqual([
			"media/shared.ts: the media deletion service (external writer)",
		]);
	});
});
