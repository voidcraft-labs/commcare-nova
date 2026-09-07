/** Pure access-error translation; no resolver mocks. Persisted membership
 * and capability forwarding are tested through the wrappers in Postgres. */
import { expect, it } from "vitest";
import { AppAccessError } from "@/lib/db/appAccess";
import { rethrowAsMcpAccess, rethrowAsMcpProjectAccess } from "../ownership";

it.each(["not_found", "not_member", "insufficient_role"] as const)(
	"collapses app %s into the internal MCP reason",
	(reason) => {
		expect(() => rethrowAsMcpAccess(new AppAccessError(reason))).toThrow(
			expect.objectContaining({
				name: "McpAccessError",
				resource: "app",
				reason: reason === "not_found" ? "not_found" : "not_owner",
			}),
		);
	},
);
it.each(["not_found", "not_member"] as const)(
	"keeps the Project resource on %s refusal",
	(reason) => {
		expect(() => rethrowAsMcpProjectAccess(new AppAccessError(reason))).toThrow(
			expect.objectContaining({
				name: "McpAccessError",
				resource: "project",
				reason: reason === "not_found" ? "not_found" : "not_owner",
			}),
		);
	},
);
it("gives an existing Project member a permission explanation with the caller's next step or default", () => {
	for (const message of [
		undefined,
		"Ask a Project admin to invite this person.",
	]) {
		expect(() =>
			rethrowAsMcpProjectAccess(
				new AppAccessError("insufficient_role"),
				message,
			),
		).toThrow(
			expect.objectContaining({
				name: "ProjectPermissionError",
				message:
					message ??
					"Your role in this Project doesn't allow this action. Ask a Project admin or owner to do it, or to raise your role.",
			}),
		);
	}
});
it("propagates infrastructure exceptions and non-Error throws unchanged", () => {
	for (const error of [
		new Error("SQL connection failed"),
		null,
		{ code: "connection_lost" },
	]) {
		for (const map of [rethrowAsMcpAccess, rethrowAsMcpProjectAccess]) {
			let thrown: unknown = Symbol("not thrown");
			try {
				map(error);
			} catch (caught) {
				thrown = caught;
			}
			expect(thrown).toBe(error);
		}
	}
});
