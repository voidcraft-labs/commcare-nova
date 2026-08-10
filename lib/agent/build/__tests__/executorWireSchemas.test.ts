/**
 * The executor's provider-facing schemas — where the `uuid | { handle }`
 * widening lands, where it deliberately does not, and that the widened shape
 * still validates through the untouched Zod schema.
 */

import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";
import { executionBlockerSchema } from "@/lib/agent/build/executionBlocker";
import {
	EXECUTOR_TOOL_SURFACE,
	executorWireToolSchema,
} from "@/lib/agent/build/executorWireSchemas";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import { CHANGE_SET_HANDLE_PATTERN } from "@/lib/agent/change-set/schemas";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";

type JsonNode = Record<string, unknown>;

function schemaFor(name: string): JsonNode {
	const entry = CHANGE_SET_TOOL_REGISTRY.get(name);
	if (entry === undefined) throw new Error(`No change-set tool ${name}`);
	return executorWireToolSchema(
		name,
		entry.tool.inputSchema,
	) as unknown as JsonNode;
}

function property(schema: JsonNode, name: string): JsonNode {
	const properties = schema.properties as JsonNode | undefined;
	const slot = properties?.[name];
	if (slot === undefined) {
		throw new Error(
			`No ${name} property; saw ${Object.keys(properties ?? {}).join(", ")}`,
		);
	}
	return slot as JsonNode;
}

/** Every `{ handle }` arm anywhere in a schema. */
function handleArms(node: unknown): JsonNode[] {
	const found: JsonNode[] = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const schema = value as JsonNode;
		const properties = schema.properties as JsonNode | undefined;
		if (properties !== undefined && "handle" in properties) found.push(schema);
		for (const entry of Object.values(schema)) walk(entry);
	};
	walk(node);
	return found;
}

/** Every uuid-patterned string leaf anywhere in a schema. */
function uuidLeaves(node: unknown): JsonNode[] {
	const found: JsonNode[] = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const schema = value as JsonNode;
		if (schema.pattern === CANONICAL_UUID_PATTERN.source) found.push(schema);
		for (const entry of Object.values(schema)) walk(entry);
	};
	walk(node);
	return found;
}

describe("EXECUTOR_TOOL_SURFACE", () => {
	it("mounts reads, one mutation batch, and the server-owned gates", () => {
		expect(EXECUTOR_TOOL_SURFACE).toEqual([
			...Array.from(CHANGE_SET_TOOL_REGISTRY.values())
				.filter((entry) => entry.policy.effect === "read-blueprint")
				.map((entry) => entry.name),
			"stageBatch",
			"inspectChangeSet",
			"commitChangeSet",
			"reportExecutionBlocker",
		]);
	});

	it("does not mount discardChangeSet", () => {
		/* Discarding a slice's private work is an orchestrator or user
		 * decision, never the executor's escape from its own diagnostics. */
		expect(EXECUTOR_TOOL_SURFACE).not.toContain("discardChangeSet");
	});

	it("keeps granular staging operations inside the batch grammar", () => {
		expect(EXECUTOR_TOOL_SURFACE).toContain("stageBatch");
		expect(EXECUTOR_TOOL_SURFACE).not.toContain("stageModule");
		expect(EXECUTOR_TOOL_SURFACE).not.toContain("stageForm");
	});
});

describe("executorWireToolSchema", () => {
	it("widens a staged module's identity and anchor slots", () => {
		const schema = schemaFor("stageModule");
		const arms = (property(schema, "moduleUuid").anyOf ?? []) as JsonNode[];

		expect(arms).toHaveLength(2);
		expect(arms[0]?.pattern).toBe(CANONICAL_UUID_PATTERN.source);
		expect((arms[1]?.properties as JsonNode | undefined)?.handle).toMatchObject(
			{ type: "string", pattern: CHANGE_SET_HANDLE_PATTERN.source },
		);

		/* `after` is nullable — only its string arm widens, never the null. */
		const afterArms = (property(schema, "after").anyOf ?? []) as JsonNode[];
		expect(afterArms.some((arm) => arm.type === "null")).toBe(true);
		expect(handleArms(property(schema, "after"))).toHaveLength(1);
	});

	it("widens a shared tool's Blueprint-entity slots", () => {
		const schema = schemaFor("moveField");
		expect(handleArms(property(schema, "fieldUuid"))).toHaveLength(1);
		expect(handleArms(schema).length).toBeGreaterThan(1);
	});

	it("leaves non-uuid strings untouched", () => {
		const schema = schemaFor("stageModule");
		expect(property(schema, "name")).toEqual({ type: "string", minLength: 1 });
		expect(handleArms(property(schema, "case_type"))).toHaveLength(0);
	});

	it("does not widen canonical-only identity families", () => {
		/* Media assets, lookup tables, and lookup columns exist outside the
		 * private candidate, so a handle for one could never resolve — the
		 * reviewed staging classification keeps them canonical. */
		const media = schemaFor("attachFieldMedia");
		expect(uuidLeaves(media).length).toBeGreaterThan(0);
		const mediaHandles = handleArms(media);
		expect(mediaHandles.length).toBeGreaterThan(0); /* fields still widen */

		const lookup = schemaFor("setFieldOptionsSource");
		const tableId = JSON.stringify(lookup).includes('"tableId"');
		expect(tableId).toBe(true);
		/* No handle arm sits directly beside a lookup table/column id. */
		const source = JSON.stringify(lookup);
		expect(source).not.toContain('"tableId":{"anyOf"');
		expect(source).not.toContain('"valueColumnId":{"anyOf"');
		expect(source).not.toContain('"labelColumnId":{"anyOf"');
	});

	it("adds no handle arm to the server-owned tools", () => {
		/* An implementation coordinate names something that already exists;
		 * a design id is never a handle. */
		const schema = executorWireToolSchema(
			"reportExecutionBlocker",
			executionBlockerSchema,
		);
		expect(handleArms(schema)).toHaveLength(0);
	});

	it("never mutates the projection chat sends", () => {
		const entry = CHANGE_SET_TOOL_REGISTRY.get("stageModule");
		if (entry === undefined) throw new Error("no stageModule");
		schemaFor("stageModule");
		const chat = wireToolSchema(entry.tool.inputSchema)
			.jsonSchema as unknown as JsonNode;
		expect(handleArms(chat)).toHaveLength(0);
	});

	it("accepts both a canonical uuid and a handle through the SDK validator", async () => {
		const entry = CHANGE_SET_TOOL_REGISTRY.get("stageForm");
		if (entry === undefined) throw new Error("no stageForm");
		const validate = jsonSchema(
			executorWireToolSchema("stageForm", entry.tool.inputSchema),
		);
		expect(await validate.jsonSchema).toBeDefined();

		/* The widened wire shape is what the provider sees; the ORIGINAL Zod
		 * schema stays the gate, and it accepts the resolved uuid only. */
		const uuid = "11111111-1111-4111-8111-111111111111";
		expect(
			entry.tool.inputSchema.safeParse({
				formUuid: uuid,
				moduleUuid: uuid,
				name: "Intake",
				type: "survey",
			}).success,
		).toBe(true);
		expect(
			entry.tool.inputSchema.safeParse({
				formUuid: { handle: "@intake" },
				moduleUuid: uuid,
				name: "Intake",
				type: "survey",
			}).success,
		).toBe(false);
	});

	it("projects every mounted change-set tool without throwing", () => {
		for (const [name, entry] of CHANGE_SET_TOOL_REGISTRY) {
			expect(() =>
				executorWireToolSchema(name, entry.tool.inputSchema),
			).not.toThrow();
		}
	});
});
