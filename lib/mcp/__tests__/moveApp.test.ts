/**
 * `registerMoveApp` unit tests.
 *
 * Verifies the load-bearing behaviors of the app-move tool:
 *   - Scope gate FIRST — a token without `nova.projects.write` gets
 *     `scope_missing` and the app resolver is never reached.
 *   - Happy-path plumbing — the source Project comes from
 *     `resolveAppScope` at the `delete` capability, the destination is
 *     preflighted at `delete` too, the transaction gets the exact
 *     `{ appId, fromProjectId, toProjectId, actorUserId }` tuple, and
 *     the wire body echoes the completed move with `result: "moved"`.
 *   - Same-Project target — `result: "already_in_project"` with the
 *     explanatory note; the app-state call still runs (it is the
 *     tenancy verify/repair), but the body reports no move.
 *   - IDOR collapse, per phase — a SOURCE denial surfaces as the
 *     APP-flavored "App not found." (the caller was probing an app id)
 *     and the move never runs; a DESTINATION non-member surfaces as the
 *     PROJECT-flavored "Project not found."; a destination member short
 *     of admin/owner gets the explicit permission message.
 *   - In-tool error mapping — `AppBusyError` and
 *     `AppRunStateCorruptError` become actionable `invalid_input` copy;
 *     `ProjectMoveDeniedError` (the transaction's governance re-check:
 *     source role, destination role, owner retention) surfaces as
 *     `permission_denied` with the arm's own message; a plain
 *     `CommitReauthError` (the app row vanished mid-move) falls to the
 *     classifier's not-found collapse, which is what it means.
 *   - `BlueprintCommitRejectedError` (immovable app: lookup tables,
 *     capture rows) passes through as `invalid_input` verbatim.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppAccessError,
	resolveAppScope,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
	ProjectMoveDeniedError,
} from "@/lib/db/commitGuard";
import {
	AppBusyError,
	AppRunStateCorruptError,
	moveAppToProject,
} from "@/lib/db/moveAppToProject";
import { SCOPES } from "../scopes";
import { registerMoveApp } from "../tools/moveApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Keep the real `AppAccessError` (the access mappers branch on
 * `instanceof`) and stub only the two resolvers the tool calls — the
 * source-app scope and the destination-Project preflight. */
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: vi.fn(),
	resolveProjectAccess: vi.fn(),
}));

/* The real module drags the full app-state data layer in; the tool needs
 * only the two error classes and the transaction entry point, so the mock
 * defines fresh classes instead of `importOriginal`. `instanceof` stays
 * consistent because the tool and the test both resolve this mock. */
vi.mock("@/lib/db/moveAppToProject", () => {
	class AppBusyError extends Error {
		readonly name = "AppBusyError";
	}
	class AppRunStateCorruptError extends Error {
		readonly name = "AppRunStateCorruptError";
	}
	return { AppBusyError, AppRunStateCorruptError, moveAppToProject: vi.fn() };
});

const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.projectsWrite],
	authKind: "oauth",
};

const moveArgs = { app_id: "app-1", to_project_id: "proj-dest" };

function parsePayload(out: { content: Array<{ type: "text"; text: string }> }) {
	return JSON.parse(out.content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
	vi.mocked(resolveAppScope).mockReset();
	vi.mocked(resolveProjectAccess).mockReset();
	vi.mocked(moveAppToProject).mockReset();
	/* Most tests need both resolutions to succeed; denial tests override
	 * per-call. */
	vi.mocked(resolveAppScope).mockResolvedValue({
		projectId: "proj-src",
		role: "owner",
		actorUserId: "u1",
	});
	vi.mocked(resolveProjectAccess).mockResolvedValue({
		projectId: "proj-dest",
		role: "admin",
		actorUserId: "u1",
	});
});

describe("registerMoveApp — scope gate", () => {
	it("rejects a token without nova.projects.write before resolving the app", async () => {
		const { server, capture } = makeFakeServer();
		registerMoveApp(server, {
			userId: "u1",
			scopes: [SCOPES.read, SCOPES.write],
			authKind: "oauth",
		});

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.projectsWrite);
		expect(resolveAppScope).not.toHaveBeenCalled();
	});
});

