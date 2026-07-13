/**
 * `registerGetHqConnection` unit tests.
 *
 * Wire-contract invariants the suite locks:
 *   - Configured → `{configured: true, server, server_url, available_domains}`.
 *     `available_domains` lists every reachable space (length 1 ⇒ single-space
 *     key); `server`/`server_url` name the HQ deployment the connection lives
 *     on. Username and any key material stay out of the wire. There is
 *     deliberately NO `domain` field — a multi-space key's target is chosen
 *     per upload (the caller asks the user), never returned here as a default.
 *   - Unconfigured → `{configured: false}`. Callers branch on the discriminant.
 *   - A `getCommCareSettings` throw surfaces as an MCP `isError: true`
 *     envelope via the shared classifier, never as an unhandled
 *     rejection.
 *
 * The DB boundary (`@/lib/db/settings::getCommCareSettings`) is mocked
 * directly — the tool should never reach the DB in unit tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommCareSettings } from "@/lib/db/settings";
import { SCOPES } from "../scopes";
import { registerGetHqConnection } from "../tools/getHqConnection";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("@/lib/db/settings", () => ({
	getCommCareSettings: vi.fn(),
}));

/* The `nova.hq.read` scope is required by the per-tool guard inside
 * `registerGetHqConnection`. The route-layer floor (`nova.read`,
 * `nova.write`) is irrelevant in these unit tests because we're calling
 * the handler directly — only the scope the handler itself reads from
 * `ctx.scopes` matters here. */
const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.hqRead],
	authKind: "oauth",
};

beforeEach(() => {
	vi.mocked(getCommCareSettings).mockReset();
});

describe("registerGetHqConnection — configured", () => {
	it("returns {configured, server, available_domains} (no domain) and forwards the caller userId to the DB layer", async () => {
		const acme = { name: "acme-research", displayName: "ACME Research" };
		vi.mocked(getCommCareSettings).mockResolvedValueOnce({
			configured: true,
			username: "alice@example.com",
			server: "eu",
			availableDomains: [acme],
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
			server: "eu",
			server_url: "https://eu.commcarehq.org",
			available_domains: [acme],
		});
		/* Regression locks — neither the username/key material nor any stored
		 * "default space" leaks onto the wire. */
		expect("username" in parsed).toBe(false);
		expect("domain" in parsed).toBe(false);
		/* Owner filter uses the authenticated caller, not a client arg. */
		expect(getCommCareSettings).toHaveBeenCalledWith("u1");
	});

	it("returns the full reachable set with no domain field for a multi-space key", async () => {
		const prod = { name: "connect-ace-prod", displayName: "ACE Prod" };
		const crispr = { name: "ace-crispr-connect", displayName: "CRISPR" };
		vi.mocked(getCommCareSettings).mockResolvedValueOnce({
			configured: true,
			username: "alice@example.com",
			server: "production",
			availableDomains: [prod, crispr],
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
			server: "production",
			server_url: "https://www.commcarehq.org",
			available_domains: [prod, crispr],
		});
		/* No default is ever returned — a multi-space key's target is the
		 * user's per-upload choice; the caller asks them which space. */
		expect("domain" in parsed).toBe(false);
	});
});

describe("registerGetHqConnection — not configured", () => {
	it("returns {configured: false} with no reachable-set fields", async () => {
		vi.mocked(getCommCareSettings).mockResolvedValueOnce({
			configured: false,
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
		/* Callers branch on the `configured` discriminant; an unconfigured
		 * row carries no `available_domains` to read. */
		expect("available_domains" in parsed).toBe(false);
	});
});

describe("registerGetHqConnection — missing nova.hq.read", () => {
	it("returns a scope_missing envelope without touching the DB", async () => {
		const { server, capture } = makeFakeServer();
		/* Caller's token has the route-layer floor scopes but not the
		 * orthogonal HQ-read scope — the per-tool guard must reject
		 * before any DB read fires. */
		registerGetHqConnection(server, {
			userId: "u1",
			scopes: [SCOPES.read, SCOPES.write],
			authKind: "oauth",
		});

		const out = (await capture()({})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
			required_scope?: string;
		};
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.hqRead);
		/* Pre-DB short-circuit: the handler must not have read settings. */
		expect(getCommCareSettings).not.toHaveBeenCalled();
	});
});

describe("registerGetHqConnection — getCommCareSettings throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type", async () => {
		vi.mocked(getCommCareSettings).mockRejectedValueOnce(new Error("db down"));

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
