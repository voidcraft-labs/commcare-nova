/**
 * `registerCreateApp` unit tests.
 *
 * Verifies the four load-bearing behaviors of the MCP-only create tool:
 *   - Happy path with a name: forwards `{ appName, status: "complete" }`
 *     to the DB helper, surfaces the returned `app_id`, and emits the
 *     `stage: "app_created"` marker MCP progress clients can latch on.
 *   - Happy path without a name: normalizes the omitted optional to
 *     `undefined` so the DB helper's `""` default kicks in.
 *   - Whitespace-only name: normalized to `undefined` for the same
 *     reason — a blank row is strictly worse than an empty one.
 *   - `createApp` throws: surfaces as an MCP `isError: true` envelope
 *     classified through the shared taxonomy.
 *
 * The MCP SDK is mocked at the boundary — same fake-server pattern
 * used throughout `lib/mcp/__tests__`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/lib/db/apps";
import { registerCreateApp } from "../tools/createApp";
import type { ToolContext } from "../types";

/* Hoisted mock — installs before `../tools/createApp` resolves
 * `@/lib/db/apps`. Only `createApp` is replaced. */
vi.mock("@/lib/db/apps", () => ({
	createApp: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

type Handler = (
	args: Record<string, unknown>,
	extra: Record<string, unknown>,
) => Promise<unknown>;

interface FakeServer {
	server: McpServer;
	capture(): Handler;
}

function makeFakeServer(): FakeServer {
	let captured: Handler | null = null;
	const server = {
		tool: (_n: string, _d: string, _s: unknown, cb: Handler) => {
			captured = cb;
		},
		server: { notification: vi.fn() },
	} as unknown as McpServer;
	return {
		server,
		capture: () => {
			if (!captured) throw new Error("handler not captured");
			return captured;
		},
	};
}

/**
 * Loose UUID-v4 regex. Asserting on shape (rather than pinning an
 * exact value) keeps the test decoupled from `crypto.randomUUID()`'s
 * output while still catching regressions that would return a fixed
 * string or something structurally wrong.
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(createApp).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerCreateApp — happy path with name", () => {
	it("forwards the name and 'complete' status, returns the minted app_id", async () => {
		vi.mocked(createApp).mockResolvedValueOnce("app-123");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()({ app_name: "My App" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { stage: string; app_id: string; run_id: string };
		};

		expect(createApp).toHaveBeenCalledTimes(1);
		const [owner, runId, opts] = vi.mocked(createApp).mock.calls[0] ?? [];
		expect(owner).toBe("u1");
		/* Run id shape — mint-per-call via `crypto.randomUUID()`. We
		 * don't pin a specific value; we just verify it's a UUID v4. */
		expect(typeof runId).toBe("string");
		expect(runId).toMatch(UUID_RE);
		expect(opts).toEqual({ appName: "My App", status: "complete" });

		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			app_id: "app-123",
		});
		expect(out._meta.stage).toBe("app_created");
		expect(out._meta.app_id).toBe("app-123");
		expect(out._meta.run_id).toBe(runId);
	});
});

describe("registerCreateApp — happy path without name", () => {
	it("omits the appName (passes undefined) when no name is provided", async () => {
		vi.mocked(createApp).mockResolvedValueOnce("app-abc");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		await capture()({}, {});

		const [, , opts] = vi.mocked(createApp).mock.calls[0] ?? [];
		/* The DB helper's default `""` kicks in only when `appName` is
		 * undefined on the options object. Explicit presence with
		 * `undefined` is the expected shape. */
		expect(opts).toEqual({ appName: undefined, status: "complete" });
	});
});

describe("registerCreateApp — whitespace-only name", () => {
	it("normalizes a whitespace-only name to undefined", async () => {
		vi.mocked(createApp).mockResolvedValueOnce("app-xyz");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		await capture()({ app_name: "   " }, {});

		const [, , opts] = vi.mocked(createApp).mock.calls[0] ?? [];
		expect(opts).toEqual({ appName: undefined, status: "complete" });
	});
});

describe("registerCreateApp — createApp throws", () => {
	it("surfaces as an MCP error envelope with populated error_type", async () => {
		vi.mocked(createApp).mockRejectedValueOnce(
			new Error("firestore write failed"),
		);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()({ app_name: "x" }, {})) as {
			isError?: true;
			_meta?: { error_type: string };
		};
		expect(out.isError).toBe(true);
		expect(typeof out._meta?.error_type).toBe("string");
		expect(out._meta?.error_type.length ?? 0).toBeGreaterThan(0);
	});
});
