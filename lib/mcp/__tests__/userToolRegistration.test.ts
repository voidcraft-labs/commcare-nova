import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerNovaTools } from "../server";
import type { ToolContext } from "../types";

const USER_TOOL_NAMES = [
	"get_users",
	"add_user_properties",
	"update_user_property",
	"remove_user_property",
	"add_user_types",
	"update_user_type",
	"remove_user_type",
	"add_personas",
	"update_persona",
	"remove_persona",
] as const;

describe("MCP user-authoring registration", () => {
	it("registers the complete snake_case projection", () => {
		const registerTool = vi.fn();
		const server = { registerTool } as unknown as McpServer;
		const context: ToolContext = {
			userId: "member",
			scopes: ["nova.read", "nova.write"],
			authKind: "api-key",
		};

		registerNovaTools(server, context);

		const names = registerTool.mock.calls.map(([name]) => name);
		expect(names).toEqual(expect.arrayContaining([...USER_TOOL_NAMES]));
		expect(
			names.filter((name) =>
				USER_TOOL_NAMES.includes(name as (typeof USER_TOOL_NAMES)[number]),
			),
		).toHaveLength(USER_TOOL_NAMES.length);
	});
});
