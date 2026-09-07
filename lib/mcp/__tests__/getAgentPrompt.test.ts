/** No database or renderer fakes: build bootstrap and schema refusal through
 * real MCP dispatch. Persisted edit and continuation authorization live in PG. */
import { expect, it } from "vitest";
import { renderAgentPrompt } from "../prompts";
import { registerGetAgentPrompt } from "../tools/getAgentPrompt";
import { withMcpClient } from "./client";
import { readPrompt } from "./promptClient";

const register: Parameters<typeof withMcpClient>[0] = (server) =>
	registerGetAgentPrompt(server, {
		userId: "member",
		scopes: ["nova.read", "nova.write"],
		authKind: "oauth",
	});

it.each(["build", "autonomous_build"] as const)(
	"serves complete %s instructions even with an irrelevant app id",
	async (mode) => {
		await withMcpClient(register, async (client) => {
			const prompt = await readPrompt((cursor) =>
				client.callTool({
					name: "get_agent_prompt",
					arguments: {
						mode,
						app_id: "does-not-exist",
						...(cursor ? { cursor } : {}),
					},
				}),
			);
			expect(prompt).toBe(renderAgentPrompt(mode === "build"));
		});
	},
);
it.each([
	{ mode: "autonomous_edit" },
	{ mode: true },
	{},
	{ mode: "build", cursor: "x".repeat(513) },
])(
	"rejects invalid protocol input %j before the handler can return guidance",
	async (args) => {
		await withMcpClient(register, async (client) => {
			const result = await client.callTool({
				name: "get_agent_prompt",
				arguments: args,
			});
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining("Input validation error"),
				},
			]);
		});
	},
);
it.each([undefined, ""])(
	"requires a nonempty app id for edit mode (%s)",
	async (app_id) => {
		await withMcpClient(register, async (client) => {
			expect(
				await client.callTool({
					name: "get_agent_prompt",
					arguments: {
						mode: "edit",
						...(app_id === undefined ? {} : { app_id }),
					},
				}),
			).toEqual({
				isError: true,
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error_type: "invalid_input",
							message: "edit mode requires app_id",
							...(app_id === undefined ? {} : { app_id }),
						}),
					},
				],
			});
		});
	},
);
it("returns a structured restart refusal for a malformed continuation", async () => {
	await withMcpClient(register, async (client) => {
		const result = await client.callTool({
			name: "get_agent_prompt",
			arguments: { mode: "build", cursor: "invalid" },
		});
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					error_type: "invalid_input",
					message:
						"The get_agent_prompt cursor is invalid. Restart without cursor.",
				}),
			},
		]);
	});
});
