/**
 * Complete authored-identity parity across the shared local, SA, and MCP tool
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
import {
	AUTHORABLE_IDENTITY_POINTER_REGISTRY,
	type AuthorableIdentityPointer,
	buildAuthorableIdentityPointerRegistry,
	collectIdentitySchemaPointers,
} from "@/lib/agent/identityPointerRegistry";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import {
	CANONICAL_UUID_PATTERN,
	LOOKUP_UUID_V7_PATTERN,
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
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	const tools = (await client.listTools()).tools;
	mcpSchemas = new Map(
		tools.map((tool) => [tool.name, tool.inputSchema as JsonNode]),
	);
	await client.close();
	await server.close();
});

function signature(pointer: AuthorableIdentityPointer): string {
	return [pointer.logicalPointer, pointer.family, pointer.pattern].join("|");
}

function signatures(
	pointers: readonly AuthorableIdentityPointer[],
): readonly string[] {
	return [...new Set(pointers.map(signature))].sort();
}

function assertRejectionMatrix(
	pointers: readonly AuthorableIdentityPointer[],
): void {
	for (const pointer of pointers) {
		const matcher = new RegExp(pointer.pattern);
		for (const invalid of GENERAL_UUID_REJECTIONS) {
			expect(
				matcher.test(invalid),
				`${pointer.tool} ${pointer.schemaPointer} accepted ${invalid}`,
			).toBe(false);
		}
		if (pointer.pattern === LOOKUP_UUID_V7_PATTERN.source) {
			expect(
				matcher.test(CANONICAL_UUID_V4),
				`${pointer.tool} ${pointer.schemaPointer} accepted non-v7 UUID`,
			).toBe(false);
		} else {
			expect(
				matcher.test(CANONICAL_UUID_V4),
				`${pointer.tool} ${pointer.schemaPointer} rejected canonical v4 UUID`,
			).toBe(true);
		}
		expect(
			matcher.test(CANONICAL_UUID),
			`${pointer.tool} ${pointer.schemaPointer} rejected canonical v7 UUID`,
		).toBe(true);
	}
}

describe("shared-tool authored identity registry", () => {
	it("is complete, deterministic, classified, and duplicate-free", () => {
		expect(AUTHORABLE_IDENTITY_POINTER_REGISTRY).toEqual(
			buildAuthorableIdentityPointerRegistry(),
		);
		const exactPointers = AUTHORABLE_IDENTITY_POINTER_REGISTRY.map(
			(pointer) => `${pointer.tool}:${pointer.schemaPointer}`,
		);
		expect(new Set(exactPointers).size).toBe(exactPointers.length);
		expect(AUTHORABLE_IDENTITY_POINTER_REGISTRY.length).toBeGreaterThan(400);
	});

	it("pins the complete malformed/case/version/variant/nil/max matrix in the domain schemas", () => {
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

	it("keeps every exact identity pointer and rejection matrix identical in local Zod, compact SA, and real MCP tools/list schemas", () => {
		for (const { mcpName, tool } of SHARED_TOOL_REGISTRY) {
			const local = collectIdentitySchemaPointers(
				mcpName,
				z.toJSONSchema(tool.inputSchema, {
					target: "draft-2020-12",
					io: "input",
				}) as JsonNode,
			);
			const sa = collectIdentitySchemaPointers(
				mcpName,
				wireToolSchema(tool.inputSchema as z.ZodType).jsonSchema as JsonNode,
			);
			const mcpJson = mcpSchemas.get(mcpName);
			expect(mcpJson, `${mcpName} missing from tools/list`).toBeDefined();
			if (mcpJson === undefined) continue;
			const mcp = collectIdentitySchemaPointers(mcpName, mcpJson);

			expect(signatures(sa), `${mcpName} SA identity drift`).toEqual(
				signatures(local),
			);
			expect(signatures(mcp), `${mcpName} MCP identity drift`).toEqual(
				signatures(local),
			);
			assertRejectionMatrix(local);
			assertRejectionMatrix(sa);
			assertRejectionMatrix(mcp);
		}
	});

	it("uses only the shared canonical UUID patterns at every registered pointer", () => {
		for (const pointer of AUTHORABLE_IDENTITY_POINTER_REGISTRY) {
			expect(
				[CANONICAL_UUID_PATTERN.source, LOOKUP_UUID_V7_PATTERN.source].includes(
					pointer.pattern,
				),
				`${pointer.tool} ${pointer.schemaPointer}`,
			).toBe(true);
		}
	});
});
