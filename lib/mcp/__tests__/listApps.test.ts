/**
 * `registerListApps` unit tests.
 *
 * Verifies the three load-bearing behaviors of the MCP-only list tool:
 *   - Happy-path projection from `AppSummary` rows to the MCP wire
 *     shape (`{ app_id, name, status, updated_at }` per entry).
 *   - Empty-list projection — `apps: []` rather than a null or missing
 *     key, so MCP clients can branch on `apps.length` unconditionally.
 *   - Error classification — a `listApps` throw surfaces as an MCP
 *     `isError: true` envelope with a populated `error_type`, never as
 *     an unhandled rejection.
 *
 * Soft-delete filtering lives at the persistence boundary (`listApps`
 * in `lib/db/apps.ts`), not here — this tool is a pure projection over
 * the already-filtered list.
 *
 * The MCP SDK is mocked at the boundary through a fake server that
 * captures the handler callback. Tests drive the adapter directly, so
 * no streaming wire-up is required. The pattern mirrors
 * `sharedToolAdapter.test.ts` to keep MCP test ergonomics consistent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AppSummary, listApps } from "@/lib/db/apps";
import { registerListApps } from "../tools/listApps";
import type { ToolContext } from "../types";

/* `vi.mock` is hoisted above imports so the mock installs before
 * `../tools/listApps` resolves `@/lib/db/apps`. Only `listApps` is
 * replaced — the rest of the module is untouched. */
vi.mock("@/lib/db/apps", () => ({
	listApps: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

/**
 * Handler signature `McpServer.tool` forwards to our callback. Zero-arg
 * tools still receive an `args` object (from schema parsing) and an
 * `extra` object (for `_meta` / progress). The list tool ignores both.
 */
type Handler = (
	args: Record<string, unknown>,
	extra: Record<string, unknown>,
) => Promise<unknown>;

interface FakeServer {
	server: McpServer;
	capture(): Handler;
}

/**
 * Capture the handler `registerListApps` registers via `server.tool`.
 * The stub records the fourth argument (the callback) and `capture()`
 * hands it back for direct invocation.
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

/** Build an `AppSummary` with ergonomic defaults for every test row. */
function makeSummary(overrides: Partial<AppSummary>): AppSummary {
	return {
		id: "default-id",
		app_name: "Default",
		connect_type: null,
		module_count: 0,
		form_count: 0,
		status: "complete",
		error_type: null,
		created_at: "2026-04-01T00:00:00.000Z",
		updated_at: "2026-04-01T00:00:00.000Z",
		...overrides,
	};
}

/** Baseline tool context — one authenticated caller, no scopes inspected. */
const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(listApps).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerListApps — happy path", () => {
	it("projects each AppSummary into the MCP wire shape", async () => {
		/* Three rows across all three live statuses. The projected entries
		 * must preserve order (Firestore already orders by `updated_at`)
		 * and expose only the four wire-shape keys. */
		const rows: AppSummary[] = [
			makeSummary({
				id: "a1",
				app_name: "First",
				status: "complete",
				updated_at: "2026-04-20T00:00:00.000Z",
			}),
			makeSummary({
				id: "a2",
				app_name: "Second",
				status: "generating",
				updated_at: "2026-04-19T00:00:00.000Z",
			}),
			makeSummary({
				id: "a3",
				app_name: "Third",
				status: "error",
				error_type: "internal",
				updated_at: "2026-04-18T00:00:00.000Z",
			}),
		];
		vi.mocked(listApps).mockResolvedValueOnce(rows);

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({}, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			apps: Array<Record<string, unknown>>;
		};
		expect(parsed.apps).toEqual([
			{
				app_id: "a1",
				name: "First",
				status: "complete",
				updated_at: "2026-04-20T00:00:00.000Z",
			},
			{
				app_id: "a2",
				name: "Second",
				status: "generating",
				updated_at: "2026-04-19T00:00:00.000Z",
			},
			{
				app_id: "a3",
				name: "Third",
				status: "error",
				updated_at: "2026-04-18T00:00:00.000Z",
			},
		]);
		expect(listApps).toHaveBeenCalledWith("u1");
	});
});

describe("registerListApps — empty", () => {
	it("returns an empty array rather than null or a missing key", async () => {
		vi.mocked(listApps).mockResolvedValueOnce([]);

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({}, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.content[0]?.text).toBe(JSON.stringify({ apps: [] }));
	});
});

describe("registerListApps — listApps throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type", async () => {
		/* A Firestore outage or a timing anomaly in the query surfaces
		 * via the shared error classifier. The envelope must carry
		 * `isError: true` and a non-empty `error_type` so MCP clients
		 * can branch without parsing the message text. */
		vi.mocked(listApps).mockRejectedValueOnce(new Error("firestore down"));

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({}, {})) as {
			isError?: true;
			_meta?: { error_type: string };
		};
		expect(out.isError).toBe(true);
		expect(typeof out._meta?.error_type).toBe("string");
		expect(out._meta?.error_type.length ?? 0).toBeGreaterThan(0);
	});
});
