import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Expression,
	isArrayLiteralExpression,
	isAsExpression,
	isCallExpression,
	isFalseLiteral,
	isFunctionDeclaration,
	isFunctionExpression,
	isIdentifier,
	isImportDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isNonNullExpression,
	isObjectLiteralExpression,
	isParenthesizedExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isReturnStatement,
	isSatisfiesExpression,
	isStringLiteral,
	isTrueLiteral,
	isTypeAssertion,
	type Node,
	type PropertyAssignment,
	type SourceFile,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API, type Program, type Snapshot } from "typescript/unstable/sync";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type LifecycleMode = "admits-proposal" | "consumes-durable-admitted";

/**
 * Every production source that names a mutation admission/reduction/write
 * chokepoint. The generated scan below fails when a new source appears without
 * an explicit decision about which side of the boundary it owns.
 */
const SOURCE_CLASSIFICATION = {
	"app/api/apps/[id]/route.ts": "admits-proposal",
	// The change-set commit re-admits the concatenated durable steps as one
	// proposal and drives the guarded writer (applyBlueprintChange) with the
	// deterministic change-set batch id.
	"lib/agent/change-set/commit.ts": "admits-proposal",
	// Overlay rehydration replays already-admitted durable steps — exact
	// reduction, never admission.
	"lib/agent/change-set/runtime.ts": "consumes-durable-admitted",
	// The private staging host runs the same optimistic admission +
	// whole-document evaluation as the canonical workspace, over its durable
	// overlay; accepted steps persist through the change-set store, never a
	// canonical writer.
	"lib/agent/change-set/workspace.ts": "admits-proposal",
	"lib/agent/generationContext.ts": "admits-proposal",
	"lib/agent/tools/common.ts": "admits-proposal",
	// The canonical workspace runs the optimistic admission + whole-document
	// verdict over each invocation's proposal; its host seam carries the
	// prepared candidate to the surface writers.
	"lib/agent/workspace/canonicalHost.ts": "admits-proposal",
	"lib/agent/workspace/canonicalWorkspace.ts": "admits-proposal",
	"lib/collab/mutationFrame.ts": "consumes-durable-admitted",
	"lib/collab/reconciler.ts": "consumes-durable-admitted",
	"lib/db/applyBlueprintChange.ts": "consumes-durable-admitted",
	"lib/db/apps.ts": "admits-proposal",
	// The closed genesis owner: admits the genesis batch and re-evaluates the
	// whole candidate inside the creation/materialization transaction.
	"lib/db/appGenesis.ts": "admits-proposal",
	// The promoted guarded-commit transaction: re-admits the caller's proposal
	// against the fresh locked snapshot before any durable write.
	"lib/db/canonicalCommitKernel.ts": "admits-proposal",
	"lib/db/canonicalMutationFold.ts": "consumes-durable-admitted",
	"lib/db/commitGuard.ts": "consumes-durable-admitted",
	"lib/db/persistedJson.ts": "consumes-durable-admitted",
	"lib/db/runtimeDatabaseProbe.ts": "admits-proposal",
	"lib/doc/commitVerdicts.ts": "admits-proposal",
	"lib/doc/diffDocsToMutations.ts": "admits-proposal",
	"lib/doc/mutationAdmission.ts": "admits-proposal",
	"lib/doc/mutations/index.ts": "consumes-durable-admitted",
	"lib/doc/store.ts": "admits-proposal",
	"lib/generation/streamDispatcher.ts": "consumes-durable-admitted",
	"lib/mcp/adapters/sharedToolAdapter.ts": "admits-proposal",
	"lib/mcp/context.ts": "admits-proposal",
	"lib/organization/service.ts": "admits-proposal",
	"lib/preview/engine/casePropertyRenamePreflight.ts": "admits-proposal",
	// The finite status-filter cutover names an allowlisted system repair and
	// submits its semantic batch through appendSyntheticBatch, whose canonical
	// commit kernel re-admits the target document before writing anything.
	"scripts/lib/caseStatusFilterRepair.ts": "admits-proposal",
	// The finite XPath-carrier cutover follows the same named-system repair
	// path for the two scan-proven historical here() defaults.
	"scripts/lib/xpathCarrierCompatibilityRepair.ts": "admits-proposal",
} as const satisfies Readonly<Record<string, LifecycleMode>>;

