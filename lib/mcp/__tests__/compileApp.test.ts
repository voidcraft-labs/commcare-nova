/**
 * `registerCompileApp` unit tests.
 *
 * Covers the five paths the route handler has to care about:
 *
 *   - Happy path, `format: "json"` — the tool ownership-gates,
 *     hydrates the blueprint, expands to HQ JSON, and returns a
 *     pretty-printed text payload with `_meta.format: "json"`.
 *   - Happy path, `format: "ccz"` — the same pipeline plus a
 *     `compileCcz` call; the returned text is base64 and
 *     `_meta.encoding: "base64"` tells clients to decode.
 *   - Ownership failure (`not_owner`) — short-circuits before any
 *     blueprint work and never calls `compileCcz`.
 *   - App not found (`not_found`) — either `loadAppOwner` returns null
 *     or the blueprint/`app_name` read races a hard-delete; both
 *     collapse to a single `not_found` reason.
 *   - `compileCcz` throws — the error surfaces through the shared
 *     taxonomy (not the `McpAccessError` fast path).
 *
 * `@/lib/mcp/loadApp` is mocked directly rather than exercised through
 * `loadApp`, so each test pins the exact `BlueprintDoc` the tool sees
 * without fabricating a full on-disk shape. The MCP SDK boundary
 * follows the fake-server pattern used by sibling tool tests.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqApplication } from "@/lib/commcare/types";
import { loadApp, loadAppOwner } from "@/lib/db/apps";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc } from "@/lib/domain";
import { loadAppBlueprint } from "../loadApp";
import { registerCompileApp } from "../tools/compileApp";
import type { ToolContext } from "../types";

/* Hoisted mocks — every dependency the tool touches has a vi.fn()
 * stand-in so each test can pin exact return values without going
 * through Firestore, the real expander, or the real compiler. */
vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn(),
	loadAppOwner: vi.fn(),
}));
vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));
vi.mock("@/lib/commcare/expander", () => ({
	expandDoc: vi.fn(),
}));
vi.mock("@/lib/commcare/compiler", () => ({
	compileCcz: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

type Handler = (
	args: Record<string, unknown>,
	extra: Record<string, unknown>,
) => Promise<unknown>;

interface FakeServer {
	server: McpServer;
	capture(): Handler;
}

/**
 * Capture the MCP handler `registerCompileApp` registers via
 * `server.tool`. `server.notification` is a no-op spy because the
 * adapter pattern wires one through; this tool doesn't emit progress
 * so the spy stays silent.
 */
function makeFakeServer(): FakeServer {
	let captured: Handler | null = null;
	const server = {
		tool: (_n: string, _d: string, _s: unknown, cb: Handler) => {
			captured = cb;
		},
		server: { notification: vi.fn() },
	} as unknown as McpServer;
	return {
		server,
		capture: () => {
			if (!captured) throw new Error("handler not captured");
			return captured;
		},
	};
}

/**
 * A minimal `BlueprintDoc` the tool is happy to hand to
 * `expandDoc`. `expandDoc` is mocked so none of these fields are read
 * — the shape just has to satisfy the type.
 */
function fixtureBlueprint(): BlueprintDoc {
	return {
		appId: "a1",
		appName: "Vaccine Tracker",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/**
 * A minimal `AppDoc` around the blueprint fixture. Only `app_name` is
 * read by the tool; the rest exists to satisfy the full type. Casting
 * through `unknown` for timestamps avoids pulling in the Firestore
 * Admin SDK just to fabricate a `Timestamp` instance.
 */
function fixtureAppDoc(overrides?: Partial<AppDoc>): AppDoc {
	return {
		owner: "u1",
		app_name: "Vaccine Tracker",
		blueprint: fixtureBlueprint(),
		connect_type: null,
		module_count: 0,
		form_count: 0,
		status: "complete",
		error_type: null,
		deleted_at: null,
		recoverable_until: null,
		run_id: null,
		created_at: new Date() as unknown as AppDoc["created_at"],
		updated_at: new Date() as unknown as AppDoc["updated_at"],
		...overrides,
	};
}

/**
 * A stand-in `HqApplication` the JSON path serializes. `expandDoc` is
 * mocked, so the only thing that matters is that the return value is
 * typed as `HqApplication` and round-trips through `JSON.stringify`
 * cleanly. We cast through `unknown` to avoid fabricating the full 70+
 * field shape in a unit test.
 */
const FAKE_HQ_JSON = {
	doc_type: "Application" as const,
	name: "Vaccine Tracker",
	langs: ["en"],
	modules: [],
} as unknown as HqApplication;

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(loadAppOwner).mockReset();
	vi.mocked(loadApp).mockReset();
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(compileCcz).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerCompileApp — happy path, json format", () => {
	it("returns the pretty-printed HqApplication JSON for an owned app", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureBlueprint());
		vi.mocked(loadApp).mockResolvedValueOnce(fixtureAppDoc());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { format: string; app_id: string };
		};

		/* The payload must parse as JSON and carry the exact shape
		 * `expandDoc` returned — pretty-print whitespace doesn't affect
		 * `JSON.parse`, so asserting on the parsed object is whitespace-
		 * agnostic while still catching any accidental mangling. */
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as HqApplication;
		expect(parsed).toEqual(FAKE_HQ_JSON);
		expect(out._meta.format).toBe("json");
		expect(out._meta.app_id).toBe("a1");
		/* Hard invariant: the JSON path never triggers the ccz packer. */
		expect(compileCcz).not.toHaveBeenCalled();
	});
});

