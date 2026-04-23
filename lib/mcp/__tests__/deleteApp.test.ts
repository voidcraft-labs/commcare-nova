/**
 * `registerDeleteApp` unit tests.
 *
 * Covers the four paths the route handler has to care about:
 *   - Happy path: an owned app soft-deletes, the returned envelope
 *     carries `{ deleted: true, recoverable_until }`, and the
 *     `_meta.stage: "app_deleted"` marker is populated for MCP
 *     progress clients.
 *   - Ownership failure (`not_owner`): a cross-tenant probe
 *     short-circuits before the write and never reaches `softDeleteApp`.
 *   - App not found (`not_found`): `loadAppOwner` returns null
 *     (missing row). `softDeleteApp` must not run — a probe for an
 *     arbitrary id must not leave soft-delete state behind.
 *   - `softDeleteApp` throws: the Firestore write rejection surfaces
 *     as an `isError: true` MCP envelope classified through the shared
 *     taxonomy (not the `McpAccessError` fast path).
 *
 * Same fake-server stub + MCP-SDK-boundary-mock pattern used by
 * `createApp.test.ts` and `getApp.test.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppOwner, softDeleteApp } from "@/lib/db/apps";
import { registerDeleteApp } from "../tools/deleteApp";
import type { ToolContext } from "../types";

/* Hoisted mock — installs before `../tools/deleteApp` resolves
 * `@/lib/db/apps`. Only the two functions the tool touches (one for
 * the ownership gate, one for the write) are replaced. */
vi.mock("@/lib/db/apps", () => ({
	loadAppOwner: vi.fn(),
	softDeleteApp: vi.fn(),
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

/**
 * Build a minimal stand-in for `McpServer` that captures the handler
 * the tool registers via `server.tool(...)`. `server.notification` is
 * a spy because the progress emitter in other tools dispatches on it;
 * `delete_app` doesn't use it, but keeping the spy present aligns
 * this fake with the shared shape.
 */
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

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

/* Fixed recovery deadline — asserting on the literal ISO value keeps
 * the test independent of `Date.now()` and decouples it from the
 * 30-day constant in the helper (changing the window should change
 * the helper's output, not this test's expectation). */
const FIXED_RECOVERABLE_UNTIL = "2026-05-23T12:00:00.000Z";

beforeEach(() => {
	vi.mocked(loadAppOwner).mockReset();
	vi.mocked(softDeleteApp).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerDeleteApp — happy path", () => {
	it("soft-deletes an owned app and surfaces the recovery deadline", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(softDeleteApp).mockResolvedValueOnce(FIXED_RECOVERABLE_UNTIL);

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { stage: string; app_id: string };
		};

		expect(softDeleteApp).toHaveBeenCalledWith("a1");
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			deleted: true,
			recoverable_until: FIXED_RECOVERABLE_UNTIL,
		});
		expect(out._meta.stage).toBe("app_deleted");
		expect(out._meta.app_id).toBe("a1");
	});
});

describe("registerDeleteApp — ownership failure", () => {
	it("short-circuits with error_type = 'not_owner' and never writes", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_owner");
		expect(out._meta?.app_id).toBe("a1");
		/* Hard invariant: a cross-tenant probe must not leave soft-delete
		 * state behind. `softDeleteApp` must not run at all. */
		expect(softDeleteApp).not.toHaveBeenCalled();
	});
});

describe("registerDeleteApp — not found", () => {
	it("maps ownership-null to error_type = 'not_found' and never writes", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "ghost" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_found");
		expect(out._meta?.app_id).toBe("ghost");
		/* A probe against a nonexistent id must not create a soft-delete
		 * row — the helper is merge-write, so a write against a missing
		 * document would materialize the row from nothing. */
		expect(softDeleteApp).not.toHaveBeenCalled();
	});
});

describe("registerDeleteApp — softDeleteApp throws", () => {
	it("surfaces firestore write rejection through the shared taxonomy", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(softDeleteApp).mockRejectedValueOnce(
			new Error("firestore write failed"),
		);

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		/* Not the `McpAccessError` fast path — the write rejection is
		 * routed through `classifyError` and resolves to a generic
		 * taxonomy bucket (e.g. `internal`). Assert shape rather than an
		 * exact value so a future classifier refinement doesn't break
		 * the test. */
		expect(typeof out._meta?.error_type).toBe("string");
		expect(out._meta?.error_type).not.toBe("not_owner");
		expect(out._meta?.error_type).not.toBe("not_found");
		expect(out._meta?.app_id).toBe("a1");
	});
});