/**
 * The named production mutation-lifecycle families this tripwire pins. Several
 * share a source file deliberately; the inventory is about ownership, not
 * file count.
 */
const MUTATION_LIFECYCLE_FAMILIES = [
	["app creation seeds/templates", ["lib/db/apps.ts"]],
	[
		"builder dispatch and queued persistence",
		["lib/doc/hooks/useBlueprintMutations.ts"],
	],
	[
		"undo/redo and inverse generation",
		["lib/doc/store.ts", "lib/routing/builderActions.ts"],
	],
	["Connect direct session action", ["lib/session/store.ts"]],
	[
		"single and staged SA planning",
		["lib/agent/tools/common.ts", "lib/agent/generationContext.ts"],
	],
	[
		"single and staged MCP planning",
		["lib/agent/tools/common.ts", "lib/mcp/context.ts"],
	],
	["whole-document diff", ["lib/doc/diffDocsToMutations.ts"]],
	[
		"frozen repair and synthetic writers",
		[
			"scripts/repair-canonical-identity-foundation.ts",
			"scripts/lib/caseStatusFilterRepair.ts",
			"scripts/lib/xpathCarrierCompatibilityRepair.ts",
			"lib/db/apps.ts",
		],
	],
	["Project-move media remap", ["lib/db/apps.ts"]],
	["autosave route", ["app/api/apps/[id]/route.ts"]],
	["case-store saga preflight", ["lib/db/applyBlueprintChange.ts"]],
	["authoritative transaction retry", ["lib/db/apps.ts"]],
	[
		"transient chat data-mutations",
		["lib/agent/generationContext.ts", "lib/generation/streamDispatcher.ts"],
	],
	[
		"chat and MCP events plus delayed flush",
		["lib/agent/generationContext.ts", "lib/mcp/context.ts"],
	],
	["accepted mutation rows", ["lib/db/apps.ts"]],
	["durable stream route", ["app/api/apps/[id]/stream/route.ts"]],
	[
		"client frame parse and reconciliation",
		["lib/collab/mutationFrame.ts", "lib/collab/reconciler.ts"],
	],
	[
		"baseline scanner and suffix replay",
		[
			"lib/db/canonicalMutationFold.ts",
			"lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenScanner.ts",
		],
	],
	["authoritative reload", ["lib/collab/ReconcilerProvider.tsx"]],
	["post-reload replay", ["lib/collab/reconciler.ts"]],
] as const;

const LIFECYCLE_NAMES = new Set([
	"applyMutations",
	"prepareMutationCandidate",
	"admitMutationBatch",
	"admitMutationStages",
	"commitGuardedBatch",
	"applyBlueprintChange",
	"appendSyntheticBatch",
	"recordMutations",
	"recordMutationStages",
]);

/**
 * The MCP adapter intentionally never calls a mutation writer: shared tool
 * bodies have already persisted their admitted value before the adapter
 * projects the result. It still owns the external proposal envelope that
 * delegates into those admitting tool bodies, so keep that non-call site in
 * the same closed source inventory explicitly rather than teaching the AST
 * walk to treat prose as executable code.
 */
const DOCUMENTED_ENVELOPE_SOURCES = new Set([
	"lib/mcp/adapters/sharedToolAdapter.ts",
]);

