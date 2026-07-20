/**
 * `GET /api/dev/login` — the local-dev one-URL sign-in.
 *
 * The route is a login backdoor by design, so what these tests pin is the
 * cage around it: the prod hard-gate (404 outside `NODE_ENV=development`,
 * before any auth machinery loads a session into existence), the
 * local-Postgres refusal (`NOVA_DB_LOCAL_URL`), the input rejections, and
 * that a minted cookie is exactly `signSessionCookie` over a token that was
 * actually written as a session row. The proxy-layer half of the cage — the
 * path staying OFF every host allowlist — is pinned in
 * `lib/__tests__/hostnames.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { GET } from "../route";

const { getAuthMock, ensurePersonalProjectMock, findOneMock, createMock } =
	vi.hoisted(() => ({
		getAuthMock: vi.fn(),
		ensurePersonalProjectMock: vi.fn(),
		findOneMock: vi.fn(),
		createMock: vi.fn(),
	}));

vi.mock("@/lib/auth", () => ({ getAuth: getAuthMock }));
vi.mock("@/lib/auth/provisionProject", () => ({
	ensurePersonalProject: ensurePersonalProjectMock,
}));

const TEST_SECRET = "x".repeat(32);

function loginReq(query = ""): Request {
	return new Request(`http://localhost:3000/api/dev/login${query}`);
}

beforeEach(() => {
	vi.clearAllMocks();
	// The route hard-gates on NODE_ENV (vitest runs as "test").
	vi.stubEnv("NODE_ENV", "development");
	vi.stubEnv(
		"NOVA_DB_LOCAL_URL",
		"postgres://nova:nova@localhost:5432/nova_cases",
	);
	vi.stubEnv("BETTER_AUTH_SECRET", TEST_SECRET);
	getAuthMock.mockResolvedValue({
		$context: Promise.resolve({
			adapter: { findOne: findOneMock, create: createMock },
		}),
	});
	findOneMock.mockResolvedValue(null);
	createMock.mockResolvedValue(undefined);
	ensurePersonalProjectMock.mockResolvedValue("project-1");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("GET /api/dev/login", () => {
	it("404s outside NODE_ENV=development before touching any auth machinery", async () => {
		for (const env of ["test", "production"]) {
			vi.stubEnv("NODE_ENV", env);
			const res = await GET(loginReq());
			expect(res.status).toBe(404);
			/* Drain the body — an unread `Response.json` body holds an internal
			 * promise open forever, which the async-leak gate flags (same
			 * phenomenon `proxy.ts::notFound` documents). Ditto below. */
			await res.text();
		}
		expect(getAuthMock).not.toHaveBeenCalled();
		expect(createMock).not.toHaveBeenCalled();
	});

	it("refuses to run without NOVA_DB_LOCAL_URL (the keep-it-off-Cloud-SQL guard)", async () => {
		vi.stubEnv("NOVA_DB_LOCAL_URL", "");
		const res = await GET(loginReq());
		expect(res.status).toBe(500);
		expect((await res.json()).error).toContain("NOVA_DB_LOCAL_URL");
		expect(getAuthMock).not.toHaveBeenCalled();
	});

	it("rejects a malformed `as` slug before any database write", async () => {
		const res = await GET(loginReq("?as=Not%20A%20Slug!"));
		expect(res.status).toBe(400);
		await res.text();
		expect(getAuthMock).not.toHaveBeenCalled();
	});

	it("rejects an absolute / protocol-relative `next` (no open redirect)", async () => {
		for (const next of ["https://evil.example", "//evil.example/x"]) {
			const res = await GET(loginReq(`?next=${encodeURIComponent(next)}`));
			expect(res.status).toBe(400);
			await res.text();
		}
		expect(createMock).not.toHaveBeenCalled();
	});

	it("mints a session row and sets its signSessionCookie-signed cookie", async () => {
		const res = await GET(loginReq("?next=/build/new"));
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/build/new");

		const userCreate = createMock.mock.calls.find(
			([arg]) => arg.model === "user",
		);
		expect(userCreate?.[0].data).toMatchObject({
			id: "local-agent",
			email: "agent@dimagi.com",
		});
		expect(ensurePersonalProjectMock).toHaveBeenCalledWith("local-agent");

		const sessionCreate = createMock.mock.calls.find(
			([arg]) => arg.model === "session",
		);
		const token = sessionCreate?.[0].data.token;
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		const cookie = res.headers.get("set-cookie");
		expect(cookie).toContain(
			`better-auth.session_token=${signSessionCookie(token, TEST_SECRET)}`,
		);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
	});

	it("reuses an existing user (`?as=` identity) instead of re-creating it", async () => {
		findOneMock.mockResolvedValue({ id: "local-agent-alice" });
		const res = await GET(loginReq("?as=alice"));
		expect(res.status).toBe(303);
		expect(
			createMock.mock.calls.find(([arg]) => arg.model === "user"),
		).toBeUndefined();
		const sessionCreate = createMock.mock.calls.find(
			([arg]) => arg.model === "session",
		);
		expect(sessionCreate?.[0].data.userId).toBe("local-agent-alice");
	});
});
