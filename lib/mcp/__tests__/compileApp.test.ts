/**
 * `registerCompileApp` unit tests.
 *
 * Covers the paths the tool handler has to care about:
 *
 *   - Happy path, `format: "json"`, media-free — the tool ownership-gates +
 *     loads the blueprint via a single `loadAppBlueprint` call, expands to
 *     HQ JSON, and returns it directly as content (no wrapper — a media-free
 *     app's JSON is byte-identical to the pre-media output).
 *   - `format: "json"`, media-bearing — returns the same `<app>.zip` bundle
 *     the HTTP export ships (app JSON + HQ bulk-upload `multimedia.zip` +
 *     README), base64-encoded inside a `{ format: "zip", ... }` wrapper so
 *     the references travel with their bytes.
 *   - Happy path, `format: "ccz"` — the same pipeline plus a
 *     `compileCcz` call; content is a JSON envelope with the
 *     base64-encoded archive under `data` and an `encoding: "base64"`
 *     tag inline.
 *   - Media gate — both formats validate media before expand; a stale
 *     reference returns `invalid_input`, not a 500 / broken bundle.
 *   - Ownership failure — IDOR hardening collapses `"not_owner"` to
 *     `"not_found"` on the wire and the tool never calls `compileCcz`.
 *   - App not found (`not_found`) — `loadAppBlueprint` throws, so the
 *     tool never reaches the expander.
 *   - `compileCcz` throws — the error surfaces through the shared
 *     taxonomy (not the `McpAccessError` fast path).
 *
 * `@/lib/mcp/loadApp` is mocked directly so each test pins the exact
 * `{ doc, app }` pair the tool sees — or pins the rejection reason for
 * the access-failure paths. The MCP SDK boundary follows the shared
 * `makeFakeServer` helper pattern used by sibling tool tests.
 */

import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqApplication } from "@/lib/commcare/types";
import { validationError } from "@/lib/commcare/validator/errors";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc } from "@/lib/domain";
import { asAssetId } from "@/lib/domain/multimedia";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { type LoadedApp, loadAppBlueprint } from "../loadApp";
import { McpAccessError } from "../ownership";
import { registerCompileApp } from "../tools/compileApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Hoisted mocks — every dependency the tool touches has a vi.fn()
 * stand-in so each test pins exact return values without going through
 * Firestore, the real expander, or the real compiler. */
vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));
vi.mock("@/lib/commcare/expander", () => ({
	expandDoc: vi.fn(),
}));
vi.mock("@/lib/commcare/compiler", () => ({
	compileCcz: vi.fn(),
}));
/* The media-validation gate reads Firestore; mock it so the unit suite
 * stays hermetic. Default `[]` = no media issues = proceed; the
 * media-rejection test overrides per-call. */
vi.mock("@/lib/media/boundaryValidation", () => ({
	collectBoundaryViolations: vi.fn(),
}));
/* The manifest resolver reads Firestore + GCS; mock it so tests pin the
 * media set. Default empty `Map` = media-free; the media-bearing json test
 * overrides with a byte-carrying asset. */
vi.mock("@/lib/media/manifest", () => ({
	resolveMediaManifest: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

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
		project_id: "project-1",
		app_name: "Vaccine Tracker",
		blueprint: fixtureBlueprint(),
		mutation_seq: 0,
		connect_type: null,
		module_count: 0,
		form_count: 0,
		status: "complete",
		error_type: null,
		deleted_at: null,
		recoverable_until: null,
		run_id: null,
		blueprint_token: null,
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

const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };

beforeEach(() => {
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(compileCcz).mockReset();
	vi.mocked(collectBoundaryViolations).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	/* Default: no media issues → the gate is transparent. Tests that
	 * exercise the rejection path override with `mockResolvedValueOnce`. */
	vi.mocked(collectBoundaryViolations).mockResolvedValue([]);
	/* Default: media-free → empty manifest. The media-bearing json test
	 * overrides with a populated `Map`. */
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
});

/* --- Tests ----------------------------------------------------------- */

describe("registerCompileApp — happy path, json format", () => {
	it("returns the HqApplication JSON for an owned app", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		/* JSON format returns the raw `HqApplication` in content — the
		 * caller asked for JSON and gets JSON, no envelope wrapper. */
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as HqApplication;
		expect(parsed).toEqual(FAKE_HQ_JSON);
		/* Hard invariant: the JSON path never triggers the ccz packer. */
		expect(compileCcz).not.toHaveBeenCalled();
		/* Hard invariant: the single-read refactor keeps Firestore reads
		 * to one per call — `loadAppBlueprint` runs once and no follow-up
		 * `loadApp` is issued. */
		expect(loadAppBlueprint).toHaveBeenCalledTimes(1);
	});
});

describe("registerCompileApp — happy path, ccz format", () => {
	it("returns the ccz archive base64-encoded with encoding meta", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const fakeBytes = Buffer.from("fake-ccz-bytes");
		vi.mocked(compileCcz).mockReturnValueOnce(fakeBytes);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "ccz" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		/* Content is a JSON envelope with the base64-encoded archive
		 * under `data` and the encoding tag inline — clients parse
		 * `encoding` to know to decode `data`. Base64 round-trip must
		 * equal the original buffer — the client decodes back to bytes,
		 * so any encoding drift would corrupt the archive. */
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			format: string;
			encoding: string;
			data: string;
		};
		expect(payload.format).toBe("ccz");
		expect(payload.encoding).toBe("base64");
		const decoded = Buffer.from(payload.data, "base64");
		expect(decoded.equals(fakeBytes)).toBe(true);
		/* `compileCcz` receives the expanded JSON, the denormalized app
		 * name (non-empty by `denormalize`'s invariant), the source
		 * blueprint, and the resolved media manifest — four args in that
		 * order, matching the signature. The fixture doc references no
		 * media, so the manifest is an empty `Map`. */
		expect(compileCcz).toHaveBeenCalledWith(
			FAKE_HQ_JSON,
			"Vaccine Tracker",
			expect.objectContaining({ appId: "a1" }),
			expect.objectContaining({ assets: expect.any(Map) }),
		);
	});

	it("stamps the loaded `mutation_seq` into compileCcz as `compiledAtSeq`", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			fixtureLoadedApp({ mutation_seq: 17 }),
		);
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);
		vi.mocked(compileCcz).mockReturnValueOnce(Buffer.from("ccz"));

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		await capture()({ app_id: "a1", format: "ccz" }, {});

		/* The seq stamps the profile's `cc-content-version` (verified against
		 * a real profile in the compiler unit test); here we assert the tool
		 * forwards `app.mutation_seq` into the compile options. */
		expect(compileCcz).toHaveBeenCalledWith(
			FAKE_HQ_JSON,
			"Vaccine Tracker",
			expect.anything(),
			expect.objectContaining({ compiledAtSeq: 17 }),
		);
	});
});

