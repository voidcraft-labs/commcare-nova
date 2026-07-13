/**
 * `registerListApps` unit tests.
 *
 * Verifies the load-bearing behaviors of the MCP enumerate tool:
 *   - Happy-path projection from `AppSummary` rows to the MCP wire
 *     shape (`{ app_id, name, status, updated_at }` per entry).
 *   - Empty-list projection — `apps: []` rather than a null or missing
 *     key, so MCP clients can branch on `apps.length` unconditionally.
 *   - Pagination cursor pass-through — when the scan returns a
 *     `nextCursor`, the wire response surfaces it as `next_cursor`;
 *     when it does not, the field is omitted (never null) so clients
 *     branch on key existence.
 *   - Scope + input forwarding — the tool enumerates EVERY Project the
 *     caller is a member of (the membership read's result) and passes
 *     the decoded args verbatim to the DB layer, so a shared-Project
 *     app the by-id tools can open is never invisible to enumeration
 *     and schema drift surfaces as a typed compile error plus a red test.
 *   - Error classification — a scan throw surfaces as an MCP
 *     `isError: true` envelope with a populated `error_type`, never as
 *     an unhandled rejection.
 *
 * Soft-delete filtering lives at the persistence boundary
 * (`listAppsAcrossProjects` in `lib/db/apps.ts`), not here — this tool
 * is a pure projection over the already-filtered list.
 *
 * The MCP SDK is mocked at the boundary through the shared `fakeServer`
 * helper that captures the handler callback. Tests drive the adapter
 * directly, so no streaming wire-up is required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listUserProjectIds } from "@/lib/db/appAccess";
import {
	type AppSummary,
	type ListAppsResult,
	listAppsAcrossProjects,
} from "@/lib/db/apps";
import { registerListApps } from "../tools/listApps";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* `vi.mock` is hoisted above imports so the mock installs before
 * `../tools/listApps` resolves `@/lib/db/apps`. Only the multi-Project
 * enumeration scan is replaced — the rest of the module is untouched. */
vi.mock("@/lib/db/apps", () => ({
	listAppsAcrossProjects: vi.fn(),
}));

/* The tool enumerates across every Project the caller is a member of; stub the
 * membership read so the unit test never touches the auth DB. Two memberships
 * exercise the cross-Project scope (a personal + a shared Project). */
vi.mock("@/lib/db/appAccess", () => ({
	listUserProjectIds: vi.fn(async () => ["proj-personal", "proj-shared"]),
}));

/* --- Helpers --------------------------------------------------------- */

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
		logo: null,
		created_at: "2026-04-01T00:00:00.000Z",
		updated_at: "2026-04-01T00:00:00.000Z",
		...overrides,
	};
}

/** Build a `ListAppsResult` from a row list with no cursor by default. */
function makeResult(apps: AppSummary[], nextCursor?: string): ListAppsResult {
	return nextCursor ? { apps, nextCursor } : { apps };
}

/** Baseline tool context — one authenticated caller, no scopes inspected. */
const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };

beforeEach(() => {
	vi.mocked(listAppsAcrossProjects).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerListApps — happy path", () => {
	it("projects each AppSummary into the MCP wire shape", async () => {
		/* Three rows across all three live statuses. The projected entries
		 * must preserve order (the query already orders by `updated_at`)
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
		vi.mocked(listAppsAcrossProjects).mockResolvedValueOnce(makeResult(rows));

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		/* The Zod schema applies defaults, so an empty `args` object still
		 * produces a populated options object downstream. */
		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			apps: Array<Record<string, unknown>>;
			next_cursor?: string;
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
		/* No cursor on this mock → key must be absent from the response,
		 * not present-and-null. */
		expect(parsed.next_cursor).toBeUndefined();
	});

	it("enumerates the caller's full membership set and forwards decoded args", async () => {
		vi.mocked(listAppsAcrossProjects).mockResolvedValueOnce(makeResult([]));

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		await capture()({
			limit: 25,
			cursor: "opaque-cursor",
			status: "complete",
			sort: "name_asc",
		});

		/* The scope is EVERY Project the caller is a member of — the membership
		 * read's result, passed straight through — so a shared-Project app the
		 * by-id tools can open is never invisible to enumeration. The decoded
		 * args ride along verbatim so schema + DB stay in sync. */
		expect(listUserProjectIds).toHaveBeenCalledWith("u1");
		expect(listAppsAcrossProjects).toHaveBeenCalledWith(
			["proj-personal", "proj-shared"],
			{
				limit: 25,
				cursor: "opaque-cursor",
				status: "complete",
				sort: "name_asc",
			},
		);
	});
});

describe("registerListApps — empty + pagination", () => {
	it("returns an empty array rather than null or a missing key", async () => {
		vi.mocked(listAppsAcrossProjects).mockResolvedValueOnce(makeResult([]));

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.content[0]?.text).toBe(JSON.stringify({ apps: [] }));
	});

	it("surfaces nextCursor from the DB layer as next_cursor on the wire", async () => {
		const rows = [
			makeSummary({
				id: "a1",
				app_name: "Full page",
				updated_at: "2026-04-20T00:00:00.000Z",
			}),
		];
		vi.mocked(listAppsAcrossProjects).mockResolvedValueOnce(
			makeResult(rows, "encoded-cursor-v1"),
		);

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			apps: Array<Record<string, unknown>>;
			next_cursor?: string;
		};
		expect(parsed.next_cursor).toBe("encoded-cursor-v1");
	});
});

describe("registerListApps — the scan throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type", async () => {
		/* A DB outage or a timing anomaly in the query surfaces
		 * via the shared error classifier. The envelope must carry
		 * `isError: true` and a non-empty `error_type`. */
		vi.mocked(listAppsAcrossProjects).mockRejectedValueOnce(
			new Error("db down"),
		);

		const { server, capture } = makeFakeServer();
		registerListApps(server, toolCtx);

		const out = (await capture()({})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
		};
		expect(typeof payload.error_type).toBe("string");
		expect(payload.error_type?.length ?? 0).toBeGreaterThan(0);
	});
});
