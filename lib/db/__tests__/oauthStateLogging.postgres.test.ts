import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { expect, it, vi } from "vitest";
import { forwardBetterAuthLog } from "@/lib/auth-logger";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";

const h = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "oauth_state_log_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (_db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
	},
});
const baseURL = "http://localhost:3000";
function fixture() {
	const sink = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
	const auth = betterAuth({
		...authMigrateOptions(h.pool),
		secret: "oauth-state-contract-secret-at-least-32-chars",
		baseURL,
		socialProviders: {
			google: { clientId: "local-contract", clientSecret: "local-contract" },
		},
		onAPIError: { errorURL: `${baseURL}/` },
		logger: {
			log: (level, message, ...args) =>
				forwardBetterAuthLog(level, message, args, sink),
		},
	});
	const callback = (state: string, cookie = "") =>
		auth.handler(
			new Request(
				`${baseURL}/api/auth/callback/google?state=${encodeURIComponent(state)}&code=unused`,
				{ headers: { cookie } },
			),
		);
	return { auth, sink, callback };
}
async function start(auth: ReturnType<typeof fixture>["auth"]) {
	const response = await auth.api.signInSocial({
		body: { provider: "google", callbackURL: `${baseURL}/settings` },
		asResponse: true,
	});
	expect(response.status).toBe(200);
	const { url } = await response.json();
	const state = new URL(url).searchParams.get("state");
	if (!state) throw new Error("Provider did not create state");
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	return { state, cookie };
}
it("rejects a missing verification with a sanitized info event and no Sentry error", async () => {
	const { callback, sink } = fixture();
	const response = await callback("private-state-token");
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).toBe(
		`${baseURL}/?error=state_mismatch`,
	);
	expect(sink.info).toHaveBeenCalledWith(
		"[better-auth] Sign-in attempt needs restarting",
		{
			event: "oauth_sign_in_rejected",
			reason: "verification_missing",
		},
	);
	expect(sink.error).not.toHaveBeenCalled();
	expect(JSON.stringify(sink.info.mock.calls)).not.toContain(
		"private-state-token",
	);
});
it("rejects an expired sign-in without accepting it or reporting a defect", async () => {
	const { auth, callback, sink } = fixture();
	const { state, cookie } = await start(auth);
	await h.pool.query(
		`UPDATE auth_verification SET value = (value::jsonb || '{"expiresAt":0}'::jsonb)::text`,
	);
	const response = await callback(state, cookie);
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).toBe(
		`${baseURL}/?error=state_mismatch`,
	);
	expect(sink.info).toHaveBeenCalledWith(
		"[better-auth] Sign-in attempt needs restarting",
		{
			event: "oauth_sign_in_rejected",
			reason: "state_expired",
		},
	);
	expect(sink.error).not.toHaveBeenCalled();
	const sessions = await h.pool.query("SELECT id FROM auth_session");
	expect(sessions.rows).toEqual([]);
});
it("keeps security mismatches and malformed stored state as errors", async () => {
	const { auth, callback, sink } = fixture();
	const { state } = await start(auth);
	await callback(state); // Real state with no matching state cookie.
	expect(sink.error).toHaveBeenCalledWith(
		"[better-auth] Failed to parse state",
		expect.objectContaining({ code: "state_security_mismatch" }),
		undefined,
	);
	sink.error.mockClear();
	await h.pool.query("UPDATE auth_verification SET value = 'invalid-json'");
	await callback(state);
	expect(sink.error).toHaveBeenCalledWith(
		"[better-auth] Failed to parse state",
		expect.any(SyntaxError),
		undefined,
	);
	expect(sink.info).not.toHaveBeenCalled();
});
it("keeps a real database failure as an error", async () => {
	const { auth, callback, sink } = fixture();
	await auth.$context;
	await callback("initialize-router");
	sink.info.mockClear();
	sink.error.mockClear();
	await h.pool.query(
		"ALTER TABLE auth_verification RENAME TO unavailable_verification",
	);
	try {
		const response = await callback("state-during-outage");
		expect(response.headers.get("location")).toBe(
			`${baseURL}/?error=internal_server_error`,
		);
		expect(sink.error).toHaveBeenCalledWith(
			"[better-auth] Failed to parse state",
			expect.objectContaining({ code: "42P01" }),
			undefined,
		);
		expect(sink.info).not.toHaveBeenCalled();
	} finally {
		await h.pool.query(
			"ALTER TABLE unavailable_verification RENAME TO auth_verification",
		);
	}
});

it("rejects a callback with no state as an expected incomplete sign-in", async () => {
	const { callback, sink } = fixture();
	const response = await callback("");
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).toBe(
		`${baseURL}/?error=state_not_found`,
	);
	// The callback rejects before parseState and uses a separate log shape.
	expect(sink.info).toHaveBeenCalledWith(
		"[better-auth] Sign-in attempt needs restarting",
		{
			event: "oauth_sign_in_rejected",
			reason: "state_parameter_missing",
		},
	);
	expect(sink.error).not.toHaveBeenCalled();
});
