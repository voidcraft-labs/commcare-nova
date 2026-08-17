/**
 * `registerListMembers` unit tests.
 *
 * Verifies the load-bearing behaviors of the member-listing tool:
 *   - Scope gate FIRST — a token without `nova.projects.read` gets
 *     `scope_missing` and the access resolver is never reached, so a
 *     scope-less credential can't probe whether the Project exists.
 *   - Happy-path projection — members and pending invitations map to
 *     their wire rows (member_id is the membership-row handle
 *     `update_member_role` takes; a legacy null invitation role projects
 *     as "viewer", never null).
 *   - IDOR collapse — a Project the caller isn't a member of surfaces as
 *     `not_found` + "Project not found.", and the membership reads never
 *     run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import {
	listPendingInvitations,
	listProjectMembers,
} from "@/lib/projects/membership";
import { SCOPES } from "../scopes";
import { registerListMembers } from "../tools/listMembers";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Keep the real `AppAccessError` (the access mapper branches on
 * `instanceof`) and stub only the resolver the tool calls. */
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveProjectAccess: vi.fn(),
}));

vi.mock("@/lib/projects/membership", () => ({
	listProjectMembers: vi.fn(),
	listPendingInvitations: vi.fn(),
}));

const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.projectsRead],
	authKind: "oauth",
};

beforeEach(() => {
	vi.mocked(resolveProjectAccess).mockReset();
	vi.mocked(listProjectMembers).mockReset();
	vi.mocked(listPendingInvitations).mockReset();
});

describe("registerListMembers — scope gate", () => {
	it("rejects a token without nova.projects.read before probing the Project", async () => {
		const { server, capture } = makeFakeServer();
		registerListMembers(server, {
			userId: "u1",
			scopes: [SCOPES.read, SCOPES.write],
			authKind: "oauth",
		});

		const out = (await capture()({ project_id: "proj-shared" })) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.projectsRead);
		/* Scope before data probe — the resolver never ran, so the token
		 * learned nothing about the Project's existence. */
		expect(resolveProjectAccess).not.toHaveBeenCalled();
	});
});

describe("registerListMembers — happy path", () => {
	it("projects members and pending invitations into the wire shape", async () => {
		vi.mocked(resolveProjectAccess).mockResolvedValueOnce({
			projectId: "proj-shared",
			role: "viewer",
			actorUserId: "u1",
		});
		vi.mocked(listProjectMembers).mockResolvedValueOnce([
			{
				memberId: "mem-1",
				userId: "u1",
				name: "Ada Lovelace",
				email: "ada@dimagi.com",
				role: "owner",
				createdAt: new Date("2026-07-01T00:00:00.000Z"),
			},
			{
				memberId: "mem-2",
				userId: "u2",
				name: "Grace Hopper",
				email: "grace@dimagi.com",
				role: "editor",
				createdAt: new Date("2026-07-02T00:00:00.000Z"),
			},
		]);
		vi.mocked(listPendingInvitations).mockResolvedValueOnce([
			{
				id: "inv-1",
				email: "lin@dimagi.com",
				role: null,
				expiresAt: new Date("2026-08-18T12:00:00.000Z"),
			},
		]);

		const { server, capture } = makeFakeServer();
		registerListMembers(server, toolCtx);

		const out = (await capture()({ project_id: "proj-shared" })) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(resolveProjectAccess).toHaveBeenCalledWith(
			"u1",
			"proj-shared",
			"view",
		);
		/* The read passes the current instant so already-expired invitations
		 * never reach the wire (parity with the invitee's banner read). */
		expect(listPendingInvitations).toHaveBeenCalledWith(
			"proj-shared",
			expect.any(Date),
		);
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			project_id: "proj-shared",
			members: [
				{
					member_id: "mem-1",
					user_id: "u1",
					name: "Ada Lovelace",
					email: "ada@dimagi.com",
					role: "owner",
					joined_at: "2026-07-01T00:00:00.000Z",
				},
				{
					member_id: "mem-2",
					user_id: "u2",
					name: "Grace Hopper",
					email: "grace@dimagi.com",
					role: "editor",
					joined_at: "2026-07-02T00:00:00.000Z",
				},
			],
			/* A legacy null invitation role projects as the plugin's default
			 * ("viewer") — the wire never carries a null role. */
			pending_invitations: [
				{
					invitation_id: "inv-1",
					email: "lin@dimagi.com",
					role: "viewer",
					expires_at: "2026-08-18T12:00:00.000Z",
				},
			],
		});
	});
});

describe("registerListMembers — access denial", () => {
	it("collapses a non-member caller to not-found and never reads members", async () => {
		vi.mocked(resolveProjectAccess).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { server, capture } = makeFakeServer();
		registerListMembers(server, toolCtx);

		const out = (await capture()({ project_id: "proj-foreign" })) as {
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
		expect(payload.project_id).toBe("proj-foreign");
		/* The PII reads sit strictly behind the access gate. */
		expect(listProjectMembers).not.toHaveBeenCalled();
		expect(listPendingInvitations).not.toHaveBeenCalled();
	});
});