describe("registerCompileApp — ownership failure", () => {
	it("collapses not_owner to not_found on the wire (IDOR hardening) and never compiles", async () => {
		/* IDOR hardening: cross-tenant probes see the same envelope a
		 * missing-id probe would see. `loadAppBlueprint` throws
		 * `McpAccessError("not_owner")`; the wire never exposes the
		 * `"not_owner"` distinction. The internal reason stays on the
		 * error for the server-side audit log. */
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_owner"),
		);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
		expect(payload.app_id).toBe("a1");
		/* No expand when ownership fails — cross-tenant compile probes
		 * must short-circuit. */
		expect(expandDoc).not.toHaveBeenCalled();
		expect(compileCcz).not.toHaveBeenCalled();
	});
});

describe("registerCompileApp — not found", () => {
	it("maps a missing app row to error_type = 'not_found'", async () => {
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_found"),
		);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "ghost", format: "json" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.app_id).toBe("ghost");
		/* The expander never runs — the tool bails on the missing row. */
		expect(expandDoc).not.toHaveBeenCalled();
	});
});

describe("registerCompileApp — wire parity (IDOR regression lock)", () => {
	it("not_owner and not_found produce byte-identical envelopes", async () => {
		/* Regression lock for the IDOR hardening: both access-failure
		 * shapes must be byte-identical so a probing client has no
		 * signal to distinguish them. */
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_owner"),
		);
		const { server: sA, capture: capA } = makeFakeServer();
		registerCompileApp(sA, toolCtx);
		const ownerMismatch = await capA()(
			{ app_id: "probe-id", format: "json" },
			{},
		);

		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_found"),
		);
		const { server: sB, capture: capB } = makeFakeServer();
		registerCompileApp(sB, toolCtx);
		const notFound = await capB()({ app_id: "probe-id", format: "json" }, {});

		expect(JSON.stringify(ownerMismatch)).toBe(JSON.stringify(notFound));
		/* Neither branch reached the expander — both short-circuited at
		 * the ownership gate with identical envelopes. */
		expect(expandDoc).not.toHaveBeenCalled();
	});
});