function productionSources(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const absolute = path.join(directory, entry);
		const relative = path
			.relative(process.cwd(), absolute)
			.replaceAll("\\", "/");
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			if (entry === "__tests__") continue;
			found.push(...productionSources(absolute));
			continue;
		}
		if (
			(relative.endsWith(".ts") || relative.endsWith(".tsx")) &&
			!relative.includes(".test.")
		) {
			found.push(relative);
		}
	}
	return found;
}

function allTypeScriptSources(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const absolute = path.join(directory, entry);
		const relative = path
			.relative(process.cwd(), absolute)
			.replaceAll("\\", "/");
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			found.push(...allTypeScriptSources(absolute));
		} else if (relative.endsWith(".ts") || relative.endsWith(".tsx")) {
			found.push(relative);
		}
	}
	return found;
}

const RETIRED_CASE_PROPERTY_IDENTIFIERS = [
	["case", "_property_on"].join(""),
	["fieldCase", "PropertyOn"].join(""),
	["CaseProperty", "Mapping"].join(""),
	["readCase", "PropertyOn"].join(""),
] as const;

const FROZEN_CANONICAL_IDENTITY_SOURCES = [
	"lib/case-store/migrations/20260728000000_canonical_identity_foundation/",
	"lib/case-store/migrations/__tests__/canonicalIdentityFoundation.integration.test.ts",
	"lib/case-store/migrations/__tests__/canonicalIdentityFoundation.test.ts",
	"lib/case-store/migrations/__tests__/frozenAuditPrivilegeBoundary.test.ts",
	"lib/case-store/migrations/__tests__/frozenOccurrenceDispatcher.test.ts",
] as const;

function isFrozenCanonicalIdentitySource(relative: string): boolean {
	return FROZEN_CANONICAL_IDENTITY_SOURCES.some((allowed) =>
		allowed.endsWith("/") ? relative.startsWith(allowed) : relative === allowed,
	);
}

let compilerApi: API | undefined;
let compilerSnapshot: Snapshot | undefined;
let compilerProgram: Program | undefined;

beforeAll(() => {
	compilerApi = new API({ cwd: process.cwd() });
	compilerSnapshot = compilerApi.updateSnapshot({
		openProjects: [path.join(process.cwd(), "tsconfig.json")],
	});
	const project = compilerSnapshot
		.getProjects()
		.find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"));
	if (project === undefined) {
		throw new Error("Mutation source tripwire could not load tsconfig.json.");
	}
	compilerProgram = project.program;
});

afterAll(() => {
	compilerSnapshot?.dispose();
	compilerSnapshot = undefined;
	compilerProgram = undefined;
	compilerApi?.close();
	compilerApi = undefined;
});

function projectSourceFile(relative: string): SourceFile {
	if (compilerProgram === undefined) {
		throw new Error("Mutation source tripwire compiler is not initialized.");
	}
	const source =
		compilerProgram.getSourceFile(relative) ??
		compilerProgram.getSourceFile(path.join(process.cwd(), relative));
	if (source !== undefined) {
		expect(compilerProgram.getSyntacticDiagnostics(relative), relative).toEqual(
			[],
		);
		return source;
	}
	/* A route under a dot-directory — `app/.well-known/...` — is outside every
	 * tsconfig wildcard, because TypeScript's globs never descend into a path
	 * segment beginning with a dot. It reaches the program only through
	 * `.next/types`, which exists after a build and not on a clean checkout. The
	 * walk that found this file on disk is the authority on what production
	 * source is; parse it directly rather than letting the guard's coverage
	 * depend on whether someone happened to build first. */
	return syntheticSourceFile(
		relative,
		readFileSync(path.join(process.cwd(), relative), "utf8"),
	);
}