describe("registerCompileApp — happy path, ccz format", () => {
	it("returns the ccz archive base64-encoded with encoding meta", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureBlueprint());
		vi.mocked(loadApp).mockResolvedValueOnce(fixtureAppDoc());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const fakeBytes = Buffer.from("fake-ccz-bytes");
		vi.mocked(compileCcz).mockReturnValueOnce(fakeBytes);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "ccz" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { format: string; encoding: string; app_id: string };
		};

		/* Base64 round-trip must equal the original buffer — the client
		 * decodes back to bytes, so any encoding drift would corrupt the
		 * archive. */
		const decoded = Buffer.from(out.content[0]?.text ?? "", "base64");
		expect(decoded.equals(fakeBytes)).toBe(true);
		expect(out._meta.format).toBe("ccz");
		expect(out._meta.encoding).toBe("base64");
		expect(out._meta.app_id).toBe("a1");
		/* Verify the packer received the expanded JSON, the (fallback-
		 * honoring) app name, and the source blueprint — three args in
		 * that order, matching `compileCcz`'s signature. */
		expect(compileCcz).toHaveBeenCalledWith(
			FAKE_HQ_JSON,
			"Vaccine Tracker",
			expect.objectContaining({ appId: "a1" }),
		);
	});

	it("falls back to 'Untitled' when app_name is blank", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureBlueprint());
		vi.mocked(loadApp).mockResolvedValueOnce(fixtureAppDoc({ app_name: "" }));
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);
		vi.mocked(compileCcz).mockReturnValueOnce(Buffer.from("x"));

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		await capture()({ app_id: "a1", format: "ccz" }, {});

		const [, passedName] = vi.mocked(compileCcz).mock.calls[0] ?? [];
		/* The denormalized `app_name` default for a list row is "Untitled"
		 * — the tool mirrors that default so the emitted profile can
		 * never contain a blank name. */
		expect(passedName).toBe("Untitled");
	});
});

describe("registerCompileApp — ownership failure", () => {
	it("returns error_type = 'not_owner' and never compiles", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_owner");
		expect(out._meta?.app_id).toBe("a1");
		/* No blueprint load and no expand when ownership fails —
		 * cross-tenant compile probes must short-circuit. */
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(expandDoc).not.toHaveBeenCalled();
		expect(compileCcz).not.toHaveBeenCalled();
	});
});

describe("registerCompileApp — not found", () => {
	it("maps ownership-null to error_type = 'not_found'", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "ghost", format: "json" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_found");
		expect(out._meta?.app_id).toBe("ghost");
	});

	it("maps a hard-delete race on the app_name load to error_type = 'not_found'", async () => {
		/* Ownership check passes, blueprint loads, then the second
		 * Firestore read for `app_name` returns null — a concurrent
		 * hard-delete between the two reads. Both branches collapse to
		 * the same `not_found` reason so MCP clients see one error code
		 * for every "this app isn't there anymore" path. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureBlueprint());
		vi.mocked(loadApp).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_found");
		expect(out._meta?.app_id).toBe("a1");
		/* The expander never runs — the tool bails on the missing app
		 * name before reaching the emission pipeline. */
		expect(expandDoc).not.toHaveBeenCalled();
	});
});

describe("registerCompileApp — compileCcz throws", () => {
	it("surfaces compiler failures through the shared error taxonomy", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureBlueprint());
		vi.mocked(loadApp).mockResolvedValueOnce(fixtureAppDoc());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);
		vi.mocked(compileCcz).mockImplementationOnce(() => {
			/* The real compiler throws on structural problems (orphan
			 * binds, dangling refs). Simulate that class of failure here
			 * — we just need any throw to prove the catch routes through
			 * `toMcpErrorResult`'s generic taxonomy branch (not the
			 * `McpAccessError` fast path). */
			throw new Error("xform validation failed");
		});

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "ccz" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(typeof out._meta?.error_type).toBe("string");
		/* Generic taxonomy, not the access-error reasons — `compileCcz`
		 * failing is an emission fault, not a missing-app probe. */
		expect(out._meta?.error_type).not.toBe("not_owner");
		expect(out._meta?.error_type).not.toBe("not_found");
		expect(out._meta?.app_id).toBe("a1");
	});
});