describe("registerCompileApp — media validation gate", () => {
	it("returns invalid_input (not a 500/compile) when ccz references a stale media asset", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		/* A stale media ref — the kind of issue that would otherwise make
		 * `expandDoc`'s `requireAssetRef` throw an opaque internal error.
		 * The gate surfaces the rule's actionable message instead. */
		vi.mocked(collectBoundaryViolations).mockResolvedValueOnce([
			validationError(
				"MEDIA_ASSET_NOT_READY",
				"field",
				"At the icon on module 'Patients', the image is still uploading. Wait for it to finish, then try again.",
				{ moduleName: "Patients" },
			),
		]);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "ccz" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		/* Routed through `McpInvalidInputError` → `invalid_input`, NOT the
		 * generic taxonomy a compile throw would land in. */
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toContain("still uploading");
		expect(payload.app_id).toBe("a1");
		/* The gate fires BEFORE expand + compile — neither runs on a
		 * media-invalid doc. */
		expect(expandDoc).not.toHaveBeenCalled();
		expect(compileCcz).not.toHaveBeenCalled();
	});

	it("proceeds to compile when the ccz boundary gate is clean", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);
		vi.mocked(compileCcz).mockReturnValueOnce(Buffer.from("ccz"));
		/* `mockResolvedValue([])` from beforeEach — no media issues. */

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "ccz" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			format: string;
		};
		expect(payload.format).toBe("ccz");
		expect(collectBoundaryViolations).toHaveBeenCalledTimes(1);
		expect(compileCcz).toHaveBeenCalledTimes(1);
	});

	it("runs the boundary gate for the json format too", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		/* A stale ref on a json compile would make the bundle emit
		 * references to bytes the manifest can't supply — so the json path
		 * runs the SAME gate as ccz and surfaces `invalid_input`. */
		vi.mocked(collectBoundaryViolations).mockResolvedValueOnce([
			validationError(
				"MEDIA_ASSET_NOT_READY",
				"field",
				"At the icon on module 'Patients', the image is still uploading. Wait for it to finish, then try again.",
				{ moduleName: "Patients" },
			),
		]);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
		};
		expect(payload.error_type).toBe("invalid_input");
		expect(collectBoundaryViolations).toHaveBeenCalledTimes(1);
		/* Gate fires before expand — no broken bundle is built. */
		expect(expandDoc).not.toHaveBeenCalled();
	});

	it("returns a base64 zip bundle when the json app has media", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);
		/* A media-bearing manifest (one ready image with bytes) flips the
		 * json output from bare text to the shared `<app>.zip` bundle. */
		const asset = {
			assetId: asAssetId("a1"),
			wirePath: "commcare/abc123def.png",
			kind: "image" as const,
			mimeType: "image/png",
			contentHash: "abc123def",
			extension: ".png",
			bytes: Buffer.from("PNG-BYTES"),
		};
		vi.mocked(resolveMediaManifest).mockResolvedValueOnce(
			new Map([[asset.assetId, asset]]),
		);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		/* Media-bearing json returns the `{ format: "zip", ... }` wrapper,
		 * NOT bare JSON — the client decodes `data` to a zip. */
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			format: string;
			encoding: string;
			data: string;
		};
		expect(payload.format).toBe("zip");
		expect(payload.encoding).toBe("base64");

		/* The decoded archive is the same bundle the HTTP export ships:
		 * the app JSON, the HQ-format multimedia zip, and the README —
		 * proving the json path and the route share one builder. */
		const bundle = new AdmZip(Buffer.from(payload.data, "base64"));
		const names = bundle.getEntries().map((e) => e.entryName);
		expect(names).toContain("Vaccine Tracker.json");
		expect(names).toContain("multimedia.zip");
		expect(names).toContain("README.txt");
		const mediaZip = new AdmZip(bundle.getEntry("multimedia.zip")?.getData());
		expect(mediaZip.getEntries().map((e) => e.entryName)).toEqual([
			"commcare/abc123def.png",
		]);
	});
});

describe("registerCompileApp — json compiledAtSeq (_meta carrier)", () => {
	it("carries the seq on `_meta` for a media-free json compile, body byte-identical", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			fixtureLoadedApp({ mutation_seq: 23 }),
		);
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta?: Record<string, unknown>;
		};

		/* The seq rides on `_meta` — protocol metadata that needs no
		 * `outputSchema` — so the `text` body stays the byte-identical HQ-import
		 * artifact (bare `HqApplication` JSON). */
		expect(out._meta?.["nova/compiledAtSeq"]).toBe(23);
		expect(out.content[0]?.text).toBe(JSON.stringify(FAKE_HQ_JSON));
	});

	it("carries the seq on `_meta` for a media-bearing json compile", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			fixtureLoadedApp({ mutation_seq: 24 }),
		);
		vi.mocked(expandDoc).mockReturnValueOnce(FAKE_HQ_JSON);
		const asset = {
			assetId: asAssetId("a1"),
			wirePath: "commcare/abc123def.png",
			kind: "image" as const,
			mimeType: "image/png",
			contentHash: "abc123def",
			extension: ".png",
			bytes: Buffer.from("PNG-BYTES"),
		};
		vi.mocked(resolveMediaManifest).mockResolvedValueOnce(
			new Map([[asset.assetId, asset]]),
		);

		const { server, capture } = makeFakeServer();
		registerCompileApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1", format: "json" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta?: Record<string, unknown>;
		};

		/* The seq rides on `_meta` for the zip-wrapper shape too, leaving the
		 * `{ format: "zip", ... }` text body untouched. */
		expect(out._meta?.["nova/compiledAtSeq"]).toBe(24);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			format: string;
		};
		expect(payload.format).toBe("zip");
	});
});

describe("registerCompileApp — compileCcz throws", () => {
	it("surfaces compiler failures through the shared error taxonomy", async () => {
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
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		expect(typeof payload.error_type).toBe("string");
		/* Generic taxonomy, not the access-error reasons — `compileCcz`
		 * failing is an emission fault, not a missing-app probe. */
		expect(payload.error_type).not.toBe("not_owner");
		expect(payload.error_type).not.toBe("not_found");
		expect(payload.app_id).toBe("a1");
	});
});
