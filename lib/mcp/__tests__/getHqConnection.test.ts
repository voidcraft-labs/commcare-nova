/**
 * `registerGetHqConnection` unit tests.
 *
 * Three wire-contract invariants the suite locks:
 *   - Configured → `{configured: true, domain: {name, displayName}}`.
 *     Username and any key material stay out of the wire.
 *   - Unconfigured → `{configured: false}` with NO `domain` key.
 *     Callers branch on the discriminant shape; an explicit-null domain
 *     would require a two-field check.
 *   - A `getCommCareSettings` throw surfaces as an MCP `isError: true`
 *     envelope via the shared classifier, never as an unhandled
 *     rejection.
 *
 * The DB boundary (`@/lib/db/settings::getCommCareSettings`) is mocked
 * directly — the tool should never reach Firestore in unit tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommCareSettings } from "@/lib/db/settings";
import { registerGetHqConnection } from "../tools/getHqConnection";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("@/lib/db/settings", () => ({
	getCommCareSettings: vi.fn(),
}));

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(getCommCareSettings).mockReset();
});

describe("registerGetHqConnection — configured", () => {
	it("returns {configured: true, domain} and forwards the caller userId to the DB layer", async () => {
		vi.mocked(getCommCareSettings).mockResolvedValueOnce({
			configured: true,
			username: "alice@example.com",
			domain: { name: "acme-research", displayName: "ACME Research" },
		});

		const { server, capture } = makeFakeServer();
		registerGetHqConnection(server, toolCtx);

		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(parsed).toEqual({
			configured: true,
			domain: { name: "acme-research", displayName: "ACME Research" },
		});
		/* Regression lock — the username and any key material MUST NOT
		 * leak onto the wire. */
		expect("username" in parsed).toBe(false);
		/* Owner filter uses the authenticated caller, not a client arg. */
		expect(getCommCareSettings).toHaveBeenCalledWith("u1");
	});
});

describe("registerGetHqConnection — not configured", () => {
	it("returns {configured: false} with no domain key", async () => {
		vi.mocked(getCommCareSettings).mockResolvedValueOnce({
			configured: false,
			username: "",
			domain: null,
		});

		const { server, capture } = makeFakeServer();
		registerGetHqConnection(server, toolCtx);

		const out = (await capture()({})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(parsed).toEqual({ configured: false });
		/* Discriminant shape: absence of `domain` is the positive signal
		 * that the user has not connected HQ. A present-but-null `domain`
		 * would force clients to check both fields. */
		expect("domain" in parsed).toBe(false);
	});
});

describe("registerGetHqConnection — getCommCareSettings throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type", async () => {
		vi.mocked(getCommCareSettings).mockRejectedValueOnce(
			new Error("firestore down"),
		);

		const { server, capture } = makeFakeServer();
		registerGetHqConnection(server, toolCtx);

		const out = (await capture()({})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
		};
		expect(typeof payload.error_type).toBe("string");
		expect(payload.error_type?.length ?? 0).toBeGreaterThan(0);
	});
});
