/**
 * `registerListApps` unit tests.
 *
 * Verifies the five load-bearing behaviors of the MCP-only list tool:
 *   - Happy-path projection from `AppSummary` rows to the MCP wire
 *     shape (`{ app_id, name, status, updated_at }` per entry).
 *   - Empty-list projection — `apps: []` rather than a null or missing
 *     key, so MCP clients can branch on `apps.length` unconditionally.
 *   - `_meta.run_id` rides on every success — absent `app_id`, it is the
 *     sole grouping signal admin surfaces use to stitch this call to
 *     sibling tool calls.
 *   - Client-supplied `run_id` threads through from `extra._meta.run_id`.
 *   - Error classification — a `listApps` throw surfaces as an MCP
 *     `isError: true` envelope with a populated `error_type` AND the
 *     same `run_id`, never as an unhandled rejection.
 *
 * Soft-delete filtering lives at the persistence boundary (`listApps`
 * in `lib/db/apps.ts`), not here — this tool is a pure projection over
 * the already-filtered list.
 *
 * The MCP SDK is mocked at the boundary through the shared `fakeServer`
 * helper that captures the handler callback. Tests drive the adapter
 * directly, so no streaming wire-up is required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AppSummary, listApps } from "@/lib/db/apps";
import { registerListApps } from "../tools/listApps";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* `vi.mock` is hoisted above imports so the mock installs before
 * `../tools/listApps` resolves `@/lib/db/apps`. Only `listApps` is
 * replaced — the rest of the module is untouched. */
vi.mock("@/lib/db/apps", () => ({
	listApps: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

/**
 * Loose UUID-v4 regex. `list_apps` mints `run_id` via
 * `crypto.randomUUID()` when the client doesn't thread one; asserting on
 * shape (rather than pinning a value) keeps the test decoupled from the
 * exact uuid returned while still catching regressions that would
 * produce a non-uuid string.
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

		/* `list_apps` has no input schema, so the callback takes only
		 * `extra` as its single argument. */
		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { run_id: string };
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
		/* `run_id` is minted fresh when the client doesn't supply one —
		 * verify shape (uuid v4) rather than a pinned value. */
		expect(out._meta.run_id).toMatch(UUID_RE);
	});
});

describe("registerListApps — empty", () => {
	it("returns an empty array rather than null or a missing key", async () => {
		vi.mocked(listApps).mockResolvedValueOnce([]);

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.content[0]?.text).toBe(JSON.stringify({ apps: [] }));
	});
});

describe("registerListApps — run_id threading", () => {
	it("threads a client-supplied run_id from extra._meta.run_id onto the response", async () => {
		vi.mocked(listApps).mockResolvedValueOnce([]);

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({ _meta: { run_id: "client-rid-42" } })) as {
			_meta: { run_id: string };
		};

		/* Clients bundle multi-call runs under one run id so admin
		 * surfaces can stitch related tool calls together. Honoring
		 * `_meta.run_id` preserves the grouping the client intended. */
		expect(out._meta.run_id).toBe("client-rid-42");
	});
});

describe("registerListApps — listApps throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type and the resolved run_id", async () => {
		/* A Firestore outage or a timing anomaly in the query surfaces
		 * via the shared error classifier. The envelope must carry
		 * `isError: true`, a non-empty `error_type`, AND the same
		 * `run_id` the success path would have stamped — admin
		 * surfaces grouping by run id must see error responses under
		 * the same id as the rest of the call. */
		vi.mocked(listApps).mockRejectedValueOnce(new Error("firestore down"));

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({ _meta: { run_id: "client-rid-err" } })) as {
			isError?: true;
			_meta?: { error_type: string; run_id?: string };
		};
		expect(out.isError).toBe(true);
		expect(typeof out._meta?.error_type).toBe("string");
		expect(out._meta?.error_type.length ?? 0).toBeGreaterThan(0);
		expect(out._meta?.run_id).toBe("client-rid-err");
	});
});