function syntheticSourceFile(relative: string, sourceText: string): SourceFile {
	const absolute = path.join(process.cwd(), relative);
	const api = new API({
		cwd: process.cwd(),
		fs: createVirtualFileSystem({ [absolute]: sourceText }),
	});
	const snapshot = api.updateSnapshot({ openFiles: [absolute] });
	try {
		const project = snapshot.getDefaultProjectForFile(absolute);
		if (project === undefined) {
			throw new Error(`Mutation source tripwire could not load ${relative}.`);
		}
		const source = project.program.getSourceFile(absolute);
		if (source === undefined) {
			throw new Error(`Mutation source tripwire could not parse ${relative}.`);
		}
		expect(project.program.getSyntacticDiagnostics(absolute), relative).toEqual(
			[],
		);
		return source;
	} finally {
		snapshot.dispose();
		api.close();
	}
}

function propertyName(property: PropertyAssignment): string | undefined {
	const { name } = property;
	if (isIdentifier(name) || isStringLiteral(name)) return name.text;
	return undefined;
}

function unwrapExpression(expression: Expression): Expression {
	let current = expression;
	while (
		isParenthesizedExpression(current) ||
		isAsExpression(current) ||
		isSatisfiesExpression(current) ||
		isTypeAssertion(current) ||
		isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function literalValue(
	property: PropertyAssignment | undefined,
): string | boolean | undefined {
	if (property === undefined) return undefined;
	const value = unwrapExpression(property.initializer);
	if (isStringLiteral(value)) return value.text;
	if (isTrueLiteral(value)) return true;
	if (isFalseLiteral(value)) return false;
	return undefined;
}

function isProtectedMutationResult(property: PropertyAssignment): boolean {
	const value = unwrapExpression(property.initializer);
	if (isArrayLiteralExpression(value)) return value.elements.length === 0;
	if (isPropertyAccessExpression(value)) {
		return value.name.text === "mutations" || value.name.text === "batch";
	}
	const callee = isCallExpression(value)
		? unwrapExpression(value.expression)
		: undefined;
	return (
		callee !== undefined &&
		isIdentifier(callee) &&
		callee.text === "admitMutationBatch"
	);
}

function visitNode(node: Node, visit: (node: Node) => void): void {
	visit(node);
	node.forEachChild((child) => visitNode(child, visit));
}

function unprotectedToolResultLocationsInSource(
	relative: string,
	sourceText: string,
): string[] {
	return unprotectedToolResultLocationsInAst(
		relative,
		syntheticSourceFile(relative, sourceText),
	);
}

function unprotectedToolResultLocationsInAst(
	relative: string,
	source: SourceFile,
): string[] {
	const failures: string[] = [];
	visitNode(source, (node) => {
		if (isReturnStatement(node) && node.expression !== undefined) {
			const expression = unwrapExpression(node.expression);
			if (isObjectLiteralExpression(expression)) {
				const properties = expression.properties.filter(
					(property): property is PropertyAssignment =>
						isPropertyAssignment(property),
				);
				const mutationProperty = properties.find(
					(property) => propertyName(property) === "mutations",
				);
				const kind = literalValue(
					properties.find((property) => propertyName(property) === "kind"),
				);
				const ok = literalValue(
					properties.find((property) => propertyName(property) === "ok"),
				);
				if (
					mutationProperty !== undefined &&
					(kind === "mutate" || ok === true) &&
					!isProtectedMutationResult(mutationProperty)
				) {
					const line =
						source.getLineAndCharacterOfPosition(
							mutationProperty.getStart(source),
						).line + 1;
					failures.push(`${relative}:${line}`);
				}
			}
		}
	});
	return failures;
}

function unprotectedToolResultLocations(relative: string): string[] {
	return unprotectedToolResultLocationsInAst(
		relative,
		projectSourceFile(relative),
	);
}

function lifecycleName(node: Node): string | undefined {
	if (isCallExpression(node)) {
		const expression = unwrapExpression(node.expression);
		if (isIdentifier(expression)) return expression.text;
		if (isPropertyAccessExpression(expression)) return expression.name.text;
	}
	if (
		(isFunctionDeclaration(node) ||
			isMethodDeclaration(node) ||
			isMethodSignatureDeclaration(node) ||
			isFunctionExpression(node)) &&
		node.name !== undefined &&
		isIdentifier(node.name)
	) {
		return node.name.text;
	}
	return undefined;
}

function namesLifecycleEntrypoint(relative: string): boolean {
	let found = false;
	visitNode(projectSourceFile(relative), (node) => {
		if (found) return;
		const name = lifecycleName(node);
		if (name !== undefined && LIFECYCLE_NAMES.has(name)) found = true;
	});
	return found;
}

function registeredSharedToolSources(): string[] {
	const relative = "lib/agent/sharedToolRegistry.ts";
	const prefix = "@/lib/agent/tools/";
	return projectSourceFile(relative)
		.statements.filter(isImportDeclaration)
		.map((declaration) => declaration.moduleSpecifier)
		.filter(isStringLiteral)
		.map((specifier) => specifier.text)
		.filter((specifier) => specifier.startsWith(prefix))
		.map((specifier) => `lib/agent/tools/${specifier.slice(prefix.length)}.ts`)
		.toSorted();
}

describe("mutation lifecycle source tripwire", () => {
	it("classifies every production admission/reducer/writer source", () => {
		const roots = ["app", "components", "lib", "scripts"];
		const discovered = [
			...roots
				.flatMap((root) => productionSources(path.join(process.cwd(), root)))
				.filter(namesLifecycleEntrypoint),
			...DOCUMENTED_ENVELOPE_SOURCES,
		].toSorted();
		expect(discovered).toEqual(Object.keys(SOURCE_CLASSIFICATION).toSorted());
		for (const relative of DOCUMENTED_ENVELOPE_SOURCES) {
			expect(
				statSync(path.join(process.cwd(), relative)).isFile(),
				relative,
			).toBe(true);
		}
	});

	it("keeps every binding lifecycle family attached to real sources", () => {
		expect(MUTATION_LIFECYCLE_FAMILIES.map(([family]) => family)).toEqual([
			"app creation seeds/templates",
			"builder dispatch and queued persistence",
			"undo/redo and inverse generation",
			"Connect direct session action",
			"single and staged SA planning",
			"single and staged MCP planning",
			"whole-document diff",
			"frozen repair and synthetic writers",
			"Project-move media remap",
			"autosave route",
			"case-store saga preflight",
			"authoritative transaction retry",
			"transient chat data-mutations",
			"chat and MCP events plus delayed flush",
			"accepted mutation rows",
			"durable stream route",
			"client frame parse and reconciliation",
			"baseline scanner and suffix replay",
			"authoritative reload",
			"post-reload replay",
		]);
		for (const [, sources] of MUTATION_LIFECYCLE_FAMILIES) {
			for (const source of sources) {
				expect(
					statSync(path.join(process.cwd(), source)).isFile(),
					source,
				).toBe(true);
			}
		}
	});

	it("forbids retired case-property identifiers in every TypeScript source and fixture outside the frozen migration oracle", () => {
		const roots = ["__tests__", "app", "components", "e2e", "lib", "scripts"];
		const failures = roots
			.flatMap((root) => allTypeScriptSources(path.join(process.cwd(), root)))
			.filter((relative) => !isFrozenCanonicalIdentitySource(relative))
			.flatMap((relative) => {
				const source = readFileSync(path.join(process.cwd(), relative), "utf8");
				return RETIRED_CASE_PROPERTY_IDENTIFIERS.flatMap((identifier) =>
					source.includes(identifier) ? [`${relative}: ${identifier}`] : [],
				);
			});
		expect(failures).toEqual([]);
	});

	it("keeps the frozen canonical identity authority out of steady-state runtime imports", () => {
		const allowedImporters = new Set([
			// These three are explicit operator/deployment entrypoints for this
			// exact timestamped cutover, never steady-state application readers.
			"scripts/audit-canonical-identity-foundation.ts",
			"scripts/repair-canonical-identity-foundation.ts",
			"scripts/scan-canonical-identity-foundation.ts",
			// The Kysely migration entrypoint is the directory's one public door;
			// reaching through it is the whole point of the quarantine.
			"lib/case-store/migrations/20260728000000_canonical_identity_foundation.ts",
		]);
		// Tests OF the frozen authority necessarily import it. They are not
		// steady-state readers, and naming each one would make this list churn
		// with every fixture added behind the door.
		const allowedImporterPrefix = "lib/case-store/migrations/__tests__/";
		// The quarantine is the DIRECTORY. The sibling
		// `…_canonical_identity_foundation.ts` is its one public door — the Kysely
		// migration entrypoint — so importing that file is allowed and importing
		// anything behind it is not.
		//
		// This has to resolve specifiers rather than match text against them. A
		// substring test for the repo-relative directory path silently passes
		// every RELATIVE import, which is how the modules physically next to the
		// frozen tree — the ones most able to reach into it — were the ones the
		// check could never see.
		const frozenDirectory =
			"lib/case-store/migrations/20260728000000_canonical_identity_foundation/";
		const specifier =
			/(?:\bfrom\s*|^\s*(?:import|export)\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/gm;
		const failures = ["__tests__", "app", "components", "e2e", "lib", "scripts"]
			.flatMap((root) => allTypeScriptSources(path.join(process.cwd(), root)))
			.filter(
				(relative) =>
					relative !==
					"lib/doc/__tests__/mutationLifecycleSourceTripwire.test.ts",
			)
			.filter((relative) => !isFrozenCanonicalIdentitySource(relative))
			.filter((relative) => !allowedImporters.has(relative))
			.filter((relative) => !relative.startsWith(allowedImporterPrefix))
			.filter((relative) => {
				const source = readFileSync(path.join(process.cwd(), relative), "utf8");
				for (const [, raw] of source.matchAll(specifier)) {
					let resolved: string;
					if (raw.startsWith(".")) {
						resolved = path
							.normalize(path.join(path.dirname(relative), raw))
							.replaceAll("\\", "/");
					} else if (raw.startsWith("@/")) {
						resolved = raw.slice(2);
					} else {
						continue; // a bare package specifier cannot reach the tree
					}
					// `frozenDirectory` carries the trailing slash, so the entrypoint
					// file — which shares the directory's name — does not match while
					// everything nested behind it does.
					if (resolved.startsWith(frozenDirectory)) return true;
				}
				return false;
			});
		expect(failures).toEqual([]);
		expect(
			existsSync(
				path.join(process.cwd(), "lib/db/canonicalIdentityFoundationRepair.ts"),
			),
		).toBe(false);
		expect(
			existsSync(path.join(process.cwd(), "scripts/verify-sequences.ts")),
		).toBe(false);
		expect(
			readFileSync(path.join(process.cwd(), "lib/db/apps.ts"), "utf8"),
		).not.toContain("canonicalIdentityFoundationRepair");
	});

	it("returns only admitted success mutations from shared tool bodies", () => {
		expect(
			registeredSharedToolSources().flatMap((relative) =>
				unprotectedToolResultLocations(relative),
			),
		).toEqual([]);
	});

	it("detects an unprotected success mutation result in parsed source", () => {
		const unsafe = `
			function execute() {
				const planned = [{ kind: "setAppName", name: "Unsafe" }];
				return {
					kind: "mutate",
					mutations: planned,
				};
			}
		`;
		expect(
			unprotectedToolResultLocationsInSource("synthetic-tool.ts", unsafe),
		).toEqual(["synthetic-tool.ts:6"]);

		const safe = `
			function execute() {
				const planned = [{ kind: "setAppName", name: "Safe" }];
				return {
					kind: "mutate",
					mutations: admitMutationBatch(planned),
				};
			}
		`;
		expect(
			unprotectedToolResultLocationsInSource("synthetic-tool.ts", safe),
		).toEqual([]);
	});
});
