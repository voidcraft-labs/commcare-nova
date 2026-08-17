/**
 * `registerInviteMember` unit tests.
 *
 * Verifies the load-bearing behaviors of the invitation tool:
 *   - Scope gate FIRST — a token without `nova.projects.write` gets
 *     `scope_missing` (with the target `project_id` stamped on the
 *     payload) and the manage layer is never reached, so a scope-less
 *     credential can't probe whether the Project exists.
 *   - Happy-path projection — the manage layer's `CreatedInvitation`
 *     becomes the full wire body, including the no-email `note` so an
 *     agent tells the human to expect the in-app banner rather than an
 *     email that will never arrive.
 *   - IDOR collapse — an `AppAccessError` for a Project the caller isn't
 *     a member of surfaces as `not_found` + "Project not found.", never
 *     as a membership hint.
 *   - Permission mapping — `insufficient_role` from the access layer and
 *     `ProjectPermissionError` from the manage layer both surface as
 *     `permission_denied` with their respective copy.
 *   - Policy rejection passthrough — a `ProjectManagementError`
 *     (duplicate invite here) surfaces as `invalid_input` verbatim.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	createProjectInvitation,
	ProjectManagementError,
	ProjectPermissionError,
} from "@/lib/projects/manage";
import { SCOPES } from "../scopes";
import { registerInviteMember } from "../tools/inviteMember";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Keep the real error classes (the error serializer and the access
 * mapper branch on `instanceof`) and stub only the write. */
vi.mock("@/lib/projects/manage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/projects/manage")>()),
	createProjectInvitation: vi.fn(),
}));

const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.projectsWrite],
	authKind: "oauth",
};

/** Baseline args every test reuses; the Project id also shows up in
 * error payload assertions. */
const inviteArgs = {
	project_id: "proj-shared",
	email: "ada@dimagi.com",
	role: "editor",
};

function parsePayload(out: { content: Array<{ type: "text"; text: string }> }) {
	return JSON.parse(out.content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
	vi.mocked(createProjectInvitation).mockReset();
});

describe("registerInviteMember — scope gate", () => {
	it("rejects a token without nova.projects.write before any data read", async () => {
		const { server, capture } = makeFakeServer();
		registerInviteMember(server, {
			userId: "u1",
			scopes: [SCOPES.read, SCOPES.write],
			authKind: "oauth",
		});

		const out = (await capture()(inviteArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.projectsWrite);
		expect(payload.project_id).toBe("proj-shared");
		expect(createProjectInvitation).not.toHaveBeenCalled();
	});
});

describe("registerInviteMember — happy path", () => {
	it("creates the invitation and returns the wire body with the no-email note", async () => {
		vi.mocked(createProjectInvitation).mockResolvedValueOnce({
			invitationId: "inv-1",
			projectId: "proj-shared",
			projectName: "Team Alpha",
			email: "ada@dimagi.com",
			role: "editor",
			expiresAt: new Date("2026-08-18T12:00:00.000Z"),
		});

		const { server, capture } = makeFakeServer();
		registerInviteMember(server, toolCtx);

		const out = (await capture()(inviteArgs)) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(createProjectInvitation).toHaveBeenCalledWith({
			projectId: "proj-shared",
			actorUserId: "u1",
			email: "ada@dimagi.com",
			role: "editor",
		});
		expect(parsePayload(out)).toEqual({
			invitation_id: "inv-1",
			project_id: "proj-shared",
			project_name: "Team Alpha",
			email: "ada@dimagi.com",
			role: "editor",
			expires_at: "2026-08-18T12:00:00.000Z",
			note: "No email is sent. ada@dimagi.com will see this invitation in commcare nova the next time they sign in, and can accept it there.",
		});
	});
});

describe("registerInviteMember — access denials", () => {
	it("collapses a non-member caller to the Project-flavored not-found envelope", async () => {
		vi.mocked(createProjectInvitation).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { server, capture } = makeFakeServer();
		registerInviteMember(server, toolCtx);

		const out = (await capture()(inviteArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("Project not found.");
	});

	it("maps an access-layer insufficient_role to the generic safety-net permission copy", async () => {
		/* In practice the manage layer refuses under-privileged actors itself
		 * with copy naming their actual role (next test); this arm is the
		 * shared fallback for a raw access-layer denial, so it carries the
		 * generic message rather than tool-specific copy. */
		vi.mocked(createProjectInvitation).mockRejectedValueOnce(
			new AppAccessError("insufficient_role"),
		);

		const { server, capture } = makeFakeServer();
		registerInviteMember(server, toolCtx);

		const out = (await capture()(inviteArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("permission_denied");
		expect(payload.message).toBe(
			"Your role in this Project doesn't allow this action. Ask a Project admin or owner to do it, or to raise your role.",
		);
	});

	it("passes the manage layer's own ProjectPermissionError copy through", async () => {
		const message =
			"Your editor role in this Project can't invite members. Ask a Project admin or the owner.";
		vi.mocked(createProjectInvitation).mockRejectedValueOnce(
			new ProjectPermissionError(message),
		);

		const { server, capture } = makeFakeServer();
		registerInviteMember(server, toolCtx);

		const out = (await capture()(inviteArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("permission_denied");
		expect(payload.message).toBe(message);
	});
});

describe("registerInviteMember — policy rejection", () => {
	it("passes a ProjectManagementError (duplicate invite) through as invalid_input", async () => {
		const message =
			"ada@dimagi.com already has a pending invitation to this Project. It expires within 48 hours; re-invite after that if it lapses.";
		vi.mocked(createProjectInvitation).mockRejectedValueOnce(
			new ProjectManagementError(message),
		);

		const { server, capture } = makeFakeServer();
		registerInviteMember(server, toolCtx);

		const out = (await capture()(inviteArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toBe(message);
		expect(payload.project_id).toBe("proj-shared");
	});
});
