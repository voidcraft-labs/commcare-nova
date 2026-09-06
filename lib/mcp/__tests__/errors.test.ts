/** Pure exception-to-wire projection. Real access checks belong in the
 * Postgres suites; these vectors protect error taxonomy and information flow. */
import { expect, it, vi } from "vitest";
import { AppPaginationError } from "@/lib/db/appPagination";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
} from "@/lib/db/commitGuard";
import { DeploymentError } from "@/lib/deployment/errors";
import { log } from "@/lib/logger";
import {
	ProjectManagementError,
	ProjectPermissionError,
} from "@/lib/projects/manage";
import { McpInvalidInputError, toMcpErrorResult } from "../errors";
import { McpAccessError } from "../ownership";
import { McpScopeError } from "../scopes";

const context = { appId: "app", projectId: "project", userId: "private-actor" };
function envelope(payload: Record<string, unknown>) {
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
}
function contextual(error_type: string, message: string) {
	return envelope({
		error_type,
		message,
		app_id: "app",
		project_id: "project",
	});
}
it.each(["app", "project"] as const)(
	"collapses both %s access reasons to one complete public envelope",
	(resource) => {
		const expected = contextual(
			"not_found",
			resource === "app" ? "App not found." : "Project not found.",
		);
		for (const reason of ["not_found", "not_owner"] as const) {
			expect(
				toMcpErrorResult(new McpAccessError(reason, resource), context),
			).toEqual(expected);
		}
		expect(log.error).not.toHaveBeenCalled();
	},
);
it("collapses a commit-time permission loss without exposing its private reason", () => {
	expect(
		toMcpErrorResult(
			new CommitReauthError("private membership detail"),
			context,
		),
	).toEqual(contextual("not_found", "App not found."));
	expect(log.error).not.toHaveBeenCalled();
});
it.each([
	{
		error: new AppPaginationError(),
		type: "invalid_input",
		message: "This pagination cursor is invalid. Try again without a cursor.",
	},
	{
		error: new McpInvalidInputError("Choose an app."),
		type: "invalid_input",
		message: "Choose an app.",
	},
	{
		error: new ProjectManagementError("An invitation is already pending."),
		type: "invalid_input",
		message: "An invitation is already pending.",
	},
	{
		error: new ProjectPermissionError("Your role cannot invite members."),
		type: "permission_denied",
		message: "Your role cannot invite members.",
	},
	{
		error: new BlueprintCommitRejectedError(
			"This change conflicts with the current app. Nothing changed.",
		),
		type: "invalid_input",
		message: "This change conflicts with the current app. Nothing changed.",
	},
	{
		error: new AppProjectChangedError(),
		type: "invalid_input",
		message:
			"This app moved to a different Project while you were editing. Reload to get the latest state.",
	},
])(
	"preserves the expected $error.name outcome without reporting an operational failure",
	({ error, type, message }) => {
		expect(toMcpErrorResult(error, context)).toEqual(contextual(type, message));
		expect(log.error).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledOnce();
	},
);
it.each([
	{ code: "hq_not_connected" as const, type: "hq_not_configured" },
	{ code: "domain_not_authorized" as const, type: "domain_not_authorized" },
	{ code: "not_found" as const, type: "not_found" },
	{ code: "invalid" as const, type: "invalid_input" },
])(
	"maps deployment $code to the external $type category without leaking its cause",
	({ code, type }) => {
		expect(
			toMcpErrorResult(
				new DeploymentError(code, "A safe next step.", {
					cause: new Error("private HQ response"),
				}),
				context,
			),
		).toEqual(contextual(type, "A safe next step."));
		expect(log.error).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledOnce();
	},
);
it.each(["oauth", "api-key"] as const)(
	"publishes a machine-readable missing scope for %s",
	(authKind) => {
		const error = new McpScopeError(
			"nova.hq.read",
			"get_hq_connection",
			authKind,
		);
		for (const ctx of [undefined, {}, context]) {
			expect(toMcpErrorResult(error, ctx)).toEqual(
				envelope({
					error_type: "scope_missing",
					message: error.message,
					required_scope: "nova.hq.read",
					...(ctx === context ? { app_id: "app", project_id: "project" } : {}),
				}),
			);
		}
	},
);
it("reports a save-id collision as a server fault without serializing internal error properties", () => {
	const error = Object.assign(new MutationBatchIdCollisionError(), {
		batchId: "private-id",
		mutations: [{ private: true }],
	});
	expect(toMcpErrorResult(error, context)).toEqual(
		contextual(
			"internal",
			"This edit could not be saved: Nova reused a save id for different content. Nothing was written. This is a fault on our side, not something to correct in the request. Repeating it will not help.",
		),
	);
	expect(log.error).toHaveBeenCalledOnce();
});
it("projects classified errors and arbitrary thrown values without raw text, stacks, actor ids or extra keys", () => {
	const circular: { self?: unknown } = {};
	circular.self = circular;
	for (const error of [
		new Error("private SQL text"),
		"private string",
		null,
		{ private: true },
		circular,
	]) {
		for (const ctx of [undefined, {}, context]) {
			expect(toMcpErrorResult(error, ctx)).toEqual(
				envelope({
					error_type: "internal",
					message: "Something went wrong during generation.",
					...(ctx === context ? { app_id: "app", project_id: "project" } : {}),
				}),
			);
		}
	}
	vi.mocked(log.error).mockClear();
	expect(
		toMcpErrorResult(
			new DOMException("private connection", "AbortError"),
			context,
		),
	).toEqual(
		contextual("api_timeout", "The request timed out. Please try again."),
	);
	expect(log.error).toHaveBeenCalledOnce();
});
