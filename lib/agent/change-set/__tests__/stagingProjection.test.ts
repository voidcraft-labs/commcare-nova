/** Cross-schema architecture: identity pointers must have a projection decision,
 * eligible families must map to the persisted binding vocabulary, and the
 * structural handle spelling must not collide with canonical tool properties.
 * Actual provider payload admission is covered by executorWireSchemas.test.ts;
 * persisted resolution is covered by changeSetRuntime.postgres.test.ts. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type StagedEntityKind,
	stagedEntityKindSchema,
} from "@/lib/agent/change-set/schemas";
import {
	HANDLE_ENTITY_KIND_BY_FAMILY,
	STAGING_PROJECTION_DECISIONS,
} from "@/lib/agent/change-set/stagingProjection";
import { AUTHORABLE_IDENTITY_POINTER_REGISTRY } from "@/lib/agent/identityPointerRegistry";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";

function walkJson(
	node: unknown,
	visit: (object: Record<string, unknown>) => void,
): void {
	if (Array.isArray(node)) {
		for (const entry of node) walkJson(entry, visit);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	visit(record);
	for (const value of Object.values(record)) walkJson(value, visit);
}

describe("STAGING_PROJECTION_DECISIONS", () => {
	it("classifies every identity pointer a stageable shared tool exposes", () => {
		const stageableTools = new Set<string>(
			SHARED_TOOL_REGISTRY.filter(
				(entry) => entry.policy.staging !== "forbidden",
			).map((entry) => entry.mcpName),
		);
		const pointers = AUTHORABLE_IDENTITY_POINTER_REGISTRY.filter((pointer) =>
			stageableTools.has(pointer.tool),
		);
		/* A vacuous pass would hide a broken registry derivation. */
		expect(pointers.some((pointer) => pointer.tool === "create_module")).toBe(
			true,
		);

		const unclassified = pointers
			.filter(
				(pointer) => STAGING_PROJECTION_DECISIONS[pointer.family] === undefined,
			)
			.map((pointer) => `${pointer.tool}${pointer.schemaPointer}`);
		expect(unclassified).toEqual([]);
	});

	it("keeps every external identity canonical", () => {
		for (const family of [
			"location",
			"media-asset",
			"lookup-table",
			"lookup-column",
			"lookup-row",
		] as const) {
			expect(STAGING_PROJECTION_DECISIONS[family]).toBe("canonical-only");
		}
	});
});

describe("HANDLE_ENTITY_KIND_BY_FAMILY", () => {
	const eligible = Object.entries(STAGING_PROJECTION_DECISIONS)
		.filter(([, decision]) => decision === "handle-eligible")
		.map(([family]) => family)
		.sort();

	it("names an entity kind for exactly the handle-eligible families", () => {
		expect(Object.keys(HANDLE_ENTITY_KIND_BY_FAMILY).sort()).toEqual(eligible);
		for (const kind of Object.values(HANDLE_ENTITY_KIND_BY_FAMILY)) {
			expect(kind).toBeDefined();
		}
	});

	it("covers the whole durable staged-entity-kind vocabulary, one kind per family", () => {
		const kinds = Object.values(HANDLE_ENTITY_KIND_BY_FAMILY).filter(
			(kind): kind is StagedEntityKind => kind !== undefined,
		);
		expect([...kinds].sort()).toEqual(
			[...stagedEntityKindSchema.options].sort(),
		);
	});
});

describe("structural handle references are collision-free", () => {
	it("no canonical tool input schema owns a property named `handle`", () => {
		const offenders: string[] = [];
		for (const entry of SHARED_TOOL_REGISTRY) {
			const json = z.toJSONSchema(entry.tool.inputSchema, {
				target: "draft-7",
				io: "input",
			});
			walkJson(json, (node) => {
				const properties = node.properties;
				if (
					properties === null ||
					typeof properties !== "object" ||
					Array.isArray(properties)
				) {
					return;
				}
				if (Object.hasOwn(properties, "handle")) offenders.push(entry.mcpName);
			});
		}
		expect(offenders).toEqual([]);
	});
});
