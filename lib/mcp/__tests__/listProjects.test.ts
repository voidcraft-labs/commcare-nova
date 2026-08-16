/**
 * `registerListProjects` unit tests.
 *
 * Verifies the load-bearing behaviors of the Project-enumeration tool:
 *   - Happy-path projection — each `ProjectSummary` membership becomes a
 *     `{ project_id, name, slug, role, personal }` wire row, in the order
 *     the membership read returned.
 *   - Floor-only access — the tool runs with an EMPTY per-tool scope set
 *     (deliberate: it exposes only the caller's own memberships, and
 *     default-scope OAuth clients need it to resolve a `project_id` for
 *     `create_app`). A regression that adds an `assertScope` gate here
 *     turns the happy-path test red.
 *   - Empty membership — `projects: []` rather than a null or missing key.
 *   - Error classification — a membership-read throw surfaces as an MCP
 *     `isError: true` envelope with a populated `error_type`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listUserProjects } from "@/lib/projects/membership";
import { registerListProjects } from "../tools/listProjects";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("@/lib/projects/membership", () => ({
	listUserProjects: vi.fn(),
}));

/* Scopes deliberately empty — the floor (`nova.read`/`nova.write`) is
 * checked at the route's verify layer, and this tool has NO per-tool
 * gate. An empty array is the strongest statement of that contract. */
const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };

beforeEach(() => {
	vi.mocked(listUserProjects).mockReset();
});

describe("registerListProjects — happy path", () => {
	it("projects each membership into the MCP wire shape without a scope gate", async () => {
		vi.mocked(listUserProjects).mockResolvedValueOnce([
			{
				id: "proj-personal",
				name: "Personal",
				slug: "personal",
				role: "owner",
				personal: true,
			},
			{
				id: "proj-shared",
				name: "Team Alpha",
				slug: "team-alpha",
				role: "editor",
				personal: false,
			},
		]);

		const { server, capture } = makeFakeServer();
		registerListProjects(server, toolCtx);

		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(listUserProjects).toHaveBeenCalledWith("u1");
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			projects: Array<Record<string, unknown>>;
		};
		expect(parsed.projects).toEqual([
			{
				project_id: "proj-personal",
				name: "Personal",
				slug: "personal",
				role: "owner",
				personal: true,
			},
			{
				project_id: "proj-shared",
				name: "Team Alpha",
				slug: "team-alpha",
				role: "editor",
				personal: false,
			},
		]);
	});

	it("returns an empty array rather than null or a missing key", async () => {
		vi.mocked(listUserProjects).mockResolvedValueOnce([]);

		const { server, capture } = makeFakeServer();
		registerListProjects(server, toolCtx);

		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.content[0]?.text).toBe(JSON.stringify({ projects: [] }));
	});
});

describe("registerListProjects — the membership read throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type", async () => {
		vi.mocked(listUserProjects).mockRejectedValueOnce(new Error("db down"));

		const { server, capture } = makeFakeServer();
		registerListProjects(server, toolCtx);

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
