/**
 * Result-size declarations, asserted where they actually matter: on the
 * wire, through a real MCP client.
 *
 * Hosts cap a single tool result. Past the cap Claude Code replaces it
 * with a ~2,000-char preview plus a path to the rest on disk — and the
 * plugin's autonomous subagent is allowlisted to Nova's MCP tools and
 * nothing else, so for it a capped result is a lost one. `_meta`, read
 * at `tools/list`, is what raises that cap.
 *
 * Asserting it at the registration boundary is not enough, and the
 * difference is the whole reason this file exists. A test that checks
 * the config object we hand `registerTool` proves only that *we* pass
 * the field; it stays green if the SDK stops publishing it — an upgrade
 * away — while the wire silently reverts to the default and the
 * failure looks exactly like the original bug: a subagent building from
 * a fragment, reporting nothing wrong. So this drives a real
 * `McpServer` through a real `Client` over an in-memory transport and
 * reads the declaration back out of an actual `tools/list` response,
 * registering through `registerNovaTools` — the same call the route
 * handler makes — so the assertion covers the wiring in production
 * rather than a reconstruction of it.
 *
 * Registration performs no I/O; only handlers touch the database, and
 * `tools/list` never invokes one. The db mocks below exist because the
 * import graph reaches those modules, not because anything here reads.
 */

import { Client } from "@modelcontextprotocol/client";
/* Both halves of the linked pair come from the server package: each
 * package bundles its own `InMemoryTransport`, and `Transport` is a
 * structural interface, so the client connects to the server-package
 * half without importing a second copy. */
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_RESULT_SIZE_CHARS } from "../resultSize";
import { registerNovaTools } from "../server";
import type { ToolContext } from "../types";

vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn(),
	listAppsForOwner: vi.fn(),
}));

/** The wire key. Spelled once here and once in `../resultSize`, on
 *  purpose: a typo in either is exactly the silent failure being
 *  guarded against, so the test must not import the string it checks. */
const META_KEY = "anthropic/maxResultSizeChars";

/**
 * Tools that must NOT declare a raised size. `compile_app` returns
 * base64 archives — a payload to be saved, not read — so spilling one
 * to a file is the correct outcome, and raising its ceiling would flood
 * a context with megabytes of base64. Listing it here makes that a
 * decision on the record rather than an omission.
 */
const INTENTIONALLY_UNDECLARED = new Set(["compile_app"]);

/** One representative of each of the three registration sites. */
const MUST_DECLARE = [
	/* MCP-only, the tool the original bug was filed against. */
	"get_agent_prompt",
	/* MCP-only, and already over the default in production (73,534
	 * chars for the largest app). */
	"get_app",
	/* Shared adapter — one declaration covers ~50 tools, so a
	 * representative read and write both prove the same wiring. */
	"search_blueprint",
	"add_fields",
];

let tools: Array<{
	name: string;
	description?: string;
	_meta?: Record<string, unknown>;
}>;

beforeAll(async () => {
	const server = new McpServer({ name: "nova-test", version: "0.0.0" });
	const ctx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };
	registerNovaTools(server, ctx);

	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	tools = (await client.listTools()).tools as typeof tools;
	await client.close();
	await server.close();
});

function declaredSize(name: string): number | undefined {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} is not registered`);
	const value = tool._meta?.[META_KEY];
	return typeof value === "number" ? value : undefined;
}

describe("result-size declarations over the wire", () => {
	it.each(MUST_DECLARE)(
		"%s publishes a raised result size in tools/list",
		(name) => {
			expect(
				declaredSize(name) ?? 0,
				`${name} reached a real MCP client without a "${META_KEY}" declaration. The host will apply its default cap, truncate anything larger, and hand the caller a preview plus a file path — which the autonomous subagent has no tool to open. If this broke without the source changing, check whether the MCP SDK still publishes _meta in its tools/list response.`,
			).toBeGreaterThanOrEqual(MAX_RESULT_SIZE_CHARS);
		},
	);

	it("leaves save-me payloads on the host default", () => {
		for (const name of INTENTIONALLY_UNDECLARED) {
			expect(
				declaredSize(name),
				`${name} declared a raised result size. Its payload is meant to be saved rather than read, so spilling it to a file is correct — raising the ceiling would put megabytes of base64 into a context instead.`,
			).toBeUndefined();
		}
	});

	it("tells a caller the served prompt carries a delivery marker", () => {
		/* The `_meta` key is undocumented and host-specific, so the
		 * marker is the backstop for the day a host stops honoring it.
		 * That backstop only works if callers know to look, and for an
		 * external MCP client the tool description is the only channel
		 * that says so. */
		const tool = tools.find((t) => t.name === "get_agent_prompt");
		expect(tool?.description ?? "").toContain("NOVA-PROMPT-END");
	});

	it("registers the read-only app feature-flag inspection tool", () => {
		const tool = tools.find((t) => t.name === "get_app_hq_feature_flags");
		expect(tool?.description ?? "").toContain("does not compile or upload");
		expect(tool?.description ?? "").toContain(
			"without claiming any flag is off",
		);
		expect(tool?.description ?? "").toContain("confirmed `missing_flags`");
		expect(tool?.description ?? "").toContain(
			"must never cause an agent to remove, undo, or avoid",
		);
	});
});
