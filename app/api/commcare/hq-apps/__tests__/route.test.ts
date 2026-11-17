/**
 * The picker's list route as a shell over its service: who may call it, the
 * query it accepts, that a stop is an answer, and the hosts that reach it.
 *
 * The service is replaced, since its reads are
 * `lib/deployment/reading/__tests__/picker.postgres.test.ts`'s. An
 * unauthenticated list, a refused query that still reaches CommCare HQ, a
 * stop answered as an error status, and the deploy-time 404 of a route the
 * main host's allowlist does not reach are what these cases would catch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/apiError";
import type { HqAppPicker } from "@/lib/deployment";
import { listHqAppsForPicker } from "@/lib/deployment/reading";
import { HOSTNAMES, isPathAllowedOnHost } from "@/lib/hostnames";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";
import { GET } from "../route";

const { requireSessionMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/deployment/reading", () => ({
	listHqAppsForPicker: vi.fn(),
}));

const ACTOR = "picker-user";

function request(query: string): Request {
	return new Request(`http://localhost/api/commcare/hq-apps${query}`);
}

beforeEach(() => {
	requireSessionMock.mockReset();
	requireSessionMock.mockResolvedValue({ user: { id: ACTOR } });
	vi.mocked(listHqAppsForPicker).mockReset();
});

describe("GET /api/commcare/hq-apps", () => {
	it("answers 401 without a session and lists nothing", async () => {
		requireSessionMock.mockRejectedValue(
			new ApiError("Authentication required", 401),
		);
		const response = await GET(request("?domain=clinic"));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Authentication required" });
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(listHqAppsForPicker).not.toHaveBeenCalled();
	});

	it.each([
		["no domain", ""],
		["an empty domain", "?domain="],
		["a domain with a slash", "?domain=clinic%2Fother"],
		["a domain with a space", "?domain=clinic%20space"],
		["a dot segment", "?domain=.."],
	])(
		"answers 400 with invalid_input for %s and asks nothing",
		async (_, query) => {
			const response = await GET(request(query));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: READING_REFUSAL_COPY.invalid_input,
				code: "invalid_input",
			});
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
			expect(listHqAppsForPicker).not.toHaveBeenCalled();
		},
	);

	it("answers a stop as 200, with the stop in the body", async () => {
		const picker: HqAppPicker = {
			kind: "stop",
			finding: circumstanceFinding("not-a-member", { kind: "app" }, {}),
		};
		vi.mocked(listHqAppsForPicker).mockResolvedValue(picker);
		const response = await GET(request("?domain=clinic"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ picker });
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(listHqAppsForPicker).toHaveBeenCalledWith(
			{ userId: ACTOR },
			{ domain: "clinic" },
		);
	});

	it("answers the list for the session's own user", async () => {
		const picker: HqAppPicker = {
			kind: "apps",
			server: "india",
			domain: "clinic-2",
			apps: [{ remoteAppId: "a".repeat(32), name: "Visits", claim: null }],
		};
		vi.mocked(listHqAppsForPicker).mockResolvedValue(picker);
		const response = await GET(request("?domain=clinic-2"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ picker });
		expect(listHqAppsForPicker).toHaveBeenCalledWith(
			{ userId: ACTOR },
			{ domain: "clinic-2" },
		);
	});
});

describe("the hosts that reach the picker's routes", () => {
	it.each(["/api/commcare/hq-apps", "/api/commcare/connection"])(
		"admits %s on the main host and refuses it on the MCP and docs hosts",
		(path) => {
			expect(isPathAllowedOnHost(HOSTNAMES.main, path)).toBe(true);
			expect(isPathAllowedOnHost(HOSTNAMES.mcp, path)).toBe(false);
			expect(isPathAllowedOnHost(HOSTNAMES.docs, path)).toBe(false);
		},
	);
});
