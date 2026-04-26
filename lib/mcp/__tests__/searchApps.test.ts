/**
 * `registerSearchApps` unit tests.
 *
 * Verifies the load-bearing behaviors of the MCP search tool:
 *   - Happy-path projection — each `AppSummary` match becomes a
 *     `{ app_id, name, status, updated_at }` wire entry, in the
 *     relevance order `searchApps` returned.
 *   - Empty result — `apps: []` rather than a null or missing key.
 *   - Pagination cursor pass-through — `nextCursor` → `next_cursor`;
 *     absent when the DB layer returns none.
 *   - Input forwarding — the tool's decoded args are passed verbatim
 *     to `searchApps`, so schema + DB stay in lockstep.
 *   - Error classification — a `searchApps` throw surfaces as an MCP
 *     `isError: true` envelope with a populated `error_type`.
 *
 * Does NOT test fuzzy-match semantics here — that's behavior inside
 * Fuse.js and would duplicate the library's own test surface. The
 * adapter's contract with the DB layer is what matters at this level.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AppSummary,
	type SearchAppsResult,
	searchApps,
} from "@/lib/db/apps";
import { registerSearchApps } from "../tools/searchApps";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("@/lib/db/apps", () => ({
	searchApps: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

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

function makeResult(apps: AppSummary[], nextCursor?: string): SearchAppsResult {
	return nextCursor ? { apps, nextCursor } : { apps };
}

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(searchApps).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerSearchApps — happy path", () => {
	it("projects each match into the MCP wire shape in relevance order", async () => {
		/* Fuse returns best-first. The test asserts that order is preserved
		 * through the adapter — the wire entries appear in the same order
		 * as the DB-layer result. */
		const rows: AppSummary[] = [
			makeSummary({
				id: "a1",
				app_name: "Vaccine Tracker",
				status: "complete",
				updated_at: "2026-04-20T00:00:00.000Z",
			}),
			makeSummary({
				id: "a2",
				app_name: "COVID Vaccine Survey",
				status: "complete",
				updated_at: "2026-04-10T00:00:00.000Z",
			}),
		];
		vi.mocked(searchApps).mockResolvedValueOnce(makeResult(rows));

		const { server, capture } = makeFakeServer();
		registerSearchApps(server, toolCtx);

		const out = (await capture()({ query: "vaccine" })) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			apps: Array<Record<string, unknown>>;
			next_cursor?: string;
		};
		expect(parsed.apps).toEqual([
			{
				app_id: "a1",
				name: "Vaccine Tracker",
				status: "complete",
				updated_at: "2026-04-20T00:00:00.000Z",
			},
			{
				app_id: "a2",
				name: "COVID Vaccine Survey",
				status: "complete",
				updated_at: "2026-04-10T00:00:00.000Z",
			},
		]);
		expect(parsed.next_cursor).toBeUndefined();
	});

	it("forwards decoded args to searchApps so schema + DB stay in sync", async () => {
		vi.mocked(searchApps).mockResolvedValueOnce(makeResult([]));

		const { server, capture } = makeFakeServer();
		registerSearchApps(server, toolCtx);

		await capture()({
			query: "tracker",
			limit: 25,
			cursor: "opaque-cursor",
			status: "complete",
		});

		expect(searchApps).toHaveBeenCalledWith("u1", {
			query: "tracker",
			limit: 25,
			cursor: "opaque-cursor",
			status: "complete",
		});
	});
});

describe("registerSearchApps — empty + pagination", () => {
	it("returns an empty array rather than null or a missing key", async () => {
		vi.mocked(searchApps).mockResolvedValueOnce(makeResult([]));

		const { server, capture } = makeFakeServer();
		registerSearchApps(server, toolCtx);

		const out = (await capture()({ query: "nothing matches" })) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.content[0]?.text).toBe(JSON.stringify({ apps: [] }));
	});

	it("surfaces nextCursor from the DB layer as next_cursor on the wire", async () => {
		const rows = [
			makeSummary({
				id: "a1",
				app_name: "Vaccine Tracker",
				updated_at: "2026-04-20T00:00:00.000Z",
			}),
		];
		vi.mocked(searchApps).mockResolvedValueOnce(
			makeResult(rows, "encoded-cursor-v1"),
		);

		const { server, capture } = makeFakeServer();
		registerSearchApps(server, toolCtx);

		const out = (await capture()({ query: "vaccine" })) as {
			content: Array<{ type: "text"; text: string }>;
		};
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			apps: Array<Record<string, unknown>>;
			next_cursor?: string;
		};
		expect(parsed.next_cursor).toBe("encoded-cursor-v1");
	});
});

describe("registerSearchApps — searchApps throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type", async () => {
		vi.mocked(searchApps).mockRejectedValueOnce(new Error("firestore down"));

		const { server, capture } = makeFakeServer();
		registerSearchApps(server, toolCtx);

		const out = (await capture()({ query: "anything" })) as {
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
