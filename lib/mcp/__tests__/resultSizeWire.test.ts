/** Registration is exercised through tools/list, including SDK schema and
 * metadata projection. Registration performs no database reads. */
import type { Client } from "@modelcontextprotocol/client";
import { beforeAll, expect, it } from "vitest";
import { registerNovaTools } from "../server";
import { withMcpClient } from "./client";

let listed: Awaited<ReturnType<Client["listTools"]>>["tools"];
beforeAll(async () => {
	listed = await withMcpClient(
		(server) =>
			registerNovaTools(server, {
				userId: "member",
				scopes: ["nova.read", "nova.write"],
				authKind: "api-key",
			}),
		async (client) => (await client.listTools()).tools,
	);
});
function tool(name: string) {
	const found = listed.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`Tool ${name} was not delivered to the client`);
	return found;
}
it.each(["get_agent_prompt", "get_app", "search_blueprint", "add_fields"])(
	"%s declares the host's 100,000-character ceiling",
	(name) => {
		expect(tool(name)._meta?.["anthropic/maxResultSizeChars"]).toBe(100_000);
	},
);
it("keeps downloadable compile archives on the host's default ceiling", () => {
	expect(
		tool("compile_app")._meta?.["anthropic/maxResultSizeChars"],
	).toBeUndefined();
});
it("publishes each user-authoring tool once with its external name", () => {
	const names = listed.map((entry) => entry.name);
	expect(new Set(names).size).toBe(names.length);
	expect(names).toEqual(
		expect.arrayContaining([
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
		]),
	);
});
it("delivers prompt continuation and compatibility inputs to clients", () => {
	expect(tool("get_agent_prompt").inputSchema.properties).toMatchObject({
		mode: { enum: ["build", "autonomous_build", "edit"] },
		cursor: { type: "string", maxLength: 512 },
	});
	expect(
		tool("check_project_space_compatibility").inputSchema.required,
	).toEqual(expect.arrayContaining(["app_id", "domain"]));
	expect(tool("get_app_hq_feature_flags").inputSchema.required).toContain(
		"app_id",
	);
});
