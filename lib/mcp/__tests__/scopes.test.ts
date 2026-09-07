import { expect, it } from "vitest";
import { assertScope, McpScopeError, parseScopes, SCOPES } from "../scopes";

it("preserves external and repeated claims while removing empty whitespace tokens", () => {
	expect(
		parseScopes(
			"  openid\r\n nova.read\t nova.write nova.read offline_access ",
		),
	).toEqual([
		"openid",
		"nova.read",
		"nova.write",
		"nova.read",
		"offline_access",
	]);
	for (const input of [undefined, "", " \r\n\t "])
		expect(parseScopes(input)).toEqual([]);
});
it("preserves all six issued credential scope names", () => {
	expect(SCOPES).toEqual({
		read: "nova.read",
		write: "nova.write",
		hqRead: "nova.hq.read",
		hqWrite: "nova.hq.write",
		projectsRead: "nova.projects.read",
		projectsWrite: "nova.projects.write",
	});
});
it.each(Object.values(SCOPES))(
	"requires the exact %s grant; other grants do not imply it",
	(required) => {
		expect(() =>
			assertScope(
				{ scopes: ["openid", required, "offline_access"], authKind: "oauth" },
				required,
				"probe",
			),
		).not.toThrow();
		for (const scopes of [
			[],
			Object.values(SCOPES).filter((scope) => scope !== required),
			[required.toUpperCase(), `${required}.extra`],
		]) {
			expect(() =>
				assertScope({ scopes, authKind: "oauth" }, required, "probe"),
			).toThrow(McpScopeError);
		}
	},
);
it.each([
	{
		authKind: "oauth" as const,
		remedy: "Re-authorize the connecting client to grant it.",
	},
	{
		authKind: "api-key" as const,
		remedy: "Edit the API key's scopes in Nova settings to grant it.",
	},
])(
	"carries the missing grant and actionable $authKind remediation",
	({ authKind, remedy }) => {
		expect(() =>
			assertScope(
				{ scopes: ["nova.read", "nova.write"], authKind },
				"nova.hq.write",
				"upload_app_to_hq",
			),
		).toThrow(
			expect.objectContaining({
				name: "McpScopeError",
				requiredScope: "nova.hq.write",
				toolName: "upload_app_to_hq",
				authKind,
				message: `Tool "upload_app_to_hq" requires the "HQ Write" permission, which isn't granted on this credential. ${remedy}`,
			}),
		);
	},
);
