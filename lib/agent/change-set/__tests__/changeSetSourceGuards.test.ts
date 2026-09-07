/** Direct-import architecture for private staging. The compiler owns module
 * syntax and path normalization. This is not a transitive capability proof:
 * native change-set tests own isolation, atomic commit and holder behavior. */
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

const CHANGE_SET_ROOT = "lib/agent/change-set";

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
	/** Files (relative to lib/agent/change-set) allowed to hold this import. */
	readonly allowedFiles: readonly string[];
}

/** The type-level lookup leaves a read set may name. Anything else in
 *  `lib/lookup` is a writer or a service call. */
const LOOKUP_TYPE_LEAVES = ["lookup/types", "lookup/definitionSnapshot"];

const RULES: readonly ForbiddenImportRule[] = [
	{
		/* The run event log is an operator-visible stream; a staged step is
		 * private until commit and must not narrate itself into it. */
		what: "the event-log writer",
		matches: (s) => s.includes("log/writer"),
		allowedFiles: [],
	},
	{
		/* GenerationContext is the chat SSE + usage host. Staging runs under
		 * the executor, not a chat turn, and never emits to a browser. */
		what: "the chat SSE / event host (generationContext)",
		matches: (s) => s.includes("generationContext"),
		allowedFiles: [],
	},
	{
		/* The stream dispatcher publishes mutations to connected clients —
		 * exactly what an uncommitted candidate must never do. */
		what: "the generation stream dispatcher",
		matches: (s) => s.includes("streamDispatcher"),
		allowedFiles: [],
	},
	{
		/* Multiplayer frames broadcast document state to every Project member;
		 * a private candidate has no peers. */
		what: "the multiplayer collab modules",
		matches: (s) => s.includes("lib/collab"),
		allowedFiles: [],
	},
	{
		/* Place rows live outside the Blueprint, so an external writer inside
		 * staging would escape the all-or-nothing commit. */
		what: "the organization row service (external writer)",
		matches: (s) => s.includes("organization/service"),
		allowedFiles: [],
	},
	{
		/* Media deletion destroys Postgres rows and GCS bytes — irreversible,
		 * and never part of a candidate that may be abandoned. */
		what: "the media deletion service",
		matches: (s) => s.includes("db/mediaDeletion"),
		allowedFiles: [],
	},
	{
		/* Object storage is the same irreversibility one level down. */
		what: "the object store",
		matches: (s) => s.includes("lib/storage"),
		allowedFiles: [],
	},
	{
		/* Deployment writes reach CommCare HQ. A staged candidate has no
		 * business touching a remote project space. */
		what: "the HQ deployment writers",
		matches: (s) => s.includes("lib/deployment"),
		allowedFiles: [],
	},
	{
		/* Lookup data is Project-scoped app state with its own persistence
		 * boundary. Read sets may name its TYPES; nothing here may call it. */
		what: "a lib/lookup module beyond its type-level leaves",
		matches: (s) =>
			s.includes("lookup/") &&
			!LOOKUP_TYPE_LEAVES.some((leaf) => s.endsWith(leaf)),
		allowedFiles: [],
	},
	{
		/* The canonical commit kernel is the shared-tool write path. Staging
		 * commits through `applyBlueprintChange` in commit.ts and nowhere
		 * else, so no change-set file reaches the kernel directly. */
		what: "the canonical commit kernel",
		matches: (s) => s.includes("db/canonicalCommitKernel"),
		allowedFiles: [],
	},
	{
		/* The one authorized crossing: commit.ts is where the candidate stops
		 * being private and becomes canonical history. */
		what: "applyBlueprintChange (the canonical writer)",
		matches: (s) => s.includes("db/applyBlueprintChange"),
		allowedFiles: ["commit.ts"],
	},
	{
		/* LISTEN/NOTIFY fan-out wakes every connected client. Private staging
		 * has nothing to announce until its commit does it for real. */
		what: "the app-change realtime notify helpers",
		matches: (s) => s.includes("appChangeStream"),
		allowedFiles: [],
	},
];

function violations(sources: Record<string, string>): string[] {
	const failures: string[] = [];
	for (const [file, imports] of directImports(sources)) {
		const relative = path.posix.relative(CHANGE_SET_ROOT, file);
		for (const rule of RULES) {
			if (!rule.allowedFiles.includes(relative) && imports.some(rule.matches)) {
				failures.push(`${relative}: ${rule.what}`);
			}
		}
	}
	return failures;
}

describe("change-set direct-import architecture", () => {
	it("has no undeclared direct imports of canonical writers or external effects", () => {
		const sources = readTypeScriptSources([CHANGE_SET_ROOT]);
		expect(Object.keys(sources)).toContain("lib/agent/change-set/workspace.ts");
		expect(violations(sources)).toEqual([]);
	});
	it("detects literal imports and reexports across quotes, escapes and relative paths", () => {
		expect(
			violations({
				"lib/agent/change-set/probe.ts": `
   import '@\\x2flib/log/writer';
   export { write } from '../../db/applyBlueprintChange.ts';
   const a = import(\`../../deployment/publish\`);
   const b = require('../../storage');
   // import '@/lib/collab';
   const prose = "import '@/lib/collab'";
  `,
			}),
		).toEqual([
			"probe.ts: the event-log writer",
			"probe.ts: the object store",
			"probe.ts: the HQ deployment writers",
			"probe.ts: applyBlueprintChange (the canonical writer)",
		]);
	});
	it("keeps the app-edit canonical writer crossing specific to commit.ts", () => {
		const source =
			"import { applyBlueprintChange } from '../../db/applyBlueprintChange';";
		expect(violations({ "lib/agent/change-set/commit.ts": source })).toEqual(
			[],
		);
		expect(violations({ "lib/agent/change-set/workspace.ts": source })).toEqual(
			["workspace.ts: applyBlueprintChange (the canonical writer)"],
		);
	});
});
