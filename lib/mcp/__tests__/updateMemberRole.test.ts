/**
 * `registerUpdateMemberRole` unit tests.
 *
 * Verifies the load-bearing behaviors of the role-change tool:
 *   - Scope gate FIRST — a token without `nova.projects.write` gets
 *     `scope_missing` and the manage layer is never reached.
 *   - Happy-path projection — the manage layer's `UpdatedMemberRole`
 *     becomes `{ project_id, member_id, user_id, name, email,
 *     previous_role, role }` on the wire.
 *   - IDOR collapse — a Project the caller can't reach surfaces as
 *     `not_found` + "Project not found.".
 *   - Policy rejection passthrough — the owner-row refusal (a
 *     `ProjectManagementError`) surfaces as `invalid_input` verbatim.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	ProjectManagementError,
	updateProjectMemberRole,
} from "@/lib/projects/manage";
import { SCOPES } from "../scopes";
import { registerUpdateMemberRole } from "../tools/updateMemberRole";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Keep the real error classes (the serializer and the access mapper
 * branch on `instanceof`) and stub only the write. */
vi.mock("@/lib/projects/manage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/projects/manage")>()),
	updateProjectMemberRole: vi.fn(),
}));

const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.projectsWrite],
	authKind: "oauth",
};

const updateArgs = {
	project_id: "proj-shared",
	member_id: "mem-2",
	role: "admin",
};

beforeEach(() => {
	vi.mocked(updateProjectMemberRole).mockReset();
});

describe("registerUpdateMemberRole — scope gate", () => {
	it("rejects a token without nova.projects.write before any data read", async () => {
		const { server, capture } = makeFakeServer();
		registerUpdateMemberRole(server, {
			userId: "u1",
			scopes: [SCOPES.read, SCOPES.write],
			authKind: "oauth",
		});

		const out = (await capture()(updateArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.projectsWrite);
		expect(updateProjectMemberRole).not.toHaveBeenCalled();
	});
});

describe("registerUpdateMemberRole — happy path", () => {
	it("applies the change and projects the wire shape", async () => {
		vi.mocked(updateProjectMemberRole).mockResolvedValueOnce({
			memberId: "mem-2",
			userId: "u2",
			name: "Grace Hopper",
			email: "grace@dimagi.com",
			previousRole: "editor",
			role: "admin",
		});

		const { server, capture } = makeFakeServer();
		registerUpdateMemberRole(server, toolCtx);

		const out = (await capture()(updateArgs)) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(updateProjectMemberRole).toHaveBeenCalledWith({
			projectId: "proj-shared",
			actorUserId: "u1",
			memberId: "mem-2",
			role: "admin",
		});
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			project_id: "proj-shared",
			member_id: "mem-2",
			user_id: "u2",
			name: "Grace Hopper",
			email: "grace@dimagi.com",
			previous_role: "editor",
			role: "admin",
		});
	});
});

describe("registerUpdateMemberRole — denials", () => {
	it("collapses a non-member caller to the Project-flavored not-found envelope", async () => {
		vi.mocked(updateProjectMemberRole).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { server, capture } = makeFakeServer();
		registerUpdateMemberRole(server, toolCtx);

		const out = (await capture()(updateArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("Project not found.");
	});

	it("passes the owner-row refusal through verbatim as invalid_input", async () => {
		const message = "The Project owner's role can't be changed.";
		vi.mocked(updateProjectMemberRole).mockRejectedValueOnce(
			new ProjectManagementError(message),
		);

		const { server, capture } = makeFakeServer();
		registerUpdateMemberRole(server, toolCtx);

		const out = (await capture()(updateArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toBe(message);
	});
});
