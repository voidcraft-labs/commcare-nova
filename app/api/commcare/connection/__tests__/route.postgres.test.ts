/**
 * The connection route against real `user_settings` rows: it answers the
 * session's own stored connection, in exactly the public shape the page
 * already receives, and nothing of the stored key.
 *
 * Only `requireSession` is replaced, by one that answers the session the
 * test names; the settings read runs against the per-test Postgres.
 */

import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/apiError";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const { requireSessionMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
}));

const { GET } = await import("../route");

const h = setupAppStateTestDb("commcare_connection_route_");

const ACTOR = "connection-reader";
const OTHER = "connection-stranger";
const STORED_KEY = "opaque-ciphertext-of-the-key";

/** Answer as `requireSession` does: the named user's session, or 401. */
function signedInAs(userId: string | null) {
	requireSessionMock.mockImplementation(async () => {
		if (userId === null) throw new ApiError("Authentication required", 401);
		return { user: { id: userId } };
	});
}

async function seed(
	userId: string,
	server: string,
	domains: readonly { name: string; displayName: string }[],
) {
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: userId,
			commcare_username: `${userId}@dimagi.com`,
			commcare_api_key: STORED_KEY,
			commcare_server: server,
			approved_domains: JSON.stringify(domains),
			updated_at: new Date(),
		})
		.execute();
}

async function read(): Promise<{ status: number; body: unknown }> {
	const response = await GET(
		new Request("http://localhost/api/commcare/connection"),
	);
	return { status: response.status, body: await response.json() };
}

beforeEach(() => {
	requireSessionMock.mockReset();
});

it("answers the session's own connection in its public shape and nothing of the stored key", async () => {
	const domains = [
		{ name: "clinic", displayName: "Clinic team" },
		{ name: "training", displayName: "Training" },
	];
	await seed(OTHER, "eu", [{ name: "foreign", displayName: "Foreign" }]);
	await seed(ACTOR, "india", domains);
	signedInAs(ACTOR);

	const { status, body } = await read();

	expect(status).toBe(200);
	expect(body).toEqual({
		connection: {
			configured: true,
			username: `${ACTOR}@dimagi.com`,
			server: "india",
			availableDomains: domains,
		},
	});
	const { connection } = body as { connection: Record<string, unknown> };
	expect(Object.keys(connection).sort()).toEqual([
		"availableDomains",
		"configured",
		"server",
		"username",
	]);
	expect(JSON.stringify(body)).not.toContain(STORED_KEY);
});

it("never answers another person's row", async () => {
	await seed(OTHER, "production", [{ name: "theirs", displayName: "Theirs" }]);
	signedInAs(ACTOR);

	expect(await read()).toEqual({
		status: 200,
		body: { connection: { configured: false } },
	});
});

it("answers a person with no stored row as not configured", async () => {
	signedInAs(ACTOR);

	expect(await read()).toEqual({
		status: 200,
		body: { connection: { configured: false } },
	});
});

it("answers 401 without a session and reads nothing", async () => {
	await seed(ACTOR, "production", [{ name: "clinic", displayName: "Clinic" }]);
	signedInAs(null);

	const { status, body } = await read();

	expect(status).toBe(401);
	expect(body).toEqual({ error: "Authentication required" });
});
