/** Exercise Nova's registrations through the actual HTTP SDK. Missing grants
 * must challenge before argument validation or any protected database/HQ read. */
import type { AuthInfo } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { ASSET_SIZE_CAPS_BYTES } from "@/lib/domain/multimedia";
import { MCP_RESOURCE_METADATA_URL } from "@/lib/hostnames";
import type { ToolContext } from "@/lib/mcp/types";
import { dispatchMcpTools, MCP_MAX_REQUEST_BODY_BYTES } from "../dispatch";

const ctx: ToolContext = {
	userId: "scope-test",
	scopes: ["nova.read", "nova.write", "nova.projects.read"],
	authKind: "oauth",
};
const authInfo: AuthInfo = {
	token: "verified-test-token",
	clientId: "scope-test-client",
	scopes: [...ctx.scopes],
	resourceMetadataUrl: MCP_RESOURCE_METADATA_URL,
};
function request(body: string, headers: Record<string, string> = {}) {
	return new Request("https://mcp.commcare.app/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body,
	});
}
const call = (name: string) =>
	JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: {} },
	});

it.each([
	["get_hq_connection", "nova.hq.read"],
	["check_project_space_compatibility", "nova.hq.read"],
	["get_deployment", "nova.hq.read"],
	["upload_app_to_hq", "nova.hq.write"],
	["refresh_deployment", "nova.hq.write"],
	["get_entry_point_link", "nova.hq.write"],
	["provision_workers", "nova.hq.write"],
	["create_project", "nova.projects.write"],
	["invite_member", "nova.projects.write"],
	["update_member_role", "nova.projects.write"],
	["move_app", "nova.projects.write"],
	["list_members", "nova.projects.read"],
])("challenges the missing grant before %s executes", async (name, scope) => {
	const context = {
		...ctx,
		scopes: ctx.scopes.filter((granted) => granted !== scope),
	};
	const response = await dispatchMcpTools(request(call(name)), context, {
		...authInfo,
		scopes: [...context.scopes],
	});
	expect(response.status).toBe(403);
	const challenge = response.headers.get("www-authenticate");
	expect(challenge).toContain('error="insufficient_scope"');
	expect(challenge).toContain(
		`resource_metadata="${MCP_RESOURCE_METADATA_URL}"`,
	);
	const grants = /scope="([^"]+)"/.exec(challenge ?? "")?.[1].split(" ");
	expect(grants).toEqual(expect.arrayContaining([...context.scopes, scope]));
	await response.text();
});

it("keeps static API keys on the actionable tool-error path", async () => {
	const response = await dispatchMcpTools(request(call("get_hq_connection")), {
		...ctx,
		authKind: "api-key",
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("www-authenticate")).toBeNull();
	const body = await response.text();
	expect(body).toContain("scope_missing");
	expect(body).toContain("Edit the API key");
});

it("admits a maximum-sized media payload through HTTP parsing", async () => {
	// An unknown tool avoids storage: its SDK error proves the entire valid body
	// passed the transport bound, including base64 and JSON framing.
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "unknown_media_test",
			arguments: {
				data_base64: "A".repeat(Math.ceil(ASSET_SIZE_CAPS_BYTES.video / 3) * 4),
			},
		},
	});
	const response = await dispatchMcpTools(request(body), ctx, authInfo);
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("unknown_media_test");
});

it.each([true, false])(
	"rejects oversized bodies and cancels unread bytes (declared length: %s)",
	async (declared) => {
		let cancelled = false;
		const chunk = new Uint8Array(1024 * 1024).fill(32);
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const req = new Request("https://mcp.commcare.app/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(declared
					? { "content-length": String(MCP_MAX_REQUEST_BODY_BYTES + 1) }
					: {}),
			},
			body: stream,
			duplex: "half",
		} as RequestInit);
		try {
			const response = await dispatchMcpTools(req, ctx, authInfo);
			expect(response.status).toBe(413);
			expect(cancelled).toBe(true);
			await response.text();
		} finally {
			await req.body?.cancel();
		}
	},
);

it("challenges modern requests and enforces their protocol header", async () => {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 0,
		method: "tools/call",
		params: {
			name: "get_hq_connection",
			arguments: {},
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": {
					name: "nova-wire-test",
					version: "1",
				},
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		},
	});
	for (const includeVersion of [true, false]) {
		const response = await dispatchMcpTools(
			request(body, {
				"Mcp-Method": "tools/call",
				"Mcp-Name": "get_hq_connection",
				...(includeVersion ? { "MCP-Protocol-Version": "2026-07-28" } : {}),
			}),
			ctx,
			authInfo,
		);
		expect(response.status).toBe(includeVersion ? 403 : 400);
		const text = await response.text();
		if (includeVersion)
			expect(response.headers.get("www-authenticate")).toContain(
				'error="insufficient_scope"',
			);
		else
			expect(JSON.parse(text)).toMatchObject({
				id: 0,
				error: { code: -32020 },
			});
	}
});
