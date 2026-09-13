/** Public HQ connection metadata through actual SDK dispatch and stored rows. */
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { registerGetHqConnection } from "../tools/getHqConnection";
import { withMcpClient } from "./client";
import { resultText } from "./resultText";

const h = setupAppStateTestDb("mcp_hq_connection_");
const ACTOR = "reader";
function register(scopes: string[] = ["nova.hq.read"]) {
	return (server: Parameters<typeof registerGetHqConnection>[0]) =>
		registerGetHqConnection(server, {
			userId: ACTOR,
			scopes,
			authKind: "oauth",
		});
}
async function seed(
	userId: string,
	server: string,
	domains = [{ name: "clinic", displayName: "Clinic team" }],
) {
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: userId,
			commcare_username: "private-username@dimagi.com",
			commcare_api_key: "opaque-ciphertext-never-decrypt-for-metadata",
			commcare_server: server,
			approved_domains: JSON.stringify(domains),
			updated_at: new Date(),
		})
		.execute();
}

it("returns the complete caller-specific domain set and deployment URL without credentials or an inferred default", async () => {
	await seed("someone-else", "production", [
		{ name: "foreign", displayName: "Foreign" },
	]);
	const domains = [
		{ name: "clinic", displayName: "Clinic team" },
		{ name: "training", displayName: "Training" },
	];
	await seed(ACTOR, "production", domains);
	await withMcpClient(register(), async (client) => {
		for (const [server, server_url] of [
			["production", "https://www.commcarehq.org"],
			["india", "https://india.commcarehq.org"],
			["eu", "https://eu.commcarehq.org"],
		]) {
			await h
				.db()
				.updateTable("user_settings")
				.set({ commcare_server: server })
				.where("user_id", "=", ACTOR)
				.execute();
			expect(
				JSON.parse(
					resultText(
						await client.callTool({ name: "get_hq_connection", arguments: {} }),
					),
				),
			).toEqual({
				configured: true,
				server,
				server_url,
				available_domains: domains,
			});
		}
	});
});

it("collapses missing and incomplete settings to the sole unconfigured shape", async () => {
	await withMcpClient(register(), async (client) => {
		const read = async () =>
			JSON.parse(
				resultText(
					await client.callTool({ name: "get_hq_connection", arguments: {} }),
				),
			);
		expect(await read()).toEqual({ configured: false });
		await seed(ACTOR, "production", []);
		expect(await read()).toEqual({ configured: false });
		await h
			.db()
			.updateTable("user_settings")
			.set({
				approved_domains: JSON.stringify([
					{ name: "clinic", displayName: "Clinic" },
				]),
				commcare_username: "",
			})
			.where("user_id", "=", ACTOR)
			.execute();
		expect(await read()).toEqual({ configured: false });
		await h
			.db()
			.updateTable("user_settings")
			.set({ commcare_username: "reader", commcare_server: "unknown" })
			.where("user_id", "=", ACTOR)
			.execute();
		expect(await read()).toEqual({ configured: false });
	});
});

it("enforces HQ scope before a failing database read and safely classifies the permitted read failure", async () => {
	await h
		.pool()
		.query("ALTER TABLE user_settings RENAME TO unavailable_settings");
	await withMcpClient(register(["nova.read", "nova.write"]), async (client) => {
		const result = await client.callTool({
			name: "get_hq_connection",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		const part = result.content[0];
		if (part.type !== "text") throw new Error("Expected text error");
		expect(JSON.parse(part.text)).toMatchObject({
			error_type: "scope_missing",
			required_scope: "nova.hq.read",
		});
	});
	await withMcpClient(register(), async (client) => {
		expect(
			await client.callTool({ name: "get_hq_connection", arguments: {} }),
		).toEqual({
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error_type: "internal",
						message: "Something went wrong during generation.",
					}),
				},
			],
		});
	});
});