describe("registerMoveApp — happy path", () => {
	it("resolves source and destination at delete capability, runs the move, and reports it", async () => {
		vi.mocked(moveAppToProject).mockResolvedValueOnce(undefined);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(resolveAppScope).toHaveBeenCalledWith("app-1", "u1", "delete");
		expect(resolveProjectAccess).toHaveBeenCalledWith(
			"u1",
			"proj-dest",
			"delete",
		);
		expect(moveAppToProject).toHaveBeenCalledWith({
			appId: "app-1",
			fromProjectId: "proj-src",
			toProjectId: "proj-dest",
			actorUserId: "u1",
		});
		expect(parsePayload(out)).toEqual({
			app_id: "app-1",
			from_project_id: "proj-src",
			to_project_id: "proj-dest",
			result: "moved",
		});
	});

	it("reports already_in_project (no move) when the app is already there", async () => {
		/* Source resolution lands on the SAME Project the caller targeted.
		 * The app-state call still runs — it is the same-Project tenancy
		 * verify/repair — but the body must say nothing moved. */
		vi.mocked(resolveAppScope).mockResolvedValueOnce({
			projectId: "proj-dest",
			role: "owner",
			actorUserId: "u1",
		});
		vi.mocked(moveAppToProject).mockResolvedValueOnce(undefined);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(moveAppToProject).toHaveBeenCalledWith({
			appId: "app-1",
			fromProjectId: "proj-dest",
			toProjectId: "proj-dest",
			actorUserId: "u1",
		});
		const payload = parsePayload(out);
		expect(payload.result).toBe("already_in_project");
		expect(payload.app_id).toBe("app-1");
		expect(payload.project_id).toBe("proj-dest");
		expect(payload.from_project_id).toBeUndefined();
		expect(typeof payload.note).toBe("string");
	});
});

describe("registerMoveApp — source access denial", () => {
	it("collapses to the APP-flavored not-found and never runs the move", async () => {
		vi.mocked(resolveAppScope).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
		expect(resolveProjectAccess).not.toHaveBeenCalled();
		expect(moveAppToProject).not.toHaveBeenCalled();
	});
});

describe("registerMoveApp — destination preflight", () => {
	it("collapses a non-member destination to the PROJECT-flavored not-found", async () => {
		vi.mocked(resolveProjectAccess).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("Project not found.");
		expect(moveAppToProject).not.toHaveBeenCalled();
	});

	it("gives a destination member short of admin/owner the explicit permission message", async () => {
		vi.mocked(resolveProjectAccess).mockRejectedValueOnce(
			new AppAccessError("insufficient_role"),
		);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("permission_denied");
		expect(payload.message).toBe(
			"Moving an app into a Project requires an admin or owner role there. Ask an admin or owner of the destination Project to grant you that role, or have them move the app.",
		);
		expect(moveAppToProject).not.toHaveBeenCalled();
	});
});

describe("registerMoveApp — transaction refusals", () => {
	it("maps AppBusyError to retriable invalid_input copy", async () => {
		vi.mocked(moveAppToProject).mockRejectedValueOnce(new AppBusyError());

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toBe(
			"This app is being generated right now. Try the move again once the run finishes.",
		);
	});

	it("maps AppRunStateCorruptError to contact-support invalid_input copy", async () => {
		vi.mocked(moveAppToProject).mockRejectedValueOnce(
			new AppRunStateCorruptError(),
		);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toBe(
			"This app's run state is inconsistent, so it can't move until it's repaired. Contact support.",
		);
	});

	it("surfaces a ProjectMoveDeniedError (governance re-check) as permission_denied with its own copy", async () => {
		const message =
			"This move would take the app away from the source Project's owner. Either an owner moves the app themselves, or every owner of the source Project must already be a member of the destination Project.";
		vi.mocked(moveAppToProject).mockRejectedValueOnce(
			new ProjectMoveDeniedError(message),
		);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		/* Regression pin: the parent-class branch of the classifier renders
		 * a `CommitReauthError` as `not_found` + "App not found." — wrong
		 * for a governance refusal when the caller just proved source
		 * access. The in-tool catch must keep the transaction's own copy. */
		expect(payload.error_type).toBe("permission_denied");
		expect(payload.message).toBe(message);
	});

	it("lets a plain CommitReauthError (vanished app row) collapse to not-found", async () => {
		vi.mocked(moveAppToProject).mockRejectedValueOnce(
			new CommitReauthError("App not found."),
		);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
	});

	it("passes a BlueprintCommitRejectedError (immovable app) through as invalid_input", async () => {
		const message =
			"This app references lookup tables, which stay with their Project, so the app can't move.";
		vi.mocked(moveAppToProject).mockRejectedValueOnce(
			new BlueprintCommitRejectedError(message),
		);

		const { server, capture } = makeFakeServer();
		registerMoveApp(server, toolCtx);

		const out = (await capture()(moveArgs)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toBe(message);
		expect(payload.app_id).toBe("app-1");
		expect(payload.project_id).toBe("proj-dest");
	});
});
