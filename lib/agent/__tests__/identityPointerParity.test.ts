/**
 * Patterned authored-identity projections across the shared local, SA, and MCP tool
 * surfaces. The local registry is schema-derived; the MCP side is read through
 * a real SDK client from tools/list, not reconstructed from registration args.
 */

import { Client } from "@modelcontextprotocol/client";
/* Both halves of the linked pair come from the server package: each
 * package bundles its own `InMemoryTransport`, and `Transport` is a
 * structural interface, so the client connects to the server-package
 * half without importing a second copy. */
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import {
	AUTHORABLE_IDENTITY_POINTER_REGISTRY,
	collectIdentitySchemaPointers,
} from "@/lib/agent/identityPointerRegistry";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
	uuidSchema,
} from "@/lib/domain";
import { registerNovaTools } from "@/lib/mcp/server";
import type { ToolContext } from "@/lib/mcp/types";

vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn(),
	listAppsForOwner: vi.fn(),
}));

type JsonNode = Record<string, unknown>;

const GENERAL_UUID_REJECTIONS = [
	"01890F45-0000-7000-8000-000000000001",
	"01890f45000070008000000000000001",
	"00000000-0000-0000-0000-000000000000",
	"ffffffff-ffff-ffff-ffff-ffffffffffff",
	"01890f45-0000-0000-8000-000000000001",
	"01890f45-0000-9000-8000-000000000001",
	"01890f45-0000-7000-7000-000000000001",
	"01890f45-0000-7000-c000-000000000001",
] as const;
const CANONICAL_UUID = "01890f45-0000-7000-8000-000000000001";
const CANONICAL_UUID_V4 = "01890f45-0000-4000-8000-000000000001";

let mcpSchemas = new Map<string, JsonNode>();

beforeAll(async () => {
	const server = new McpServer({
		name: "nova-identity-test",
		version: "0.0.0",
	});
	const context: ToolContext = {
		userId: "identity-test-user",
		scopes: [],
		authKind: "oauth",
	};
	registerNovaTools(server, context);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "identity-test-client", version: "0.0.0" });
	try {
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		const tools = (await client.listTools()).tools;
		mcpSchemas = new Map(
			tools.map((tool) => [tool.name, tool.inputSchema as JsonNode]),
		);
	} finally {
		await Promise.all([client.close(), server.close()]);
	}
});

describe("shared-tool authored identity registry", () => {
	it("has duplicate-free classified pointers for module ownership and confirmation", () => {
		const exactPointers = AUTHORABLE_IDENTITY_POINTER_REGISTRY.map(
			(pointer) => `${pointer.tool}:${pointer.schemaPointer}`,
		);
		expect(new Set(exactPointers).size).toBe(exactPointers.length);
		for (const tool of ["create_module", "move_module"]) {
			expect(
				AUTHORABLE_IDENTITY_POINTER_REGISTRY.find(
					(pointer) =>
						pointer.tool === tool && pointer.property === "parentModuleUuid",
				),
			).toMatchObject({ family: "module" });
		}
		expect(
			AUTHORABLE_IDENTITY_POINTER_REGISTRY.find(
				(pointer) =>
					pointer.tool === "configure_case_selection" &&
					pointer.logicalPointer === "/confirmedModuleUuids/*",
			),
		).toMatchObject({
			property: "confirmedModuleUuids",
			family: "module",
		});
	});

	it("rejects malformed/case/version/variant/nil/max examples in the domain schemas", () => {
		for (const invalid of GENERAL_UUID_REJECTIONS) {
			expect(uuidSchema.safeParse(invalid).success, invalid).toBe(false);
		}
		expect(uuidSchema.safeParse(CANONICAL_UUID_V4).success).toBe(true);
		expect(uuidSchema.safeParse(CANONICAL_UUID).success).toBe(true);

		for (const schema of [
			lookupTableIdSchema,
			lookupColumnIdSchema,
			lookupRowIdSchema,
		]) {
			for (const invalid of [...GENERAL_UUID_REJECTIONS, CANONICAL_UUID_V4]) {
				expect(schema.safeParse(invalid).success, invalid).toBe(false);
			}
			expect(schema.safeParse(CANONICAL_UUID).success).toBe(true);
		}
	});

	it("publishes the same authored grammar through SA and actual MCP tools/list", () => {
		for (const { saName, mcpName, tool } of SHARED_TOOL_REGISTRY) {
			const expected = authoringToolSchema(saName, tool.inputSchema).json;
			const listed = mcpSchemas.get(mcpName);
			expect(listed, mcpName).toBeDefined();
			if (!listed) throw new Error(`Missing ${mcpName}`);
			const actual = structuredClone(listed);
			const properties = actual.properties as Record<string, unknown>;
			delete properties.app_id;
			actual.required = (actual.required as string[]).filter(
				(name) => name !== "app_id",
			);
			if (!("required" in expected)) delete actual.required;
			expect(actual, mcpName).toEqual(expected);
		}
	});

	it("collects nested and array identities and refuses an unclassified canonical identity", () => {
		const json = z.toJSONSchema(
			z.object({
				confirmedModuleUuids: z.array(uuidSchema),
				target: z.object({ formUuid: uuidSchema }),
				columnId: lookupColumnIdSchema,
			}),
		);
		expect(
			collectIdentitySchemaPointers("probe", json).map((pointer) => ({
				path: pointer.logicalPointer,
				family: pointer.family,
			})),
		).toEqual([
			{ path: "/confirmedModuleUuids/*", family: "module" },
			{ path: "/target/formUuid", family: "form" },
			{ path: "/columnId", family: "lookup-column" },
		]);
		expect(() =>
			collectIdentitySchemaPointers(
				"probe",
				z.toJSONSchema(
					z.object({
						unknownIdentity: uuidSchema,
					}),
				),
			),
		).toThrow("Unclassified authored identity");
	});
});
