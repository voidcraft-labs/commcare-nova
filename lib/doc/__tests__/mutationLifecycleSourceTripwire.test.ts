import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Expression,
	type Node,
	type ObjectProperty,
	parseSync,
	visitorKeys,
} from "oxc-parser";
import { describe, expect, it } from "vitest";

type LifecycleMode = "admits-proposal" | "consumes-durable-admitted";

/**
 * Every production source that names a mutation admission/reduction/write
 * chokepoint. The generated scan below fails when a new source appears without
 * an explicit decision about which side of the boundary it owns.
 */
const SOURCE_CLASSIFICATION = {
	"app/api/apps/[id]/route.ts": "admits-proposal",
	"lib/agent/generationContext.ts": "admits-proposal",
	"lib/agent/toolExecutionContext.ts": "admits-proposal",
	"lib/agent/tools/common.ts": "admits-proposal",
	"lib/collab/mutationFrame.ts": "consumes-durable-admitted",
	"lib/collab/reconciler.ts": "consumes-durable-admitted",
	"lib/db/applyBlueprintChange.ts": "consumes-durable-admitted",
	"lib/db/apps.ts": "admits-proposal",
	"lib/db/canonicalMutationFold.ts": "consumes-durable-admitted",
	"lib/db/commitGuard.ts": "consumes-durable-admitted",
	"lib/db/runtimeDatabaseProbe.ts": "admits-proposal",
	"lib/doc/commitVerdicts.ts": "admits-proposal",
	"lib/doc/diffDocsToMutations.ts": "admits-proposal",
	"lib/doc/mutationAdmission.ts": "admits-proposal",
	"lib/doc/mutations/index.ts": "consumes-durable-admitted",
	"lib/doc/store.ts": "admits-proposal",
	"lib/generation/streamDispatcher.ts": "consumes-durable-admitted",
	"lib/mcp/adapters/sharedToolAdapter.ts": "admits-proposal",
	"lib/mcp/context.ts": "admits-proposal",
	"scripts/repair-legacy-findings.ts": "admits-proposal",
} as const satisfies Readonly<Record<string, LifecycleMode>>;

/**
 * Named lifecycle families from the binding Unit 18 contract. Several share a
 * source file deliberately; the inventory is about ownership, not file count.
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
		"repair and synthetic writers",
		["scripts/repair-legacy-findings.ts", "lib/db/apps.ts"],
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
			"scripts/scan-canonical-identity-foundation.ts",
		],
	],
	["authoritative reload", ["lib/collab/ReconcilerProvider.tsx"]],
	["post-reload replay", ["lib/collab/reconciler.ts"]],
] as const;

const LIFECYCLE_TOKEN =
	/\b(?:applyMutations|prepareMutationCandidate|admitMutationBatch|admitMutationStages|commitGuardedBatch|applyBlueprintChange|appendSyntheticBatch|recordMutations|recordMutationStages)\s*\(/u;

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

function propertyName(property: ObjectProperty): string | undefined {
	if (property.computed) return undefined;
	if (property.key.type === "Identifier") return property.key.name;
	if (
		property.key.type === "Literal" &&
		typeof property.key.value === "string"
	) {
		return property.key.value;
	}
	return undefined;
}

function unwrapExpression(expression: Expression): Expression {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current;
}

function literalValue(
	property: ObjectProperty | undefined,
): string | boolean | undefined {
	if (property === undefined) return undefined;
	const value = unwrapExpression(property.value);
	return value.type === "Literal" &&
		(typeof value.value === "string" || typeof value.value === "boolean")
		? value.value
		: undefined;
}

function isProtectedMutationResult(property: ObjectProperty): boolean {
	const value = unwrapExpression(property.value);
	if (value.type === "ArrayExpression") return value.elements.length === 0;
	if (
		value.type === "MemberExpression" &&
		!value.computed &&
		value.property.type === "Identifier"
	) {
		return (
			value.property.name === "mutations" || value.property.name === "batch"
		);
	}
	const callee =
		value.type === "CallExpression" ? unwrapExpression(value.callee) : null;
	return callee?.type === "Identifier" && callee.name === "admitMutationBatch";
}

function isNode(value: unknown): value is Node {
	return (
		value !== null &&
		typeof value === "object" &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function visitNode(node: Node, visit: (node: Node) => void): void {
	visit(node);
	const record = node as unknown as Readonly<Record<string, unknown>>;
	for (const key of visitorKeys[node.type] ?? []) {
		const child = record[key];
		if (Array.isArray(child)) {
			for (const entry of child) {
				if (isNode(entry)) visitNode(entry, visit);
			}
		} else if (isNode(child)) {
			visitNode(child, visit);
		}
	}
}

function unprotectedToolResultLocations(relative: string): string[] {
	const sourceText = readFileSync(path.join(process.cwd(), relative), "utf8");
	const parsed = parseSync(relative, sourceText, {
		lang: relative.endsWith(".tsx") ? "tsx" : "ts",
		astType: "ts",
		preserveParens: true,
	});
	expect(parsed.errors, relative).toEqual([]);
	const failures: string[] = [];
	visitNode(parsed.program, (node) => {
		if (node.type === "ReturnStatement" && node.argument !== null) {
			const expression = unwrapExpression(node.argument);
			if (expression.type === "ObjectExpression") {
				const properties = expression.properties.filter(
					(property): property is ObjectProperty =>
						property.type === "Property" && property.kind === "init",
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
					const line = sourceText
						.slice(0, mutationProperty.start)
						.split("\n").length;
					failures.push(`${relative}:${line}`);
				}
			}
		}
	});
	return failures;
}

function registeredSharedToolSources(): string[] {
	const registry = readFileSync(
		path.join(process.cwd(), "lib/agent/sharedToolRegistry.ts"),
		"utf8",
	);
	return [
		...registry.matchAll(/from\s+["']@\/lib\/agent\/tools\/([^"']+)["']/gu),
	]
		.map((match) => `lib/agent/tools/${match[1]}.ts`)
		.toSorted();
}

describe("mutation lifecycle source tripwire", () => {
	it("classifies every production admission/reducer/writer source", () => {
		const roots = ["app", "components", "lib", "scripts"];
		const discovered = roots
			.flatMap((root) => productionSources(path.join(process.cwd(), root)))
			.filter((relative) =>
				LIFECYCLE_TOKEN.test(
					readFileSync(path.join(process.cwd(), relative), "utf8"),
				),
			)
			.toSorted();
		expect(discovered).toEqual(Object.keys(SOURCE_CLASSIFICATION).toSorted());
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
			"repair and synthetic writers",
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

	it("returns only admitted success mutations from shared tool bodies", () => {
		expect(
			registeredSharedToolSources().flatMap((relative) =>
				unprotectedToolResultLocations(relative),
			),
		).toEqual([]);
	});
});
