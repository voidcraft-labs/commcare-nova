/**
 * `registerCreateProject` unit tests.
 *
 * Verifies the load-bearing behaviors of the Project-creation tool:
 *   - Scope gate FIRST — a token without `nova.projects.write` gets the
 *     `scope_missing` envelope (with `required_scope`) and the manage
 *     layer is never reached, so nothing is created and nothing probed.
 *   - Happy-path projection — the manage layer's `CreatedProject` becomes
 *     `{ project_id, name, slug, role: "owner" }` on the wire, and the
 *     write is invoked with the caller's userId + the raw name.
 *   - Policy rejection passthrough — a `ProjectManagementError` (name
 *     policy) surfaces as `invalid_input` with the message verbatim.
 *
 * The manage layer itself (slug retry, atomicity) is covered by its own
 * integration tests — this level pins the adapter contract only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, ProjectManagementError } from "@/lib/projects/manage";
import { SCOPES } from "../scopes";
import { registerCreateProject } from "../tools/createProject";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Keep the real error classes (the error serializer branches on
 * `instanceof ProjectManagementError`) and stub only the write. */
vi.mock("@/lib/projects/manage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/projects/manage")>()),
	createProject: vi.fn(),
}));

/* The context carries ONLY the scope the handler inspects — the route
 * floor is checked upstream of the tool layer. */
const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.projectsWrite],
	authKind: "oauth",
};

beforeEach(() => {
	vi.mocked(createProject).mockReset();
});

describe("registerCreateProject — scope gate", () => {
	it("rejects a token without nova.projects.write before touching the manage layer", async () => {
		const { server, capture } = makeFakeServer();
		/* Floor scopes only — the shape a default-registered client holds. */
		registerCreateProject(server, {
			userId: "u1",
			scopes: [SCOPES.read, SCOPES.write],
			authKind: "oauth",
		});

		const out = (await capture()({ name: "Village Health Program" })) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
			required_scope?: string;
		};
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.projectsWrite);
		/* The gate fires before the write — nothing was created. */
		expect(createProject).not.toHaveBeenCalled();
	});
});

describe("registerCreateProject — happy path", () => {
	it("creates the Project as the caller and projects the wire shape", async () => {
		vi.mocked(createProject).mockResolvedValueOnce({
			id: "proj-new",
			name: "Village Health Program",
			slug: "village-health-program-a1b2c3",
		});

		const { server, capture } = makeFakeServer();
		registerCreateProject(server, toolCtx);

		const out = (await capture()({ name: "Village Health Program" })) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(createProject).toHaveBeenCalledWith("u1", "Village Health Program");
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			project_id: "proj-new",
			name: "Village Health Program",
			slug: "village-health-program-a1b2c3",
			role: "owner",
		});
	});
});

describe("registerCreateProject — policy rejection", () => {
	it("passes a ProjectManagementError through verbatim as invalid_input", async () => {
		const message =
			"Project names are limited to 64 characters. Shorten the name and try again.";
		vi.mocked(createProject).mockRejectedValueOnce(
			new ProjectManagementError(message),
		);

		const { server, capture } = makeFakeServer();
		registerCreateProject(server, toolCtx);

		const out = (await capture()({ name: "x".repeat(80) })) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
			message?: string;
		};
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toBe(message);
	});
});
