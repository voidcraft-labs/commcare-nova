/**
 * `registerCompileApp` unit tests.
 *
 * Covers the five paths the route handler has to care about:
 *
 *   - Happy path, `format: "json"` — the tool ownership-gates, loads
 *     the blueprint, expands to HQ JSON, and returns a compact JSON
 *     text payload with `_meta.format: "json"` + `run_id`.
 *   - Happy path, `format: "ccz"` — the same pipeline plus a
 *     `compileCcz` call; the returned text is base64 and
 *     `_meta.encoding: "base64"` tells clients to decode.
 *   - Ownership failure — IDOR hardening collapses `"not_owner"` to
 *     `"not_found"` on the wire and the tool never calls `compileCcz`.
 *   - App not found (`not_found`) — ownership returns null, so the
 *     tool never reaches the blueprint load or the expander.
 *   - `compileCcz` throws — the error surfaces through the shared
 *     taxonomy (not the `McpAccessError` fast path).
 *
 * `@/lib/mcp/loadApp` is mocked directly so each test pins the exact
 * `{ doc, app }` pair the tool sees. `loadAppOwner` is mocked on the
 * db layer to drive the ownership gate. The MCP SDK boundary follows
 * the shared `makeFakeServer` helper pattern used by sibling tool tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqApplication } from "@/lib/commcare/types";
import { loadAppOwner } from "@/lib/db/apps";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc } from "@/lib/domain";
import { type LoadedApp, loadAppBlueprint } from "../loadApp";
import { registerCompileApp } from "../tools/compileApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Hoisted mocks — every dependency the tool touches has a vi.fn()
 * stand-in so each test pins exact return values without going through
 * Firestore, the real expander, or the real compiler. */
vi.mock("@/lib/db/apps", () => ({
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

/** Loose UUID-v4 regex for asserting minted run ids without pinning a value. */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A minimal `BlueprintDoc` the tool hands to `expandDoc`. `expandDoc`
 * is mocked so none of these fields are read — the shape just has to
 * satisfy the type.
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
 * A minimal `AppDoc` whose only consumed field in this tool is
 * `app_name`. Casting timestamps through `unknown` avoids pulling in
 * the Firestore Admin SDK just to fabricate `Timestamp` instances.
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
 * Assemble the `{ doc, app }` pair `loadAppBlueprint` resolves to on
 * the happy path. Both sides share the same fixture blueprint so
 * downstream assertions can compare-by-reference.
 */
function fixtureLoadedApp(appOverrides?: Partial<AppDoc>): LoadedApp {
	return { doc: fixtureBlueprint(), app: fixtureAppDoc(appOverrides) };
}

/**
 * A stand-in `HqApplication` the JSON path serializes. `expandDoc` is
 * mocked, so the only thing that matters is that the return value is
 * typed as `HqApplication` and round-trips through `JSON.stringify`
 * cleanly. Cast through `unknown` to avoid fabricating the full 70+
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
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(compileCcz).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerCompileApp — happy path, json format", () => {
	it("returns the HqApplication JSON for an owned app", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { format: string; app_id: string; run_id: string };
		};

		/* The payload must parse as JSON and carry the exact shape
		 * `expandDoc` returned. `JSON.parse` is whitespace-agnostic, so
		 * this assertion catches both compact and pretty-printed output
		 * without pinning the formatting choice. */
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as HqApplication;
		expect(parsed).toEqual(FAKE_HQ_JSON);
		expect(out._meta.format).toBe("json");
		expect(out._meta.app_id).toBe("a1");
		/* Minted run id shape — uuid v4 when the client didn't thread one. */
		expect(out._meta.run_id).toMatch(UUID_RE);
		/* Hard invariant: the JSON path never triggers the ccz packer. */
		expect(compileCcz).not.toHaveBeenCalled();
		/* Hard invariant: the single-read refactor keeps Firestore reads
		 * to one per call — `loadAppBlueprint` runs once and no follow-up
		 * `loadApp` is issued. */
		expect(loadAppBlueprint).toHaveBeenCalledTimes(1);
	});

	it("threads a client-supplied run_id through to _meta.run_id", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", format: "json" },
			{ _meta: { run_id: "client-rid-json" } },
		)) as { _meta: { run_id: string } };

		expect(out._meta.run_id).toBe("client-rid-json");
	});
});

describe("registerCompileApp — happy path, ccz format", () => {
	it("returns the ccz archive base64-encoded with encoding meta", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const fakeBytes = Buffer.from("fake-ccz-bytes");
		vi.mocked(compileCcz).mockReturnValueOnce(fakeBytes);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "ccz" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: {
				format: string;
				encoding: string;
				app_id: string;
				run_id: string;
			};
		};

		/* Base64 round-trip must equal the original buffer — the client
		 * decodes back to bytes, so any encoding drift would corrupt the
		 * archive. */
		const decoded = Buffer.from(out.content[0]?.text ?? "", "base64");
		expect(decoded.equals(fakeBytes)).toBe(true);
		expect(out._meta.format).toBe("ccz");
		expect(out._meta.encoding).toBe("base64");
		expect(out._meta.app_id).toBe("a1");
		expect(out._meta.run_id).toMatch(UUID_RE);
		/* `compileCcz` receives the expanded JSON, the denormalized app
		 * name (non-empty by `denormalize`'s invariant), and the source
		 * blueprint — three args in that order, matching the signature. */
		expect(compileCcz).toHaveBeenCalledWith(
			FAKE_HQ_JSON,
			"Vaccine Tracker",
			expect.objectContaining({ appId: "a1" }),
		);
	});
});

describe("registerCompileApp — ownership failure", () => {
	it("collapses not_owner to not_found on the wire (IDOR hardening) and never compiles", async () => {
		/* IDOR hardening: cross-tenant probes see the same envelope a
		 * missing-id probe would see. The wire never exposes the
		 * `"not_owner"` distinction; the internal reason stays on the
		 * `McpAccessError` for the server-side audit log. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_found");
		expect(out.content[0]?.text).toBe("App not found.");
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

	it("maps a hard-delete race on loadAppBlueprint to error_type = 'not_found'", async () => {
		/* Ownership check passes, then the blueprint load returns null —
		 * a concurrent hard-delete between the two reads. The tool must
		 * collapse this to the same `not_found` reason a missing-app
		 * probe gets so MCP clients see one error code. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			isError?: true;
			_meta?: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_found");
		expect(out._meta?.app_id).toBe("a1");
		/* The expander never runs — the tool bails on the missing row
		 * before reaching the emission pipeline. */
		expect(expandDoc).not.toHaveBeenCalled();
	});
});

describe("registerCompileApp — compileCcz throws", () => {
	it("surfaces compiler failures through the shared error taxonomy", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
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
